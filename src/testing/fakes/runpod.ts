// A fetch() that answers like RunPod's REST v2 (api.runpod.io/v2/openapi.json,
// read 2026-09-29) for the calls the GPU provider makes: the GPU catalog with
// per-data-center stock for the product (pods or serverless workers), cloud
// and GPU count asked (include=AVAILABILITY needs product=), scoped by
// minCudaVersion and listing each type's cudaVersions; pods that go
// PROVISIONING -> STARTING -> RUNNING over a few reads, placed on the cloud
// they name, on a machine with their GPUs free and on hosts whose CUDA meets
// gpu.minCudaVersion, and billed at that cloud's rate; POST .../action for start / stop /
// restart (409 when the status does not allow it); cursor pages; the SSE log
// stream (RunPod's own lines as source `system`, the command's output as
// `container`; `source` picks one, `tail` backfills the last lines, 100 by
// default, at most 5000); the account key list replaced whole by PUT; and
// ssh.proxy / ssh.direct (direct only with 22/tcp); stored registry logins
// (/v2/registries: write-only credentials, a pod's `registry` must name one);
// network volumes (/v2/network-volumes) that a pod mounts in their data center
// (`mounts.network`, at most one, never with `mounts.persistent`). Errors are
// application/problem+json {title, status, detail, errors?}: a body with a field
// the schema lacks, or a value breaking its type or pattern, is a 422 whose
// reasons are in errors[]; a create that cannot be placed is a 400 with only a
// human-readable detail.

import { echoed, FakeApi, json, readRequest } from './util';

/** What the fake records of a GPU type in one data center: its stock in each context (absent: none there), its hosts' CUDA. */
type GpuStock = {
    id: string,
    /** The one CUDA version this data center's hosts of the type run. */
    cuda: string | null,
    /** Pods on each cloud: the availability, and the GPUs free on the largest machine (a pod runs on one: more than that is none here). */
    SECURE?: [string, number],
    COMMUNITY?: [string, number],
    /** Serverless workers of the type's pool. */
    SERVERLESS?: string,
};

/**
 * GPU types (`GET /v2/catalog/gpus`), with each data center's stock per
 * product context: pods on the secure or community cloud, or serverless
 * workers. The catalog answers for the product, cloud and GPU count asked, as
 * the spec has it, and lists a data center only for a context it has stock
 * records for.
 */
const GPUS: Array<{ id: string, name: string, manufacturer: string, memory: number, secure: boolean, community: boolean, maxCount: { secure: number, community: number },
    pool: string | null, price: { secure: number | null, community: number | null, serverless: number | null }, dataCenters: GpuStock[] }> = [
    { id: 'NVIDIA RTX A5000', name: 'RTX A5000', manufacturer: 'NVIDIA', memory: 24, secure: true, community: true, maxCount: { secure: 8, community: 8 }, pool: 'AMPERE_24',
        price: { secure: 0.27, community: 0.16, serverless: 0.69 },
        // Secure pods in Texas; community pods in Romania.
        dataCenters: [{ id: 'US-TX-3', cuda: '12.8', SECURE: ['HIGH', 8], SERVERLESS: 'HIGH' }, { id: 'EU-RO-1', cuda: '12.4', SECURE: ['NONE', 0], COMMUNITY: ['HIGH', 4] }] },
    { id: 'NVIDIA L4', name: 'L4', manufacturer: 'NVIDIA', memory: 24, secure: true, community: true, maxCount: { secure: 8, community: 8 }, pool: 'AMPERE_24',
        price: { secure: 0.49, community: 0.44, serverless: 0.69 }, dataCenters: [{ id: 'US-TX-3', cuda: '12.8', SECURE: ['NONE', 0], COMMUNITY: ['NONE', 0], SERVERLESS: 'NONE' }] },
    // One GPU free on a secure machine; its serverless pool runs in another data center than its pods.
    { id: 'NVIDIA GeForce RTX 4090', name: 'RTX 4090', manufacturer: 'NVIDIA', memory: 24, secure: true, community: true, maxCount: { secure: 8, community: 8 }, pool: 'ADA_24',
        price: { secure: 0.74, community: 0.34, serverless: 1.1 },
        dataCenters: [{ id: 'EU-RO-1', cuda: '12.4', SECURE: ['LOW', 1], COMMUNITY: ['HIGH', 2] }, { id: 'US-TX-3', cuda: '12.8', SERVERLESS: 'HIGH' }] },
    { id: 'AMD Instinct MI300X OAM', name: 'MI300X', manufacturer: 'AMD', memory: 192, secure: true, community: false, maxCount: { secure: 8, community: 0 }, pool: null,
        price: { secure: 2.49, community: null, serverless: null }, dataCenters: [{ id: 'US-TX-3', cuda: null, SECURE: ['MEDIUM', 8] }] },
    { id: 'NVIDIA RTX A4000', name: 'RTX A4000', manufacturer: 'NVIDIA', memory: 16, secure: false, community: true, maxCount: { secure: 0, community: 8 }, pool: 'AMPERE_16',
        price: { secure: null, community: 0.17, serverless: 0.58 }, dataCenters: [{ id: 'US-TX-3', cuda: '12.9', COMMUNITY: ['HIGH', 4], SERVERLESS: 'HIGH' }] },
    // A MIG slice of a card: its own GPU type, a fraction of the card's memory, cheaper than the card.
    { id: 'NVIDIA RTX PRO 6000 Blackwell Server Edition MIG 1g.24gb', name: 'PRO 6000 MIG 24GB', manufacturer: 'NVIDIA', memory: 24, secure: true, community: false,
        maxCount: { secure: 1, community: 0 }, pool: null, price: { secure: 0.8, community: null, serverless: null }, dataCenters: [{ id: 'US-TX-3', cuda: '12.9', SECURE: ['HIGH', 1] }] },
    { id: 'NVIDIA RTX PRO 6000 Blackwell Server Edition', name: 'RTX PRO 6000', manufacturer: 'NVIDIA', memory: 96, secure: true, community: false,
        maxCount: { secure: 8, community: 0 }, pool: 'BLACKWELL_96', price: { secure: 1.79, community: null, serverless: 2.79 },
        dataCenters: [{ id: 'US-TX-3', cuda: '12.9', SECURE: ['LOW', 2], SERVERLESS: 'LOW' }] },
    // Listed with a secure price the secure cloud does not sell (the flag decides).
    { id: 'NVIDIA RTX 3090', name: 'RTX 3090', manufacturer: 'NVIDIA', memory: 24, secure: false, community: true, maxCount: { secure: 0, community: 4 }, pool: 'AMPERE_24',
        price: { secure: 0.22, community: 0.22, serverless: 0.69 }, dataCenters: [{ id: 'US-TX-3', cuda: '12.2', COMMUNITY: ['HIGH', 2], SERVERLESS: 'HIGH' }] },
];

/** A data center's stock of a GPU type in one context, for `count` GPUs per pod (serverless: per worker, one): undefined where it has none on record. */
const stockIn = (d: GpuStock, context: 'SECURE' | 'COMMUNITY' | 'SERVERLESS', count: number): string | undefined => {
    if (context === 'SERVERLESS') return d.SERVERLESS;
    const pod = d[context];
    return pod && (pod[1] >= count ? pod[0] : 'NONE');
};

/** CPU flavors (`GET /v2/catalog/cpus`): priced per vCPU, rented in power-of-two counts within `vcpu`; stock per data center and count (the fake's `stock`). */
const CPUS = [
    { id: 'cpu3c', name: 'Compute-Optimized', group: 'Gen 3', vcpu: { min: 2, max: 32 }, ramGbPerVcpu: 2, price: { securePerVcpu: 0.03, serverlessPerVcpu: 0.02 },
        stock: { 'US-TX-3': ['HIGH', 2, 4, 8], 'EU-RO-1': ['NONE', 16, 32] } },
    { id: 'cpu5g', name: 'General Purpose', group: 'Gen 5', vcpu: { min: 4, max: 8 }, ramGbPerVcpu: 4, price: { securePerVcpu: 0.05, serverlessPerVcpu: 0.04 },
        stock: { 'EU-RO-1': ['MEDIUM', 4, 8] } },
];

const ACTIONS: Record<string, string[]> = {
    RUNNING: ['stop', 'restart', 'terminate'],
    EXITED: ['start', 'terminate'],
    ERROR: ['start', 'terminate'],
    PROVISIONING: ['stop', 'terminate'],
    STARTING: ['stop', 'terminate'],
};

/** CreatePodRequest's fields (unevaluatedProperties: false), and CreateGpuConfig's. */
const CREATE_FIELDS = new Set(['args', 'cloud', 'cmd', 'cpu', 'dataCenterIds', 'disk', 'entrypoint', 'env', 'globalNetworking', 'gpu', 'image', 'mounts',
    'name', 'ports', 'registry', 'startJupyter', 'startSsh', 'templateId']);
const GPU_FIELDS = new Set(['allowedCudaVersions', 'count', 'id', 'minCudaVersion', 'minRamPerGpu', 'minVcpuCountPerGpu']);
/** CreateCpuConfig's fields (unevaluatedProperties: false). */
const CPU_FIELDS = new Set(['id', 'vcpuCount']);
/** CreateRegistryRequest's and CreateNetworkVolumeRequest's fields (additionalProperties: false). */
const REGISTRY_FIELDS = new Set(['name', 'username', 'password']);
const VOLUME_FIELDS = new Set(['name', 'size', 'dataCenter', 'type']);
/** UpdateSshKeysRequest's item pattern. */
const KEY_LINE = /^(ssh|ecdsa|sk)-[^\s]+ [^\s]+( .*)?$/;

const cudaAtLeast = (have: string | null, want: string) => {
    if (!have) return false;
    const [hm, hn] = have.split('.').map(Number);
    const [wm, wn = 0] = want.split('.').map(Number);
    return hm - wm > 0 || (hm === wm && hn >= wn);
};

export function fakeRunPod(o: {
    token?: string, bootReads?: number, resumeWithoutGpu?: boolean,
    /** Requests a load-balancing endpoint answers "no workers available" while its first worker boots (a cold start). */
    coldRequests?: number,
} = {}) {
    const token = o.token ?? 'rp-test';
    const calls: FakeApi['calls'] = [];
    const state = {
        gpus: GPUS.map((g) => ({ ...g, dataCenters: g.dataCenters.map((d) => ({ ...d })) })),
        pods: new Map<string, any>(),
        keys: [] as string[],
        /** Stored registry logins: RunPod answers only their id and name. */
        registries: new Map<string, { id: string, name: string, username: string, password: string }>(),
        volumes: new Map<string, { id: string, name: string, size: number, dataCenter: string, type: string }>(),
        /** Serverless endpoints, and each one's workers: a cold start left, and whether a worker is up. */
        endpoints: new Map<string, any>(),
        workers: new Map<string, { cold: number, up: number }>(),
        nextId: 1,
        bootReads: o.bootReads ?? 2,
        /** "You may be allocated zero GPUs if capacity has changed": a start that comes back with none. */
        resumeWithoutGpu: o.resumeWithoutGpu ?? false,
    };
    for (const name of ['comfy-dev', 'jupyter']) {
        const id = `pod_prod${state.nextId++}`;
        state.pods.set(id, { id, name, status: 'RUNNING', gpu: { id: 'NVIDIA RTX A5000', count: 1 }, dataCenterId: 'US-TX-3', cudaVersion: '12.8', cost: 0.27,
            createdAt: '2026-01-01T00:00:00Z', startedAt: '2026-01-01T00:01:00Z', rate: 0.27, image: 'runpod/base', ports: [], reads: 99, logs: [] });
    }
    const problem = (status: number, detail: string, errors?: string[]) =>
        json(status, { title: 'Error', status, detail, ...(errors ? { errors } : {}) }, 'application/problem+json');
    const invalid = (errors: string[]) => problem(422, 'Request validation failed.', errors);
    /**
     * One run of the pod's container, as its log has it: RunPod's own lines
     * (source `system`), then what the command prints (source `container`):
     * `nvidia-smi -L`'s line for each GPU it has, and its echoes.
     */
    const containerRun = (pod: any): Array<{ source: 'system' | 'container', line: string }> => [
        { source: 'system', line: `create container ${pod.image}` },
        { source: 'system', line: 'start container' },
        ...(String(pod.cmd ?? '').includes('nvidia-smi') && pod.gpu
            ? Array.from({ length: pod.gpu.count ?? 1 }, (_, i) => ({ source: 'container' as const, line: `GPU ${i}: ${pod.gpu.id} (UUID: GPU-0f1e2d3${i})` })) : []),
        ...echoed(pod.cmd, pod.env).map((line) => ({ source: 'container' as const, line })),
    ];
    /** The data centers the catalog knows: where a network volume can be made. */
    const dataCenters = () => new Set(state.gpus.flatMap((g) => g.dataCenters.map((d) => d.id)));
    const livePods = () => [...state.pods.values()].filter((x) => x.status !== 'TERMINATED');
    const view = (p: any) => {
        const { reads, logs, rate, ...rest } = p;
        const running = p.status === 'RUNNING';
        const ports = (p.ports ?? []).map((x: string) => {
            const [n, type = 'tcp'] = x.split('/');
            // An http port rides RunPod's proxy network (a private address); a tcp port is mapped on the host's public IP.
            return type === 'http' ? { private: Number(n), public: Number(n), type, ip: '100.65.0.101' }
                : { private: Number(n), public: 40000 + Number(n) % 1000, type, ip: '194.68.245.10' };
        });
        const direct = ports.find((x: any) => x.private === 22 && x.type === 'tcp');
        return {
            ...rest, actions: ACTIONS[p.status] ?? [],
            runtime: running ? { uptime: 12, ports } : null,
            ssh: {
                proxy: p.dataCenterId ? { host: 'ssh.runpod.io', port: 22, username: `${p.id}-64411eb2`, command: `ssh ${p.id}-64411eb2@ssh.runpod.io` } : null,
                direct: running && direct ? { host: direct.ip, port: direct.public, username: 'root', command: `ssh root@${direct.ip} -p ${direct.public}` } : null,
            },
        };
    };

    /** A CPU pod: a flavor at a power-of-two vCPU count in its range, in a data center with stock of it; container disk and network volumes only. */
    const createCpuPod = (body: any): Response => {
        if (!body.name) return invalid(['$: missing property \'name\'']);
        if (!body.image) return problem(400, 'image is required unless templateId is set');
        if (body.mounts?.persistent) return problem(400, 'mounts.persistent is invalid when cpu is set');
        const c = CPUS.find((x) => x.id === body.cpu.id);
        const n = Number(body.cpu.vcpuCount);
        if (!c) return problem(400, `invalid CPU flavor id "${body.cpu.id}"`);
        if (!(Number.isInteger(n) && n >= c.vcpu.min && n <= c.vcpu.max && (n & (n - 1)) === 0)) return problem(400, `vcpuCount ${body.cpu.vcpuCount} is not valid for ${c.id}`);
        const inStock = Object.entries(c.stock).filter(([, [availability, ...counts]]) => availability !== 'NONE' && counts.includes(n)).map(([id]) => id);
        const dc = (body.dataCenterIds?.length ? body.dataCenterIds : inStock).find((id: string) => inStock.includes(id));
        if (!dc) return problem(400, 'There are no longer any instances available with the requested specifications. Please refresh and try again.');
        const network = body.mounts?.network?.[0];
        const mounted = network ? state.volumes.get(network.volumeId) : undefined;
        if (network && !mounted) return problem(400, `network volume ${network.volumeId} not found`);
        if (mounted && mounted.dataCenter !== dc) return problem(400, `network volume ${mounted.id} is in ${mounted.dataCenter}, not ${dc}: the pod must be in the volume's data center`);
        const id = `pod_${state.nextId++}`;
        const rate = c.price.securePerVcpu * n;
        const pod: any = { id, name: body.name, status: 'PROVISIONING', image: body.image, env: body.env ?? {}, ports: body.ports ?? [], cmd: body.cmd,
            ...(body.mounts ? { mounts: body.mounts } : {}), registry: body.registry ?? null, cpu: { id: c.id, vcpuCount: n, memory: c.ramGbPerVcpu * n },
            dataCenterId: dc, cudaVersion: null, cost: rate, rate, startedAt: null, createdAt: new Date().toISOString(), reads: 0 };
        pod.logs = containerRun(pod);
        state.pods.set(id, pod);
        return json(201, view(pod));
    };

    /** POST /v2/serverless's fields (unknown ones are refused), and the pools the catalog knows. */
    const ENDPOINT_FIELDS = new Set(['name', 'type', 'scaling', 'image', 'templateId', 'gpu', 'cpu', 'workers', 'timeout', 'flashboot', 'dataCenterIds',
        'networkVolumes', 'registry', 'disk', 'env', 'ports', 'args', 'entrypoint', 'cmd']);
    const pools = () => new Set(state.gpus.map((g) => g.pool).filter(Boolean));
    const endpointView = (e: any) => e;

    /** Serverless endpoints (REST v2): made in one call, read, listed by cursor, patched, deleted; their workers. */
    function serverless(method: string, path: string, u: URL, body: any): Response {
        let m: RegExpExecArray | null;
        if (path === '/v2/serverless' && method === 'POST') {
            const bad = Object.keys(body ?? {}).filter((k) => !ENDPOINT_FIELDS.has(k)).map((k) => `$: additional properties '${k}' not allowed`);
            if (typeof body?.name !== 'string' || !body.name) bad.push("$: missing property 'name'");
            if (!['QUEUE', 'LOAD_BALANCER'].includes(body?.type)) bad.push('$.type: value must be one of QUEUE, LOAD_BALANCER');
            const sc = body?.scaling;
            if (!(sc?.type === 'REQUEST_COUNT' && Number.isInteger(sc.requestCount) && sc.requestCount >= 1) && !(sc?.type === 'QUEUE_DELAY' && sc.queueDelay >= 0.5)) bad.push('$.scaling: does not match any variant');
            const w = body?.workers ?? {};
            if ((w.min !== undefined && !(Number.isInteger(w.min) && w.min >= 0)) || (w.max !== undefined && !(Number.isInteger(w.max) && w.max >= 0))) bad.push('$.workers: min and max are integers from 0');
            if (w.idleTimeout !== undefined && !(Number.isInteger(w.idleTimeout) && w.idleTimeout >= 1 && w.idleTimeout <= 3600)) bad.push('$.workers.idleTimeout: must be 1-3600');
            for (const p of body?.ports ?? []) if (!/^\d+\/(http|tcp)$/.test(p)) bad.push(`$.ports: "${p}" does not match pattern`);
            if (bad.length) return invalid(bad);
            if (body.type === 'LOAD_BALANCER' && sc.type !== 'REQUEST_COUNT') return problem(400, 'a load-balancing endpoint scales on REQUEST_COUNT');
            if (!body.image && !body.templateId) return problem(400, 'image is required unless templateId is set');
            if (Boolean(body.gpu) === Boolean(body.cpu)) return problem(400, 'exactly one of gpu and cpu is required');
            if (body.gpu) {
                if (!body.gpu.pools?.length || body.gpu.pools.some((p: string) => !pools().has(p))) return problem(400, `unknown GPU pool in ${JSON.stringify(body.gpu.pools)}`);
                if ((body.gpu.excludedTypes ?? []).some((t: string) => !state.gpus.some((g) => g.id === t))) return problem(400, 'unknown GPU type in excludedTypes');
            }
            for (const c of body.cpu ?? []) {
                const flavor = CPUS.find((x) => x.id === c.id);
                const n = Number(c.vcpuCount);
                if (!flavor) return problem(400, `invalid CPU flavor id "${c.id}"`);
                if (!(Number.isInteger(n) && n >= 2 && n >= flavor.vcpu.min && n <= flavor.vcpu.max && (n & (n - 1)) === 0)) return problem(400, `vcpuCount ${c.vcpuCount} is not valid for ${c.id}`);
            }
            if (body.registry != null && !state.registries.has(body.registry)) return problem(400, `registry ${body.registry} not found`);
            const id = Math.random().toString(36).slice(2, 10) + (state.nextId++).toString(36).padStart(6, '0');
            const base = `https://${id}.api.runpod.ai`;
            const q = `https://api.runpod.ai/v2/${id}`;
            const e = {
                id, name: body.name, type: body.type, image: body.image, env: body.env ?? {}, ports: body.ports ?? [],
                ...(body.cmd ? { cmd: body.cmd } : {}), ...(body.entrypoint ? { entrypoint: body.entrypoint } : {}), disk: body.disk ?? 10, registry: body.registry ?? null,
                requestUrls: body.type === 'LOAD_BALANCER' ? { base, health: `${base}/ping` }
                    : { run: `${q}/run`, runSync: `${q}/runsync`, status: `${q}/status`, stream: `${q}/stream`, cancel: `${q}/cancel`, retry: `${q}/retry`, purgeQueue: `${q}/purge-queue`, health: `${q}/health` },
                gpu: body.gpu ? { pools: body.gpu.pools, ...(body.gpu.excludedTypes ? { excludedTypes: body.gpu.excludedTypes } : {}), count: body.gpu.count ?? 1, allowedCudaVersions: [], minCudaVersion: null } : null,
                ...(body.cpu ? { cpu: body.cpu.map((c: any) => ({ ...c, memory: CPUS.find((x) => x.id === c.id)!.ramGbPerVcpu * c.vcpuCount })) } : {}),
                workers: { min: w.min ?? 0, max: w.max ?? 3, idleTimeout: w.idleTimeout ?? 10 }, scaling: sc,
                dataCenterIds: body.dataCenterIds ?? [], networkVolumes: body.networkVolumes ?? [], timeout: body.timeout ?? 300000, flashboot: body.flashboot ?? 'OFF',
                createdAt: new Date().toISOString(),
            };
            state.endpoints.set(id, e);
            state.workers.set(id, { cold: o.coldRequests ?? 1, up: 0 });
            return json(201, endpointView(e));
        }
        if (path === '/v2/serverless' && method === 'GET') {
            const all = [...state.endpoints.values()];
            const limit = Number(u.searchParams.get('limit') ?? 1000);
            const start = Number(u.searchParams.get('cursor') ?? 0);
            const page = all.slice(start, start + limit);
            const more = start + page.length < all.length;
            return json(200, { endpoints: page.map(endpointView), pagination: { nextCursor: more ? String(start + page.length) : null, hasNextPage: more } });
        }
        if ((m = /^\/v2\/serverless\/([^/]+)(\/workers)?$/.exec(path))) {
            const e = state.endpoints.get(m[1]);
            if (!e) return problem(404, `endpoint ${m[1]} not found`);
            if (m[2]) {
                const up = state.workers.get(e.id)?.up ?? 0;
                return json(200, { endpointVersion: 1, summary: { running: 0, idle: up, initializing: 0, throttled: 0, unhealthy: 0, total: up },
                    workers: up ? [{ id: `w-${e.id}`, status: 'IDLE', isStale: false, version: 1, gpuCount: e.gpu?.count ?? 0, image: e.image }] : [] });
            }
            if (method === 'GET') return json(200, endpointView(e));
            if (method === 'PATCH') {
                if (body?.type !== undefined && body.type !== e.type) return problem(400, 'type cannot change');
                if (body?.workers) {
                    e.workers = { ...e.workers, ...body.workers };
                    // Scaled to no workers: the one up is stopped.
                    if (e.workers.max === 0) state.workers.set(e.id, { cold: 0, up: 0 });
                }
                for (const k of ['name', 'scaling', 'env', 'image', 'timeout', 'flashboot']) if (body?.[k] !== undefined) e[k] = body[k];
                return json(200, endpointView(e));
            }
            if (method === 'DELETE') {
                state.endpoints.delete(e.id);
                state.workers.delete(e.id);
                return new Response(null, { status: 204 });
            }
        }
        return problem(404, `no route ${method} ${path}`);
    }

    async function fetchImpl(url: string | URL | Request, init?: RequestInit): Promise<Response> {
        const { u, method, body, auth, path } = readRequest(calls, url, init);
        if (auth !== `Bearer ${token}`) return problem(401, 'missing bearer token');
        let m: RegExpExecArray | null;
        // A request to a load-balancing endpoint's workers: https://<id>.api.runpod.ai/<path>.
        if ((m = /^([a-z0-9]+)\.api\.runpod\.ai$/.exec(u.host))) {
            const e = state.endpoints.get(m[1]);
            if (!e || e.type !== 'LOAD_BALANCER') return json(404, { error: 'endpoint not found' });
            const w = state.workers.get(e.id)!;
            if (!w.up) {
                if (e.workers.max < 1 || w.cold > 0) {
                    if (e.workers.max >= 1) w.cold--;
                    return json(400, { error: 'no workers available' });
                }
                w.up = 1;
            }
            return json(200, { worker: `w-${e.id}`, method, path, query: u.search, image: e.image, port: Number(e.env.PORT) });
        }
        if (path === '/v2/serverless' || path.startsWith('/v2/serverless/')) return serverless(method, path, u, body);
        if (method === 'GET' && path === '/v2/catalog/gpus') {
            const include = u.searchParams.get('include');
            if (Boolean(include) !== Boolean(u.searchParams.get('product'))) return problem(400, 'product is required with include=AVAILABILITY, and valid only with it');
            for (const k of ['count', 'cloud', 'minCudaVersion']) if (u.searchParams.get(k) !== null && !include) return problem(400, `${k} is valid only with include=AVAILABILITY`);
            const products = (u.searchParams.get('product') ?? '').split(',').filter(Boolean);
            if (products.some((x) => !['POD', 'CLUSTER', 'SERVERLESS'].includes(x))) return invalid(['product: must be POD, CLUSTER or SERVERLESS']);
            const cloud = u.searchParams.get('cloud') ?? 'SECURE';
            if (!['SECURE', 'COMMUNITY'].includes(cloud)) return invalid(['cloud: must be SECURE or COMMUNITY']);
            const count = Number(u.searchParams.get('count') ?? 1);
            if (!(Number.isInteger(count) && count >= 1)) return invalid(['count: must be an integer from 1']);
            const minCuda = u.searchParams.get('minCudaVersion');
            if (minCuda !== null && !/^\d+(\.\d+)?$/.test(minCuda)) return invalid([`minCudaVersion: does not match pattern`]);
            // Pods (and clusters) are on the cloud asked; serverless workers are their pool's.
            const contexts = [...new Set(products.map((x) => (x === 'SERVERLESS' ? 'SERVERLESS' : cloud) as 'SECURE' | 'COMMUNITY' | 'SERVERLESS'))];
            const RANK = ['NONE', 'LOW', 'MEDIUM', 'HIGH'];
            return json(200, {
                gpus: state.gpus.map(({ dataCenters, ...g }) => {
                    if (!include) return g;
                    // The data centers that offer the type in the asked configuration, each at its best stock among the contexts asked.
                    const dcs = dataCenters.filter((d) => minCuda === null || cudaAtLeast(d.cuda, minCuda)).flatMap((d) => {
                        const levels = contexts.map((c) => stockIn(d, c, count)).filter((x): x is string => x !== undefined);
                        return levels.length ? [{ id: d.id, cuda: d.cuda, availability: levels.sort((a, b) => RANK.indexOf(b) - RANK.indexOf(a))[0] }] : [];
                    });
                    const versions = new Map<string, boolean>();
                    for (const d of dcs) if (d.cuda) versions.set(d.cuda, (versions.get(d.cuda) ?? false) || d.availability !== 'NONE');
                    return {
                        ...g,
                        availability: dcs.some((d) => d.availability !== 'NONE') ? 'HIGH' : 'NONE',
                        ...(dcs.length ? { dataCenters: dcs.map(({ cuda, ...d }) => ({ ...d, name: d.id })) } : {}),
                        ...(versions.size ? { cudaVersions: [...versions].map(([version, available]) => ({ version, available })) } : {}),
                    };
                }),
            });
        }
        if (method === 'GET' && path === '/v2/catalog/cpus') {
            const include = u.searchParams.get('include');
            if (Boolean(include) !== Boolean(u.searchParams.get('product'))) return problem(400, 'product is required with include=AVAILABILITY, and valid only with it');
            const count = u.searchParams.get('vcpuCount');
            if (count !== null && !include) return problem(400, 'vcpuCount is valid only with include=AVAILABILITY');
            const n = count === null ? null : Number(count);
            if (n !== null && !(Number.isInteger(n) && n >= 2 && (n & (n - 1)) === 0)) return invalid(['vcpuCount: must be a power of two from 2']);
            return json(200, {
                cpus: CPUS.map(({ stock, ...c }) => {
                    if (!include) return c;
                    // Stock per data center for the count asked (any count when none is asked).
                    const dcs = Object.entries(stock).map(([id, [availability, ...counts]]) => ({ id, availability: n === null || counts.includes(n) ? String(availability) : 'NONE' }));
                    return { ...c, availability: dcs.some((d) => d.availability !== 'NONE') ? 'HIGH' : 'NONE', dataCenters: dcs };
                }),
            });
        }
        if (method === 'POST' && path === '/v2/pods') {
            const bad = Object.keys(body ?? {}).filter((k) => !CREATE_FIELDS.has(k)).map((k) => `$: additional properties '${k}' not allowed`);
            bad.push(...Object.keys(body?.gpu ?? {}).filter((k) => !GPU_FIELDS.has(k)).map((k) => `$.gpu: additional properties '${k}' not allowed`));
            bad.push(...Object.keys(body?.cpu ?? {}).filter((k) => !CPU_FIELDS.has(k)).map((k) => `$.cpu: additional properties '${k}' not allowed`));
            if (body?.gpu?.minCudaVersion !== undefined && !/^\d+\.\d+$/.test(String(body.gpu.minCudaVersion))) bad.push('$.gpu.minCudaVersion: does not match pattern ^\\d+\\.\\d+$');
            if (body?.disk !== undefined && !Number.isInteger(body.disk)) bad.push('$.disk: expected integer');
            if (body?.mounts?.persistent?.size !== undefined && !Number.isInteger(body.mounts.persistent.size)) bad.push('$.mounts.persistent.size: expected integer');
            if (bad.length) return invalid(bad);
            // Exactly one of gpu and cpu (enforced at the handler).
            if (Boolean(body?.gpu) === Boolean(body?.cpu)) return problem(400, 'exactly one of gpu or cpu must be set');
            if (body.cpu) return createCpuPod(body);
            if (!body?.name || !body.gpu?.id) return invalid(['$: missing property \'name\' or \'gpu\'']);
            if (!body.image) return problem(400, 'image is required unless templateId is set');
            const network = body.mounts?.network;
            if (network !== undefined && (!Array.isArray(network) || network.length > 1)) return invalid(['$.mounts.network: maxItems 1']);
            if (network?.some((m: any) => !m?.volumeId || !m?.path)) return invalid(['$.mounts.network[0]: missing property \'volumeId\' or \'path\'']);
            if (network?.length && body.mounts?.persistent) return problem(400, 'mounts.persistent and mounts.network are mutually exclusive');
            const mounted = network?.length ? state.volumes.get(network[0].volumeId) : undefined;
            if (network?.length && !mounted) return problem(400, `network volume ${network[0].volumeId} not found`);
            if (body.registry !== undefined && !state.registries.has(body.registry)) return problem(400, `container registry auth ${body.registry} not found`);
            const g = state.gpus.find((x) => x.id === body.gpu.id);
            if (!g) return problem(400, `invalid GPU type id "${body.gpu.id}"`);
            const cloud: 'SECURE' | 'COMMUNITY' = body.cloud ?? 'SECURE';
            if (!['SECURE', 'COMMUNITY'].includes(cloud)) return invalid(['$.cloud: must be SECURE or COMMUNITY']);
            const count = body.gpu.count ?? 1;
            const minCuda = body.gpu.minCudaVersion;
            // A machine of the type on the cloud asked, with `count` GPUs free, whose CUDA is new enough.
            const inStock = g.dataCenters.filter((d) => ![undefined, 'NONE'].includes(stockIn(d, cloud, count)) && (!minCuda || cudaAtLeast(d.cuda, minCuda)));
            const dc = (body.dataCenterIds?.length ? body.dataCenterIds : inStock.map((d) => d.id)).map((id: string) => inStock.find((d) => d.id === id)).find(Boolean);
            if (!dc) return problem(400, 'There are no longer any instances available with the requested specifications. Please refresh and try again.');
            // A network volume is mounted only by a pod in its own data center.
            if (mounted && mounted.dataCenter !== dc.id) return problem(400, `network volume ${mounted.id} is in ${mounted.dataCenter}, not ${dc.id}: the pod must be in the volume's data center`);
            // Once a machine is found, a pod without a container disk is refused, whatever the spec says (observed 2026-10-01).
            if (body.disk === undefined && !body.templateId) return problem(400, 'You must either provide a template id or pod configuration parameters');
            const id = `pod_${state.nextId++}`;
            const pod: any = { id, name: body.name, status: 'PROVISIONING', image: body.image, env: body.env ?? {}, ports: body.ports ?? [], cmd: body.cmd,
                ...(body.mounts ? { mounts: body.mounts } : {}), registry: body.registry ?? null,
                gpu: { id: g.id, count }, cloud, dataCenterId: dc.id, cudaVersion: dc.cuda,
                // Billed at its cloud's rate, for each of its GPUs.
                cost: Number(g.price[cloud === 'SECURE' ? 'secure' : 'community']) * count, rate: Number(g.price[cloud === 'SECURE' ? 'secure' : 'community']) * count, startedAt: null,
                createdAt: new Date().toISOString(), reads: 0 };
            pod.logs = containerRun(pod);
            state.pods.set(id, pod);
            return json(201, view(pod));
        }
        if (method === 'GET' && path === '/v2/pods') {
            const all = [...state.pods.values()].filter((x) => x.status !== 'TERMINATED');
            const limit = Number(u.searchParams.get('limit') ?? 1000);
            const at = Number(u.searchParams.get('cursor') ?? 0);
            const next = at + limit < all.length ? String(at + limit) : null;
            return json(200, { pods: all.slice(at, at + limit).map(view), pagination: { nextCursor: next, hasNextPage: next !== null } });
        }
        if ((m = /^\/v2\/pods\/([^/]+)$/.exec(path))) {
            const pod = state.pods.get(m[1]);
            if (!pod || pod.status === 'TERMINATED') return problem(404, 'resource not found');
            if (method === 'GET') {
                pod.reads++;
                if (pod.status === 'PROVISIONING' && pod.reads >= 1) pod.status = 'STARTING';
                // Its run (and its billing) starts once it is running: startedAt (v2 spec, 2026-10-02).
                else if (pod.status === 'STARTING' && pod.reads >= state.bootReads) Object.assign(pod, { status: 'RUNNING', startedAt: new Date().toISOString() });
                return json(200, view(pod));
            }
            if (method === 'DELETE') {
                pod.status = 'TERMINATED';
                return new Response(null, { status: 204 });
            }
        }
        if (method === 'POST' && (m = /^\/v2\/pods\/([^/]+)\/action$/.exec(path))) {
            const pod = state.pods.get(m[1]);
            if (!pod || pod.status === 'TERMINATED') return problem(404, 'resource not found');
            if (!(ACTIONS[pod.status] ?? []).includes(body?.action)) return problem(409, `cannot ${body?.action} a pod that is ${pod.status}`);
            if (body.action === 'stop') Object.assign(pod, { status: 'EXITED', cost: 0, startedAt: null });
            if (body.action === 'start') {
                Object.assign(pod, { status: 'STARTING', reads: 0, cost: pod.rate });
                if (state.resumeWithoutGpu) delete pod.gpu;
                pod.logs.push(...containerRun(pod));
            }
            // A restart runs the container's command again: the log keeps every run, as a container's does.
            if (body.action === 'restart') pod.logs.push(...containerRun(pod));
            if (body.action === 'terminate') {
                pod.status = 'TERMINATED';
                return new Response(null, { status: 204 });
            }
            return json(200, view(pod));
        }
        if (method === 'GET' && (m = /^\/v2\/pods\/([^/]+)\/logs$/.exec(path))) {
            const pod = state.pods.get(m[1]);
            if (!pod) return problem(404, 'resource not found');
            const tail = Number(u.searchParams.get('tail') ?? 100);
            if (!(Number.isInteger(tail) && tail >= 0 && tail <= 5000)) return invalid(['tail: must be between 0 and 5000']);
            // Both sources unless one is asked for; the backfill is the last `tail` lines of those.
            const source = u.searchParams.get('source');
            if (source !== null && !['container', 'system'].includes(source)) return invalid(['source: must be one of container, system']);
            const lines = pod.logs.map((x: { source: string, line: string }, i: number) => ({ ...x, i })).filter((x: { source: string }) => source === null || x.source === source);
            const sse = lines.slice(lines.length - Math.min(tail, lines.length)).map((x: { source: string, line: string, i: number }) =>
                `id: 2026-09-29T12:00:00Z/${String(x.i).padStart(12, '0')}\ndata: ${JSON.stringify({ ts: '2026-09-29T12:00:00Z', source: x.source, line: x.line })}\n\n`).join('');
            return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
        }
        if (path === '/v2/registries') {
            if (method === 'GET') return json(200, { registries: [...state.registries.values()].map(({ id, name }) => ({ id, name })) });
            if (method === 'POST') {
                const bad = Object.keys(body ?? {}).filter((k) => !REGISTRY_FIELDS.has(k)).map((k) => `$: additional properties '${k}' not allowed`);
                for (const k of REGISTRY_FIELDS) if (typeof body?.[k] !== 'string' || !body[k]) bad.push(`$.${k}: expected a non-empty string`);
                if (bad.length) return invalid(bad);
                const id = `reg_${state.nextId++}`;
                state.registries.set(id, { id, name: body.name, username: body.username, password: body.password });
                return json(201, { id, name: body.name });
            }
        }
        if ((m = /^\/v2\/registries\/([^/]+)$/.exec(path))) {
            const r = state.registries.get(m[1]);
            if (!r) return problem(404, 'resource not found');
            if (method === 'GET') return json(200, { id: r.id, name: r.name });
            if (method === 'DELETE') {
                if (livePods().some((x) => x.registry === r.id)) return problem(400, 'Registry credential is in use by a pod and cannot be deleted');
                state.registries.delete(r.id);
                return new Response(null, { status: 204 });
            }
        }
        if (path === '/v2/network-volumes') {
            if (method === 'GET') return json(200, { networkVolumes: [...state.volumes.values()] });
            if (method === 'POST') {
                const bad = Object.keys(body ?? {}).filter((k) => !VOLUME_FIELDS.has(k)).map((k) => `$: additional properties '${k}' not allowed`);
                if (!Number.isInteger(body?.size) || body.size < 10 || body.size > 4096) bad.push('$.size: must be an integer between 10 and 4096');
                if (typeof body?.name !== 'string' || !body.name) bad.push('$.name: expected a non-empty string');
                if (body?.type !== undefined && !['STANDARD', 'HIGH_PERFORMANCE'].includes(body.type)) bad.push('$.type: must be one of STANDARD, HIGH_PERFORMANCE');
                if (bad.length) return invalid(bad);
                if (!dataCenters().has(body.dataCenter)) return problem(400, `invalid data center "${body.dataCenter}"`);
                const id = `vol_${state.nextId++}`;
                const v = { id, name: body.name, size: body.size, dataCenter: body.dataCenter, type: body.type ?? 'STANDARD' };
                state.volumes.set(id, v);
                return json(201, v);
            }
        }
        if ((m = /^\/v2\/network-volumes\/([^/]+)$/.exec(path))) {
            const v = state.volumes.get(m[1]);
            if (!v) return problem(404, 'resource not found');
            if (method === 'GET') return json(200, v);
            if (method === 'DELETE') {
                state.volumes.delete(v.id);
                return new Response(null, { status: 204 });
            }
        }
        if (path === '/v2/account/ssh-keys') {
            if (method === 'GET') return json(200, { keys: state.keys });
            if (method === 'PUT') {
                if (!Array.isArray(body?.keys)) return invalid(['$.keys: expected array']);
                const bad = body.keys.map((k: unknown, i: number) => (typeof k === 'string' && KEY_LINE.test(k) ? null : `$.keys[${i}]: does not match pattern`)).filter(Boolean);
                if (bad.length) return invalid(bad);
                state.keys = [...body.keys];
                return json(200, { keys: state.keys });
            }
        }
        return problem(404, `fake has no route ${method} ${path}`);
    }

    const api: FakeApi & { state: typeof state } = {
        fetchImpl: fetchImpl as typeof fetch,
        calls,
        state,
        liveServers: () => [...state.pods.values()].filter((x) => x.status !== 'TERMINATED').length,
    };
    return api;
}
