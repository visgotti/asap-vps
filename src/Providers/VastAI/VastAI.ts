// Vast.ai over its REST API (https://console.vast.ai, spec
// docs.vast.ai/api-reference/openapi.yaml and the official CLI vast-ai/vast-cli,
// checked 2026-09-29 and 2026-10-06; the older openapi.json still lists network
// volumes, which Vast withdrew in July 2026). A marketplace: every offer is ONE machine (an "ask"), so renting it
// twice answers 410 no_such_ask. A search returns at most 64 offers, so this
// pages by price. An interruptible offer shares its machine's id and is rented
// with a bid price. An instance is a container on that machine: env is a JSON
// object (ports ride in it as "-p" keys), each port is mapped to a RANDOM public
// port, a stopped instance bills storage only, and starting it again waits for
// that machine's GPU. A volume is storage on one machine, rented from that
// machine's storage offer: its region is the machine (`machine:<id>`, which an
// offer's regions name too), and an instance rented on that machine mounts it.
// Vast keeps no images: a snapshot commits an instance's container and pushes it
// to a registry of yours (`snapshots`), whose tags are then the account's images.

import type { CapabilityDescriptor, ProviderCapabilities } from '../../capabilities';
import { ComputeProvider, ResolvedMount } from '../../Core/ComputeProvider';
import {
    compareCudaVersions, cudaVersion, deleteRegistryImage, filterOffers, findSSHKey, http, isKind, parseImageRef, parseSSHPublicKey, RegistryClient, registryOf, timeLeft,
} from '../../Core/utils';
import { CapacityError, falseIfNotFound, NotFoundError, NotSupportedError, nullIfNotFound, ProviderError } from '../../errors';
import type {
    CreateServerOptions, CreateVolumeOptions, InitializedSSHKeyData, LogOptions, Offer, OfferQuery, RegistryAuth, Server, ServerImage, ServerListOptions, Volume, WaitOptions,
} from '../../types';
import { VastApi } from './api';
import {
    hostCuda, IMAGE_TAG, machineOf, machineRegion, RELAUNCH_GRACE_MS, serverSideModels, SNAPSHOT_TAG, toImage, toOffer, toServer, toSSHKey, toVolume, VAST_BILLING, VAST_ID,
    VAST_MOUNT_PATH, VAST_REFUSED, VOLUME_NAME,
} from './mappers';
import type {
    VastAIParams, VastImage, VastInstance, VastOffer, VastSnapshotRepository, VastSSHKeyData, VastTypes, VastVolume, VastVolumeInfo, VastVolumeOffer,
} from './types';

/** What Vast can do, and how. */
export const VAST_CAPABILITIES = {
    // Instances boot registry images on the machine's driver; userData is a script run before the command at each start.
    compute: { kind: 'container', gpu: true, cpu: false, userData: true, liveAvailability: true },
    // A stopped instance bills only its disk.
    power: { stoppedBilling: 'storage' },
    restart: {},
    logs: {},
    sshKeys: { appliedAtBoot: false },
    // A snapshot of an instance's container, pushed to a registry of yours (`snapshots`): it boots on any machine.
    images: { scope: 'global' },
    // A volume of one machine, sized when made, that an instance on that machine mounts at a path (one at a time).
    volumes: { block: { mount: 'path', size: 'fixed', minGb: 1 } },
} as const satisfies CapabilityDescriptor;

type Caps = typeof VAST_CAPABILITIES;

export class VastAI extends ComputeProvider<VastTypes, VastApi> implements ProviderCapabilities<VastTypes, Caps> {
    static readonly capabilities: Caps = VAST_CAPABILITIES;
    readonly id = VAST_ID;
    readonly capabilities: Caps = VAST_CAPABILITIES;
    readonly minReliability: number;
    readonly verifiedOnly: boolean;
    readonly minCudaVersion?: number;
    readonly offerPages: number;
    /** Where createImage pushes snapshots: a repository of yours (VastAIParams.snapshots). */
    readonly snapshots?: VastSnapshotRepository;

    /** Vast's cap on one search, whatever `limit` asks for (observed 2026-09-29). */
    static readonly PAGE = 64;
    /** Rentals bill per second while they run; the disk bills while stopped too. */
    static readonly BILLING = VAST_BILLING;
    /** How long after a start or reboot a container still reported as it was left reads as pending. */
    static readonly RELAUNCH_GRACE_MS = RELAUNCH_GRACE_MS;
    /** When this provider last started or rebooted each instance. */
    private readonly relaunched = new Map<string, number>();

    constructor(params: VastAIParams | string) {
        super(new VastApi(params));
        const p = typeof params === 'object' ? params : {} as Partial<VastAIParams>;
        this.minReliability = p.minReliability ?? 0.95;
        this.verifiedOnly = p.verifiedOnly ?? true;
        this.minCudaVersion = p.minCudaVersion;
        this.offerPages = p.offerPages ?? 8;
        this.snapshots = p.snapshots;
    }

    /** Each offer is one machine; its only region is where that machine is. */
    public async listOffers(query: OfferQuery = {}): Promise<Offer<VastOffer>[]> {
        // Every ask is a GPU machine: a question about machines without them has no answer here.
        if (query.kind === 'cpu' || query.gpuCount === 0) return [];
        const offers = (await this.search('ondemand', query)).map((a) => toOffer(a, false));
        if (query.includeInterruptible) offers.push(...(await this.search('bid', query)).map((a) => toOffer(a, true)));
        return filterOffers(offers, query);
    }

    /**
     * Rents the offer's machine. The container runs `command` (the image's own
     * CMD when none) with `env`; each of `ports` is mapped to a random public
     * port (read it from the server's `ports`). An interruptible offer's id
     * carries its bid price, which is what is sent. With `minCudaVersion` the
     * machine's driver is read first, and one below it is not rented.
     * `registryAuth` goes with the rental (Vast keeps no logins): the machine
     * pulls `image` with it. `userData` is a shell script (Vast runs no
     * cloud-init) run each time the container starts, before `command`, which
     * it then becomes (`sh -c '<script>; exec "$@"' <command>`): the image
     * needs a `sh`, and `command` must be given, as the image's own is replaced.
     * `mounts`: one volume, of the offer's machine and mounted by no other
     * instance (refused before anything is rented), at the mount's path
     * (default /data).
     */
    public async createServer(o: CreateServerOptions<VastTypes>): Promise<Server<VastInstance>> {
        // Vast authorizes every account key on its ssh-runtype images; pass
        // providerOptions { runtype: 'ssh' } for that instead of sshKeyIds.
        this.rejectOptions(o, VAST_REFUSED);
        // The offer is one machine: its GPUs are fixed, and its place is where it is (no region to pick).
        const resolved = this.resolveOffer(o);
        this.checkFixedGpuCount(o, resolved.offer?.gpuCount);
        // The container: `container`, or the top-level image, env, command, ports and registryAuth.
        const c = this.containerOf(o);
        const image = this.imageName(c?.image);
        if (!c || !image) throw new ProviderError(this.id, 'an instance needs an image');
        if (c.registryAuth && o.providerOptions?.image_login !== undefined) throw new ProviderError(this.id, 'pass registryAuth or providerOptions.image_login, not both');
        // A snapshot is pulled with the login it was pushed with, unless the create gives one.
        const auth = c.registryAuth ?? (this.tagOf(image) !== undefined ? this.snapshots : undefined);
        const login = auth ? this.imageLogin(auth, image) : undefined;
        const args = this.argsWith(o.userData, c.command);
        const offer = /^(\d+)(?::bid:(\d+(?:\.\d+)?))?$/.exec(resolved.id);
        if (!offer) throw new ProviderError(this.id, `bad offer id "${resolved.id}"`);
        // Env is a JSON object (a docker-flags string is not applied); ports ride in it as "-p" keys.
        const env: Record<string, string> = {};
        for (const [k, v] of Object.entries(c.env ?? {})) env[k] = this.flagValue(v, k);
        for (const p of c.ports ?? []) {
            const m = /^(\d+)(?:\/(tcp|udp|http))?$/.exec(p);
            if (!m) throw new ProviderError(this.id, `bad port "${p}": use <port>/<tcp|udp|http>`);
            env[`-p ${m[1]}:${m[1]}${m[2] === 'udp' ? '/udp' : ''}`] = '1';
        }
        const bid = offer[2] !== undefined ? Number(offer[2]) : undefined;
        const [mount, ...more] = this.mountsOf(o.mounts);
        if (more.length) throw new NotSupportedError(this.id, 'createServer option "mounts" with more than one volume (an instance mounts one)');
        // The machine's ask, read where something needs it: its driver, or the machine a volume must be on.
        const ask = o.minCudaVersion !== undefined || (mount && resolved.offer?.raw.machine_id === undefined) ? await this.askOf(Number(offer[1]), bid !== undefined) : undefined;
        if (o.minCudaVersion !== undefined) this.checkCuda(ask!, cudaVersion(o.minCudaVersion));
        const volumeInfo = mount ? await this.volumeInfo(mount, resolved.offer?.raw.machine_id ?? ask!.machine_id, resolved.id) : undefined;
        const body = await this.api.call<{ new_contract: number }>('PUT', `/api/v0/asks/${offer[1]}/`, {
            image,
            label: o.name,
            runtype: 'args',
            ...args,
            ...(Object.keys(env).length ? { env } : {}),
            ...(o.diskGb ? { disk: Math.ceil(o.diskGb) } : {}),
            ...(bid !== undefined ? { price: bid } : {}),
            ...(login ? { image_login: login } : {}),
            ...(volumeInfo ? { volume_info: volumeInfo } : {}),
            cancel_unavail: true,
            ...o.providerOptions,
        }, false);
        if (!body?.new_contract) throw new ProviderError(this.id, 'the rental returned no instance id (new_contract)');
        const id = String(body.new_contract);
        // Not listed yet: what the rental said, as the instance it is.
        const rented: VastInstance = { id: body.new_contract, label: o.name, actual_status: 'created' };
        return (await this.getServer(id).catch(() => null)) ?? { ...toServer(rented), offerId: resolved.id };
    }

    /**
     * The instance, from the instance list filtered to it: the same record as
     * the single read, and the volumes it mounts, which only the list has
     * (observed 2026-10-06). One the list does not have yet is read alone.
     */
    public async getServer(id: string): Promise<Server<VastInstance> | null> {
        if (!/^\d+$/.test(id)) return null;
        const listed = await this.api.call<{ instances?: VastInstance[] }>('GET', `/api/v1/instances/?select_filters=${encodeURIComponent(JSON.stringify({ id: { eq: Number(id) } }))}`);
        const found = (listed?.instances ?? []).find((i) => String(i.id) === id);
        if (found) return this.toServer(found);
        const body = await nullIfNotFound(this.api.call<{ instances?: VastInstance | null }>('GET', `/api/v0/instances/${encodeURIComponent(id)}/`));
        return body?.instances?.id ? this.toServer(body.instances) : null;
    }

    /** The account's instances (every rental is a GPU machine). */
    public async listServers(options: ServerListOptions = {}): Promise<Server<VastInstance>[]> {
        const out: Server<VastInstance>[] = [];
        let token = '';
        // Keyset pages of at most 25.
        for (let page = 0; page < 400; page++) {
            const body = await this.api.call<{ instances?: VastInstance[], next_token?: string | null }>(
                'GET', `/api/v1/instances/?limit=25${token ? `&after_token=${encodeURIComponent(token)}` : ''}`);
            out.push(...(body.instances ?? []).filter((i) => isKind(i.num_gpus ?? 1, options.kind)).map((i) => this.toServer(i)));
            if (!body.next_token) return out;
            token = body.next_token;
        }
        throw new ProviderError(this.id, 'the instance list has more than 400 pages');
    }

    public async deleteServer(id: string): Promise<void> {
        await falseIfNotFound(this.api.call('DELETE', `/api/v0/instances/${encodeURIComponent(id)}/`));
    }

    // ── power, restart, logs ─────────────────────────────────────────────

    public async stopServer(id: string): Promise<void> {
        await this.api.call('PUT', `/api/v0/instances/${encodeURIComponent(id)}/`, { state: 'stopped' });
    }

    /**
     * Starts the container again on its machine. When that machine's GPU is
     * someone else's now, Vast queues the start ("Required resources are
     * currently unavailable, state change queued") and would start, and bill,
     * the instance whenever the GPU frees: that start is cancelled (the
     * instance stays stopped) and this throws CapacityError.
     */
    public async startServer(id: string): Promise<void> {
        const path = `/api/v0/instances/${encodeURIComponent(id)}/`;
        try {
            await this.api.call('PUT', path, { state: 'running' });
        } catch (e) {
            if (!(e instanceof ProviderError) || !/currently unavailable|state change queued/i.test(e.message)) throw e;
            await this.api.call('PUT', path, { state: 'stopped' });
            throw new CapacityError(this.id, `instance ${id} cannot start now (its machine's GPU is taken): the queued start was cancelled, so it stays stopped`,
                { status: e.status, code: e.code, cause: e });
        }
        this.relaunched.set(id, Date.now());
    }

    /** Stops and starts the container without giving up the machine's GPU. */
    public async restartServer(id: string): Promise<void> {
        await this.api.call('PUT', `/api/v0/instances/reboot/${encodeURIComponent(id)}/`);
        this.relaunched.set(id, Date.now());
    }

    /** Vast uploads the container's log on request and hands back a URL to fetch it from. */
    public async getServerLogs(id: string, o: LogOptions = {}): Promise<string> {
        const body = await this.api.call<{ result_url?: string }>('PUT', `/api/v0/instances/request_logs/${encodeURIComponent(id)}/`, { tail: String(o.tail ?? 1000) });
        if (!body?.result_url) return '';
        for (let i = 0; i < 10; i++) {
            await this.sleep(i === 0 ? 1000 : 2000);
            // Not the API host: the key does not go along.
            const r = await http(body.result_url, { retries: 0, fetchImpl: this.api.fetchImpl, sleep: this.sleep });
            if (r.status === 200) return typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
        }
        throw new ProviderError(this.id, `the log of instance ${id} was not uploaded in time`, { retriable: true });
    }

    /**
     * Deletes the instance, verified gone, and waits until the volumes it
     * mounted are free again (Vast lets go of one some 30 s after its instance
     * is gone, observed 2026-10-06): until then none of them can be mounted
     * again, or deleted.
     */
    public override async deleteServerAndWait(id: string, o: WaitOptions = {}): Promise<boolean> {
        const held = (await this.listVolumes().catch((): Volume<VastVolume>[] => [])).filter((v) => v.serverIds?.includes(id)).map((v) => v.id);
        const left = timeLeft(o);
        if (!(await super.deleteServerAndWait(id, left()))) return false;
        if (held.length) {
            await this.poll(() => this.listVolumes(), (all) => !all.some((v) => held.includes(v.id) && (v.serverIds?.includes(id) || v.status === 'attached')), {
                timeoutMs: 5 * 60_000, ...left(), what: `volume ${held.join(', ')} to let go of instance ${id}`, describe: () => `still in use by instance ${id}, which is gone`,
            });
        }
        return true;
    }

    /**
     * The offers on the machine `region` names (`machine:<id>`: a volume's
     * region, an offer's last), cheapest first: where an instance that mounts a
     * volume of that machine is rented. [] while the machine is rented out.
     * The account's reliability and verification floors do not apply: the
     * machine is chosen already.
     */
    public async offersOn(region: string, query: OfferQuery = {}): Promise<Offer<VastOffer>[]> {
        const machine = machineOf(region);
        if (machine === undefined) throw new ProviderError(this.id, `region "${region}" names no machine (machine:<id>)`);
        const search = async (type: 'ondemand' | 'bid') => ((await this.api.call<{ offers?: VastOffer[] }>('POST', '/api/v0/bundles/', {
            machine_id: { eq: machine }, rentable: { eq: true }, type, order: [['dph_total', 'asc']], limit: VastAI.PAGE,
        }, true))?.offers ?? []).map((a) => toOffer(a, type === 'bid'));
        return filterOffers([...await search('ondemand'), ...(query.includeInterruptible ? await search('bid') : [])], query);
    }

    // ── images ───────────────────────────────────────────────────────────

    /**
     * The snapshot repository's images: one per image (manifest), under each
     * name given to it, or, where it has none (a snapshot taken elsewhere), the
     * tag Vast gave it. [] where no `snapshots` repository is given.
     */
    public async listImages(): Promise<ServerImage<VastImage>[]> {
        const r = this.snapshots;
        if (!r) return [];
        const { registry, repository } = this.snapshotRegistry(r);
        const tags = await registry.tags(repository);
        const digests = await Promise.all(tags.map((tag) => registry.digest(repository, tag)));
        // The images that have a name: their snapshot's own tag is left out.
        const named = new Set(tags.flatMap((tag, i) => (!SNAPSHOT_TAG.test(tag) && digests[i] ? [digests[i]] : [])));
        return tags.flatMap((tag, i) => {
            const digest = digests[i];
            if (!digest || (SNAPSHOT_TAG.test(tag) && named.has(digest))) return [];
            const image = toImage(r, tag);
            return [{ ...image, raw: { ...image.raw, digest } }];
        });
    }

    /** The image its reference (`<server>/<repository>:<tag>`, its id) names, read from the snapshot repository: null when it has no such tag, or it is another repository's. */
    public async getImage(id: string): Promise<ServerImage<VastImage> | null> {
        const r = this.snapshots;
        const tag = this.tagOf(id);
        if (!r || tag === undefined) return null;
        const { registry, repository } = this.snapshotRegistry(r);
        const manifest = await registry.manifest(repository, tag);
        return manifest ? toImage(r, tag, manifest) : null;
    }

    /**
     * A snapshot of the instance's container, running or stopped: Vast
     * commits it (its processes paused) and pushes it to the `snapshots`
     * repository under a tag of its own (`instance_<id>_at_<time>`). Vast
     * reports no progress, so this waits until the repository has a new such
     * tag for this instance (default up to 1 h, read every 30 s; a small image
     * took under a minute), then names the same image `name` too: the image
     * is `<server>/<repository>:<name>`, with the instance's command, and
     * boots on any machine (createServer's `image`, pulled with the snapshot
     * login). A name the repository has already is refused.
     */
    public async createImage(serverId: string, o: { name: string } & WaitOptions): Promise<ServerImage<VastImage>> {
        const r = this.snapshots;
        if (!r) throw new ProviderError(this.id, 'Vast keeps no images: createImage pushes a snapshot to a registry of yours, so pass `snapshots` (its server, repository and a login that can push)');
        if (!IMAGE_TAG.test(o.name)) throw new ProviderError(this.id, `image name "${o.name}": it is the image's tag (letters, digits, _ . -, at most 128, not starting with . or -)`);
        const { registry, repository } = this.snapshotRegistry(r);
        const where = `${r.server}/${r.repository}`;
        const before = new Set(await registry.tags(repository));
        if (before.has(o.name)) throw new ProviderError(this.id, `image ${where}:${o.name} exists already: delete it, or pick another name`);
        // The instance is the URL's alone (an `id` in the body too is a 400); the repository names its registry (else Vast pushes to
        // Docker Hub) and no tag: Vast appends its own, which names the instance (observed 2026-10-06).
        await this.api.call('POST', `/api/v0/instances/take_snapshot/${encodeURIComponent(serverId)}/`, {
            container_registry: r.server, personal_repo: where, docker_login_user: r.username, docker_login_pass: r.password, pause: 'true',
        }, false);
        const ours = (t: string) => !before.has(t) && SNAPSHOT_TAG.exec(t)?.[1] === String(serverId);
        const fresh = await this.poll(async () => (await registry.tags(repository)).filter(ours), (tags) => tags.length > 0, {
            timeoutMs: o.timeoutMs ?? 60 * 60_000, intervalMs: o.intervalMs ?? 30_000, what: `the snapshot of instance ${serverId} in ${where}`, describe: () => 'not pushed yet',
        });
        const manifest = await registry.manifest(repository, fresh[0]);
        if (!manifest) throw new ProviderError(this.id, `the snapshot ${where}:${fresh[0]} went before it could be named ${o.name}`);
        await registry.putManifest(repository, o.name, manifest);
        return toImage(r, o.name, manifest);
    }

    /**
     * Deletes the image from the snapshot repository, every tag of it (its
     * name, the tag Vast gave it): through the Registry API, or Scaleway's own
     * for a Scaleway registry (deleteRegistryImage); a registry that deletes
     * nothing through an API is an error saying so. Idempotent; another
     * repository's image is left alone.
     */
    public async deleteImage(id: string): Promise<void> {
        const r = this.snapshots;
        const tag = this.tagOf(id);
        if (!r || tag === undefined) return;
        await deleteRegistryImage(`${r.server}/${r.repository}:${tag}`, r, { fetchImpl: this.api.fetchImpl, sleep: this.sleep });
    }

    // ── volumes ──────────────────────────────────────────────────────────

    /** The account's volumes: Vast's local ones, each on one machine (network volumes, withdrawn in July 2026, are left out). */
    public async listVolumes(): Promise<Volume<VastVolume>[]> {
        const body = await this.api.call<{ volumes?: VastVolume[] }>('GET', '/api/v0/volumes?owner=me&type=all_volume');
        return (body?.volumes ?? []).filter((v) => (v.type ?? 'machine') === 'machine').map(toVolume);
    }

    /** Vast reads one volume only in the list. */
    public async getVolume(id: string): Promise<Volume<VastVolume> | null> {
        return (await this.listVolumes()).find((v) => v.id === String(id)) ?? null;
    }

    /**
     * A volume of `sizeGb` on the machine `region` names (`machine:<id>`,
     * which an offer's regions have), rented from that machine's storage offer
     * (CapacityError when it has no room), named `name` (letters, digits and
     * underscores, at most 64: Vast's rule). Only an instance rented on that
     * machine mounts it (createServer's `mounts`), one at a time. It bills
     * (`raw.storage_total_cost`, USD per hour) until deleteVolume, and goes when
     * its host's listing ends (`raw.end_date`).
     */
    public async createVolume(o: CreateVolumeOptions<VastTypes>): Promise<Volume<VastVolume>> {
        if (!VOLUME_NAME.test(o.name)) throw new ProviderError(this.id, `volume name "${o.name}": Vast takes letters, digits and underscores only, at most 64`);
        if (!Number.isInteger(o.sizeGb) || o.sizeGb < 1) throw new ProviderError(this.id, `a volume is whole GB, 1 GB or more, not ${o.sizeGb} GB`);
        const machine = machineOf(this.regionName(o.region));
        if (machine === undefined) throw new ProviderError(this.id, `a Vast volume is on one machine: region "${o.region}" names none (an offer's regions name its machine, machine:<id>)`);
        const offer = await this.volumeOffer(machine, o.sizeGb);
        const made = await this.api.call<{ volume_id?: number, volume_name?: string }>('PUT', '/api/v0/volumes/', { id: offer.id, size: o.sizeGb, name: o.name, ...o.providerOptions }, false);
        const id = made?.volume_id ?? Number(/^V\.(\d+)$/.exec(made?.volume_name ?? '')?.[1]);
        if (!id) throw new ProviderError(this.id, 'the volume create returned no volume id');
        const volume = await this.poll(() => this.getVolume(String(id)), (v) => v?.status === 'available', {
            timeoutMs: o.timeoutMs ?? 5 * 60_000, intervalMs: o.intervalMs ?? 3000, what: `volume ${id}`, describe: (v) => (v ? v.providerStatus : 'not listed'),
        });
        return volume!;
    }

    /**
     * Deletes the volume, and its data, once no instance mounts it (one that
     * does is refused: delete the instance first), and waits until it is no
     * longer listed. Idempotent.
     */
    public async deleteVolume(id: string, o: WaitOptions = {}): Promise<void> {
        const v = await this.getVolume(id);
        if (!v) return;
        if (v.serverIds?.length) throw new ProviderError(this.id, `volume ${id} is attached to instance ${v.serverIds.join(', ')}: delete the instance first`);
        await falseIfNotFound(this.api.call('DELETE', `/api/v0/volumes/?id=${encodeURIComponent(id)}`, undefined, false));
        await this.poll(() => this.getVolume(id), (x) => !x, {
            timeoutMs: o.timeoutMs ?? 5 * 60_000, intervalMs: o.intervalMs ?? 3000, what: `delete of volume ${id}`, describe: (x) => x?.providerStatus ?? 'gone',
        });
    }

    // ── SSH keys ─────────────────────────────────────────────────────────

    public async listSSHKeys(): Promise<InitializedSSHKeyData[]> {
        // "No SSH keys found for the user." is a 404.
        const keys = await nullIfNotFound(this.api.call<VastSSHKeyData[]>('GET', '/api/v0/ssh/'));
        return (Array.isArray(keys) ? keys : []).filter((k) => !k.deleted_at).map(toSSHKey);
    }

    /** Vast keys have no name: it rides as the key's comment. */
    public async addSSHKey(publicKey: string, keyName: string): Promise<InitializedSSHKeyData> {
        const existing = findSSHKey(await this.listSSHKeys(), publicKey);
        if (existing) return existing;
        const k = parseSSHPublicKey(publicKey);
        const body = await this.api.call<{ key: VastSSHKeyData }>('POST', '/api/v0/ssh/', { ssh_key: `${k.type} ${k.blob}${keyName ? ` ${keyName}` : ''}` });
        return toSSHKey(body.key);
    }

    public async deleteSSHKey(id: string | number): Promise<boolean> {
        try {
            await this.api.call('DELETE', `/api/v0/ssh/${encodeURIComponent(id)}/`);
            return true;
        } catch (e) {
            // A key that is already gone: 400 no_ssh_key ("No ssh key provided") or "SSH key not found".
            if (e instanceof NotFoundError || (e instanceof ProviderError && e.status === 400
                && (e.code === 'no_ssh_key' || /not found|no ssh key/i.test(e.message)))) return false;
            throw e;
        }
    }

    // ── helpers ──────────────────────────────────────────────────────────

    private toServer(i: VastInstance): Server<VastInstance> {
        return toServer(i, this.relaunched.get(String(i.id)));
    }

    /** Cheapest first, a page of 64 at a time: the next page starts at the last page's price. */
    private async search(type: 'ondemand' | 'bid', query: OfferQuery): Promise<VastOffer[]> {
        const out: VastOffer[] = [];
        const seen = new Set<number>();
        let floor: number | undefined;
        const minCuda = query.minCudaVersion !== undefined ? Number(cudaVersion(query.minCudaVersion)) : this.minCudaVersion;
        const models = serverSideModels(query);
        for (let page = 0; page < this.offerPages; page++) {
            const price = {
                ...(floor !== undefined ? { gte: floor } : {}),
                ...(query.maxPricePerHour !== undefined ? { lte: query.maxPricePerHour } : {}),
            };
            // A search is a read: retried on 5xx like any GET.
            const body = await this.api.call<{ offers?: VastOffer[] }>('POST', '/api/v0/bundles/', {
                ...(this.verifiedOnly ? { verified: { eq: true } } : {}),
                ...(query.includeUnavailable ? {} : { rentable: { eq: true } }),
                reliability: { gte: this.minReliability },
                ...(minCuda ? { cuda_max_good: { gte: minCuda } } : {}),
                ...(query.gpuCount ? { num_gpus: { eq: query.gpuCount } } : {}),
                // The vendor and the models' compute capability: an expensive model is then not
                // hidden behind hundreds of cheaper cards. filterOffers does the exact match.
                ...models,
                // MB, and Vast reports USABLE memory (an L4 lists ~22.5 GB): a margin, the exact check is filterOffers.
                ...(query.minVramGb ? { gpu_ram: { gte: Math.floor(query.minVramGb * 1024 * 0.9) } } : {}),
                ...(Object.keys(price).length ? { dph_total: price } : {}),
                type,
                order: [['dph_total', 'asc']],
                limit: VastAI.PAGE,
            }, true);
            const batch = body?.offers ?? [];
            let added = 0;
            for (const a of batch) {
                if (seen.has(a.id)) continue;
                seen.add(a.id);
                out.push(a);
                added++;
            }
            if (batch.length < VastAI.PAGE || added === 0) break;
            floor = Number(batch[batch.length - 1].dph_total);
        }
        return out;
    }

    /**
     * The offer's machine, read by its ask id: CapacityError when it is gone.
     * Vast's search finds an offer by `ask_contract_id`; a filter on `id`
     * matches no offer at all (observed 2026-10-02).
     */
    private async askOf(askId: number, bid: boolean): Promise<VastOffer> {
        const found = await this.api.call<{ offers?: VastOffer[] }>('POST', '/api/v0/bundles/', { ask_contract_id: { eq: askId }, type: bid ? 'bid' : 'ondemand', limit: 1 }, true);
        const a = (found?.offers ?? []).find((x) => x.id === askId || x.ask_contract_id === askId);
        if (!a) throw new CapacityError(this.id, `offer ${askId} is no longer offered`);
        return a;
    }

    /** CapacityError when the machine's driver is older than `want`. */
    private checkCuda(a: VastOffer, want: string): void {
        const have = hostCuda(a);
        if (!have || compareCudaVersions(have, want) < 0) {
            throw new CapacityError(this.id, `offer ${a.id}: its host's driver runs CUDA ${have ?? '(unknown)'}, below ${want}`);
        }
    }

    /**
     * The volume a rental mounts, read now: on the offer's machine, mounted by
     * no other instance, at an absolute path (the mount's, default /data).
     * Anything else is refused before anything is rented.
     */
    private async volumeInfo(mount: ResolvedMount<VastVolume>, machine: number | undefined, offerId: string): Promise<VastVolumeInfo> {
        const path = mount.path ?? VAST_MOUNT_PATH;
        if (!path.startsWith('/')) throw new ProviderError(this.id, `mount path "${path}" is not absolute`);
        const volume = await this.getVolume(mount.id);
        if (!volume) throw new NotFoundError(this.id, `no volume ${mount.id}`);
        const here = machine !== undefined ? machineRegion(machine) : '(an unknown machine)';
        if (volume.region !== here) throw new ProviderError(this.id, `volume ${mount.id} is on ${volume.region}: only an instance rented there mounts it, and offer ${offerId} is on ${here}`);
        if (volume.serverIds?.length) throw new ProviderError(this.id, `volume ${mount.id} is attached to instance ${volume.serverIds.join(', ')}: one instance mounts it at a time`);
        return { create_new: false, volume_id: Number(volume.id), mount_path: path };
    }

    /** The snapshot repository as its registry's API addresses it (Docker Hub's API host, its library/ names), and a client with the snapshot login. */
    private snapshotRegistry(r: VastSnapshotRepository): { registry: RegistryClient, host: string, repository: string } {
        const { host, repository } = parseImageRef(`${r.server}/${r.repository}`);
        return { registry: new RegistryClient(host, r, this.api.fetchImpl, this.sleep), host, repository };
    }

    /** The tag an image reference names in the snapshot repository; undefined for any other image. */
    private tagOf(image: string): string | undefined {
        const r = this.snapshots;
        if (!r) return undefined;
        const ref = parseImageRef(image);
        const own = this.snapshotRegistry(r);
        return ref.host === own.host && ref.repository === own.repository && IMAGE_TAG.test(ref.reference) ? ref.reference : undefined;
    }

    /** The machine's storage offer with room for `sizeGb`: CapacityError when it has none now. */
    private async volumeOffer(machine: number, sizeGb: number): Promise<VastVolumeOffer> {
        const body = await this.api.call<{ offers?: VastVolumeOffer[] }>('POST', '/api/v0/volumes/search/', {
            machine_id: { eq: machine }, disk_space: { gte: sizeGb }, order: [['storage_cost', 'asc']], limit: 64, allocated_storage: sizeGb,
        }, true);
        const offer = (body?.offers ?? []).find((x) => x.machine_id === machine && x.disk_space >= sizeGb);
        if (!offer) throw new CapacityError(this.id, `machine ${machine} has no room for a volume of ${sizeGb} GB now`);
        return offer;
    }

    /**
     * The container's start, in the `args` launch mode: `command` as it is, or,
     * with a userData script, the script first and then `command` (an entrypoint
     * of `sh -c`, `onstart` being the entrypoint in this mode). A script needs a
     * command to hand over to (the image's own is replaced), and is a shell
     * script: cloud-config is cloud-init's, which a container does not run.
     */
    private argsWith(userData: string | undefined, command: string[] | undefined): { args?: string[], onstart?: string } {
        if (!userData) return command?.length ? { args: command } : {};
        if (/^\s*#cloud-config/.test(userData)) throw new NotSupportedError(this.id, 'createServer option "userData" as cloud-config (a Vast container runs no cloud-init: pass a shell script)');
        if (!command?.length) throw new NotSupportedError(this.id, 'createServer option "userData" without "command" (the script runs before the command, which replaces the image\'s own)');
        return { onstart: 'sh', args: ['-c', `${userData}\nexec "$@"`, 'asap-vps', ...command] };
    }

    /**
     * The login as Vast takes it, `docker login` arguments in one string:
     * '-u <user> -p <password> <host>' (the host the login names, else the
     * image's). A part with a space or a quote would split the string, so it is refused.
     */
    private imageLogin(auth: RegistryAuth, image: string): string {
        const host = registryOf(auth, image);
        for (const [what, v] of [['username', auth.username], ['password', auth.password], ['server', host]] as const) {
            if (!v || /[\s'"\\]/.test(v)) throw new ProviderError(this.id, `registryAuth ${what}: Vast takes the login as one string of docker login arguments, so it cannot be empty or hold spaces or quotes`);
        }
        return `-u ${auth.username} -p ${auth.password} ${host}`;
    }

    /**
     * An env entry: a plain name, and (until a live run proves Vast passes them
     * through intact) a value without spaces or quotes: encode such a value, e.g. base64.
     */
    private flagValue(v: string, key: string): string {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new ProviderError(this.id, `bad env name "${key}"`);
        if (/[\s'"\\]/.test(v)) throw new ProviderError(this.id, `env ${key}: a value cannot hold spaces or quotes on Vast (encode it, e.g. base64)`);
        return v;
    }
}
