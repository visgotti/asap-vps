// RunPod Pods over REST v2 (https://api.runpod.io, spec /v2/openapi.json read
// 2026-09-29; the v1 API at rest.runpod.io retires 2026-11-15). A pod is a
// container on a GPU host: RunPod pulls the image and runs it on the host's
// driver. Stock is per GPU type and data center (the catalog), and a MIG slice
// is a GPU type of its own. Pods take no UDP ports. A stopped pod bills only
// its volume; it restarts on the same host, which may have rented its GPU out
// meanwhile ("you may be allocated zero GPUs", docs.runpod.io/pods/manage-pods).
// A network volume is the account's storage in one data center: any number of
// pods there mount it (one each), and it outlives them. A private image is
// pulled with a registry login RunPod stores (`/v2/registries`).

import type { CapabilityDescriptor, ProviderCapabilities } from '../../capabilities';
import { ComputeProvider } from '../../Core/ComputeProvider';
import { asksForGpu, cudaVersion, filterOffers, findSSHKey, isKind, parseSSHPublicKey, pickSSHKeys, registryAuthName, registryOf } from '../../Core/utils';
import { CapacityError, falseIfNotFound, NotFoundError, NotSupportedError, nullIfNotFound, ProviderError } from '../../errors';
import type {
    CreateEndpointOptions, CreateServerOptions, CreateVolumeOptions, Endpoint, EndpointRequestInit, InitializedSSHKeyData, LogOptions, Offer, OfferQuery, RegistryAuth,
    Server, ServerListOptions, Volume,
} from '../../types';
import { RunPodApi } from './api';
import {
    parseCpuOfferId, RUNPOD_BILLING, RUNPOD_ID, RUNPOD_MOUNT_PATH, RUNPOD_REFUSED, RUNPOD_SERVERLESS_HOST, sseLogLines, toCpuOffer, toEndpoint, toOffer, toServer,
    toServerlessCpuOffer, toServerlessGpuOffer, toSSHKey, toVolume, vcpuCounts,
} from './mappers';
import type {
    RunPodCloud, RunPodCpuOffer, RunPodCpuType, RunPodCreateEndpointBody, RunPodEndpoint, RunPodGpuType, RunPodMounts, RunPodNetworkVolume, RunPodParams, RunPodPod,
    RunPodRegistry, RunPodTypes,
} from './types';

/** What RunPod can do, and how. */
export const RUNPOD_CAPABILITIES = {
    // Pods boot registry images on the host's driver: GPU pods, and CPU pods (a flavor at a vCPU count).
    compute: { kind: 'container', gpu: true, cpu: true, userData: false, liveAvailability: true },
    // A stopped pod bills only its volume.
    power: { stoppedBilling: 'storage' },
    restart: {},
    logs: {},
    sshKeys: { appliedAtBoot: false },
    // Network volumes: any number of pods in its data center mount one, each at the path it asks for.
    volumes: { shared: { mount: 'path', size: 'fixed', minGb: 10, maxGb: 4096 } },
    // Load-balancing endpoints: workers serve plain HTTP, no RunPod SDK in the image; on GPU pools or CPU flavors.
    serverless: { gpu: true, cpu: true, registryAuth: true },
} as const satisfies CapabilityDescriptor;

type Caps = typeof RUNPOD_CAPABILITIES;

export class RunPod extends ComputeProvider<RunPodTypes, RunPodApi> implements ProviderCapabilities<RunPodTypes, Caps> {
    static readonly capabilities: Caps = RUNPOD_CAPABILITIES;
    readonly id = RUNPOD_ID;
    readonly capabilities: Caps = RUNPOD_CAPABILITIES;
    readonly cloud: RunPodCloud;

    /** The log endpoint's backfill limit (spec: `tail` maximum). */
    static readonly MAX_LOG_TAIL = 5000;
    /** Pods bill per second while they run; a stopped pod bills only its volume. */
    static readonly BILLING = RUNPOD_BILLING;
    /**
     * The container disk a pod gets when createServer names none (GB). RunPod
     * refuses a pod without one once it has found it a machine, with "You must
     * either provide a template id or pod configuration parameters" (observed
     * 2026-10-01); its spec calls the field optional.
     */
    static readonly DEFAULT_DISK_GB = 20;
    /** Where a pod mounts a network volume when its mount names no path. */
    static readonly MOUNT_PATH = RUNPOD_MOUNT_PATH;
    /** A network volume's size bounds, GB (spec: CreateNetworkVolumeRequest.size). */
    static readonly VOLUME_GB = { min: 10, max: 4096 } as const;

    constructor(params: RunPodParams | string) {
        super(new RunPodApi(params));
        this.cloud = (typeof params === 'object' && params.cloud) || 'SECURE';
    }

    /**
     * One offer per GPU type, priced for `gpuCount` GPUs (default 1), and one per
     * CPU flavor at each vCPU count it is rented in (`<flavor>:<vcpus>`, a
     * machine without GPUs, on the secure cloud); regions are data centers with
     * stock. `minCudaVersion` scopes the GPU stock to hosts that run it.
     */
    public async listOffers(query: OfferQuery = {}): Promise<Offer<RunPodGpuType | RunPodCpuOffer>[]> {
        const [gpus, cpus] = await Promise.all([this.gpuOffers(query), this.cpuOffers(query)]);
        return filterOffers<Offer<RunPodGpuType | RunPodCpuOffer>>([...gpus, ...cpus], query);
    }

    /**
     * A pod of the offer's GPU type, with the offer's GPU count (`gpuCount`
     * overrides it: a pod takes any count up to the type's maximum), in the
     * offer's data center.
     *
     * `sshKeyIds` authorizes exactly those account keys: they go in PUBLIC_KEY,
     * which RunPod's SSH setup reads (left to itself it would put every key on the
     * account there; the image must honor PUBLIC_KEY, as RunPod's own images do).
     * It also exposes 22/tcp: without it the pod has only RunPod's proxy, a shell
     * with no scp, sftp or port forwarding.
     *
     * `mounts` takes one network volume (a pod mounts at most one), at its
     * `path` (default /workspace): the pod is placed in the volume's data
     * center, so a `region` elsewhere is refused. `registryAuth` is stored on the
     * account once (named `asap-vps:<user>@<host>:<hash>`, reused by every pod
     * with the same login) and the pod pulls `image` with it.
     */
    public async createServer(o: CreateServerOptions<RunPodTypes>): Promise<Server<RunPodPod>> {
        this.rejectOptions(o, RUNPOD_REFUSED);
        const { id: offerId, offer, region: offered } = this.resolveOffer(o);
        // A CPU flavor at a vCPU count, or a GPU type.
        const cpu = parseCpuOfferId(offerId);
        if (cpu && o.gpuCount) throw new NotSupportedError(this.id, `createServer option "gpuCount" with CPU offer ${offerId} (a CPU pod has no GPUs)`);
        if (cpu && o.volume) throw new NotSupportedError(this.id, 'createServer option "volume" on a CPU pod (it has no disk of its own: mount a network volume)');
        // The container: `container`, or the top-level image, env, command, ports and registryAuth.
        const c = this.containerOf(o);
        const image = this.imageName(c?.image);
        if (!c || !image) throw new ProviderError(this.id, 'a pod needs an image');
        if (c.ports?.some((p) => /\/udp$/i.test(p))) throw new NotSupportedError(this.id, 'createServer option "ports" with udp');
        const network = await this.networkMount(o);
        // A pod that mounts a volume goes where the volume is.
        const region = network?.dataCenter ?? offered;
        if (c.registryAuth && o.providerOptions?.registry !== undefined) throw new ProviderError(this.id, 'pass registryAuth or providerOptions.registry, not both');
        const registry = c.registryAuth ? await this.registryId(c.registryAuth, image) : undefined;
        const ports = [...(c.ports ?? [])];
        if (o.sshKeyIds?.length && !ports.some((p) => /^22\/tcp$/i.test(p))) ports.push('22/tcp');
        const minCuda = o.minCudaVersion !== undefined ? cudaVersion(o.minCudaVersion) : undefined;
        const env = { ...(c.env ?? {}) };
        if (o.sshKeyIds?.length) {
            if (env.PUBLIC_KEY !== undefined) throw new ProviderError(this.id, 'pass sshKeyIds or env.PUBLIC_KEY, not both');
            env.PUBLIC_KEY = pickSSHKeys(await this.listSSHKeys(), o.sshKeyIds, this.id).map((k) => k.publicKey).join('\n');
        }
        const pod = await this.api.call<RunPodPod>('POST', '/v2/pods', {
            name: o.name,
            image,
            ...(cpu ? { cpu: { id: cpu.flavor, vcpuCount: cpu.vcpuCount } }
                : { gpu: { id: offerId, count: o.gpuCount ?? offer?.gpuCount ?? 1, ...(minCuda ? { minCudaVersion: minCuda } : {}) } }),
            // CPU pods are on the secure cloud only.
            cloud: cpu ? 'SECURE' : this.cloud,
            ...(region ? { dataCenterIds: [region] } : {}),
            ...(Object.keys(env).length ? { env } : {}),
            ...(ports.length ? { ports } : {}),
            ...(c.command?.length ? { cmd: c.command } : {}),
            // Always set (RunPod needs one: DEFAULT_DISK_GB), in whole GB (the API takes integers).
            disk: Math.ceil(o.diskGb || RunPod.DEFAULT_DISK_GB),
            ...(network ? { mounts: { network: [{ volumeId: network.volumeId, path: network.path }] } satisfies RunPodMounts } : {}),
            ...(o.volume ? { mounts: { persistent: { size: Math.max(10, Math.ceil(o.volume.sizeGb)), path: o.volume.path } } satisfies RunPodMounts } : {}),
            ...(registry ? { registry } : {}),
            ...(o.sshKeyIds?.length ? { startSsh: true } : {}),
            ...o.providerOptions,
        });
        return toServer(pod);
    }

    public async getServer(id: string): Promise<Server<RunPodPod> | null> {
        const pod = await this.api.getPod(id);
        return pod ? toServer(pod) : null;
    }

    /** The account's pods, GPU and CPU alike unless `kind` says which. */
    public async listServers(options: ServerListOptions = {}): Promise<Server<RunPodPod>[]> {
        const out: Server<RunPodPod>[] = [];
        let cursor = '';
        for (let page = 0; page < 200; page++) {
            const body = await this.api.call<{ pods: RunPodPod[], pagination?: { nextCursor?: string | null, hasNextPage?: boolean } }>(
                'GET', `/v2/pods?limit=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
            out.push(...(body.pods ?? []).filter((p) => isKind(p.gpu?.count, options.kind)).map(toServer));
            if (!body.pagination?.hasNextPage || !body.pagination.nextCursor) return out;
            cursor = body.pagination.nextCursor;
        }
        throw new ProviderError(this.id, 'the pod list has more than 200 pages');
    }

    public async deleteServer(id: string): Promise<void> {
        await falseIfNotFound(this.api.call('DELETE', `/v2/pods/${encodeURIComponent(id)}`));
    }

    // ── power, restart, logs ─────────────────────────────────────────────

    /** Releases the GPU and keeps the pod's volume; a pod that is already stopped stays so. */
    public async stopServer(id: string): Promise<void> {
        await this.action(id, 'stop', ['EXITED']);
    }

    /**
     * Boots the pod on its host again. A host that rented the GPU out meanwhile
     * either refuses the start or resumes the pod with none (that pod is stopped
     * again): either way this throws CapacityError, and the pod stays stopped
     * (create a new pod elsewhere instead).
     */
    public async startServer(id: string): Promise<void> {
        const before = await this.api.getPod(id);
        if (!before) throw new NotFoundError(this.id, `pod ${id} not found`);
        const pod = await this.action(id, 'start', ['RUNNING', 'STARTING', 'PROVISIONING']);
        if ((before.gpu?.count ?? 0) >= 1 && !((pod?.gpu?.count ?? 0) >= 1)) {
            await this.action(id, 'stop', ['EXITED']).catch(() => undefined);
            throw new CapacityError(this.id, `pod ${id} resumed without a GPU (its host has none free now): stopped it again`);
        }
    }

    public async restartServer(id: string): Promise<void> {
        await this.action(id, 'restart');
    }

    /** The pod's recent container output: the log stream's backfill, read for `windowMs` (default 3 s). */
    public async getServerLogs(id: string, o: LogOptions & { windowMs?: number } = {}): Promise<string> {
        const tail = Math.min(RunPod.MAX_LOG_TAIL, Math.max(0, Math.floor(o.tail ?? 1000)));
        return sseLogLines(await this.api.logEvents(id, tail, o.windowMs ?? 3000)).join('\n');
    }

    // ── volumes ──────────────────────────────────────────────────────────

    /** The account's network volumes, in every data center. */
    public async listVolumes(): Promise<Volume<RunPodNetworkVolume>[]> {
        const { networkVolumes } = await this.api.call<{ networkVolumes?: RunPodNetworkVolume[] }>('GET', '/v2/network-volumes');
        return (networkVolumes ?? []).map(toVolume);
    }

    public async getVolume(id: string): Promise<Volume<RunPodNetworkVolume> | null> {
        const v = await this.api.getNetworkVolume(id);
        return v ? toVolume(v) : null;
    }

    /**
     * A network volume of `sizeGb` (10-4096 GB; it can grow later, never shrink)
     * in a data center (`region`), mountable at once. It bills until deleteVolume.
     */
    public async createVolume(o: CreateVolumeOptions<RunPodTypes>): Promise<Volume<RunPodNetworkVolume>> {
        const size = Math.ceil(o.sizeGb);
        const { min, max } = RunPod.VOLUME_GB;
        if (!(size >= min && size <= max)) throw new ProviderError(this.id, `a network volume is ${min}-${max} GB, not ${o.sizeGb}`);
        return toVolume(await this.api.call<RunPodNetworkVolume>('POST', '/v2/network-volumes', {
            name: o.name, size, dataCenter: this.regionName(o.region), ...o.providerOptions,
        }));
    }

    public async deleteVolume(id: string): Promise<void> {
        await falseIfNotFound(this.api.call('DELETE', `/v2/network-volumes/${encodeURIComponent(id)}`));
    }

    // ── serverless: load-balancing endpoints ─────────────────────────────

    /**
     * What a worker can run on, at serverless prices: each GPU type of a
     * serverless pool (a GPU a worker, at the pool's flex price) and each CPU
     * flavor at each vCPU count from 2, billed per second while a worker runs;
     * cheapest first, in stock unless the query says otherwise.
     */
    public async listEndpointOffers(query: OfferQuery = {}): Promise<Offer<RunPodGpuType | RunPodCpuOffer>[]> {
        const [gpus, cpus] = await Promise.all([
            query.kind === 'cpu' ? [] : this.serverlessGpus().then((g) => g.map(toServerlessGpuOffer)),
            asksForGpu(query) ? [] : this.serverlessCpuOffers(),
        ]);
        return filterOffers([...gpus, ...cpus].filter((o): o is Offer<RunPodGpuType> | Offer<RunPodCpuOffer> => o !== null), query);
    }

    /** The account's endpoints, load-balancing and queue ones alike. */
    public async listEndpoints(): Promise<Endpoint<RunPodEndpoint>[]> {
        const out: Endpoint<RunPodEndpoint>[] = [];
        let cursor = '';
        for (let page = 0; page < 200; page++) {
            const body = await this.api.call<{ endpoints: RunPodEndpoint[], pagination?: { nextCursor?: string | null, hasNextPage?: boolean } }>(
                'GET', `/v2/serverless?limit=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
            out.push(...(body.endpoints ?? []).map(toEndpoint));
            if (!body.pagination?.hasNextPage || !body.pagination.nextCursor) return out;
            cursor = body.pagination.nextCursor;
        }
        throw new ProviderError(this.id, 'the endpoint list has more than 200 pages');
    }

    public async getEndpoint(id: string): Promise<Endpoint<RunPodEndpoint> | null> {
        const e = await nullIfNotFound(this.api.call<RunPodEndpoint>('GET', `/v2/serverless/${encodeURIComponent(id)}`));
        return e ? toEndpoint(e) : null;
    }

    /**
     * A load-balancing endpoint: workers of the image serve plain HTTP on
     * `port` (default 80, given to them as PORT and PORT_HEALTH: its /ping
     * answers 200 once a worker is ready, 204 while it starts), behind
     * https://<id>.api.runpod.ai, scaling on requests in flight from
     * `minWorkers` (default 0) to `maxWorkers` (default 1). A GPU offer pins
     * a worker to that GPU type (its pool, the pool's other types left out); a
     * CPU offer is a flavor at a power-of-two vCPU count from 2. RunPod gives
     * an endpoint no status: it takes requests once it is made.
     */
    public async createEndpoint(o: CreateEndpointOptions<RunPodTypes>): Promise<Endpoint<RunPodEndpoint>> {
        const c = o.container;
        const image = this.imageName(c?.image);
        if (!image) throw new ProviderError(this.id, 'an endpoint needs an image');
        const port = o.port ?? 80;
        if (!(Number.isInteger(port) && port > 0 && port < 65536)) throw new ProviderError(this.id, `bad port ${port}`);
        for (const k of ['PORT', 'PORT_HEALTH']) {
            if (c.env?.[k] !== undefined && c.env[k] !== String(port)) throw new ProviderError(this.id, `env.${k} is the endpoint's port: pass port (${c.env[k]}), not env.${k}`);
        }
        const min = o.minWorkers ?? 0;
        const max = o.maxWorkers ?? 1;
        if (!(Number.isInteger(min) && Number.isInteger(max) && min >= 0 && max >= 1 && min <= max)) {
            throw new ProviderError(this.id, `workers: 0 <= minWorkers <= maxWorkers, maxWorkers >= 1 (not ${min} and ${max})`);
        }
        const idle = o.idleTimeoutSeconds;
        if (idle !== undefined && !(Number.isInteger(idle) && idle >= 1 && idle <= 3600)) throw new ProviderError(this.id, `idleTimeoutSeconds is 1-3600, not ${idle}`);
        const compute = await this.endpointCompute(o.offer);
        if (c.registryAuth && o.providerOptions?.registry !== undefined) throw new ProviderError(this.id, 'pass registryAuth or providerOptions.registry, not both');
        const registry = c.registryAuth ? await this.registryId(c.registryAuth, image) : undefined;
        const region = o.region !== undefined ? this.regionName(o.region) : undefined;
        const body: RunPodCreateEndpointBody = {
            name: o.name,
            type: 'LOAD_BALANCER',
            scaling: { type: 'REQUEST_COUNT', requestCount: 1 },
            image,
            ...compute,
            workers: { min, max, ...(idle !== undefined ? { idleTimeout: idle } : {}) },
            env: { ...c.env, PORT: String(port), PORT_HEALTH: String(port) },
            ports: [`${port}/http`],
            ...(c.command?.length ? { cmd: c.command } : {}),
            ...(registry ? { registry } : {}),
            ...(region ? { dataCenterIds: [region] } : {}),
        };
        return toEndpoint(await this.api.call<RunPodEndpoint>('POST', '/v2/serverless', { ...body, ...o.providerOptions }));
    }

    /** Scaled to no workers first (RunPod's GraphQL API asks that of a delete; the REST one does no harm by it), then deleted; one gone already is no error. */
    public async deleteEndpoint(id: string): Promise<void> {
        const path = `/v2/serverless/${encodeURIComponent(id)}`;
        if (!(await falseIfNotFound(this.api.call('PATCH', path, { workers: { min: 0, max: 0 } })))) return;
        await falseIfNotFound(this.api.call('DELETE', path));
    }

    /**
     * A request to the endpoint, with the account's key: to
     * https://<id>.api.runpod.ai (made from the id, so the key goes nowhere
     * else). A cold start is waited out: the load balancer holds a request up
     * to 2 min while a worker boots, then answers that no worker is available
     * (or a worker not yet up answers 502-504); the request is sent again until
     * `timeoutMs` (default 5 min). A body that is a stream is sent once.
     */
    public async requestEndpoint(endpoint: Endpoint | string, path: string, init: EndpointRequestInit = {}): Promise<Response> {
        if (typeof endpoint !== 'string' && endpoint.provider !== this.id) throw new ProviderError(this.id, `endpoint ${endpoint.id} is ${endpoint.provider}'s, not ${this.id}'s`);
        const id = typeof endpoint === 'string' ? endpoint : endpoint.id;
        if (!/^[a-z0-9]+$/i.test(id)) throw new ProviderError(this.id, `bad endpoint id "${id}"`);
        const url = `https://${id}.${RUNPOD_SERVERLESS_HOST}${path.startsWith('/') ? path : `/${path}`}`;
        return this.requestWarm(url, init, { authorization: `Bearer ${this.apiKey}` },
            async (r) => [502, 503, 504].includes(r.status) || (r.status === 400 && /no workers available/i.test(await r.clone().text().catch(() => ''))));
    }

    // ── SSH keys ─────────────────────────────────────────────────────────

    /** The account's keys (RunPod keeps them as one list; a key's id is its SHA256 fingerprint). */
    public async listSSHKeys(): Promise<InitializedSSHKeyData[]> {
        // A line this parser cannot read has no id to address it by: it is left out, never dropped.
        return (await this.api.keyLines()).map(toSSHKey).filter((k): k is InitializedSSHKeyData => k !== null);
    }

    /** RunPod replaces the whole key list: read it, add, write it back (with every line it had). */
    public async addSSHKey(publicKey: string, keyName: string): Promise<InitializedSSHKeyData> {
        const existing = findSSHKey(await this.listSSHKeys(), publicKey);
        if (existing) return existing;
        const k = parseSSHPublicKey(publicKey);
        const line = `${k.type} ${k.blob}${keyName ? ` ${keyName}` : ''}`;
        await this.api.setKeyLines([...await this.api.keyLines(), line]);
        return toSSHKey(line) as InitializedSSHKeyData;
    }

    public async deleteSSHKey(id: string | number): Promise<boolean> {
        const keys = await this.api.keyLines();
        const rest = keys.filter((x) => toSSHKey(x)?.id !== String(id));
        if (rest.length === keys.length) return false;
        await this.api.setKeyLines(rest);
        return true;
    }

    // ── helpers ──────────────────────────────────────────────────────────

    /** The GPU types of the catalog with their serverless pool and price, and stock for serverless workers. */
    private async serverlessGpus(): Promise<RunPodGpuType[]> {
        return (await this.api.call<{ gpus: RunPodGpuType[] }>('GET', '/v2/catalog/gpus?include=AVAILABILITY&product=SERVERLESS')).gpus ?? [];
    }

    /** The CPU flavors as serverless offers: one per vCPU count from 2, with the stock for that count. */
    private async serverlessCpuOffers(): Promise<Offer<RunPodCpuOffer>[]> {
        const read = (count: number) => this.api.call<{ cpus: RunPodCpuType[] }>('GET', `/v2/catalog/cpus?include=AVAILABILITY&product=SERVERLESS&vcpuCount=${count}`);
        const counts = [...new Set(((await this.api.call<{ cpus: RunPodCpuType[] }>('GET', '/v2/catalog/cpus')).cpus ?? []).flatMap(vcpuCounts))].filter((n) => n >= 2).sort((a, b) => a - b);
        const perCount = await Promise.all(counts.map(async (n) => ({ n, cpus: (await read(n)).cpus ?? [] })));
        return perCount.flatMap(({ n, cpus }) => cpus.filter((c) => vcpuCounts(c).includes(n)).map((c) => toServerlessCpuOffer(c, n)))
            .filter((x): x is Offer<RunPodCpuOffer> => x !== null);
    }

    /** What an endpoint's workers run on, as its create takes it: a GPU type pinned within its pool, or a CPU flavor; the cheapest in stock when no offer is named. */
    private async endpointCompute(offer: Offer<RunPodGpuType | RunPodCpuOffer> | string | undefined): Promise<Pick<RunPodCreateEndpointBody, 'gpu' | 'cpu'>> {
        if (offer !== undefined && typeof offer !== 'string' && offer.provider !== this.id) throw new ProviderError(this.id, `offer ${offer.id} is ${offer.provider}'s, not ${this.id}'s`);
        let id = typeof offer === 'string' ? offer : offer?.id;
        if (id === undefined) {
            const [cheapest] = await this.listEndpointOffers();
            if (!cheapest) throw new CapacityError(this.id, 'no serverless worker of any kind is in stock right now');
            id = cheapest.id;
        }
        const cpu = parseCpuOfferId(id);
        if (cpu) {
            if (cpu.vcpuCount < 2 || (cpu.vcpuCount & (cpu.vcpuCount - 1)) !== 0) throw new ProviderError(this.id, `a serverless CPU worker has a power-of-two vCPU count from 2, not ${cpu.vcpuCount}`);
            return { cpu: [{ id: cpu.flavor, vcpuCount: cpu.vcpuCount }] };
        }
        const gpus = await this.serverlessGpus();
        const type = gpus.find((g) => g.id === id);
        if (!type) throw new NotFoundError(this.id, `no GPU type "${id}"`);
        if (!type.pool) throw new ProviderError(this.id, `GPU type "${id}" is in no serverless pool`);
        const others = gpus.filter((g) => g.pool === type.pool && g.id !== type.id).map((g) => g.id);
        return { gpu: { pools: [type.pool], ...(others.length ? { excludedTypes: others } : {}), count: 1 } };
    }

    /** The GPU types as offers: none for a question about machines without GPUs. */
    private async gpuOffers(query: OfferQuery): Promise<Offer<RunPodGpuType>[]> {
        const count = query.gpuCount ?? 1;
        if (count < 1 || query.kind === 'cpu') return [];
        const minCuda = query.minCudaVersion !== undefined ? cudaVersion(query.minCudaVersion) : undefined;
        const { gpus } = await this.api.call<{ gpus: RunPodGpuType[] }>('GET',
            `/v2/catalog/gpus?include=AVAILABILITY&product=POD&cloud=${this.cloud}&count=${count}${minCuda ? `&minCudaVersion=${minCuda}` : ''}`);
        return (gpus ?? []).map((g) => toOffer(g, count, this.cloud)).filter((o): o is Offer<RunPodGpuType> => o !== null);
    }

    /**
     * The CPU flavors as offers, one per vCPU count each is rented in, with the
     * stock for that count (the catalog reads stock per count): none for a
     * question about GPUs.
     */
    private async cpuOffers(query: OfferQuery): Promise<Offer<RunPodCpuOffer>[]> {
        if (asksForGpu(query)) return [];
        const read = (count: number) => this.api.call<{ cpus: RunPodCpuType[] }>('GET', `/v2/catalog/cpus?include=AVAILABILITY&product=POD&vcpuCount=${count}`);
        const counts = [...new Set(((await this.api.call<{ cpus: RunPodCpuType[] }>('GET', '/v2/catalog/cpus')).cpus ?? []).flatMap(vcpuCounts))].sort((a, b) => a - b);
        const perCount = await Promise.all(counts.map(async (n) => ({ n, cpus: (await read(n)).cpus ?? [] })));
        return perCount.flatMap(({ n, cpus }) => cpus.filter((c) => vcpuCounts(c).includes(n)).map((c) => toCpuOffer(c, n)))
            .filter((x): x is Offer<RunPodCpuOffer> => x !== null);
    }

    /**
     * The network volume a create mounts, read (a volume object is taken at its
     * word, an id is looked up): undefined when it mounts none. A pod mounts one
     * network volume, or a disk of its own (`volume`): never both, nor two
     * volumes. The pod goes to the volume's data center: a `region` that names
     * another is refused.
     */
    private async networkMount(o: CreateServerOptions<RunPodTypes>): Promise<{ volumeId: string, path: string, dataCenter: string } | undefined> {
        const [mount, ...more] = this.mountsOf(o.mounts);
        if (!mount) return undefined;
        if (more.length) throw new NotSupportedError(this.id, 'createServer option "mounts" with more than one volume (a pod mounts one network volume)');
        if (o.volume) throw new NotSupportedError(this.id, 'createServer options "mounts" and "volume" together (a pod has a network volume or a disk of its own)');
        const path = mount.path ?? RunPod.MOUNT_PATH;
        if (!path.startsWith('/')) throw new ProviderError(this.id, `mount path "${path}" is not absolute`);
        const volume = mount.volume?.raw ?? await this.api.getNetworkVolume(mount.id);
        if (!volume) throw new NotFoundError(this.id, `no network volume ${mount.id}`);
        const asked = o.region !== undefined ? this.regionName(o.region) : undefined;
        if (asked && asked !== volume.dataCenter) {
            throw new ProviderError(this.id, `network volume ${mount.id} is in ${volume.dataCenter}: a pod that mounts it is placed there, not in ${asked}`);
        }
        return { volumeId: volume.id, path, dataCenter: volume.dataCenter };
    }

    /**
     * The stored login a pod pulls `image` with: the one this account already
     * holds under the login's name (registryAuthName), else a new one. RunPod has
     * no update for a stored login, so a changed password is a new name, and a new one.
     */
    private async registryId(auth: RegistryAuth, image: string): Promise<string> {
        if (!auth.username || !auth.password) throw new ProviderError(this.id, 'registryAuth needs a username and a password');
        const name = registryAuthName(auth, registryOf(auth, image), this.apiKey);
        const stored = async () => ((await this.api.call<{ registries?: RunPodRegistry[] }>('GET', '/v2/registries')).registries ?? []).find((r) => r.name === name);
        const found = await stored();
        if (found) return found.id;
        try {
            return (await this.api.call<RunPodRegistry>('POST', '/v2/registries', { name, username: auth.username, password: auth.password })).id;
        } catch (e) {
            // Another create with the same login stored it meanwhile: that one serves.
            const made = e instanceof ProviderError && (e.status === 400 || e.status === 409) ? await stored() : undefined;
            if (made) return made.id;
            throw e;
        }
    }

    /**
     * POST .../action: 200 with the updated pod, 409 when the status does not
     * allow it. `already` lists the statuses in which the action's work is
     * done: a 409 there is success (a retried stop, a start of a running pod).
     */
    private async action(id: string, action: 'start' | 'stop' | 'restart', already: RunPodPod['status'][] = []): Promise<RunPodPod | null> {
        try {
            return await this.api.call<RunPodPod>('POST', `/v2/pods/${encodeURIComponent(id)}/action`, { action });
        } catch (e) {
            if (!(e instanceof ProviderError) || e.status !== 409 || !already.length) throw e;
            const pod = await this.api.getPod(id);
            if (pod && already.includes(pod.status)) return pod;
            throw e;
        }
    }
}
