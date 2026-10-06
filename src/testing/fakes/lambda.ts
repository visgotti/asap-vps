// A fetch() that answers like Lambda Cloud's API (cloud.lambda.ai/api/v1/openapi.json,
// read 2026-09-29) for the calls the GPU provider makes: instance types keyed by
// name with the regions that have capacity, launch by SSH key NAMES (400
// instance-operations/launch/insufficient-capacity where a type has none,
// global/quota-exceeded past the account's cap), instances that go booting ->
// active, terminate -> terminating -> terminated -> gone, restart, SSH keys,
// and filesystems (one region each; mounted at launch by name or with a mount
// point under /home, /lambda/nfs or /data; in use while a live instance mounts
// one, which cannot be deleted then). Every body is wrapped in `data`; every
// failure is {error: {code, message}}.

import { FakeApi, json, readRequest } from './util';

const TYPES = {
    gpu_1x_a10: { instance_type: { name: 'gpu_1x_a10', description: '1x A10 (24 GB PCIe)', gpu_description: 'A10 (24 GB PCIe)', price_cents_per_hour: 75,
        specs: { vcpus: 30, memory_gib: 200, storage_gib: 1400, gpus: 1 }, architecture: 'x86_64' },
    regions_with_capacity_available: [{ name: 'us-east-1', description: 'Virginia, USA' }] },
    gpu_1x_a6000: { instance_type: { name: 'gpu_1x_a6000', description: '1x RTX A6000 (48 GB)', gpu_description: 'RTX A6000 (48 GB)', price_cents_per_hour: 80,
        specs: { vcpus: 14, memory_gib: 100, storage_gib: 512, gpus: 1 }, architecture: 'x86_64' },
    regions_with_capacity_available: [{ name: 'us-west-1', description: 'California, USA' }, { name: 'us-east-1', description: 'Virginia, USA' }] },
    gpu_1x_h100_pcie: { instance_type: { name: 'gpu_1x_h100_pcie', description: '1x H100 (80 GB PCIe)', gpu_description: 'H100 (80 GB PCIe)', price_cents_per_hour: 249,
        specs: { vcpus: 26, memory_gib: 200, storage_gib: 1000, gpus: 1 }, architecture: 'x86_64' },
    regions_with_capacity_available: [] },
    gpu_8x_a100_80gb_sxm4: { instance_type: { name: 'gpu_8x_a100_80gb_sxm4', description: '8x A100 (80 GB SXM4)', gpu_description: 'A100 (80 GB SXM4)', price_cents_per_hour: 1432,
        specs: { vcpus: 240, memory_gib: 1800, storage_gib: 20000, gpus: 8 }, architecture: 'x86_64' },
    regions_with_capacity_available: [{ name: 'us-east-1', description: 'Virginia, USA' }] },
    cpu_4x_general: { instance_type: { name: 'cpu_4x_general', description: '4x vCPU', gpu_description: 'none', price_cents_per_hour: 10,
        specs: { vcpus: 4, memory_gib: 16, storage_gib: 100, gpus: 0 }, architecture: 'x86_64' },
    regions_with_capacity_available: [{ name: 'us-east-1', description: 'Virginia, USA' }] },
};

/** The regions a filesystem can be made in. */
const REGIONS = ['us-east-1', 'us-west-1', 'us-south-1'];

export function fakeLambda(o: { token?: string, bootReads?: number, instanceQuota?: number } = {}) {
    const token = o.token ?? 'lambda-test';
    const calls: FakeApi['calls'] = [];
    const state = {
        instances: new Map<string, any>(),
        keys: new Map<string, any>(),
        filesystems: new Map<string, any>(),
        nextId: 1,
        bootReads: o.bootReads ?? 2,
        instanceQuota: o.instanceQuota ?? 10,
    };
    const hex = (n: number) => n.toString(16).padStart(32, '0');
    state.keys.set('key0', { id: 'key0', name: 'laptop', public_key: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKd0 laptop' });
    const prod = hex(state.nextId++);
    state.instances.set(prod, { id: prod, name: 'ml-dev', status: 'active', ip: '192.0.2.10', private_ip: '10.0.0.10', ssh_key_names: ['laptop'],
        file_system_names: [], region: { name: 'us-east-1', description: 'Virginia, USA' }, instance_type: TYPES.gpu_1x_a10.instance_type, actions: {}, first_healthy: '2026-01-01T00:00:00Z', reads: 99 });
    const fail = (status: number, code: string, message: string, suggestion?: string) => json(status, { error: { code, message, ...(suggestion ? { suggestion } : {}) } });
    const view = (i: any) => {
        const { reads, ...rest } = i;
        return rest;
    };
    /** Whether a live instance mounts the filesystem. */
    const inUse = (id: string) => [...state.instances.values()].some((i) => i.status !== 'terminated' && (i.file_system_mounts ?? []).some((x: any) => x.file_system_id === id));
    const fsView = (f: any) => ({ ...f, is_in_use: inUse(f.id) });

    async function fetchImpl(url: string | URL | Request, init?: RequestInit): Promise<Response> {
        const { method, body, auth, path } = readRequest(calls, url, init);
        if (auth !== `Bearer ${token}`) return fail(401, 'global/invalid-api-key', 'API key was invalid, expired, or deleted.', 'Check your API key.');
        let m: RegExpExecArray | null;
        if (method === 'GET' && path === '/api/v1/instance-types') return json(200, { data: TYPES });
        if (method === 'POST' && path === '/api/v1/instance-operations/launch') {
            if (!body?.region_name || !body.instance_type_name || !Array.isArray(body.ssh_key_names)) return fail(400, 'global/invalid-parameters', 'Missing required parameters.');
            // Spec 1.10.0: "Currently, exactly one SSH key must be specified"; names at most 64
            // characters; tag keys ^[a-z][a-z0-9-:]+$ up to 55, not lambda-ai-; values up to 128.
            if (body.ssh_key_names.length !== 1) return fail(400, 'global/invalid-parameters', 'Exactly one SSH key must be specified.');
            if (typeof body.name === 'string' && body.name.length > 64) return fail(400, 'global/invalid-parameters', 'Name is too long.');
            if ((body.tags ?? []).some((t: any) => !/^[a-z][a-z0-9-:]{1,54}$/.test(t.key) || String(t.key).startsWith('lambda-ai-') || String(t.value ?? '').length > 128)) {
                return fail(400, 'global/invalid-parameters', 'Invalid tag.');
            }
            const t = (TYPES as Record<string, any>)[body.instance_type_name];
            if (!t) return fail(404, 'global/object-does-not-exist', 'Specified instance type does not exist.');
            const names = [...state.keys.values()].map((k) => k.name);
            if (!body.ssh_key_names.length || body.ssh_key_names.some((n: string) => !names.includes(n))) return fail(404, 'global/object-does-not-exist', 'Specified SSH key does not exist.');
            if (!t.regions_with_capacity_available.some((r: any) => r.name === body.region_name)) {
                return fail(400, 'instance-operations/launch/insufficient-capacity', 'Not enough capacity to fulfill launch request.', 'Choose an instance type with more availability, or try again later.');
            }
            const live = [...state.instances.values()].filter((i) => !['terminated'].includes(i.status)).length;
            if (live >= state.instanceQuota) return fail(400, 'global/quota-exceeded', 'Quota exceeded.', 'Contact Support to increase your quota.');
            // Filesystems by name (at their own mount point) and with a mount point: the latter wins for one named in both.
            const mounts = new Map<string, string>();
            for (const n of body.file_system_names ?? []) {
                const f = [...state.filesystems.values()].find((x) => x.name === n);
                if (!f) return fail(404, 'global/object-does-not-exist', `Filesystem ${n} was not found.`);
                mounts.set(f.id, f.mount_point);
            }
            for (const e of body.file_system_mounts ?? []) {
                if (!e?.file_system_id || typeof e.mount_point !== 'string' || e.mount_point.length > 256 || !/^(\/home|\/lambda\/nfs|\/data)[/a-zA-Z0-9-]*$/.test(e.mount_point)) {
                    return fail(400, 'global/invalid-parameters', 'Invalid filesystem mount.');
                }
                if (!state.filesystems.has(e.file_system_id)) return fail(404, 'global/object-does-not-exist', 'Filesystem was not found.');
                mounts.set(e.file_system_id, e.mount_point);
            }
            for (const fid of mounts.keys()) {
                if (state.filesystems.get(fid).region.name !== body.region_name) {
                    return fail(400, 'instance-operations/launch/file-system-in-wrong-region', 'File system is in a different region than the instance.');
                }
            }
            const id = hex(state.nextId++);
            const fsMounts = [...mounts].map(([file_system_id, mount_point]) => ({ file_system_id, mount_point }));
            state.instances.set(id, { id, name: body.name, status: 'booting', ssh_key_names: body.ssh_key_names,
                file_system_names: fsMounts.map((x) => state.filesystems.get(x.file_system_id).name), ...(fsMounts.length ? { file_system_mounts: fsMounts } : {}),
                region: { name: body.region_name, description: '' }, instance_type: t.instance_type, actions: {}, user_data: body.user_data, tags: body.tags, reads: 0 });
            return json(200, { data: { instance_ids: [id] } });
        }
        if (method === 'GET' && path === '/api/v1/instances') {
            return json(200, { data: [...state.instances.values()].filter((i) => i.status !== 'terminated').map(view) });
        }
        if (method === 'GET' && (m = /^\/api\/v1\/instances\/([0-9a-f]+)$/.exec(path))) {
            const i = state.instances.get(m[1]);
            if (!i) return fail(404, 'global/object-does-not-exist', 'Specified instance does not exist.');
            i.reads++;
            // Billed from its first passed health check: first_healthy.
            if (i.status === 'booting' && i.reads >= state.bootReads) Object.assign(i, { status: 'active', ip: `198.51.100.${i.reads}`, private_ip: '10.0.0.20', first_healthy: new Date().toISOString() });
            else if (i.status === 'terminating') i.status = 'terminated';
            else if (i.status === 'terminated') {
                state.instances.delete(m[1]);
                return fail(404, 'global/object-does-not-exist', 'Specified instance does not exist.');
            }
            return json(200, { data: view(i) });
        }
        if (method === 'POST' && path === '/api/v1/instance-operations/terminate') {
            const found = (body?.instance_ids ?? []).map((id: string) => state.instances.get(id)).filter((i: any) => i && i.status !== 'terminated');
            if (found.length !== (body?.instance_ids ?? []).length) return fail(404, 'global/object-does-not-exist', 'Specified instance does not exist.');
            for (const i of found) i.status = 'terminating';
            return json(200, { data: { terminated_instances: found.map(view) } });
        }
        if (method === 'POST' && path === '/api/v1/instance-operations/restart') {
            const found = (body?.instance_ids ?? []).map((id: string) => state.instances.get(id)).filter(Boolean);
            if (!found.length) return fail(404, 'global/object-does-not-exist', 'Specified instance does not exist.');
            return json(200, { data: { restarted_instances: found.map(view) } });
        }
        if (path === '/api/v1/filesystems') {
            if (method === 'GET') return json(200, { data: [...state.filesystems.values()].map(fsView) });
            if (method === 'POST') {
                if (typeof body?.name !== 'string' || !/^[a-zA-Z]+[0-9a-zA-Z-]*$/.test(body.name) || body.name.length > 60 || typeof body.region !== 'string') {
                    return fail(400, 'global/invalid-parameters', 'Invalid filesystem name or region.');
                }
                if (!REGIONS.includes(body.region)) return fail(400, 'global/invalid-parameters', `Unknown region ${body.region}.`);
                if ([...state.filesystems.values()].some((f) => f.name === body.name)) return fail(400, 'global/duplicate', 'A filesystem with this name already exists.');
                const id = hex(state.nextId++);
                const f = { id, name: body.name, mount_point: `/lambda/nfs/${body.name}`, created: new Date().toISOString(),
                    created_by: { id: 'user0', email: 'owner@example.com', status: 'active' }, region: { name: body.region, description: '' }, bytes_used: 0 };
                state.filesystems.set(id, f);
                return json(200, { data: fsView(f) });
            }
        }
        if (method === 'DELETE' && (m = /^\/api\/v1\/filesystems\/([^/]+)$/.exec(path))) {
            if (!state.filesystems.has(m[1])) return fail(404, 'global/object-does-not-exist', 'Filesystem was not found.');
            if (inUse(m[1])) return fail(400, 'filesystems/filesystem-in-use', 'Filesystem is in use by an instance and cannot be deleted.', 'Terminate the instances that mount it first.');
            state.filesystems.delete(m[1]);
            return json(200, { data: { deleted_ids: [m[1]] } });
        }
        if (path === '/api/v1/ssh-keys') {
            if (method === 'GET') return json(200, { data: [...state.keys.values()] });
            if (method === 'POST') {
                if ([...state.keys.values()].some((k) => k.name === body?.name)) return fail(400, 'global/duplicate', 'An SSH key with this name already exists.');
                const id = `key${state.nextId++}`;
                const key = { id, name: body.name, public_key: body.public_key };
                state.keys.set(id, key);
                return json(200, { data: key });
            }
        }
        if (method === 'DELETE' && (m = /^\/api\/v1\/ssh-keys\/([^/]+)$/.exec(path))) {
            if (!state.keys.delete(m[1])) return fail(404, 'global/object-does-not-exist', 'Specified SSH key does not exist.');
            return json(200, { data: {} });
        }
        return fail(404, 'global/not-found', `fake has no route ${method} ${path}`);
    }

    const api: FakeApi & { state: typeof state } = {
        fetchImpl: fetchImpl as typeof fetch,
        calls,
        state,
        liveServers: () => [...state.instances.values()].filter((i) => i.status !== 'terminated' && i.status !== 'terminating').length,
    };
    return api;
}
