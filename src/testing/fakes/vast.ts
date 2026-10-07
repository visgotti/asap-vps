// A fetch() that answers like Vast.ai's REST API
// (docs.vast.ai/api-reference/openapi.json, read 2026-09-29) for the calls the
// GPU provider makes: the offer search with operator filters, renting an ask
// (410 no_such_ask once it is taken), instances that go loading -> running,
// PUT {state} to stop / start, reboot, DELETE, keyset pages of at most 25 from
// /api/v1/instances/, logs uploaded to a result_url on another host, and
// account keys (404 when there are none), a private registry's login
// (image_login, docker login arguments), and volumes (observed 2026-10-06):
// storage offers per machine, a volume made from one (its name letters, digits
// and underscores: 422 otherwise), listed as `created`, mounted by a rental on
// its machine (`volume_info`: `in-use`, the instance in its `instances`, and
// the instance's env a docker flag "-v <name>:<path>"; the instance list, not
// the single read, has the instance's `volume_info`), letting go of a deleted
// instance a read later, and deleted only once no instance mounts it. An
// instance's env is kept as [name, value] pairs. A snapshot (take_snapshot:
// the instance in the URL only, an `id` in the body too is a 400) is pushed to
// the registry it names a few requests later, if its login can push there
// (FAKE_SNAPSHOTS: a fake registry of the account's). Failures carry {success: false, error, msg}.

import { fakeRegistry } from './registry';
import { echoed, FakeApi, json, readRequest } from './util';

/** A registry of the account's with a repository snapshots are pushed to, and a login that can push to it. */
export const FAKE_SNAPSHOTS = { server: 'registry.fake', repository: 'acme/snapshots', username: 'pusher', password: 'push-secret' };

const ASKS = [
    { id: 101, gpu_name: 'RTX 4000Ada', num_gpus: 1, gpu_ram: 20475, dph_total: 0.21, min_bid: 0.12, geolocation: 'Texas, US', rentable: true,
        cuda_max_good: 12.9, reliability: 0.995, verified: true, machine_id: 11, cpu_cores_effective: 8, cpu_ram: 32768, disk_space: 200 },
    { id: 102, gpu_name: 'RTX A5000', num_gpus: 1, gpu_ram: 24564, dph_total: 0.23, min_bid: 0.14, geolocation: 'Quebec, CA', rentable: true,
        cuda_max_good: 12.8, reliability: 0.99, verified: true, machine_id: 12, cpu_cores_effective: 8, cpu_ram: 65536, disk_space: 400 },
    { id: 103, gpu_name: 'RTX 4090', num_gpus: 1, gpu_ram: 24564, dph_total: 0.45, min_bid: 0.3, geolocation: 'Sweden, SE', rentable: false,
        cuda_max_good: 12.9, reliability: 0.99, verified: true, machine_id: 13, cpu_cores_effective: 16, cpu_ram: 65536, disk_space: 800 },
    { id: 104, gpu_name: 'Tesla T4', num_gpus: 1, gpu_ram: 15360, dph_total: 0.1, min_bid: 0.05, geolocation: 'Ohio, US', rentable: true,
        cuda_max_good: 12.2, reliability: 0.98, verified: true, machine_id: 14, cpu_cores_effective: 4, cpu_ram: 16384, disk_space: 100 },
    { id: 105, gpu_name: 'RTX 3090', num_gpus: 2, gpu_ram: 24576, dph_total: 0.38, min_bid: 0.2, geolocation: 'Utah, US', rentable: true,
        cuda_max_good: 12.8, reliability: 0.9, verified: true, machine_id: 15, cpu_cores_effective: 16, cpu_ram: 65536, disk_space: 500 },
    // A card with more than 40 GB: a VRAM filter has something to keep, not just something to drop.
    { id: 106, gpu_name: 'RTX A6000', num_gpus: 1, gpu_ram: 49140, dph_total: 0.49, min_bid: 0.3, geolocation: 'Oregon, US', rentable: true,
        cuda_max_good: 12.8, reliability: 0.99, verified: true, machine_id: 16, cpu_cores_effective: 16, cpu_ram: 131072, disk_space: 500 },
];

/** What Vast reports per machine and filters on (gpu_arch, compute_cap: 890 for sm_89). */
const COMPUTE_CAP: Record<string, number> = {
    'RTX 4000Ada': 890, 'RTX A5000': 860, 'RTX 4090': 890, 'Tesla T4': 750, 'RTX 3090': 860, 'RTX 3060': 860, L4: 890, 'H100 SXM': 900, 'RTX A6000': 860,
};

const OPS: Record<string, (a: number, b: any) => boolean> = {
    eq: (a, b) => a === b, neq: (a, b) => a !== b, gt: (a, b) => a > b, gte: (a, b) => a >= b, lt: (a, b) => a < b, lte: (a, b) => a <= b,
    in: (a, b) => b.includes(a), notin: (a, b) => !b.includes(a),
};

/** Storage on each machine: what a volume is rented from. */
const VOLUME_ASKS = ASKS.map((a) => ({ id: 5000 + a.machine_id, machine_id: a.machine_id, disk_space: 400, storage_cost: 0.2, geolocation: a.geolocation, reliability: a.reliability }));

export function fakeVast(o: { token?: string, bootReads?: number, seededInstances?: number, volumeReleaseReads?: number, snapshotReads?: number } = {}) {
    const token = o.token ?? 'vast-test';
    const calls: FakeApi['calls'] = [];
    const state = {
        asks: ASKS.map((a) => ({ ...a })),
        instances: new Map<string, any>(),
        keys: new Map<string, any>(),
        logs: new Map<string, { text: string, fetchesBeforeReady: number }>(),
        nextId: 9000,
        bootReads: o.bootReads ?? 2,
        failNextRentWith: 0,
        /** The next start finds its machine's GPU taken: Vast queues it (observed 2026-10-02). */
        queueNextStart: false,
        volumeAsks: VOLUME_ASKS.map((v) => ({ ...v })),
        volumes: new Map<string, any>(),
        /** Volume list reads during which a deleted instance is still listed as mounting its volume. */
        volumeReleaseReads: o.volumeReleaseReads ?? 1,
        /** Snapshots asked for, each pushed once its requests are spent. */
        snapshots: [] as Array<{ repo: string, tag: string, content: string, left: number }>,
        snapshotReads: o.snapshotReads ?? 2,
    };
    const registry = fakeRegistry(FAKE_SNAPSHOTS.server, { users: { [FAKE_SNAPSHOTS.username]: FAKE_SNAPSHOTS.password } });
    /** A request: time passes for the snapshots being pushed. */
    const tick = () => {
        for (const x of state.snapshots) if (--x.left === 0) registry.push(x.repo, x.tag, x.content);
    };
    // A network volume, withdrawn in July 2026 but still listed for an account that had one.
    state.volumes.set('7001', { id: 7001, label: 'old_network', status: 'created', machine_id: 0, type: 'network', disk_space: 50, instances: [], start_date: 1_750_000_000 });
    // More than one page of someone's existing instances (the API pages at 25).
    for (let i = 0; i < (o.seededInstances ?? 27); i++) {
        const id = state.nextId++;
        state.instances.set(String(id), { id, label: i % 2 ? `sd-box-${i}` : null, actual_status: 'running', cur_state: 'running', intended_status: 'running',
            gpu_name: 'RTX 3090', num_gpus: 1, geolocation: 'Utah, US', dph_total: 0.2, machine_id: 99, start_date: 1_700_000_000, reads: 99 });
    }
    const fail = (status: number, error: string, msg: string) => json(status, { success: false, error, msg });
    /** What one run of an instance's container prints: only what its command prints (nvidia-smi -L: a line per GPU; its echoes). */
    const containerRun = (i: any): string => {
        const gpus = String(i.image_args ?? '').includes('nvidia-smi')
            ? Array.from({ length: Number(i.num_gpus ?? 1) }, (_, k) => `GPU ${k}: NVIDIA ${i.gpu_name} (UUID: GPU-9a8b7c6d-${k})\n`).join('') : '';
        return `${gpus}${echoed(i.image_args, Object.fromEntries(i.extra_env ?? [])).map((l) => `${l}\n`).join('')}`;
    };
    /** A start or a reboot runs the container again: the log keeps every run, as docker's does. */
    const rerun = (id: string) => {
        const l = state.logs.get(id);
        const i = state.instances.get(id);
        if (l && i) l.text += containerRun(i);
    };
    /** An instance as the single read has it: no volume_info (the list's alone). */
    const view = (i: any) => {
        const { reads, relaunching, volume_info: _, ...rest } = i;
        return rest;
    };
    /** A read of one instance (alone, or the list filtered to it): time passes for it, its container loads, then runs. */
    const readOne = (i: any) => {
        i.reads++;
        if (i.actual_status === null && i.reads >= 1) i.actual_status = 'loading';
        // A started or rebooted container still reads as it was left (exited) for a while, then loads (observed 2026-10-02).
        else if (i.actual_status === 'exited' && i.relaunching && i.reads >= 2) Object.assign(i, { actual_status: 'loading', relaunching: false, reads: 0 });
        else if (i.actual_status === 'loading' && i.reads >= state.bootReads && i.intended_status === 'running') i.actual_status = 'running';
    };
    /** An instance as the list has it. */
    const listView = (i: any) => {
        const { reads, relaunching, ...rest } = i;
        return rest;
    };
    const volumeView = (v: any) => {
        const { leaving, ...rest } = v;
        return rest;
    };
    /** A list read: a deleted instance's volumes let go of it once its last read is spent. */
    const volumeRead = () => {
        for (const v of state.volumes.values()) {
            for (const [id, left] of Object.entries(v.leaving ?? {}) as Array<[string, number]>) {
                if (left <= 0) {
                    v.instances = v.instances.filter((x: number) => String(x) !== id);
                    if (!v.instances.length) v.status = 'created';
                    delete v.leaving[id];
                } else v.leaving[id] = left - 1;
            }
        }
    };

    async function fetchImpl(url: string | URL | Request, init?: RequestInit): Promise<Response> {
        tick();
        const host = new URL(String(url)).host;
        if (host === FAKE_SNAPSHOTS.server || host === `auth.${FAKE_SNAPSHOTS.server}`) return registry.fetchImpl(url, init);
        const { u, method, body, auth, path } = readRequest(calls, url, init);
        if (u.host === 'logs.fake') {
            const l = state.logs.get(path.slice(1));
            if (!l || l.fetchesBeforeReady-- > 0) return new Response('<Error><Code>NoSuchKey</Code></Error>', { status: 404, headers: { 'content-type': 'application/xml' } });
            // The last `tail` lines the request asked for.
            const lines = l.text.split('\n').filter((x, k, all) => x !== '' || k < all.length - 1);
            const tail = Number(u.searchParams.get('tail') ?? lines.length);
            return new Response(lines.slice(-tail).map((x) => `${x}\n`).join(''), { status: 200, headers: { 'content-type': 'text/plain' } });
        }
        // What the real API answers (observed 2026-09-29): a 404, not a 401.
        if (auth !== `Bearer ${token}`) return fail(404, 'auth_error', 'Invalid user key');
        let m: RegExpExecArray | null;
        if (method === 'POST' && path === '/api/v0/bundles/') {
            let offers = state.asks
                .map((a: any) => ({ gpu_arch: /MI\d|Radeon/i.test(a.gpu_name) ? 'amd' : 'nvidia', compute_cap: COMPUTE_CAP[a.gpu_name] ?? 0, ask_contract_id: a.id, ...a }))
                .map((a) => (body.type === 'bid' ? { ...a, dph_total: a.min_bid, is_bid: true } : a));
            for (const [field, cond] of Object.entries(body)) {
                if (!cond || typeof cond !== 'object' || Array.isArray(cond)) continue;
                // An offer is found by ask_contract_id: a filter on `id` matches no offer at all (observed 2026-10-02).
                if (field === 'id') offers = [];
                for (const [op, v] of Object.entries(cond as Record<string, unknown>)) {
                    offers = offers.filter((a: any) => OPS[op]?.(a[field], v) ?? true);
                }
            }
            offers.sort((a, b) => a.dph_total - b.dph_total);
            // Vast returns at most 64 offers whatever `limit` asks for (observed 2026-09-29).
            return json(200, { offers: offers.slice(0, Math.min(64, body.limit ?? 64)) });
        }
        if (method === 'PUT' && (m = /^\/api\/v0\/asks\/(\d+)\/$/.exec(path))) {
            if (state.failNextRentWith) {
                const status = state.failNextRentWith;
                state.failNextRentWith = 0;
                return fail(status, 'server_error', 'upstream timeout');
            }
            const ask = state.asks.find((a) => String(a.id) === m![1]);
            // An offer Vast does not have: the spec's 404, whose error is invalid_args (only its message says no_such_ask).
            if (!ask) return json(404, { success: false, error: 'invalid_args', msg: `error 404/3603: no_such_ask Instance type by id ${m[1]} is not available.`, ask_id: Number(m[1]) });
            // One rented since it was listed: the spec's 410 (the answer with cancel_unavail).
            if (!ask.rentable) return json(410, { success: false, error: 'no_such_ask', msg: `error 410/3907: no_such_ask Instance type ${m[1]} is no longer available.`, ask_id: Number(m[1]) });
            if (!body?.image) return fail(400, 'invalid_args', 'error 400/3467: Invalid args: image is required');
            // env is a JSON object (the create guide: a docker-flags STRING is not applied). The real API
            // ignores a string silently; the fake refuses it, so sending one fails loudly.
            if (body.env !== undefined && (typeof body.env !== 'object' || Array.isArray(body.env))) {
                return fail(400, 'invalid_args', 'env must be an object');
            }
            if (body.price !== undefined && !(Number(body.price) >= Number(ask.min_bid ?? 0))) return fail(400, 'invalid_args', 'bid below the minimum');
            // In the args launch mode `onstart` is the container's ENTRYPOINT (the CLI sends --entrypoint there): a program name.
            if (body.onstart !== undefined && (typeof body.onstart !== 'string' || !body.onstart)) return fail(400, 'invalid_args', 'onstart must be a string');
            // The private registry's login: `docker login` arguments in one string ('-u <user> -p <password> <host>').
            if (body.image_login !== undefined && !(typeof body.image_login === 'string' && /^-u \S+ -p \S+ \S+$/.test(body.image_login))) {
                return fail(400, 'invalid_args', 'image_login must be "-u <user> -p <password> <registry>"');
            }
            // A volume to mount: an existing one (create_new false) of this machine, at an absolute path.
            const vi = body.volume_info;
            const volume = vi ? state.volumes.get(String(vi.volume_id)) : undefined;
            if (vi) {
                if (vi.create_new !== false || !volume) return fail(400, 'invalid_args', 'volume_info: no such volume');
                if (volume.machine_id !== ask.machine_id) return fail(400, 'invalid_args', 'volume_info: the volume is on another machine');
                if (volume.instances.length) return fail(400, 'invalid_args', 'volume_info: the volume is in use');
                if (!/^\/\S*$/.test(String(vi.mount_path))) return fail(400, 'invalid_args', 'volume_info: mount_path must be an absolute path');
            }
            ask.rentable = false;
            const id = state.nextId++;
            // Each "-p N:N" key opens container port N, mapped to a RANDOM public port.
            const ports: Record<string, Array<{ HostIp: string, HostPort: string }>> = {};
            for (const k of Object.keys(body.env ?? {})) {
                const pm = /^-p (\d+):\d+(\/udp)?$/.exec(k);
                if (pm) ports[`${pm[1]}/${pm[2] ? 'udp' : 'tcp'}`] = [{ HostIp: '0.0.0.0', HostPort: String(40000 + (Number(pm[1]) * 7) % 20000) }];
            }
            // The env as pairs; a volume's mount among them as a docker flag on its name.
            const extraEnv: Array<[string, string]> = [...Object.entries((body.env ?? {}) as Record<string, string>), ...(volume ? [[`-v ${volume.label}:${vi.mount_path}`, '1'] as [string, string]] : [])];
            state.instances.set(String(id), { id, label: body.label ?? null, image_uuid: body.image, extra_env: extraEnv, image_args: body.args, onstart: body.onstart,
                actual_status: null, cur_state: 'running', intended_status: 'running', gpu_name: ask.gpu_name, num_gpus: ask.num_gpus,
                geolocation: ask.geolocation, dph_total: body.price !== undefined ? Number(body.price) : ask.dph_total, is_bid: body.price !== undefined,
                machine_id: ask.machine_id, start_date: Date.now() / 1000, ports,
                ...(volume ? { volume_info: [{ id: volume.id, label: volume.label, created_from: 5000 + volume.machine_id, avail_space: volume.disk_space, total_space: volume.disk_space, type: 'machine' }] } : {}),
                public_ipaddr: `198.51.100.${id % 250}\n`, ssh_host: 'ssh5.vast.ai', ssh_port: 20000 + (id % 1000), reads: 0 });
            state.logs.set(String(id), { text: containerRun(state.instances.get(String(id))), fetchesBeforeReady: 1 });
            if (volume) Object.assign(volume, { instances: [...volume.instances, id], status: 'in-use' });
            return json(200, { success: true, new_contract: id });
        }
        if (method === 'GET' && path === '/api/v1/instances/') {
            // select_filters: {"id": {"eq": <id>}} (what a read of one instance sends).
            const filters = JSON.parse(u.searchParams.get('select_filters') ?? '{}') as Record<string, Record<string, unknown>>;
            const all = [...state.instances.values()].filter((i) => Object.entries(filters).every(([f, cond]) => Object.entries(cond).every(([op, v]) => OPS[op]?.(i[f], v) ?? true)));
            if (filters.id) all.forEach(readOne);
            const limit = Math.min(25, Number(u.searchParams.get('limit') ?? 25));
            const after = u.searchParams.get('after_token');
            const at = after ? Number(Buffer.from(after, 'base64').toString()) : 0;
            if (!Number.isFinite(at)) return fail(400, 'invalid_args', 'invalid after_token');
            const next = at + limit < all.length ? Buffer.from(String(at + limit)).toString('base64') : null;
            const page = all.slice(at, at + limit);
            return json(200, { success: true, instances_found: page.length, total_instances: all.length, instances: page.map(listView), next_token: next });
        }
        if ((m = /^\/api\/v0\/instances\/(\d+)\/$/.exec(path))) {
            const i = state.instances.get(m[1]);
            // One Vast does not have. Its read answers 200 with no instance (seen live 2026-10-07: `{"instances":null}`);
            // its delete, the spec's 404 not_found (which the spec gives its update too, without a body).
            if (!i) return method === 'GET' ? json(200, { instances: null }) : fail(404, 'not_found', 'Instance not found');
            if (method === 'GET') {
                readOne(i);
                return json(200, { instances: view(i) });
            }
            if (method === 'PUT') {
                if (body?.state === 'stopped') Object.assign(i, { cur_state: 'stopped', intended_status: 'stopped', actual_status: 'exited' });
                if (body?.state === 'running') {
                    // Its machine's GPU is someone else's now: the start is queued, a 200 that says it failed (observed 2026-10-02).
                    if (state.queueNextStart) {
                        state.queueNextStart = false;
                        i.intended_status = 'running';
                        return json(200, { success: false, msg: 'Required resources are currently unavailable, state change queued.' });
                    }
                    Object.assign(i, { cur_state: 'running', intended_status: 'running', actual_status: 'exited', relaunching: true, reads: 0 });
                    rerun(m[1]);
                }
                if (body?.label) i.label = body.label;
                return json(200, { success: true });
            }
            if (method === 'DELETE') {
                state.instances.delete(m[1]);
                // Its volumes list it a while longer.
                for (const v of state.volumes.values()) {
                    if (v.instances.some((x: number) => String(x) === m![1])) v.leaving = { ...v.leaving, [m[1]]: state.volumeReleaseReads };
                }
                return json(200, { success: true, msg: 'destroying instance' });
            }
        }
        if (method === 'POST' && (m = /^\/api\/v0\/instances\/take_snapshot\/(\d+)\/$/.exec(path))) {
            // The instance is the URL's alone (observed 2026-10-06).
            if (body?.id !== undefined) return fail(400, 'invalid_args', "params duplicated in URL and body: ['id']");
            const i = state.instances.get(m[1]);
            if (!i) return fail(404, 'no_such_instance', 'Instance not found');
            const repo = String(body?.personal_repo ?? '');
            if (!repo || !body?.container_registry || !body?.docker_login_user || !body?.docker_login_pass) {
                return fail(400, 'invalid_args', 'container_registry, personal_repo, docker_login_user and docker_login_pass are required');
            }
            // The repository has no tag: Vast appends its own (observed 2026-10-06).
            if (/[:@]/.test(repo.replace(/^[^/]+:\d+\//, ''))) {
                return fail(400, 'invalid_args', 'Invalid Docker repository format. Expected [registry[:port]/]namespace/repo with no tag or digest — the snapshot tag is appended by the server.');
            }
            // Pushed later where the repository names the registry (else to Docker Hub: never seen here) and the login can push,
            // tagged with the instance and the time: instance_54548215_at_October_6th_2026_at_10-08-32_PM_UTC.
            const host = `${FAKE_SNAPSHOTS.server}/`;
            if (repo.startsWith(host) && body.docker_login_user === FAKE_SNAPSHOTS.username && body.docker_login_pass === FAKE_SNAPSHOTS.password) {
                const t = new Date(Date.UTC(2026, 9, 6, 22, 8, state.snapshots.length));
                const hour = t.getUTCHours() % 12 || 12;
                const tag = `instance_${i.id}_at_October_6th_2026_at_${hour}-${String(t.getUTCMinutes()).padStart(2, '0')}-${String(t.getUTCSeconds()).padStart(2, '0')}_${t.getUTCHours() < 12 ? 'AM' : 'PM'}_UTC`;
                state.snapshots.push({ repo: repo.slice(host.length), tag, content: String(i.label), left: state.snapshotReads });
            }
            return json(200, { success: true, msg: 'Snapshot request sent' });
        }
        if (method === 'PUT' && (m = /^\/api\/v0\/instances\/reboot\/(\d+)\/$/.exec(path))) {
            const i = state.instances.get(m[1]);
            if (!i) return fail(404, 'no_such_instance', 'Instance not found');
            Object.assign(i, { actual_status: 'exited', relaunching: true, reads: 0 });
            rerun(m[1]);
            return json(200, { success: true });
        }
        if (method === 'PUT' && (m = /^\/api\/v0\/instances\/request_logs\/(\d+)\/$/.exec(path))) {
            if (!state.instances.has(m[1])) return fail(404, 'no_such_instance', 'Instance not found');
            // The upload holds the last `tail` lines (a string, as the CLI sends it).
            const tail = body?.tail !== undefined ? `?tail=${Number(body.tail)}` : '';
            return json(200, { success: true, result_url: `https://logs.fake/${m[1]}${tail}`, msg: 'Logs will be uploaded shortly' });
        }
        if (method === 'POST' && path === '/api/v0/volumes/search/') {
            let offers = state.volumeAsks.filter((v) => v.disk_space > 0);
            for (const [field, cond] of Object.entries(body ?? {})) {
                if (!cond || typeof cond !== 'object' || Array.isArray(cond)) continue;
                for (const [op, v] of Object.entries(cond as Record<string, unknown>)) offers = offers.filter((a: any) => OPS[op]?.(a[field], v) ?? true);
            }
            return json(200, { offers: offers.slice(0, Math.min(64, body?.limit ?? 64)) });
        }
        if (path === '/api/v0/volumes/' && method === 'PUT') {
            if (!/^[A-Za-z0-9_]{1,64}$/.test(String(body?.name ?? ''))) {
                return fail(422, 'invalid_args', `invalid volume name: ${body?.name}. Max length 64, alphanumeric and underscore characters only`);
            }
            const offer = state.volumeAsks.find((v) => v.id === body?.id);
            if (!offer) return fail(404, 'no_such_ask', `no volume offer ${body?.id}`);
            if (!(Number.isInteger(body.size) && body.size >= 1 && body.size <= offer.disk_space)) return fail(400, 'invalid_args', 'invalid size');
            offer.disk_space -= body.size;
            const id = state.nextId++;
            state.volumes.set(String(id), { id, label: body.name, status: 'created', machine_id: offer.machine_id, host_id: 77, type: 'machine', disk_space: body.size, instances: [],
                start_date: Date.now() / 1000, end_date: Date.now() / 1000 + 30 * 86_400, geolocation: offer.geolocation, storage_total_cost: (body.size * offer.storage_cost) / 720 });
            return json(200, { success: true, volume_name: `V.${id}`, volume_id: id });
        }
        if (method === 'GET' && path === '/api/v0/volumes') {
            if (u.searchParams.get('owner') !== 'me') return fail(400, 'invalid_args', 'owner=me is required');
            volumeRead();
            return json(200, { volumes: [...state.volumes.values()].map(volumeView) });
        }
        if (method === 'DELETE' && path === '/api/v0/volumes/') {
            const v = state.volumes.get(String(u.searchParams.get('id')));
            if (!v) return fail(404, 'no_such_volume', 'could not find a listed volume matching id');
            if (v.instances.length) return fail(400, 'invalid_args', 'the volume is in use by an instance');
            state.volumes.delete(String(v.id));
            const offer = state.volumeAsks.find((x) => x.machine_id === v.machine_id);
            if (offer) offer.disk_space += v.disk_space;
            return json(200, { success: true });
        }
        if (path === '/api/v0/ssh/') {
            if (method === 'GET') {
                if (!state.keys.size) return fail(404, 'not_found', 'No SSH keys found for the user.');
                return json(200, [...state.keys.values()].map((k) => ({ id: k.id, user_id: 1, key: k.public_key, created_at: '2026-09-29T00:00:00Z', deleted_at: null })));
            }
            if (method === 'POST') {
                if (!/^ssh-/.test(body?.ssh_key ?? '')) return fail(400, 'invalid_args', 'invalid ssh key');
                const id = state.nextId++;
                const key = { id, user_id: 1, public_key: body.ssh_key, created_at: '2026-09-29T00:00:00Z', deleted_at: null };
                state.keys.set(String(id), key);
                return json(200, { success: true, key });
            }
        }
        if (method === 'DELETE' && (m = /^\/api\/v0\/ssh\/(\d+)\/$/.exec(path))) {
            // A key that is not there: the one 400 the spec documents ("Invalid request or SSH key not found").
            if (!state.keys.delete(m[1])) return fail(400, 'no_ssh_key', 'No ssh key provided');
            return json(200, { success: true });
        }
        return fail(404, 'not_found', `fake has no route ${method} ${path}`);
    }

    const api: FakeApi & { state: typeof state, registry: typeof registry } = {
        fetchImpl: fetchImpl as typeof fetch,
        calls,
        state,
        registry,
        liveServers: () => state.instances.size,
    };
    return api;
}
