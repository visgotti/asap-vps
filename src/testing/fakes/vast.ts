// A fetch() that answers like Vast.ai's REST API
// (docs.vast.ai/api-reference/openapi.json, read 2026-09-29) for the calls the
// GPU provider makes: the offer search with operator filters, renting an ask
// (410 no_such_ask once it is taken), instances that go loading -> running,
// PUT {state} to stop / start, reboot, DELETE, keyset pages of at most 25 from
// /api/v1/instances/, logs uploaded to a result_url on another host, and
// account keys (404 when there are none), and a private registry's login
// (image_login, docker login arguments). Failures carry {success: false,
// error, msg}.

import { echoed, FakeApi, json, readRequest } from './util';

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

export function fakeVast(o: { token?: string, bootReads?: number, seededInstances?: number } = {}) {
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
    };
    // More than one page of someone's existing instances (the API pages at 25).
    for (let i = 0; i < (o.seededInstances ?? 27); i++) {
        const id = state.nextId++;
        state.instances.set(String(id), { id, label: i % 2 ? `sd-box-${i}` : null, actual_status: 'running', cur_state: 'running', intended_status: 'running',
            gpu_name: 'RTX 3090', num_gpus: 1, geolocation: 'Utah, US', dph_total: 0.2, machine_id: 99, start_date: 1_700_000_000, reads: 99 });
    }
    const fail = (status: number, error: string, msg: string) => json(status, { success: false, error, msg });
    /** What one run of an instance's container prints: its GPU (when the command asks), its echoes, a hello. */
    const containerRun = (i: any): string => `booting\n${String(i.image_args ?? '').includes('nvidia-smi') ? `GPU 0: NVIDIA ${i.gpu_name} (UUID: GPU-9a8b7c6d)\n` : ''}`
        + `${echoed(i.image_args, i.extra_env).map((l) => `${l}\n`).join('')}hello from ${i.label}\n`;
    /** A start or a reboot runs the container again: the log keeps every run, as docker's does. */
    const rerun = (id: string) => {
        const l = state.logs.get(id);
        const i = state.instances.get(id);
        if (l && i) l.text += containerRun(i);
    };
    const view = (i: any) => {
        const { reads, relaunching, ...rest } = i;
        return rest;
    };

    async function fetchImpl(url: string | URL | Request, init?: RequestInit): Promise<Response> {
        const { u, method, body, auth, path } = readRequest(calls, url, init);
        if (u.host === 'logs.fake') {
            const l = state.logs.get(path.slice(1));
            if (!l || l.fetchesBeforeReady-- > 0) return new Response('<Error><Code>NoSuchKey</Code></Error>', { status: 404, headers: { 'content-type': 'application/xml' } });
            return new Response(l.text, { status: 200, headers: { 'content-type': 'text/plain' } });
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
            if (!ask || !ask.rentable) return fail(410, 'no_such_ask', `error 410/3907: no_such_ask Instance type ${m[1]} is no longer available.`);
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
            ask.rentable = false;
            const id = state.nextId++;
            // Each "-p N:N" key opens container port N, mapped to a RANDOM public port.
            const ports: Record<string, Array<{ HostIp: string, HostPort: string }>> = {};
            for (const k of Object.keys(body.env ?? {})) {
                const pm = /^-p (\d+):\d+(\/udp)?$/.exec(k);
                if (pm) ports[`${pm[1]}/${pm[2] ? 'udp' : 'tcp'}`] = [{ HostIp: '0.0.0.0', HostPort: String(40000 + (Number(pm[1]) * 7) % 20000) }];
            }
            state.instances.set(String(id), { id, label: body.label ?? null, image_uuid: body.image, extra_env: body.env, image_args: body.args, onstart: body.onstart,
                actual_status: null, cur_state: 'running', intended_status: 'running', gpu_name: ask.gpu_name, num_gpus: ask.num_gpus,
                geolocation: ask.geolocation, dph_total: body.price !== undefined ? Number(body.price) : ask.dph_total, is_bid: body.price !== undefined,
                machine_id: ask.machine_id, start_date: Date.now() / 1000, ports,
                public_ipaddr: `198.51.100.${id % 250}\n`, ssh_host: 'ssh5.vast.ai', ssh_port: 20000 + (id % 1000), reads: 0 });
            state.logs.set(String(id), { text: containerRun(state.instances.get(String(id))), fetchesBeforeReady: 1 });
            return json(200, { success: true, new_contract: id });
        }
        if (method === 'GET' && path === '/api/v1/instances/') {
            const all = [...state.instances.values()];
            const limit = Math.min(25, Number(u.searchParams.get('limit') ?? 25));
            const after = u.searchParams.get('after_token');
            const at = after ? Number(Buffer.from(after, 'base64').toString()) : 0;
            if (!Number.isFinite(at)) return fail(400, 'invalid_args', 'invalid after_token');
            const next = at + limit < all.length ? Buffer.from(String(at + limit)).toString('base64') : null;
            const page = all.slice(at, at + limit);
            return json(200, { success: true, instances_found: page.length, total_instances: all.length, instances: page.map(view), next_token: next });
        }
        if ((m = /^\/api\/v0\/instances\/(\d+)\/$/.exec(path))) {
            const i = state.instances.get(m[1]);
            if (!i) return fail(404, 'no_such_instance', 'Instance not found');
            if (method === 'GET') {
                i.reads++;
                if (i.actual_status === null && i.reads >= 1) i.actual_status = 'loading';
                // A started or rebooted container still reads as it was left (exited) for a while, then loads (observed 2026-10-02).
                else if (i.actual_status === 'exited' && i.relaunching && i.reads >= 2) Object.assign(i, { actual_status: 'loading', relaunching: false, reads: 0 });
                else if (i.actual_status === 'loading' && i.reads >= state.bootReads && i.intended_status === 'running') i.actual_status = 'running';
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
                return json(200, { success: true, msg: 'destroying instance' });
            }
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
            return json(200, { success: true, result_url: `https://logs.fake/${m[1]}`, msg: 'Logs will be uploaded shortly' });
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
            if (!state.keys.delete(m[1])) return fail(400, 'invalid_args', 'SSH key not found');
            return json(200, { success: true });
        }
        return fail(404, 'not_found', `fake has no route ${method} ${path}`);
    }

    const api: FakeApi & { state: typeof state } = {
        fetchImpl: fetchImpl as typeof fetch,
        calls,
        state,
        liveServers: () => state.instances.size,
    };
    return api;
}
