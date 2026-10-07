// DigitalOcean Droplets over API v2 (https://docs.digitalocean.com/reference/api/,
// spec DigitalOcean-public.v2.yaml checked 2026-09-29): a VPS and a GPU Droplet
// are both droplets, of a plain size or a GPU size (one with `gpu_info`). A
// size's `regions` list where it can be created right now, and GPU stock comes
// and goes within the hour. The plain droplet list holds only droplets WITHOUT
// GPUs: GPU droplets are listed with `?type=gpus`. A droplet action (power,
// snapshot) locks the droplet until it completes, so every action here waits
// for it. A powered-off droplet bills in full. Images are droplet snapshots:
// region-bound (a transfer adds a region, at no extra charge), stored at
// $0.06/GB-month, bootable on any size whose disk holds them; a GPU size's
// scratch disk is not part of them. Volumes are Block Storage: in one region,
// attached to one droplet at a time, mounted at /mnt/<name> (dashes as underscores) once formatted
// (createVolume formats them), and kept when the droplet is deleted.

import type { CapabilityDescriptor, ProviderCapabilities } from '../../capabilities';
import { ComputeProvider } from '../../Core/ComputeProvider';
import { filterOffers, findSSHKey, pickSSHKeys, pollUntil, sshKeyFingerprint, timeLeft } from '../../Core/utils';
import { CapacityError, falseIfNotFound, NotFoundError, NotSupportedError, nullIfNotFound, ProviderError, QuotaError } from '../../errors';
import type {
    CreateServerOptions, CreateVolumeOptions, ImportImageOptions, InitializedSSHKeyData, Offer, OfferQuery, ProviderParams, Server, ServerImage, ServerListOptions, Volume,
    WaitOptions,
} from '../../types';
import { DigitalOceanApi, sshKeyRef } from './api';
import {
    DIGITALOCEAN_BILLING, DIGITALOCEAN_ENUMS, DIGITALOCEAN_ID, DIGITALOCEAN_REFUSED, FS_TAG, nfsMountScript, nfsTag, toImage, toNfsVolume, toOffer, toServer, toVolume,
    volumeMountScript,
} from './mappers';
import type {
    DigitalOceanAction, DigitalOceanCreateNfsParams, DigitalOceanDropletData, DigitalOceanImageData, DigitalOceanNfsShare, DigitalOceanSizeData, DigitalOceanTypes,
    DigitalOceanVolumeData, DigitalOceanVpc,
} from './types';

/** What DigitalOcean can do, and how: every capability asap-vps has. */
export const DIGITALOCEAN_CAPABILITIES = {
    compute: { kind: 'vm', gpu: true, cpu: true, userData: true, liveAvailability: true },
    // A powered-off droplet still bills in full.
    power: { stoppedBilling: 'full' },
    restart: {},
    sshKeys: { appliedAtBoot: false },
    // Snapshots boot in the regions they are in; a transfer adds one.
    images: { scope: 'region' },
    imageCopy: {},
    // A custom image from a file at a URL (docs.digitalocean.com/products/custom-images/details/limits, 2026-07-13).
    imageImport: { formats: ['raw', 'qcow2', 'vhdx', 'vdi', 'vmdk'], compressions: ['gzip', 'bzip2'], maxGb: 100 },
    // Block Storage: one droplet at a time, mounted at /mnt/<name> (dashes as underscores). Network File Storage (shared):
    // NFS shares many droplets of its VPC mount at a path of their own (nyc2, ams3, atl1, ric1, mkc1, mem1).
    volumes: { block: { mount: 'auto', size: 'fixed', minGb: 1, maxGb: 16384 }, shared: { mount: 'path', size: 'fixed', minGb: 50, maxGb: 32768 } },
    // A volume is attached to, and detached from, a droplet that runs, by a volume action.
    volumeAttach: {},
} as const satisfies CapabilityDescriptor;

type Caps = typeof DIGITALOCEAN_CAPABILITIES;

export class DigitalOcean extends ComputeProvider<DigitalOceanTypes, DigitalOceanApi> implements ProviderCapabilities<DigitalOceanTypes, Caps> {
    static readonly capabilities: Caps = DIGITALOCEAN_CAPABILITIES;
    readonly id = DIGITALOCEAN_ID;
    readonly capabilities: Caps = DIGITALOCEAN_CAPABILITIES;
    protected readonly enums = DIGITALOCEAN_ENUMS;

    /** DigitalOcean's AI/ML-ready image with the NVIDIA driver and CUDA, for single-GPU sizes. */
    static readonly NVIDIA_IMAGE = 'gpu-h100x1-base';
    /** Its 8-GPU counterpart (Fabric Manager, NVLink), for every x8 NVIDIA size. */
    static readonly NVIDIA_8GPU_IMAGE = 'gpu-h100x8-base';
    /** The AMD counterpart, with ROCm. */
    static readonly AMD_IMAGE = 'gpu-amd-base';
    /** What a size without GPUs boots by default: Ubuntu 24.04. */
    static readonly CPU_IMAGE = 'ubuntu-24-04-x64';
    /** How a droplet is billed, GPU or not: per second, at least 60 s or $0.01, powered off or not. */
    static readonly BILLING = DIGITALOCEAN_BILLING;
    /**
     * How long a key added lately may be unknown to DigitalOcean (its key list, its
     * duplicate check and its droplet create lag the write: ~45 s seen live
     * 2026-10-05): how long a key this provider registered is taken as the
     * account's though the list does not show it yet, and how long createServer
     * asks again when the create refuses a key it was given as unknown.
     */
    static readonly KEY_LAG_MS = 120_000;

    /**
     * The keys this provider registered lately, by fingerprint. For seconds
     * after a key is added, DigitalOcean's key list does not show it and its
     * own duplicate check lets the same key in again (seen live 2026-10-05: 201
     * twice, two registrations): so the same key added again by this provider
     * meanwhile returns the registration it made. Another process has no such
     * memory: during that window it may register the key a second time.
     */
    private readonly recentKeys = new Map<string, { key: InitializedSSHKeyData, at: number }>();

    constructor(params: ProviderParams | string) {
        super(new DigitalOceanApi(params));
    }

    /** Every size, with its GPUs where it has them (`kind: 'gpu'` for those only, `'cpu'` for plain droplets). */
    public async listOffers(query: OfferQuery = {}): Promise<Offer<DigitalOceanSizeData>[]> {
        return filterOffers((await this.api.all<DigitalOceanSizeData>('/v2/sizes', 'sizes')).map(toOffer), query);
    }

    /**
     * A droplet of the offer's size in its region. `image` defaults to
     * DigitalOcean's GPU image for a GPU size's vendor and GPU count, and to
     * Ubuntu 24.04 for any other size. `sshKeyIds` names keys of the account: an
     * id or DigitalOcean's (MD5) fingerprint goes to DigitalOcean as it is,
     * which refuses one the account does not hold; a name, a public key or a
     * SHA256 fingerprint is looked up first, and one the account does not hold
     * is refused before anything is created. `mounts` attaches volumes of the
     * droplet's region that no droplet holds now (each read first: one elsewhere
     * or attached is refused); each is mounted at its mountPath.
     */
    public async createServer(o: CreateServerOptions<DigitalOceanTypes>): Promise<Server<DigitalOceanDropletData>> {
        this.rejectOptions(o, DIGITALOCEAN_REFUSED);
        const { id: size, offer, region } = this.resolveOffer(o);
        this.checkFixedGpuCount(o, offer ? offer.gpuCount : DigitalOcean.gpuCountOf(size) ?? (size.startsWith('gpu-') ? undefined : 0));
        if (!region) throw new ProviderError(this.id, 'a droplet needs a region (one of the offer\'s regions)');
        const image = this.imageName(o.image) ?? DigitalOcean.defaultImage(size, offer);
        const attached = await this.attachable(o, region);
        const volumes = attached.blocks.map((v) => v.id);
        const vpc = this.shareVpc(attached.shares.map((m) => m.share), o.providerOptions?.vpc_uuid);
        const tags = [...(o.tags ?? []), ...attached.shares.map((m) => nfsTag(m.share.id, m.path))];
        const own = [volumeMountScript(attached.blocks), nfsMountScript(attached.shares)].filter((x): x is string => !!x);
        const userData = this.userDataWith(o, (offer?.gpuCount ?? DigitalOcean.gpuCountOf(size) ?? (size.startsWith('gpu-') ? 1 : 0)) > 0, own);
        const keys = o.sshKeyIds?.length ? await this.keyRefs(o.sshKeyIds) : [];
        const body = {
            name: o.name,
            region,
            size,
            image: /^\d+$/.test(image) ? Number(image) : image,
            ...(keys.length ? { ssh_keys: keys } : {}),
            ...(userData ? { user_data: userData } : {}),
            ...(tags.length ? { tags } : {}),
            ...(volumes.length ? { volumes } : {}),
            ...(vpc ? { vpc_uuid: vpc } : {}),
            ...o.providerOptions,
        };
        // A key added moments ago may be unknown to the droplet create too: it refuses the droplet (422 "... are invalid
        // key identifiers", nothing made), so the same create is asked again while DigitalOcean catches up, for up to
        // KEY_LAG_MS. Any other refusal (no stock, the droplet limit) is thrown at once.
        for (let waited = 0; ;) {
            try {
                const { droplet } = await this.api.call<{ droplet: DigitalOceanDropletData }>('POST', '/v2/droplets', body);
                return toServer(droplet);
            } catch (e) {
                const keyNotKnownYet = keys.length > 0 && e instanceof ProviderError && !(e instanceof CapacityError) && !(e instanceof QuotaError)
                    && e.status === 422 && /invalid key identifiers/i.test(e.message);
                if (!keyNotKnownYet || waited >= DigitalOcean.KEY_LAG_MS) throw e;
                const pause = Math.min(10_000, DigitalOcean.KEY_LAG_MS - waited);
                await this.sleep(pause);
                waited += pause;
            }
        }
    }

    public async getServer(id: string): Promise<Server<DigitalOceanDropletData> | null> {
        const droplet = await this.api.getDroplet(id);
        return droplet ? toServer(droplet) : null;
    }

    /**
     * The account's droplets, every one of them: pick yours by name.
     * DigitalOcean lists GPU droplets only with `?type=gpus` (its plain list
     * is the others), so `kind` decides which lists are read.
     */
    public async listServers(options: ServerListOptions = {}): Promise<Server<DigitalOceanDropletData>[]> {
        const kind = options.kind ?? 'any';
        const gpus = kind === 'cpu' ? [] : await this.api.all<DigitalOceanDropletData>('/v2/droplets?type=gpus', 'droplets');
        const plain = kind === 'gpu' ? [] : await this.api.all<DigitalOceanDropletData>('/v2/droplets', 'droplets');
        const seen = new Set<number>();
        return [...gpus, ...plain].filter((d) => !seen.has(d.id) && !!seen.add(d.id)).map(toServer);
    }

    /** Idempotent: a droplet that is already gone is deleted. */
    public async deleteServer(id: string): Promise<void> {
        await this.api.deleteDroplet(id);
    }

    /** The GPU count a GPU size slug names ('gpu-h100x8-640gb': 8), or undefined. */
    static gpuCountOf(sizeSlug: string): number | undefined {
        const m = /^gpu-[a-z0-9]+?x(\d+)-/.exec(sizeSlug);
        return m ? Number(m[1]) : undefined;
    }

    /** DigitalOcean's recommended image: AMD (ROCm), 8-GPU NVIDIA, single-GPU NVIDIA, or plain Ubuntu for a size without GPUs. */
    static defaultImage(sizeSlug: string, offer?: Offer<unknown>): string {
        if (offer ? offer.gpuCount === 0 : !sizeSlug.startsWith('gpu-')) return DigitalOcean.CPU_IMAGE;
        if (/^gpu-mi\d/.test(sizeSlug)) return DigitalOcean.AMD_IMAGE;
        if (/^gpu-[a-z0-9]+x8-/.test(sizeSlug)) return DigitalOcean.NVIDIA_8GPU_IMAGE;
        return DigitalOcean.NVIDIA_IMAGE;
    }

    // ── power, restart ───────────────────────────────────────────────────

    /**
     * A clean shutdown (a consistent disk, e.g. before createImage), else a hard
     * power-off, as DigitalOcean recommends; waits until the droplet is off. A
     * shutdown that completes was issued, not obeyed ("this action guarantees
     * that the command is issued, not that it succeeds"): the droplet is read,
     * and powered off if it is still on. A stopped droplet still bills in full.
     */
    public async stopServer(id: string): Promise<void> {
        const s = await this.getServer(id);
        if (!s) throw new NotFoundError(this.id, `no droplet ${id}`);
        if (s.status === 'stopped') return;
        try {
            await this.action(id, 'shutdown', { timeoutMs: 3 * 60_000 });
            const after = await this.api.getDroplet(id);
            if (!after) throw new NotFoundError(this.id, `droplet ${id} is gone`);
            if (after.status === 'off') return;
        } catch (e) {
            if (e instanceof NotFoundError) throw e;
        }
        await this.action(id, 'power_off');
    }

    public async startServer(id: string): Promise<void> {
        await this.action(id, 'power_on');
    }

    public async restartServer(id: string): Promise<void> {
        await this.action(id, 'reboot');
    }

    // ── SSH keys ─────────────────────────────────────────────────────────

    public async listSSHKeys(): Promise<InitializedSSHKeyData[]> {
        return this.api.listSSHKeys();
    }

    /**
     * The account's registration of this key, or a new one. A key this provider
     * registered in the last KEY_LAG_MS is its registration even when the
     * account's list does not show it yet (recentKeys): idempotent within one
     * provider, best-effort across processes for those seconds.
     */
    public async addSSHKey(publicKey: string, keyName: string): Promise<InitializedSSHKeyData> {
        const listed = findSSHKey(await this.listSSHKeys(), publicKey);
        if (listed) return listed;
        const fingerprint = sshKeyFingerprint(publicKey);
        const recent = this.recentKeys.get(fingerprint);
        if (recent && Date.now() - recent.at < DigitalOcean.KEY_LAG_MS) return recent.key;
        const key = await this.api.registerSSHKey(publicKey.trim(), keyName);
        this.recentKeys.set(fingerprint, { key, at: Date.now() });
        return key;
    }

    public async deleteSSHKey(id: string | number): Promise<boolean> {
        for (const [fingerprint, r] of this.recentKeys) if (String(r.key.id) === String(id)) this.recentKeys.delete(fingerprint);
        return this.api.deleteSSHKey(id);
    }

    // ── images ───────────────────────────────────────────────────────────

    /** Every private image of the account: snapshots, backups and custom images alike. */
    public async listImages(): Promise<ServerImage<DigitalOceanImageData>[]> {
        return (await this.api.all<DigitalOceanImageData>('/v2/images?private=true', 'images')).filter((i) => i.status !== 'deleted').map(toImage);
    }

    /** A deleted image (DigitalOcean still answers for a custom one, as 'deleted') is null: it is gone. */
    public async getImage(id: string): Promise<ServerImage<DigitalOceanImageData> | null> {
        const found = await nullIfNotFound(this.api.call<{ image: DigitalOceanImageData }>('GET', `/v2/images/${encodeURIComponent(id)}`));
        return found && found.image.status !== 'deleted' ? toImage(found.image) : null;
    }

    /**
     * A custom image from the file at `url` (raw, qcow2, vhdx, vdi or vmdk, gzip
     * or bzip2 too; under 100 GB uncompressed), fetched by DigitalOcean: the host
     * must answer HEAD, and the URL end in the file's extension. It boots in
     * `region` (copyImage adds more) where it has cloud-init 0.7.7 or later
     * (ConfigDrive before NoCloud), ext3 or ext4, sshd and BIOS boot; a droplet
     * made from it needs an SSH key, and has no IPv6. DigitalOcean ends an import
     * it cannot read 'deleted', with its message: thrown here.
     */
    public async importImage(o: ImportImageOptions<DigitalOceanTypes>): Promise<ServerImage<DigitalOceanImageData>> {
        if (!/^(https?|ftp):\/\/[^/]+\/./i.test(o.url)) throw new ProviderError(this.id, `an image is imported from an http(s) or ftp URL of a file, not "${o.url}"`);
        const { image } = await this.api.call<{ image: DigitalOceanImageData }>('POST', '/v2/images', {
            name: o.name, url: o.url, region: this.regionName(o.region), ...o.providerOptions,
        });
        const read = async () => (await this.api.call<{ image: DigitalOceanImageData }>('GET', `/v2/images/${image.id}`)).image;
        let done: DigitalOceanImageData;
        try {
            done = await this.poll(read, (i) => i.status === 'available' || i.status === 'deleted',
                { timeoutMs: 60 * 60_000, intervalMs: 15_000, ...o, what: `import of ${o.name}`, describe: (i) => i.status ?? '?' });
        } catch (e) {
            // Still importing when the wait ran out: deleted, so it is not left to bill.
            await this.deleteImage(String(image.id)).catch(() => undefined);
            throw new ProviderError(this.id, `import of ${o.name} from ${o.url}: ${(e as Error).message} (the import was deleted)`, { cause: e });
        }
        if (done.status !== 'available') throw new ProviderError(this.id, `import of ${o.name} from ${o.url} failed: ${done.error_message || done.status}`);
        return toImage(done);
    }

    /**
     * A droplet snapshot. DigitalOcean snapshots a running droplet too; power it
     * off first (stopServer) for a consistent disk. Resolves once the snapshot is
     * listed, in the droplet's region only.
     */
    public async createImage(serverId: string, o: { name: string } & WaitOptions): Promise<ServerImage<DigitalOceanImageData>> {
        const path = `/v2/droplets/${encodeURIComponent(serverId)}`;
        await this.act(`${path}/actions`, { type: 'snapshot', name: o.name }, { timeoutMs: 30 * 60_000, ...o });
        // The action names no image: the droplet's newest snapshot of that name is it.
        const snaps = (await this.api.all<DigitalOceanImageData>(`${path}/snapshots`, 'snapshots'))
            .filter((s) => s.name === o.name)
            .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
        if (!snaps.length) throw new ProviderError(this.id, `snapshot "${o.name}" of droplet ${serverId} completed but is not listed`);
        return toImage(snaps[0]);
    }

    /** One deleted already is no error: DigitalOcean answers that delete with a 422 ("already deleted", seen live), not a 404. */
    public async deleteImage(id: string): Promise<void> {
        await falseIfNotFound(this.api.call('DELETE', `/v2/images/${encodeURIComponent(id)}`).catch((e) => {
            if (e instanceof ProviderError && e.status === 422 && /already deleted/i.test(e.message)) return;
            throw e;
        }));
    }

    /** One transfer per missing region, side by side (DigitalOcean charges nothing extra for more regions). */
    public async copyImage(id: string, regions: string[], o: WaitOptions = {}): Promise<ServerImage<DigitalOceanImageData>> {
        const image = await this.getImage(id);
        if (!image) throw new NotFoundError(this.id, `no image ${id}`);
        const missing = [...new Set(regions)].filter((r) => !image.regions.includes(r));
        const started = await Promise.all(missing.map((region) =>
            this.api.call<{ action: DigitalOceanAction }>('POST', `/v2/images/${encodeURIComponent(id)}/actions`, { type: 'transfer', region })));
        await Promise.all(started.map(({ action }) => this.waitForAction(action.id, o)));
        const after = await this.getImage(id);
        if (!after) throw new NotFoundError(this.id, `image ${id} disappeared while it was copied`);
        return after;
    }

    // ── volumes ──────────────────────────────────────────────────────────

    /** The account's Block Storage volumes and Network File Storage shares (`shared`), in every region. */
    public async listVolumes(): Promise<Volume<DigitalOceanVolumeData | DigitalOceanNfsShare>[]> {
        const [blocks, shares] = await Promise.all([this.api.all<DigitalOceanVolumeData>('/v2/volumes', 'volumes'), this.shares()]);
        return [...blocks.map(toVolume), ...shares.map(toNfsVolume)];
    }

    /** A Block Storage volume or an NFS share, by its id. */
    public async getVolume(id: string): Promise<Volume<DigitalOceanVolumeData | DigitalOceanNfsShare> | null> {
        const v = await this.api.getVolume(id);
        if (v) return toVolume(v);
        const share = await this.findShare(id);
        return share ? toNfsVolume(share) : null;
    }

    /**
     * A Block Storage volume of `sizeGb` GiB in `region`, formatted ext4 (so a
     * droplet it is attached to mounts it at its mountPath, /mnt/<name> with dashes
     * as underscores). Its name is lowercase
     * letters, digits and dashes, starting with a letter (at most 64). It bills
     * until deleteVolume, attached or not.
     */
    public async createVolume(o: CreateVolumeOptions<DigitalOceanTypes> & { shared: true }): Promise<Volume<DigitalOceanNfsShare>>;
    public async createVolume(o: CreateVolumeOptions<DigitalOceanTypes> & { shared?: false }): Promise<Volume<DigitalOceanVolumeData>>;
    public async createVolume(o: CreateVolumeOptions<DigitalOceanTypes>): Promise<Volume<DigitalOceanVolumeData | DigitalOceanNfsShare>>;
    public async createVolume(o: CreateVolumeOptions<DigitalOceanTypes>): Promise<Volume<DigitalOceanVolumeData | DigitalOceanNfsShare>> {
        if (!/^[a-z][a-z0-9-]{0,63}$/.test(o.name)) throw new ProviderError(this.id, `volume name "${o.name}": lowercase letters, digits and dashes, starting with a letter (at most 64)`);
        if (o.shared) return this.createShare(o);
        const size = Math.ceil(o.sizeGb);
        if (!(size >= 1 && size <= 16384)) throw new ProviderError(this.id, `a volume is 1-16384 GiB, not ${o.sizeGb}`);
        // Tagged with its filesystem: DigitalOcean says it only in this answer, never in a read.
        const filesystem = o.providerOptions?.filesystem_type ?? 'ext4';
        const tags = [...(o.providerOptions?.tags ?? []), ...(filesystem ? [`${FS_TAG}${filesystem}`] : [])];
        const { volume } = await this.api.call<{ volume: DigitalOceanVolumeData }>('POST', '/v2/volumes', {
            name: o.name, size_gigabytes: size, region: this.regionName(o.region), filesystem_type: 'ext4', ...o.providerOptions, tags,
        });
        return toVolume(volume);
    }

    /** A Block Storage volume one droplet holds is refused: detach it, or delete the droplet (that detaches it). An NFS share is waited for until gone. */
    public async deleteVolume(id: string, o: WaitOptions = {}): Promise<void> {
        if (await falseIfNotFound(this.api.call('DELETE', `/v2/volumes/${encodeURIComponent(id)}`))) return;
        const share = await this.findShare(id);
        if (share) await this.deleteShare(share, o);
    }

    /**
     * The `attach` volume action, waited for. A droplet that was created
     * without it does not mount it by itself: mount /dev/disk/by-id/scsi-0DO_Volume_<name>
     * at its mountPath (DigitalOcean mounts a formatted volume by itself only at a create).
     */
    public async attachVolume(volumeId: string, serverId: string, o: WaitOptions = {}): Promise<void> {
        const read = await this.api.getVolume(volumeId);
        if (!read && await this.findShare(volumeId)) {
            throw new NotSupportedError(this.id, 'attaching a shared volume (an NFS share) to a droplet that runs: it is mounted over the network, by any droplet of its VPC (mount host:mount_path of its raw), or at a create (mounts)');
        }
        if (!read) throw new NotFoundError(this.id, `no volume ${volumeId}`);
        const v = await this.releasedByGone(read, o);
        if (v.droplet_ids?.includes(Number(serverId))) return;
        const droplet = await this.api.getDroplet(serverId);
        if (!droplet) throw new NotFoundError(this.id, `no droplet ${serverId}`);
        if (v.region?.slug !== droplet.region?.slug) throw new ProviderError(this.id, `volume ${v.name} is in ${v.region?.slug}: droplet ${serverId} in ${droplet.region?.slug} cannot attach it`);
        if (v.droplet_ids?.length) throw new ProviderError(this.id, `volume ${v.name} is attached to droplet ${v.droplet_ids.join(', ')}: a volume is attached to one droplet at a time`);
        await this.volumeAction(v, 'attach', serverId, o);
    }

    /** The `detach` volume action, waited for; a volume the droplet does not hold is left as it is. */
    public async detachVolume(volumeId: string, serverId: string, o: WaitOptions = {}): Promise<void> {
        const v = await this.api.getVolume(volumeId);
        if (!v || !v.droplet_ids?.includes(Number(serverId))) return;
        await this.volumeAction(v, 'detach', serverId, o);
    }

    /**
     * Deletes the droplet, verified gone, and waits until DigitalOcean has let
     * go of the volumes it held: they read as attached to it for a while after
     * it is gone (seen live 2026-10-06), and no droplet can take them till then.
     */
    public override async deleteServerAndWait(id: string, o: WaitOptions = {}): Promise<boolean> {
        const held = (await this.api.getDroplet(id).catch(() => null))?.volume_ids ?? [];
        const left = timeLeft(o);
        if (!(await super.deleteServerAndWait(id, left()))) return false;
        for (const volumeId of held) {
            const v = await this.api.getVolume(volumeId);
            if (v) await this.releasedByGone(v, left());
        }
        return true;
    }

    // ── helpers ──────────────────────────────────────────────────────────

    /**
     * `v` once the droplets it reads as attached to, all gone, have let go of
     * it (DigitalOcean releases a deleted droplet's volumes a while after it is
     * gone); as it is when it is free, or held by a droplet that exists.
     */
    private async releasedByGone(v: DigitalOceanVolumeData, o: WaitOptions = {}): Promise<DigitalOceanVolumeData> {
        const holders = v.droplet_ids ?? [];
        if (!holders.length) return v;
        const exist = await Promise.all(holders.map(async (d) => (await this.api.getDroplet(d)) !== null));
        if (exist.some(Boolean)) return v;
        const after = await this.poll(() => this.api.getVolume(v.id), (x) => !x || !x.droplet_ids?.some((d) => holders.includes(d)),
            { timeoutMs: 5 * 60_000, ...o, what: `volume ${v.name}`, describe: (x) => `attached to droplet ${x?.droplet_ids?.join(', ')}, which is gone` });
        if (!after) throw new NotFoundError(this.id, `no volume ${v.id}`);
        return after;
    }

    /**
     * The volumes a create mounts, each read now. A Block Storage volume must be
     * in the droplet's region and attached to no droplet, and is mounted at its
     * mountPath (a mount that asks for another path is refused). An NFS share
     * must be in the droplet's region and ACTIVE, and is mounted at the mount's
     * path (default its mountPath, /mnt/<name>).
     */
    private async attachable(o: CreateServerOptions<DigitalOceanTypes>, region: string): Promise<{ blocks: DigitalOceanVolumeData[], shares: Array<{ share: DigitalOceanNfsShare, path: string }> }> {
        const blocks: DigitalOceanVolumeData[] = [];
        const shares: Array<{ share: DigitalOceanNfsShare, path: string }> = [];
        for (const m of this.mountsOf(o.mounts)) {
            const read = m.volume?.shared ? null : await this.api.getVolume(m.id);
            if (read) {
                if (m.path !== undefined) throw new NotSupportedError(this.id, 'a mount path for a Block Storage volume (DigitalOcean mounts it at /mnt/<its name>, dashes as underscores: its mountPath)');
                const v = await this.releasedByGone(read);
                if (v.region?.slug !== region) throw new ProviderError(this.id, `volume ${v.name} is in ${v.region?.slug}: a droplet in ${region} cannot attach it`);
                if (v.droplet_ids?.length) throw new ProviderError(this.id, `volume ${v.name} is attached to droplet ${v.droplet_ids.join(', ')}: a volume is attached to one droplet at a time`);
                blocks.push(v);
                continue;
            }
            const share = await this.findShare(m.id);
            if (!share) throw new NotFoundError(this.id, `no volume ${m.id}`);
            if (share.region !== region) throw new ProviderError(this.id, `share ${share.name} is in ${share.region}: a droplet in ${region} cannot mount it`);
            if (share.status !== 'ACTIVE' || !share.host || !share.mount_path) throw new ProviderError(this.id, `share ${share.name} is ${share.status}: it is mounted once ACTIVE`);
            const path = m.path ?? toNfsVolume(share).mountPath!;
            if (!path.startsWith('/')) throw new ProviderError(this.id, `mount path "${path}" is not absolute`);
            shares.push({ share, path });
        }
        return { blocks, shares };
    }

    /**
     * The VPC a droplet that mounts these shares joins: one every share is
     * attached to (the one asked for, `vpc_uuid`, when it is one); none to
     * pick when it mounts no share.
     */
    private shareVpc(shares: DigitalOceanNfsShare[], asked: string | undefined): string | undefined {
        if (!shares.length) return undefined;
        const common = shares.map((s) => s.vpc_ids).reduce((a, b) => a.filter((x) => b.includes(x)));
        if (asked !== undefined && !common.includes(asked)) throw new ProviderError(this.id, `vpc_uuid ${asked} is not a VPC of every share the droplet mounts (${common.join(', ') || 'they share none'})`);
        if (!common.length) throw new ProviderError(this.id, `the shares ${shares.map((s) => s.name).join(', ')} have no VPC in common: a droplet is in one VPC`);
        return asked ?? common[0];
    }

    /** The account's NFS shares, in every region (a deleted one is gone). */
    private async shares(): Promise<DigitalOceanNfsShare[]> {
        return (await this.api.all<DigitalOceanNfsShare>('/v2/nfs', 'shares')).filter((s) => s.status !== 'DELETED');
    }

    private async findShare(id: string): Promise<DigitalOceanNfsShare | null> {
        return (await this.shares()).find((s) => s.id === id) ?? null;
    }

    /**
     * An NFS share of `sizeGb` (50-32768 GB, standard tier) in `region`'s
     * default VPC (or the VPCs providerOptions.vpc_ids names), once ACTIVE. One
     * that fails is deleted, and its failure thrown.
     */
    private async createShare(o: CreateVolumeOptions<DigitalOceanTypes> & { shared: true }): Promise<Volume<DigitalOceanNfsShare>> {
        const size = Math.ceil(o.sizeGb);
        if (!(size >= 50 && size <= 32768)) throw new ProviderError(this.id, `a shared volume (an NFS share) is 50-32768 GB, not ${o.sizeGb}`);
        const region = this.regionName(o.region);
        const asked = o.providerOptions?.vpc_ids;
        const vpc = asked?.length ? undefined : (await this.api.all<DigitalOceanVpc>('/v2/vpcs', 'vpcs')).find((v) => v.default && v.region === region);
        if (!asked?.length && !vpc) throw new ProviderError(this.id, `region ${region} has no default VPC yet (a droplet made there makes one): name a VPC in providerOptions.vpc_ids`);
        const body: DigitalOceanCreateNfsParams = { name: o.name, size_gib: size, region, vpc_ids: asked?.length ? asked : [vpc!.id], performance_tier: 'standard' };
        const { share } = await this.api.call<{ share: DigitalOceanNfsShare }>('POST', '/v2/nfs', { ...body, ...o.providerOptions });
        try {
            const ready = await this.poll(() => this.findShare(share.id), (x) => !x || x.status !== 'CREATING',
                { timeoutMs: o.timeoutMs ?? 10 * 60_000, intervalMs: o.intervalMs ?? 5000, what: `share ${o.name}`, describe: (x) => String(x?.status) });
            if (!ready) throw new NotFoundError(this.id, `share ${o.name} disappeared while it was made`);
            if (ready.status !== 'ACTIVE') throw new ProviderError(this.id, `share ${o.name} is ${ready.status}, not ACTIVE`);
            return toNfsVolume(ready);
        } catch (e) {
            await this.deleteShare(share).catch(() => undefined);
            throw e;
        }
    }

    /** Deletes a share, and waits until it is gone. */
    private async deleteShare(s: DigitalOceanNfsShare, o: WaitOptions = {}): Promise<void> {
        await falseIfNotFound(this.api.call('DELETE', `/v2/nfs/${encodeURIComponent(s.id)}?region=${encodeURIComponent(s.region)}`));
        await this.poll(() => this.findShare(s.id), (x) => !x,
            { timeoutMs: o.timeoutMs ?? 5 * 60_000, intervalMs: o.intervalMs ?? 3000, what: `delete of share ${s.name}`, describe: (x) => String(x?.status) });
    }

    /**
     * The keys `refs` name, as a droplet create takes them. An id or an MD5
     * fingerprint is what DigitalOcean takes itself: sent as it is, unread, as
     * the account's key list lags its writes by seconds (checked live
     * 2026-10-05: a key added just before a create was not listed yet). Any
     * other reference is looked up in that list.
     */
    private async keyRefs(refs: Array<string | number>): Promise<Array<string | number>> {
        const own = (r: string | number) => typeof r === 'number' || /^\d+$/.test(r) || /^([0-9a-f]{2}:){15}[0-9a-f]{2}$/i.test(r);
        const named = refs.filter((r) => !own(r));
        const listed = named.length ? pickSSHKeys(await this.listSSHKeys(), named, this.id) : [];
        return refs.map((r) => (own(r) ? sshKeyRef(r) : listed[named.indexOf(r)].id));
    }

    /** A volume action on a droplet, waited for (actions of a volume are actions like a droplet's). */
    private async volumeAction(v: DigitalOceanVolumeData, type: 'attach' | 'detach', serverId: string, o: WaitOptions): Promise<void> {
        await this.act(`/v2/volumes/${encodeURIComponent(v.id)}/actions`, { type, droplet_id: Number(serverId), region: v.region.slug }, { timeoutMs: 10 * 60_000, ...o });
    }

    /** A droplet action, waited for: the droplet takes no other action until it completes. */
    private async action(id: string, type: string, o: WaitOptions = {}): Promise<void> {
        await this.act(`/v2/droplets/${encodeURIComponent(id)}/actions`, { type }, { timeoutMs: 10 * 60_000, ...o });
    }

    /**
     * Asks for an action on a droplet (its own, or a volume's on it) and waits
     * until it is done, all within `o.timeoutMs`. A droplet takes one action at
     * a time: while one is in progress (its create too, until it is active)
     * DigitalOcean refuses another with a 422 "Droplet already has a pending
     * event", and starts nothing, so it is asked again until the wait ends.
     */
    private async act(path: string, body: object, o: WaitOptions & { timeoutMs: number }): Promise<void> {
        const left = timeLeft(o);
        const { action } = await pollUntil(() => this.api.call<{ action: DigitalOceanAction }>('POST', path, body), () => true, {
            timeoutMs: o.timeoutMs,
            intervalMs: o.intervalMs ?? 5000,
            sleep: this.sleep,
            retryOn: (e) => e instanceof ProviderError && e.status === 422 && /pending event/i.test(e.message),
            timeoutError: () => new ProviderError(this.id, `timed out after ${Math.round(o.timeoutMs / 1000)} s waiting for the droplet's pending event to end, to ask for ${JSON.stringify(body)}`, { code: 'timeout' }),
        });
        await this.waitForAction(action.id, left());
    }

    /** Poll an action until it completes; an errored action throws. */
    private async waitForAction(actionId: number, o: WaitOptions): Promise<void> {
        const action = await this.poll(
            async () => (await this.api.call<{ action: DigitalOceanAction }>('GET', `/v2/actions/${actionId}`)).action,
            (a) => a.status !== 'in-progress',
            { timeoutMs: 30 * 60_000, ...o, what: `action ${actionId}`, describe: (a) => `${a.type} ${a.status}` });
        if (action.status === 'errored') throw new ProviderError(this.id, `action ${actionId} (${action.type}) errored`);
    }
}
