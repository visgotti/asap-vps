// Scaleway Instances over the Instance API v1
// (https://www.scaleway.com/en/developers/api/instance/v1, spec read 2026-10-01;
// every endpoint called is in endpoints.ts with its reference page): every
// Instance type, a VPS ('DEV1-S', 'PLAY2-MICRO') and a GPU type ('L4-1-24G',
// 'H100-SXM-8-80G', RENDER-S) alike, listed per zone with its price in EUR and
// its live stock (`available`, `scarce`, `shortage`); one offer here is one
// type, whose `regions` are the zones that are not in shortage. A server is
// named by its zone and id (`fr-par-2/<uuid>`) because every call is zonal. It
// is created powered off, so createServer sets its cloud-init user data and
// starts it. A GPU type boots from Block Storage (a root `sbs_volume`, sized by
// `diskGb`), which `terminate` only detaches, so deleting a server deletes its
// volumes too. `poweroff` releases the hypervisor slot (the GPU) and ends
// compute billing (only volumes and IPs bill), and `poweron` needs stock again.
// Images (`backup`) are zone-bound, made of snapshots, and the API has no copy
// to another zone (only a QCOW2 export of a snapshot to Object Storage and an
// import elsewhere, a path this provider does not take): Scaleway has images,
// but no image copy. A
// Project's SSH keys are applied at every boot to every server created in it.
// Volumes are Block Storage: zonal, attached to one server at a time as a
// disk (the server formats and mounts it), and the caller's: a server keeps
// the ones it was created with from `mounts` out of its deletion and its images.

import type { CapabilityDescriptor, ProviderCapabilities } from '../../capabilities';
import { ComputeProvider, ResolvedMount } from '../../Core/ComputeProvider';
import { randomBytes } from 'crypto';
import { filterOffers, findSSHKey, isKind, pickSSHKeys, S3Client, stageDownload, urlSource } from '../../Core/utils';
import { CapacityError, NotFoundError, NotSupportedError, ProviderError } from '../../errors';
import type {
    CreateEndpointOptions, CreateServerOptions, CreateVolumeOptions, Endpoint, EndpointRequestInit, ImportImageOptions, InitializedSSHKeyData, Offer, OfferQuery, Server,
    ServerImage, ServerListOptions, Volume, WaitOptions,
} from '../../types';
import { ScalewayApi } from './api';
import {
    BILLING_PER_HOUR, BILLING_PER_MINUTE, CONTAINER_SIZES, CONTAINER_TRANSIENT, containerSizeId, copyTag, ENDPOINT_TAG, endpointUrl, epochMs, FILE_REGIONS, fileSystemMountScript,
    fileSystemTag, GB, gpuOf, isCopyOf, isScalewayZone, MOUNT_TAG, mountedVolumeIds, parseContainerSizeId, parseRegionalId, parseZonedId, regionOfZone, SCALEWAY_ENUMS, SCALEWAY_ID,
    SCALEWAY_REFUSED, SCALEWAY_SSH_USER, TMP_BUCKET_PREFIX, toContainerOffer, toEndpoint, toFileSystemVolume, toImage, toOffer, toServer, toVolume, zonedId,
} from './mappers';
import { SCALEWAY_REGIONS } from './types';
import type {
    ScalewayBlockVolume, ScalewayContainer, ScalewayContainerSize, ScalewayCreateServerBody, ScalewayFileSystem, ScalewayImage, ScalewayOfferRaw, ScalewayParams,
    ScalewayRegion, ScalewayServer, ScalewayServerType, ScalewayTypes, ScalewayVolumeTemplate, ScalewayZone,
} from './types';

/** What Scaleway can do, and how. */
export const SCALEWAY_CAPABILITIES = {
    compute: { kind: 'vm', gpu: true, cpu: true, userData: true, liveAvailability: true },
    // poweroff releases the hypervisor slot: only the volumes and IPs bill, and startServer needs stock.
    power: { stoppedBilling: 'storage' },
    restart: {},
    // A Project's keys are read at each boot (checked live 2026-10-02): a key deleted from the Project is gone from the server at its next reboot.
    sshKeys: { appliedAtBoot: true },
    // An image boots in its own zone only: a copy to another is made through Object Storage (export, import, image).
    images: { scope: 'region' },
    imageCopy: {},
    // A QCOW2 from a URL, through a bucket of the run's own (Object Storage), imported as a Block snapshot, imaged (UEFI boot).
    imageImport: { formats: ['qcow2'], compressions: [], maxGb: 1000 },
    // Block Storage: one server at a time, attached as a disk the server formats and mounts itself. File Storage (shared):
    // filesystems many Instances of its region (Paris) attach at once, mounted with virtiofs at a path (types with max_file_systems).
    volumes: { block: { mount: 'device', size: 'fixed', minGb: 1 }, shared: { mount: 'path', size: 'fixed', minGb: 25, maxGb: 50000 } },
    // A volume is attached to, and detached from, a server that runs.
    volumeAttach: {},
    // Serverless Containers: CPU only; a public image (any registry) or the Project's own registry's, no other login.
    serverless: { gpu: false, cpu: true, registryAuth: false },
} as const satisfies CapabilityDescriptor;

type Caps = typeof SCALEWAY_CAPABILITIES;

/** An image's creation time, for ordering: one with no date is oldest. */
const createdAt = (i: ScalewayImage) => epochMs(i.creation_date) ?? 0;

export class Scaleway extends ComputeProvider<ScalewayTypes, ScalewayApi> implements ProviderCapabilities<ScalewayTypes, Caps> {
    static readonly capabilities: Caps = SCALEWAY_CAPABILITIES;
    readonly id = SCALEWAY_ID;
    readonly capabilities: Caps = SCALEWAY_CAPABILITIES;
    protected readonly enums = SCALEWAY_ENUMS;

    /** Scaleway's GPU OS image (Marketplace label): Ubuntu 24.04 with the NVIDIA driver, CUDA, Docker and the container toolkit; compatible with every GPU type. */
    static readonly GPU_IMAGE = 'ubuntu_noble_gpu_os_13_nvidia';
    /** The plain Ubuntu 24.04 a type without GPUs boots by default (the GPU image is for GPU types). */
    static readonly CPU_IMAGE = 'ubuntu_noble';
    /** Scaleway's images log in as root. */
    static readonly SSH_USER = SCALEWAY_SSH_USER;
    /** How a GPU Instance is billed: by the minute. CPU Instances and RENDER-S bill by the hour. */
    static readonly BILLING_PER_MINUTE = BILLING_PER_MINUTE;
    static readonly BILLING_PER_HOUR = BILLING_PER_HOUR;

    constructor(params: ScalewayParams | string) {
        super(new ScalewayApi(params));
    }

    /**
     * Instance types, one offer per type: the price per hour in USD (Scaleway
     * bills in EUR: `eurToUsd`), the GPU memory per GPU, and the zones with
     * stock now. Every GPU type, and the x86 types without GPUs (an Arm image
     * cannot boot on a GPU type, so an image prepared on one could not move to a
     * GPU); an Arm type is created by its id.
     */
    public async listOffers(query: OfferQuery = {}): Promise<Offer<ScalewayOfferRaw>[]> {
        const zones = await this.api.forZones(async (zone) => {
            const [types, stock] = await Promise.all([this.api.serverTypes(zone), this.api.availability(zone)]);
            return { zone, types, stock };
        });
        const offered = new Map<string, { raw: ScalewayOfferRaw, regions: ScalewayZone[] }>();
        for (const { zone, types, stock } of zones) {
            for (const [name, type] of Object.entries(types)) {
                if (type.end_of_service || !(gpuOf(type) || type.arch === 'x86_64')) continue;
                const entry = offered.get(name) ?? { raw: { serverType: type, availability: {} }, regions: [] };
                const availability = stock[name];
                if (availability) entry.raw.availability[zone] = availability;
                if (availability === 'available' || availability === 'scarce') entry.regions.push(zone);
                offered.set(name, entry);
            }
        }
        return filterOffers([...offered].map(([name, e]) => toOffer(name, e.raw, e.regions, this.api.eurToUsd)), query);
    }

    /**
     * Creates the server in the offer's zone, sets `userData` (cloud-init) and
     * powers it on; returns it `pending`. `image` is a Marketplace label
     * (default: Scaleway's GPU image for a GPU type, plain Ubuntu for any other),
     * a MACHINE_TYPES member, an image id, or one of listImages (`fr-par-2/<uuid>`,
     * which fixes the zone). `region` is a zone or a REGION_TYPES member.
     * `diskGb` sizes the root volume (default: the image's). The Project's SSH
     * keys are authorized, `sshKeyIds` among them (it must name keys of the
     * Project, by id, name, fingerprint or public key, and cannot exclude the
     * others). Needs the Project (`projectId`). A zone with no stock for the
     * type, at the create or at the power-on, is a CapacityError, and a server
     * that could not be started is deleted again.
     *
     * `mounts` attaches Block Storage volumes of the server's zone that no
     * server holds (each read first: one elsewhere or in use is refused), as
     * disks after the image's own; a zoned id (`fr-par-2/<uuid>`) fixes the
     * zone. Scaleway does not mount them: the server formats (when new) and
     * mounts each. They are the caller's: deleteServer and createImage leave them.
     */
    public async createServer(o: CreateServerOptions<ScalewayTypes>): Promise<Server<ScalewayServer>> {
        this.rejectOptions(o, SCALEWAY_REFUSED);
        const resolved = this.resolveOffer(o);
        const image = this.imageName(o.image);
        let imageRef = image ? parseZonedId(image) : null;
        // An image of another zone than the one asked for: its copy there (copyImage), where it has one.
        if (imageRef && o.region !== undefined) {
            const asked = this.zoneOf(this.regionName(o.region));
            if (imageRef.zone !== asked) {
                const copy = (await this.api.listImages(asked)).find((i) => isCopyOf(i, imageRef!.id));
                if (copy) imageRef = { zone: asked, id: copy.id };
            }
        }
        const { blocks: mounts, files } = await this.splitMounts(this.mountsOf(o.mounts));
        const zone = this.zoneFor(o, resolved.region, imageRef?.zone, mounts);
        const type = await this.typeOf(zone, resolved.id, resolved.offer);
        this.checkFileSystems(zone, type, files.map((x) => x.fs));
        this.checkFixedGpuCount(o, gpuOf(type)?.count ?? 0);
        if (o.diskGb !== undefined && !(o.diskGb > 0)) throw new ProviderError(this.id, 'diskGb must be a size in GB above 0');
        if (o.sshKeyIds?.length) pickSSHKeys(await this.api.listSSHKeys(), o.sshKeyIds, this.id);
        const attached = await this.attachable(zone, mounts, imageRef?.id);
        const volumes: Record<string, ScalewayVolumeTemplate> = {
            // A multiple of 512 bytes; Block Storage where the type has it (every GPU type), else a local SSD.
            ...(o.diskGb !== undefined ? { 0: { volume_type: type.capabilities?.block_storage ? 'sbs_volume' : 'l_ssd', size: Math.round((o.diskGb * GB) / 512) * 512 } } : {}),
            ...attached.volumes,
        };
        // The server's tags name what it holds but does not own (MOUNT_TAG, the filesystems): what its deletion and
        // its images leave alone. providerOptions may add tags and name volumes, never drop that bookkeeping.
        const { tags: rawTags, volumes: rawVolumes, ...raw } = o.providerOptions ?? {};
        if (rawVolumes !== undefined && Object.keys(volumes).length) {
            throw new NotSupportedError(this.id, 'providerOptions.volumes with diskGb or mounts (both set the server\'s volumes: pass one)');
        }
        const allVolumes: Record<string, ScalewayVolumeTemplate> = rawVolumes ?? volumes;
        // A volume named by id exists already: it is the caller's, as a mount is, however it was named.
        const held = Object.values(allVolumes).flatMap((v) => (v.id ? [`${MOUNT_TAG}${v.id}`] : []));
        const tags = [...new Set([...(o.tags ?? []), ...(rawTags ?? []), ...attached.tags, ...held, ...files.map((x) => fileSystemTag(x.fs.id, x.path))])];
        const body: ScalewayCreateServerBody = {
            name: o.name,
            commercial_type: resolved.id,
            image: imageRef ? imageRef.id : image ?? (gpuOf(type) ? Scaleway.GPU_IMAGE : Scaleway.CPU_IMAGE),
            project: this.api.requireProject('create a server'),
            dynamic_ip_required: true,
            boot_type: 'local',
            protected: false,
            ...raw,
            ...(Object.keys(allVolumes).length ? { volumes: allVolumes } : {}),
            ...(tags.length ? { tags } : {}),
        };
        const own = fileSystemMountScript(files.map((x) => ({ id: x.fs.id, path: x.path })));
        const userData = this.userDataWith(o, !!gpuOf(type), own ? [own] : []);
        return toServer(await this.api.launchServer(zone, body, { userData, filesystems: files.map((x) => x.fs.id) }), type, this.api.eurToUsd);
    }

    public async getServer(id: string): Promise<Server<ScalewayServer> | null> {
        const server = await this.api.findServer(id);
        return server ? toServer(server, (await this.catalog(server.zone))[server.commercial_type], this.api.eurToUsd) : null;
    }

    /**
     * Every server of the zones' Projects the key can read, other people's
     * included: pick yours by name. `kind` keeps those with GPUs or without; a
     * server of a type no longer in the catalog is always listed.
     */
    public async listServers(options: ServerListOptions = {}): Promise<Server<ScalewayServer>[]> {
        const perZone = await this.api.forZones(async (zone) => {
            const [servers, types] = await Promise.all([this.api.listServers(zone), this.catalog(zone)]);
            return servers
                .filter((s) => !types[s.commercial_type] || isKind(gpuOf(types[s.commercial_type])?.count ?? 0, options.kind))
                .map((s) => toServer(s, types[s.commercial_type], this.api.eurToUsd));
        });
        return perZone.flat();
    }

    /**
     * Terminates the server, waits until it is gone (up to `o.timeoutMs`), and
     * deletes its volumes. Idempotent: deleting a server that is already gone
     * succeeds. A volume it could not delete is a ProviderError (`left_behind`)
     * naming it: it bills until deleted, and nothing finds it once the server is gone.
     */
    public async deleteServer(id: string, o: WaitOptions = {}): Promise<void> {
        const r = parseZonedId(id);
        if (!r) return;
        const server = r.zone ? { zone: r.zone, id: r.id } : await this.api.findServer(id);
        if (server) await this.api.deleteServer(server.zone, server.id, o);
    }

    // ── power, restart ───────────────────────────────────────────────────

    /**
     * `poweroff`, and waits until it is stopped: the hypervisor slot (a GPU) is
     * released and only the volumes and IPs bill. startServer needs stock again.
     * A server in standby (`stopped in place`, which keeps its slot and bills as
     * running, though it reads as stopped) is powered off too.
     */
    public async stopServer(id: string): Promise<void> {
        const s = await this.need(id);
        // Standby (`stopped in place`) keeps the slot and bills as running: it is powered off too.
        if (s.state === 'stopped') return;
        if (s.state !== 'stopping') await this.api.serverAction(s.zone, s.id, { action: 'poweroff' }, true);
        const stopped = await this.waitFor(s, 'to stop', (x) => x.state === 'stopped' || x.state === 'locked');
        if (!stopped) throw new NotFoundError(this.id, `server ${id} disappeared while it was stopping`);
        if (stopped.state === 'locked') throw new ProviderError(this.id, `server ${id} is locked (${stopped.state_detail || 'no detail'}): it did not stop`);
    }

    /** `poweron`: CapacityError when the slot it released has no stock to come back to. */
    public async startServer(id: string): Promise<void> {
        const s = await this.need(id);
        if (s.state === 'running' || s.state === 'starting') return;
        if (s.state === 'stopping') await this.waitFor(s, 'to finish stopping', (x) => x.state !== 'stopping');
        await this.api.serverAction(s.zone, s.id, { action: 'poweron' }, true);
    }

    /** The `reboot` action; a bare id is asked of every zone. */
    public async restartServer(id: string): Promise<void> {
        const s = await this.need(id);
        await this.api.serverAction(s.zone, s.id, { action: 'reboot' });
    }

    // ── SSH keys ─────────────────────────────────────────────────────────

    /** The Project's SSH keys. */
    public async listSSHKeys(): Promise<InitializedSSHKeyData[]> {
        return this.api.listSSHKeys();
    }

    /**
     * Adds the key to the Project, where Scaleway applies it to every server at
     * every boot, or returns the Project's existing registration of the same key:
     * Scaleway accepts a key twice, so this looks first.
     */
    public async addSSHKey(publicKey: string, keyName: string): Promise<InitializedSSHKeyData> {
        return findSSHKey(await this.listSSHKeys(), publicKey) ?? this.api.registerSSHKey(publicKey.trim(), keyName);
    }

    public async deleteSSHKey(id: string | number): Promise<boolean> {
        return this.api.deleteSSHKey(id);
    }

    // ── images ───────────────────────────────────────────────────────────

    /** The Project's own images, in every zone: pick yours by name. */
    public async listImages(): Promise<ServerImage<ScalewayImage>[]> {
        return (await this.api.forZones((zone) => this.api.listImages(zone))).flat().map(toImage);
    }

    /** By `fr-par-2/<uuid>`, or a bare id asked of every zone; its regions: its zone and those of its copies (copyImage). */
    public async getImage(id: string): Promise<ServerImage<ScalewayImage> | null> {
        const image = await this.findImage(id);
        if (!image) return null;
        const copies = await this.copiesOf(image);
        return { ...toImage(image), regions: [image.zone, ...copies.map((c) => c.zone)] };
    }

    /**
     * The `backup` action: an image of the server's volumes (made of snapshots;
     * a `scratch` volume is left out, and so are the volumes it mounts from
     * `mounts`, the caller's), waited for until it is available. Stop the
     * server first for a consistent disk. The image boots in the server's zone only.
     *
     * With a mount, the request names the server's own volumes, each by id with
     * an empty template (its own type, as the API's spec says): the image is then
     * of the root alone. Checked live 2026-10-06: a server with a mounted volume
     * made an image with a `sbs_volume` root's `sbs_snapshot` and no extra volume.
     * The same backup without the volumes named (a raw call, not this method's)
     * answered `500 internal_server_error` once: seen once, not retried, but one
     * more reason the request always names them when there is a mount.
     */
    public async createImage(serverId: string, o: { name: string } & WaitOptions): Promise<ServerImage<ScalewayImage>> {
        const s = await this.need(serverId);
        const mounted = new Set(mountedVolumeIds(s));
        // Its own volumes by id, each snapshot of its own type; named only when a mount has to be left out.
        const own = Object.values(s.volumes).filter((v) => v.volume_type !== 'scratch' && !mounted.has(v.id));
        const task = await this.api.serverAction(s.zone, s.id, {
            action: 'backup', name: o.name, ...(mounted.size ? { volumes: Object.fromEntries(own.map((v) => [v.id, {}])) } : {}),
        });
        // The action names the image it makes: `/images/<uuid>`.
        const id = /(?:^|\/)images\/([0-9a-f-]{36})/i.exec(task?.href_result ?? '')?.[1]
            ?? (await this.api.listImages(s.zone)).filter((i) => i.name === o.name && i.from_server === s.id)
                .sort((a, b) => createdAt(b) - createdAt(a))[0]?.id;
        if (!id) throw new ProviderError(this.id, `the backup of server ${serverId} did not say which image it makes`);
        const image = await this.poll(() => this.api.getImage(s.zone, id), (i) => !i || i.state !== 'creating', {
            timeoutMs: o.timeoutMs ?? 60 * 60_000, intervalMs: o.intervalMs ?? 15_000, what: `image ${zonedId(s.zone, id)}`, describe: (i) => String(i?.state),
        });
        if (!image) throw new NotFoundError(this.id, `image ${zonedId(s.zone, id)} disappeared while it was made`);
        if (image.state === 'error') throw new ProviderError(this.id, `image ${zonedId(s.zone, id)} of server ${serverId} ended in an error`);
        return toImage(image);
    }

    /**
     * An image from the QCOW2 at `url`, in a zone of this provider's
     * (`region`): put in a bucket made for it in the zone's region (Object
     * Storage: needs `accessKey`), imported as a Block snapshot, imaged, the
     * bucket deleted. A server that serves ranges of the file has them streamed
     * into the bucket's upload, several at a time, nothing kept here; any other
     * is downloaded to a temporary file first. It boots where it has UEFI boot and cloud-init
     * (Scaleway boots no legacy BIOS). A file Scaleway cannot read is an error,
     * and leaves nothing behind. Default wait 1 h. Needs the Project.
     */
    public async importImage(o: ImportImageOptions<ScalewayTypes>): Promise<ServerImage<ScalewayImage>> {
        if (!/^https?:\/\/[^/]+\/./i.test(o.url)) throw new ProviderError(this.id, `an image is imported from an http(s) URL of a file, not "${o.url}"`);
        const zone = this.zoneOf(this.regionName(o.region));
        const project = this.api.requireProject('import an image');
        const s3 = this.api.objectStorage(regionOfZone(zone), 'importImage');
        const wait = { timeoutMs: o.timeoutMs ?? 60 * 60_000, intervalMs: o.intervalMs ?? 10_000 };
        const bucket = `${TMP_BUCKET_PREFIX}${randomBytes(6).toString('hex')}`;
        await s3.createBucket(bucket);
        try {
            const source = await urlSource(o.url, this.api.fetchImpl);
            if (source) await s3.upload(bucket, 'image.qcow2', source);
            else {
                const file = await stageDownload(o.url, this.api.fetchImpl);
                try {
                    await s3.putFile(bucket, 'image.qcow2', file);
                } finally {
                    await file.remove();
                }
            }
            return await this.imageFromObject(zone, { bucket, key: 'image.qcow2', name: o.name, project }, wait, o.providerOptions);
        } finally {
            await s3.emptyAndDeleteBucket(bucket).catch(() => undefined);
        }
    }

    /** Deletes the image and its snapshots (which would otherwise stay, billed), and its copies (copyImage) with theirs. Idempotent. */
    public async deleteImage(id: string): Promise<void> {
        const image = await this.findImage(id);
        if (!image) return;
        for (const copy of await this.copiesOf(image)) await this.api.deleteImage(copy.zone, copy.id);
        await this.api.deleteImage(image.zone, image.id);
    }

    /**
     * Copies the image to every zone of `regions` it is not in yet (zones of
     * this provider's), and waits until each copy is available (default up to
     * 2 h): its root disk's snapshot exported as a QCOW2 to a bucket of its
     * region (Object Storage: needs `accessKey`), moved to a bucket of the
     * other region where the zone is in another (streamed through this machine,
     * a range a part: nothing is kept here), imported
     * there as a Block snapshot, imaged; the buckets deleted. A copy is an image
     * of its zone (the same name, tagged COPY_TAG<source>): createServer boots it
     * for the source's id in that zone, and deleteImage deletes it with the
     * source. The result is the source, its regions every zone it or a copy is
     * in. Only the root disk comes: an image with more volumes is refused.
     */
    public async copyImage(id: string, regions: string[], o: WaitOptions = {}): Promise<ServerImage<ScalewayImage>> {
        const source = await this.findImage(id);
        if (!source) throw new NotFoundError(this.id, `no image ${id}`);
        if (source.state !== 'available') throw new ProviderError(this.id, `image ${zonedId(source.zone, source.id)} is ${source.state}: it is copied once available`);
        const root = source.root_volume;
        if (!root) throw new ProviderError(this.id, `image ${zonedId(source.zone, source.id)} has no root volume to copy`);
        if (Object.keys(source.extra_volumes).length) throw new NotSupportedError(this.id, 'copying an image with more than its root volume (only the root disk would come)');
        const have = new Set<string>([source.zone, ...(await this.copiesOf(source)).map((c) => c.zone)]);
        const targets = [...new Set(regions.map((r) => this.zoneOf(this.regionName(r))))].filter((z) => !have.has(z));
        if (!targets.length) return { ...toImage(source), regions: [...have] };
        const project = this.api.requireProject('copy an image');
        const wait = { timeoutMs: o.timeoutMs ?? 2 * 60 * 60_000, intervalMs: o.intervalMs ?? 15_000 };
        const key = `${source.id}.qcow2`;
        const buckets = new Map<ScalewayRegion, { s3: S3Client, bucket: string }>();
        const bucketIn = async (region: ScalewayRegion) => {
            const s3 = this.api.objectStorage(region, 'copyImage');
            const bucket = `${TMP_BUCKET_PREFIX}${randomBytes(6).toString('hex')}`;
            await s3.createBucket(bucket);
            buckets.set(region, { s3, bucket });
            return { s3, bucket };
        };
        try {
            const from = await bucketIn(regionOfZone(source.zone));
            await this.exportRoot(source.zone, root, from, key, wait);
            for (const zone of targets) {
                const region = regionOfZone(zone);
                let to = buckets.get(region);
                if (!to) {
                    // Another region: Object Storage copies no object across regions, so the QCOW2 goes through this machine,
                    // streamed a range a part (its time the slower of the download and the upload, not their sum; nothing kept here).
                    to = await bucketIn(region);
                    const source = await from.s3.objectSource(from.bucket, key);
                    if (!source) throw new ProviderError(this.id, `the export ${from.bucket}/${key} went before it was copied to ${region}`);
                    await to.s3.upload(to.bucket, key, source);
                }
                await this.imageFromObject(zone, { bucket: to.bucket, key, name: source.name, project }, wait, { arch: source.arch, tags: [copyTag(source.id)] });
                have.add(zone);
            }
        } finally {
            for (const { s3, bucket } of buckets.values()) await s3.emptyAndDeleteBucket(bucket).catch(() => undefined);
        }
        return { ...toImage(source), regions: [...have] };
    }

    // ── volumes ──────────────────────────────────────────────────────────

    /**
     * The Project's Block Storage volumes (every one the key can read without a
     * Project) in every zone, named `fr-par-2/<uuid>`, and its File Storage
     * filesystems (`shared`) in the regions of the zones, named `fr-par/<uuid>`.
     */
    public async listVolumes(): Promise<Volume<ScalewayBlockVolume | ScalewayFileSystem>[]> {
        const [blocks, files] = await Promise.all([
            this.api.forZones((zone) => this.api.listBlockVolumes(zone)),
            Promise.all(this.fileRegions().map((r) => this.api.listFileSystems(r))),
        ]);
        return [...blocks.flat().map(toVolume), ...files.flat().map(toFileSystemVolume)];
    }

    /** A Block Storage volume by `fr-par-2/<uuid>`, a filesystem by `fr-par/<uuid>`, or either by a bare id asked of every zone and region. */
    public async getVolume(id: string): Promise<Volume<ScalewayBlockVolume | ScalewayFileSystem> | null> {
        if (parseRegionalId(id)?.region) {
            const f = await this.findFileSystem(id);
            return f ? toFileSystemVolume(f) : null;
        }
        const v = await this.findVolume(id);
        if (v) return toVolume(v);
        const f = await this.findFileSystem(id);
        return f ? toFileSystemVolume(f) : null;
    }

    /**
     * An empty Block Storage volume of `sizeGb` (whole GB, 5000 IOPS) in a zone
     * (`region`) of this provider, once it is `available` (default: up to 5
     * min). It bills until deleteVolume, attached or not. Needs the Project (`projectId`).
     */
    public async createVolume(o: CreateVolumeOptions<ScalewayTypes> & { shared: true }): Promise<Volume<ScalewayFileSystem>>;
    public async createVolume(o: CreateVolumeOptions<ScalewayTypes> & { shared?: false }): Promise<Volume<ScalewayBlockVolume>>;
    public async createVolume(o: CreateVolumeOptions<ScalewayTypes>): Promise<Volume<ScalewayBlockVolume | ScalewayFileSystem>>;
    public async createVolume(o: CreateVolumeOptions<ScalewayTypes>): Promise<Volume<ScalewayBlockVolume | ScalewayFileSystem>> {
        if (o.shared) return this.createFileSystem(o);
        const zone = this.zoneOf(this.regionName(o.region));
        if (!(o.sizeGb >= 1)) throw new ProviderError(this.id, `a volume is at least 1 GB, not ${o.sizeGb}`);
        const made = await this.api.createBlockVolume(zone, {
            name: o.name, perf_iops: 5000, project_id: this.api.requireProject('create a volume'), from_empty: { size: Math.ceil(o.sizeGb) * GB }, ...o.providerOptions,
        });
        const v = await this.poll(() => this.api.getBlockVolume(zone, made.id), (x) => !x || x.status !== 'creating', {
            timeoutMs: o.timeoutMs ?? 5 * 60_000, intervalMs: o.intervalMs ?? 2000, what: `volume ${zonedId(zone, made.id)}`, describe: (x) => String(x?.status),
        });
        if (!v) throw new NotFoundError(this.id, `volume ${zonedId(zone, made.id)} disappeared while it was made`);
        if (v.status !== 'available') throw new ProviderError(this.id, `volume ${zonedId(zone, made.id)} is ${v.status}, not available`);
        return toVolume(v);
    }

    /**
     * Deletes the volume and its data. A Block Storage volume a server holds is
     * refused (precondition_failed): detach it, or delete the server; so is a
     * filesystem an Instance has attached. A filesystem is waited for until gone. Idempotent.
     */
    public async deleteVolume(id: string, o: WaitOptions = {}): Promise<void> {
        const v = parseRegionalId(id)?.region ? null : await this.findVolume(id);
        if (v) return void await this.api.deleteBlockVolumeNow(v.zone, v.id);
        const f = await this.findFileSystem(id);
        if (!f) return;
        const region = f.region as ScalewayRegion;
        await this.api.deleteFileSystem(region, f.id);
        await this.poll(() => this.api.getFileSystem(region, f.id), (x) => !x,
            { timeoutMs: o.timeoutMs ?? 5 * 60_000, intervalMs: o.intervalMs ?? 2000, what: `delete of filesystem ${f.name}`, describe: (x) => String(x?.status) });
    }

    /**
     * Attaches the volume (of the server's zone, held by no server) as the
     * server's next disk, tags the server with it (MOUNT_TAG: so deleteServer
     * and createImage leave it, as one it was created with), and waits until
     * the volume is `in_use`. The server formats (when new) and mounts it.
     */
    public async attachVolume(volumeId: string, serverId: string, o: WaitOptions = {}): Promise<void> {
        const s = await this.need(serverId);
        const f = await this.fileSystemOf(volumeId);
        if (f) {
            // A filesystem: attached (the Instance mounts it with virtiofs: `mount -t virtiofs <id> <path>`), and tagged at its mountPath.
            // One the server holds already is no further one: it is not counted against what its type takes.
            if (!s.filesystems?.some((x) => x.filesystem_id === f.id)) {
                this.checkFileSystems(s.zone, await this.typeOf(s.zone, s.commercial_type), [f], s.filesystems?.length ?? 0);
                await this.api.attachServerFileSystem(s.zone, s.id, f.id);
            }
            await this.api.fileSystemState(s.zone, s.id, f.id, 'available', o);
            const tag = fileSystemTag(f.id, toFileSystemVolume(f).mountPath!);
            if (!s.tags.some((t) => t.startsWith(fileSystemTag(f.id, '')))) await this.api.setServerTags(s.zone, s.id, [...s.tags, tag]);
            return;
        }
        const v = await this.volumeOf(s, volumeId);
        const held = Object.values(s.volumes).some((x) => x.id === v.id);
        if (!held && v.status !== 'available') throw new ProviderError(this.id, `volume ${zonedId(s.zone, v.id)} is ${v.status}: a volume attached to a server is attached to no other`);
        if (!held) await this.api.attachServerVolume(s.zone, s.id, v.id);
        const tag = `${MOUNT_TAG}${v.id}`;
        if (!s.tags.includes(tag)) await this.api.setServerTags(s.zone, s.id, [...s.tags, tag]);
        await this.volumeStatus(s.zone, v.id, 'in_use', o);
    }

    /** Detaches the volume, drops its tag, and waits until it is `available`; a volume the server does not hold is left as it is. */
    public async detachVolume(volumeId: string, serverId: string, o: WaitOptions = {}): Promise<void> {
        const s = await this.api.findServer(serverId);
        if (!s) return;
        const f = await this.fileSystemOf(volumeId);
        if (f) {
            if (s.filesystems?.some((x) => x.filesystem_id === f.id)) {
                await this.api.detachServerFileSystem(s.zone, s.id, f.id);
                await this.api.fileSystemState(s.zone, s.id, f.id, 'gone', o);
            }
            const untagged = s.tags.filter((t) => !t.startsWith(fileSystemTag(f.id, '')));
            if (untagged.length !== s.tags.length) await this.api.setServerTags(s.zone, s.id, untagged);
            return;
        }
        const ref = parseZonedId(volumeId);
        if (!ref) return;
        const tag = `${MOUNT_TAG}${ref.id}`;
        if (!Object.values(s.volumes).some((x) => x.id === ref.id)) {
            if (s.tags.includes(tag)) await this.api.setServerTags(s.zone, s.id, s.tags.filter((t) => t !== tag));
            return;
        }
        await this.api.detachServerVolume(s.zone, s.id, ref.id);
        await this.api.setServerTags(s.zone, s.id, s.tags.filter((t) => t !== tag));
        await this.volumeStatus(s.zone, ref.id, 'available', o);
    }

    // ── serverless: Serverless Containers ────────────────────────────────

    /** Container sizes (CPU in proportion to memory), priced per second while an instance runs, in every region; cheapest first. No GPUs. */
    public async listEndpointOffers(query: OfferQuery = {}): Promise<Offer<ScalewayContainerSize>[]> {
        return filterOffers(CONTAINER_SIZES.map((s) => toContainerOffer(s, this.api.eurToUsd)), query);
    }

    /** The Project's serverless containers in the regions of this provider's zones, named `fr-par/<uuid>`. */
    public async listEndpoints(): Promise<Endpoint<ScalewayContainer>[]> {
        return (await Promise.all(this.regions().map((r) => this.api.listContainers(r)))).flat().map(toEndpoint);
    }

    /** By `fr-par/<uuid>`, or a bare id asked of each region. */
    public async getEndpoint(id: string): Promise<Endpoint<ScalewayContainer> | null> {
        const c = await this.findContainer(id);
        return c ? toEndpoint(c) : null;
    }

    /**
     * A serverless container in a namespace made for it (deleted with it),
     * private (a request carries the account's key as X-Auth-Token), once
     * Scaleway has deployed it ('ready'; default wait up to 10 min). Its
     * instances serve HTTP on `port` (given to them as PORT), from
     * `minWorkers` (0-10, default 0) to `maxWorkers` (1-200, default 1); an
     * idle one stops after 15 min. Its name: 2-34 lowercase letters, digits
     * and dashes. Needs the Project (`projectId`). A deploy that fails is
     * thrown with Scaleway's message, and leaves nothing behind.
     */
    public async createEndpoint(o: CreateEndpointOptions<ScalewayTypes>): Promise<Endpoint<ScalewayContainer>> {
        const c = o.container;
        if (c.registryAuth) throw new NotSupportedError(this.id, 'createEndpoint option "container.registryAuth" (Scaleway pulls a public image, or one of the Project\'s own registry)');
        if (o.idleTimeoutSeconds !== undefined) throw new NotSupportedError(this.id, 'createEndpoint option "idleTimeoutSeconds" (Scaleway stops an idle instance after 15 minutes)');
        if (!/^[a-z][a-z0-9-]{0,32}[a-z0-9]$/.test(o.name)) throw new ProviderError(this.id, `endpoint name "${o.name}": 2-34 lowercase letters, digits and dashes, a letter first, no dash last`);
        const image = this.imageName(c.image);
        if (!image) throw new ProviderError(this.id, 'an endpoint needs an image');
        const port = o.port ?? 80;
        if (!(Number.isInteger(port) && port > 0 && port < 65536)) throw new ProviderError(this.id, `bad port ${port}`);
        if (c.env?.PORT !== undefined && c.env.PORT !== String(port)) throw new ProviderError(this.id, `env.PORT is the endpoint's port: pass port (${c.env.PORT}), not env.PORT`);
        const min = o.minWorkers ?? 0;
        const max = o.maxWorkers ?? 1;
        if (!(Number.isInteger(min) && Number.isInteger(max) && min >= 0 && min <= 10 && max >= 1 && max <= 200 && min <= max)) {
            throw new ProviderError(this.id, `workers: minWorkers 0-10, maxWorkers 1-200, min <= max (not ${min} and ${max})`);
        }
        const size = this.containerSize(o.offer);
        const region = this.providerRegion(o.region);
        const project = this.api.requireProject('create an endpoint');
        const wait = { timeoutMs: o.timeoutMs ?? 10 * 60_000, intervalMs: o.intervalMs ?? 3000 };
        const ns = await this.api.createContainerNamespace(region, { project_id: project, name: o.name, tags: [ENDPOINT_TAG] });
        try {
            await this.settled(`namespace ${ns.name}`, () => this.api.getContainerNamespace(region, ns.id), wait);
            const made = await this.api.createContainer(region, {
                namespace_id: ns.id, name: o.name, image, port, min_scale: min, max_scale: max, mvcpu_limit: size.mvcpu, memory_limit_bytes: size.memoryBytes,
                privacy: 'private', ...(c.env ? { environment_variables: c.env } : {}), ...(c.command?.length ? { args: c.command } : {}), tags: [ENDPOINT_TAG],
                ...o.providerOptions,
            });
            return toEndpoint(await this.settled(`endpoint ${o.name}`, () => this.api.getContainer(region, made.id), wait));
        } catch (e) {
            // Nothing half-made is left: the namespace goes, and its container with it, waited for.
            await this.deleteNamespaceAndWait(region, ns.id, ns.name, wait).catch(() => undefined);
            throw e;
        }
    }

    /** Deletes the container, and the namespace made for it, and waits until both are gone (default up to 5 min each); one gone already is no error. */
    public async deleteEndpoint(id: string, o: WaitOptions = {}): Promise<void> {
        const c = await this.findContainer(id);
        if (!c) return;
        const region = c.region as ScalewayRegion;
        const gone = { timeoutMs: o.timeoutMs ?? 5 * 60_000, intervalMs: o.intervalMs ?? 2000 };
        await this.api.deleteContainer(region, c.id);
        const ns = await this.api.getContainerNamespace(region, c.namespace_id);
        await this.poll(() => this.api.getContainer(region, c.id), (x) => !x, { ...gone, what: `delete of endpoint ${c.name}`, describe: (x) => String(x?.status) });
        // The namespace made for it goes too; one of the caller's own stays.
        if (ns?.tags.includes(ENDPOINT_TAG)) await this.deleteNamespaceAndWait(region, ns.id, ns.name, gone);
    }

    /**
     * A request to the container's public endpoint, with the account's key
     * (X-Auth-Token) where it is private. Its URL is read from the container
     * itself, and must be Scaleway's (*.scw.cloud): the key goes nowhere else.
     * A cold start is waited out: 502-504 while no instance answers yet is
     * sent again until `timeoutMs` (default 5 min).
     */
    public async requestEndpoint(endpoint: Endpoint | string, path: string, init: EndpointRequestInit = {}): Promise<Response> {
        if (typeof endpoint !== 'string' && endpoint.provider !== this.id) throw new ProviderError(this.id, `endpoint ${endpoint.id} is ${endpoint.provider}'s, not ${this.id}'s`);
        const ref = typeof endpoint === 'string' ? endpoint : endpoint.id;
        const c = await this.findContainer(ref);
        if (!c) throw new NotFoundError(this.id, `no endpoint ${ref}`);
        const base = new URL(endpointUrl(c));
        if (!/\.scw\.cloud$/.test(base.hostname)) throw new ProviderError(this.id, `endpoint ${c.name} answers on ${base.hostname}, not on a Scaleway host: no key is sent there`);
        return this.requestWarm(`${base.origin}${path.startsWith('/') ? path : `/${path}`}`, init,
            c.privacy === 'public' ? {} : { 'x-auth-token': this.api.apiKey }, async (r) => [502, 503, 504].includes(r.status));
    }

    // ── helpers ──────────────────────────────────────────────────────────

    /** The regions of this provider's zones that have File Storage. */
    private fileRegions(): ScalewayRegion[] {
        return this.regions().filter((r) => FILE_REGIONS.includes(r));
    }

    /** A filesystem by `fr-par/<uuid>`, or a bare id asked of each region with File Storage; null when there is none. */
    private async findFileSystem(ref: string): Promise<ScalewayFileSystem | null> {
        const r = parseRegionalId(ref);
        if (!r) return null;
        for (const region of (r.region ? [r.region] : this.fileRegions()).filter((x) => FILE_REGIONS.includes(x))) {
            const f = await this.api.getFileSystem(region, r.id);
            if (f) return f;
        }
        return null;
    }

    /** The filesystem a volume id names (a regional id, or a bare id no Block Storage volume has); null for a Block Storage volume. */
    private async fileSystemOf(id: string): Promise<ScalewayFileSystem | null> {
        if (parseRegionalId(id)?.region) {
            const f = await this.findFileSystem(id);
            if (!f) throw new NotFoundError(this.id, `no filesystem ${id}`);
            return f;
        }
        return parseZonedId(id)?.zone || await this.findVolume(id) ? null : this.findFileSystem(id);
    }

    /**
     * createServer's mounts, split: Block Storage volumes (attached as disks),
     * and filesystems (a shared volume, or a regional id `fr-par/<uuid>`: each
     * read now, available, mounted at the mount's path, default its mountPath).
     */
    private async splitMounts(mounts: ResolvedMount[]): Promise<{ blocks: ResolvedMount[], files: Array<{ fs: ScalewayFileSystem, path: string }> }> {
        const blocks: ResolvedMount[] = [];
        const files: Array<{ fs: ScalewayFileSystem, path: string }> = [];
        for (const m of mounts) {
            const fileRef = !!m.volume?.shared || !!parseRegionalId(m.id)?.region;
            const fs = fileRef ? await this.findFileSystem(m.id) : null;
            if (fileRef && !fs) throw new NotFoundError(this.id, `no filesystem ${m.id}`);
            if (!fs) {
                blocks.push(m);
                continue;
            }
            if (fs.status !== 'available') throw new ProviderError(this.id, `filesystem ${fs.name} is ${fs.status}: it is attached once available`);
            const path = m.path ?? toFileSystemVolume(fs).mountPath!;
            if (!path.startsWith('/')) throw new ProviderError(this.id, `mount path "${path}" is not absolute`);
            files.push({ fs, path });
        }
        return { blocks, files };
    }

    /** Refuses filesystems a server in `zone` of `type` cannot attach: of another region, or more than its type takes (`has` it holds already). */
    private checkFileSystems(zone: ScalewayZone, type: ScalewayServerType, files: ScalewayFileSystem[], has = 0): void {
        if (!files.length) return;
        const away = files.find((f) => f.region !== regionOfZone(zone));
        if (away) throw new ProviderError(this.id, `filesystem ${away.name} is in ${away.region}: an Instance in ${zone} cannot attach it`);
        const most = type.capabilities?.max_file_systems ?? 0;
        if (files.length + has > most) {
            throw new NotSupportedError(this.id, `${files.length + has} filesystems on ${type.alt_names?.[0] ?? 'this type'} (it attaches ${most}: types with max_file_systems, e.g. POP2, L4, L40S, H100)`);
        }
    }

    /**
     * A File Storage filesystem of `sizeGb` (25-50000 GB) in a region of this
     * provider's with File Storage (Paris), once available. One that fails is
     * deleted, and its failure thrown. Needs the Project.
     */
    private async createFileSystem(o: CreateVolumeOptions<ScalewayTypes> & { shared: true }): Promise<Volume<ScalewayFileSystem>> {
        const size = Math.ceil(o.sizeGb);
        if (!(size >= 25 && size <= 50000)) throw new ProviderError(this.id, `a shared volume (a filesystem) is 25-50000 GB, not ${o.sizeGb}`);
        const region = this.providerRegion(o.region);
        if (!FILE_REGIONS.includes(region)) throw new ProviderError(this.id, `File Storage is in ${FILE_REGIONS.join(', ')}, not ${region}`);
        const made = await this.api.createFileSystem(region, { name: o.name, project_id: this.api.requireProject('create a filesystem'), size: size * GB, ...o.providerOptions });
        try {
            const f = await this.poll(() => this.api.getFileSystem(region, made.id), (x) => !x || x.status !== 'creating',
                { timeoutMs: o.timeoutMs ?? 10 * 60_000, intervalMs: o.intervalMs ?? 3000, what: `filesystem ${o.name}`, describe: (x) => String(x?.status) });
            if (!f) throw new NotFoundError(this.id, `filesystem ${o.name} disappeared while it was made`);
            if (f.status !== 'available') throw new ProviderError(this.id, `filesystem ${o.name} is ${f.status}, not available`);
            return toFileSystemVolume(f);
        } catch (e) {
            await this.api.deleteFileSystem(region, made.id).catch(() => undefined);
            throw e;
        }
    }

    /** The copies of an image (copyImage), in every zone of this provider's. */
    private async copiesOf(image: ScalewayImage): Promise<ScalewayImage[]> {
        return (await this.api.forZones((z) => this.api.listImages(z))).flat().filter((i) => isCopyOf(i, image.id));
    }

    /**
     * An image's root snapshot, exported as a QCOW2 to bucket/key (of its
     * region): by the Block API (`sbs_snapshot`) or the Instance API (a local
     * volume's); waited for until the snapshot is no longer exporting and the
     * object is there.
     */
    private async exportRoot(zone: ScalewayZone, root: { id: string, volume_type: string }, to: { s3: S3Client, bucket: string }, key: string, wait: Required<WaitOptions>): Promise<void> {
        const block = root.volume_type === 'sbs_snapshot';
        if (block) await this.api.exportBlockSnapshot(zone, root.id, { bucket: to.bucket, key });
        else await this.api.exportInstanceSnapshot(zone, root.id, { bucket: to.bucket, key });
        const read = async () => {
            const state = block ? (await this.api.getBlockSnapshot(zone, root.id))?.status : (await this.api.getInstanceSnapshot(zone, root.id))?.state;
            return { state, there: state !== 'exporting' && !!(await to.s3.headObject(to.bucket, key)) };
        };
        const last = await this.poll(read, (x) => x.there || !x.state || x.state === 'error', { ...wait, what: `export of snapshot ${zonedId(zone, root.id)}`, describe: (x) => String(x.state) });
        if (!last.there) throw new ProviderError(this.id, `the export of snapshot ${zonedId(zone, root.id)} is ${last.state ?? 'gone'}`);
    }

    /**
     * An image of the QCOW2 at bucket/key (of the zone's region): imported as a
     * Block snapshot, once available, then imaged, once available. What fails
     * on the way is deleted (the snapshot, the image), and the failure thrown.
     */
    private async imageFromObject(zone: ScalewayZone, from: { bucket: string, key: string, name: string, project: string }, wait: Required<WaitOptions>,
        extra?: Partial<ScalewayTypes['imageImportBody']>): Promise<ServerImage<ScalewayImage>> {
        const made = await this.api.importBlockSnapshot(zone, { bucket: from.bucket, key: from.key, name: from.name, project_id: from.project });
        let imaged = false;
        try {
            const snap = await this.poll(() => this.api.getBlockSnapshot(zone, made.id), (x) => !x || x.status !== 'creating', { ...wait, what: `import of ${from.name}`, describe: (x) => String(x?.status) });
            if (!snap) throw new NotFoundError(this.id, `the snapshot of ${from.name} disappeared while it was imported`);
            if (snap.status !== 'available') throw new ProviderError(this.id, `the import of ${from.name} is ${snap.status}: Scaleway could not read the file (a QCOW2, unencrypted, no backing file, at most 1 TB)`);
            const image = await this.api.createImage(zone, { name: from.name, root_volume: snap.id, arch: 'x86_64', project: from.project, ...extra });
            imaged = true;
            const done = await this.poll(() => this.api.getImage(zone, image.id), (i) => !i || i.state !== 'creating', { ...wait, what: `image ${zonedId(zone, image.id)}`, describe: (i) => String(i?.state) });
            if (!done || done.state !== 'available') {
                // The image goes, its snapshot with it.
                await this.api.deleteImage(zone, image.id).catch(() => undefined);
                throw new ProviderError(this.id, `image ${zonedId(zone, image.id)} of ${from.name} is ${done?.state ?? 'gone'}, not available`);
            }
            return toImage(done);
        } catch (e) {
            if (!imaged) await this.api.deleteBlockSnapshot(zone, made.id).catch(() => undefined);
            throw e;
        }
    }

    /** Deletes a namespace (and its containers), and waits until it is gone. */
    private async deleteNamespaceAndWait(region: ScalewayRegion, id: string, name: string, o: Required<WaitOptions>): Promise<void> {
        await this.api.deleteContainerNamespace(region, id);
        await this.poll(() => this.api.getContainerNamespace(region, id), (x) => !x, { ...o, what: `delete of namespace ${name}`, describe: (x) => String(x?.status) });
    }

    /** The regions of this provider's zones: where its endpoints are (Serverless Containers is regional). */
    private regions(): ScalewayRegion[] {
        return [...new Set(this.api.zones.map(regionOfZone))];
    }

    /**
     * The region an endpoint goes to: the one named (a region, a zone of it, a
     * REGION_TYPES member), else that of this provider's first zone. It must be
     * one of this provider's (its zones'): its endpoints are listed and read there.
     */
    private providerRegion(region: string | undefined): ScalewayRegion {
        const mine = this.regions();
        if (region === undefined) return mine[0];
        const name = this.regionName(region);
        const r = (SCALEWAY_REGIONS as readonly string[]).includes(name) ? name as ScalewayRegion : isScalewayZone(name) ? regionOfZone(name) : undefined;
        if (!r) throw new ProviderError(this.id, `"${region}" is no Scaleway region (${SCALEWAY_REGIONS.join(', ')}) nor zone`);
        if (!mine.includes(r)) throw new ProviderError(this.id, `region ${r} is outside this provider's zones (${this.api.zones.join(', ')})`);
        return r;
    }

    /** An endpoint instance's size: an offer of listEndpointOffers, or its id; the smallest when none is named. */
    private containerSize(offer: Offer<ScalewayContainerSize> | string | undefined): ScalewayContainerSize {
        if (offer === undefined) return CONTAINER_SIZES[0];
        if (typeof offer !== 'string' && offer.provider !== this.id) throw new ProviderError(this.id, `offer ${offer.id} is ${offer.provider}'s, not ${this.id}'s`);
        const size = parseContainerSizeId(typeof offer === 'string' ? offer : offer.id);
        if (!size) throw new ProviderError(this.id, `bad container size "${typeof offer === 'string' ? offer : offer.id}": an offer of listEndpointOffers, e.g. ${containerSizeId(CONTAINER_SIZES[4])}`);
        return size;
    }

    /** The container `ref` names (`fr-par/<uuid>`, or a bare id asked of each region); null when there is none. */
    private async findContainer(ref: string): Promise<ScalewayContainer | null> {
        const r = parseRegionalId(ref);
        if (!r) return null;
        for (const region of r.region ? [r.region] : this.regions()) {
            const c = await this.api.getContainer(region, r.id);
            if (c) return c;
        }
        return null;
    }

    /** What `read` reads once it is not on its way somewhere (creating, updating...): it, ready; anything else is thrown, with Scaleway's message. */
    private async settled<T extends { status: string, error_message: string | null }>(what: string, read: () => Promise<T | null>, o: WaitOptions): Promise<T> {
        const x = await this.poll(read, (v) => !v || !CONTAINER_TRANSIENT.has(v.status), { ...o, what, describe: (v) => String(v?.status) });
        if (!x) throw new NotFoundError(this.id, `${what} disappeared while it was made`);
        if (x.status !== 'ready') throw new ProviderError(this.id, `${what} is ${x.status}${x.error_message ? `: ${x.error_message}` : ''}`);
        return x;
    }

    /**
     * The zone a create goes to: the caller's (a zone, or a REGION_TYPES member),
     * else the image's, else a mounted volume's (by its zoned id), else the
     * offer's first with stock; one of this provider's zones, and the image's
     * and every zoned volume's.
     */
    private zoneFor(o: CreateServerOptions<ScalewayTypes>, region: string | undefined, imageZone: ScalewayZone | undefined, mounts: ResolvedMount[]): ScalewayZone {
        const volumeZones = mounts.map((m) => ({ id: m.id, zone: parseZonedId(m.id)?.zone })).filter((v): v is { id: string, zone: ScalewayZone } => !!v.zone);
        const zone = this.zoneOf((o.region !== undefined ? region : undefined) ?? imageZone ?? volumeZones[0]?.zone ?? region);
        if (imageZone && imageZone !== zone) {
            throw new ProviderError(this.id, `image ${o.image} is in ${imageZone}, not ${zone}: a Scaleway image boots in its own zone only`);
        }
        const away = volumeZones.find((v) => v.zone !== zone);
        if (away) throw new ProviderError(this.id, `volume ${away.id} is in ${away.zone}, not ${zone}: a Block Storage volume is attached in its own zone only`);
        return zone;
    }

    /** `zone` as one of this provider's zones, or why it is not one. */
    private zoneOf(zone: string | undefined): ScalewayZone {
        if (!zone) throw new ProviderError(this.id, 'a Scaleway server needs a zone (one of the offer\'s regions)');
        if (!isScalewayZone(zone)) throw new ProviderError(this.id, `unknown Scaleway zone "${zone}" (zones: ${this.api.zones.join(', ')})`);
        if (!this.api.zones.includes(zone)) {
            throw new ProviderError(this.id, `zone ${zone} is not one of this provider's zones (${this.api.zones.join(', ')}): a server there would not be listed`);
        }
        return zone;
    }

    /**
     * The volumes a create attaches, each read now in the server's zone: it must
     * be there and `available` (attached to no server), and a mount takes no
     * path (Scaleway attaches a disk; the server mounts it). Keyed after the
     * image's own volumes ('1'..'n' are an account image's extra volumes), and
     * named in the server's MOUNT_TAG tags, so its deletion and its images leave them.
     */
    private async attachable(zone: ScalewayZone, mounts: ResolvedMount[], imageId: string | undefined): Promise<{ volumes: Record<string, ScalewayVolumeTemplate>, tags: string[] }> {
        if (!mounts.length) return { volumes: {}, tags: [] };
        const ids: string[] = [];
        for (const m of mounts) {
            if (m.path !== undefined) throw new NotSupportedError(this.id, 'a mount path (Scaleway attaches a volume as a disk: the server formats and mounts it)');
            const ref = parseZonedId(m.id);
            if (!ref) throw new ProviderError(this.id, `"${m.id}" is not a volume id (a UUID, or fr-par-2/<uuid>)`);
            const v = await this.api.getBlockVolume(zone, ref.id);
            if (!v) throw new NotFoundError(this.id, `no volume ${ref.id} in ${zone}`);
            if (v.status !== 'available') throw new ProviderError(this.id, `volume ${zonedId(zone, v.id)} is ${v.status}: a volume attached to a server is attached to no other`);
            ids.push(v.id);
        }
        const extra = imageId ? Object.keys((await this.api.getImage(zone, imageId))?.extra_volumes ?? {}).length : 0;
        return {
            volumes: Object.fromEntries(ids.map((id, i) => [String(extra + 1 + i), { id, volume_type: 'sbs_volume' } satisfies ScalewayVolumeTemplate])),
            tags: ids.map((id) => `${MOUNT_TAG}${id}`),
        };
    }

    /** The volume an id names, in the server's zone: a zoned id of another zone, or one the zone does not have, is refused. */
    private async volumeOf(s: ScalewayServer, volumeId: string): Promise<ScalewayBlockVolume> {
        const ref = parseZonedId(volumeId);
        if (!ref) throw new ProviderError(this.id, `"${volumeId}" is not a volume id (a UUID, or fr-par-2/<uuid>)`);
        if (ref.zone && ref.zone !== s.zone) throw new ProviderError(this.id, `volume ${volumeId} is in ${ref.zone}, not ${s.zone}: a Block Storage volume is attached in its own zone only`);
        const v = await this.api.getBlockVolume(s.zone, ref.id);
        if (!v) throw new NotFoundError(this.id, `no volume ${ref.id} in ${s.zone}`);
        return v;
    }

    /** Reads the volume until it is `status` (an attach or a detach settles in seconds). */
    private async volumeStatus(zone: ScalewayZone, id: string, status: ScalewayBlockVolume['status'], o: WaitOptions): Promise<void> {
        const v = await this.poll(() => this.api.getBlockVolume(zone, id), (x) => !x || x.status === status, {
            timeoutMs: o.timeoutMs ?? 5 * 60_000, intervalMs: o.intervalMs ?? 2000, what: `volume ${zonedId(zone, id)} to be ${status}`, describe: (x) => String(x?.status),
        });
        if (!v) throw new NotFoundError(this.id, `volume ${zonedId(zone, id)} disappeared`);
    }

    /** A Block Storage volume by `fr-par-2/<uuid>`, or by a bare id asked of every zone. */
    private async findVolume(id: string): Promise<ScalewayBlockVolume | null> {
        const r = parseZonedId(id);
        if (!r) return null;
        if (r.zone) return this.api.getBlockVolume(r.zone, r.id);
        return (await this.api.forZones((z) => this.api.getBlockVolume(z, r.id))).find((v) => v !== null) ?? null;
    }

    /** The type's record: the offer's own, or the zone's table. A type the zone does not offer is a place with no stock for it. */
    private async typeOf(zone: ScalewayZone, name: string, offer?: Offer<ScalewayOfferRaw>): Promise<ScalewayServerType> {
        const own = (offer?.raw as Partial<ScalewayOfferRaw> | undefined)?.serverType;
        const type = own ?? (await this.api.serverTypes(zone))[name];
        if (!type) throw new CapacityError(this.id, `${name} is not offered in ${zone}`);
        return type;
    }

    /** The zone's types for display (a server's GPU and price): none when the catalog cannot be read, so a server stays readable. */
    private catalog(zone: ScalewayZone): Promise<Record<string, ScalewayServerType>> {
        return this.api.serverTypes(zone).catch((): Record<string, ScalewayServerType> => ({}));
    }

    /** Reads the server until `done` accepts it, or it is gone (null), for up to ten minutes: what a stop waits on. */
    private waitFor(s: ScalewayServer, what: string, done: (x: ScalewayServer) => boolean): Promise<ScalewayServer | null> {
        return this.poll(() => this.api.getServer(s.zone, s.id), (x) => !x || done(x),
            { timeoutMs: 10 * 60_000, intervalMs: 5000, what: `server ${zonedId(s.zone, s.id)} ${what}`, describe: (x) => String(x?.state) });
    }

    private async need(id: string): Promise<ScalewayServer> {
        const s = await this.api.findServer(id);
        if (!s) throw new NotFoundError(this.id, `no server ${id}`);
        return s;
    }

    /** An image by `fr-par-2/<uuid>`, or by a bare id asked of every zone. */
    private async findImage(id: string): Promise<ScalewayImage | null> {
        const r = parseZonedId(id);
        if (!r) return null;
        if (r.zone) return this.api.getImage(r.zone, r.id);
        return (await this.api.forZones((z) => this.api.getImage(z, r.id))).find((i) => i !== null) ?? null;
    }
}
