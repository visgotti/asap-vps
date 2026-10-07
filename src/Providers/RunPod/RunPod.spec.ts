// RunPod against the fake of its REST v2 API (src/testing/fakes/runpod.ts): what
// is particular to it beyond the shared contract (../contract.spec.ts). From
// api.runpod.io/v2/openapi.json and docs.runpod.io (checked 2026-09-29): MIG
// slices are GPU types of their own, the catalog's secure/community flags say
// where a type is sold, pods take no UDP, sshd's direct endpoint needs 22/tcp, a
// resumed pod can come back without its GPU, logs backfill at most 5000 lines, a
// 422 explains itself in errors[], sizes are whole GB, the account's key list
// holds any OpenSSH key type, and minCudaVersion scopes the catalog's stock and
// places the pod.

import { REGION_TYPES } from '../../constants';
import { AuthError, CapacityError, NotFoundError, NotSupportedError, ProviderError } from '../../errors';
import { fakeRunPod } from '../../testing/fakes/runpod';
import { testPublicKey } from '../../testing/fakes/util';
import { runPodGpuName, sseLogLines } from './mappers';
import { RunPod } from './RunPod';

const noSleep = async () => {};
const fast = { intervalMs: 0, timeoutMs: 5000 };
const last = <T>(a: T[]): T | undefined => a[a.length - 1];

describe('RunPod', () => {
    const make = (cloud?: 'SECURE' | 'COMMUNITY') => {
        const fake = fakeRunPod();
        return { fake, p: new RunPod({ apiKey: 'rp-test', fetchImpl: fake.fetchImpl, sleep: noSleep, cloud }) };
    };

    it('offers what the chosen cloud sells, where it has stock, for the GPU count asked', async () => {
        let { p } = make();
        let offers = await p.listOffers({ includeUnavailable: true });
        expect(offers.map((o) => o.id)).not.toContain('NVIDIA RTX A4000');
        expect(offers.find((o) => o.id === 'NVIDIA RTX A5000')).toMatchObject({ pricePerHour: 0.27, regions: ['US-TX-3'] });
        offers = await p.listOffers({ gpuCount: 2 });
        expect(offers.find((o) => o.id === 'NVIDIA RTX A5000')).toMatchObject({ gpuCount: 2, pricePerHour: 0.54 });
        // A pod runs on one machine: where none has two of a type free, two are not in stock (the 4090 has one free).
        expect(offers.map((o) => o.id)).not.toContain('NVIDIA GeForce RTX 4090');
        expect((await p.listOffers({ includeUnavailable: true, gpuCount: 2 })).find((o) => o.id === 'NVIDIA GeForce RTX 4090')?.regions).toEqual([]);
        ({ p } = make('COMMUNITY'));
        offers = await p.listOffers({ includeUnavailable: true });
        expect(offers.find((o) => o.id === 'NVIDIA RTX A4000')?.pricePerHour).toBe(0.17);
        expect(offers.map((o) => o.id)).not.toContain('AMD Instinct MI300X OAM');
        // The community cloud's own stock: its A5000s are in Romania, the secure cloud's in Texas.
        expect(offers.find((o) => o.id === 'NVIDIA RTX A5000')).toMatchObject({ pricePerHour: 0.16, regions: ['EU-RO-1'] });
    });

    it('a pod is placed and billed on the chosen cloud', async () => {
        const { p, fake } = make('COMMUNITY');
        const [offer] = await p.listOffers({ gpus: ['RTX A5000'] });
        const s = await p.createServer({ name: 'community', offer, image: 'img' });
        expect(fake.calls.find((c) => c.method === 'POST' && c.path === '/v2/pods')?.body.cloud).toBe('COMMUNITY');
        expect(fake.state.pods.get(s.id)).toMatchObject({ cloud: 'COMMUNITY', dataCenterId: 'EU-RO-1' });
        expect(await p.waitUntilRunning(s.id, fast)).toMatchObject({ region: 'EU-RO-1', pricePerHour: 0.16 });
    });

    it('sends the command as exec-form cmd, ports, and SSH setup when keys are asked for', async () => {
        const { p, fake } = make();
        const key = await p.addSSHKey(testPublicKey('ci'), 'ci');
        await p.createServer({ name: 'x', offer: 'NVIDIA RTX A5000', image: 'img', command: ['python', '-u', 'main.py'], ports: ['22/tcp'], sshKeyIds: [key.id],
            volume: { sizeGb: 5, path: '/workspace' } });
        const body = fake.calls.find((c) => c.method === 'POST' && c.path === '/v2/pods')?.body;
        expect(body).toMatchObject({ cmd: ['python', '-u', 'main.py'], ports: ['22/tcp'], startSsh: true, cloud: 'SECURE', env: { PUBLIC_KEY: key.publicKey },
            gpu: { id: 'NVIDIA RTX A5000', count: 1 }, mounts: { persistent: { size: 10, path: '/workspace' } } });
        expect(body.dataCenterIds).toBeUndefined();
    });

    it('a pod gets the GPU count of the offer it was made from', async () => {
        const { p, fake } = make();
        const [two] = await p.listOffers({ gpuCount: 2 });
        const s = await p.createServer({ name: 'two', offer: two, image: 'img' });
        expect(fake.calls.find((c) => c.method === 'POST' && c.path === '/v2/pods')?.body.gpu).toMatchObject({ id: two.id, count: 2 });
        expect((await p.waitUntilRunning(s.id, fast)).gpuCount).toBe(2);
    });

    it('lists GPU pods, CPU pods, or both (the default)', async () => {
        const { p, fake } = make();
        fake.state.pods.set('pod_cpu1', { id: 'pod_cpu1', name: 'cpu-box', status: 'RUNNING', gpu: null, cpu: { id: 'cpu3c', vcpuCount: 4, memory: 8 },
            dataCenterId: 'US-TX-3', cost: 0.08, createdAt: '2026-01-01T00:00:00Z', reads: 99, logs: [] });
        expect((await p.listServers({ kind: 'gpu' })).map((s) => s.id)).not.toContain('pod_cpu1');
        expect((await p.listServers({ kind: 'cpu' })).map((s) => s.id)).toEqual(['pod_cpu1']);
        expect((await p.listServers()).map((s) => s.id)).toContain('pod_cpu1');
    });

    it('lists every page of the account\'s pods: by RunPod\'s cursor until it says there is no next page, never by counting rows', async () => {
        // RunPod cuts its pages at two rows here (the spec: "a page may hold fewer than `limit` pods").
        const fake = fakeRunPod({ pageSize: 2 });
        const p = new RunPod({ apiKey: 'rp-test', fetchImpl: fake.fetchImpl, sleep: noSleep });
        // The account's two pods, then a CPU pod, then two GPU pods: five rows, three pages, newest first.
        fake.state.pods.set('pod_cpu1', { id: 'pod_cpu1', name: 'cpu-box', status: 'RUNNING', gpu: null, cpu: { id: 'cpu3c', vcpuCount: 4, memory: 8 },
            dataCenterId: 'US-TX-3', cost: 0.08, createdAt: '2026-01-02T00:00:00Z', reads: 99, logs: [] });
        for (const name of ['a', 'b']) await p.createServer({ name, offer: 'NVIDIA RTX A5000', image: 'img' });
        const reads = () => fake.calls.filter((c) => c.method === 'GET' && c.path.startsWith('/v2/pods?')).map((c) => new URLSearchParams(c.path.split('?')[1]));
        const before = reads().length;
        expect((await p.listServers()).map((s) => s.name)).toEqual(['b', 'a', 'cpu-box', 'jupyter', 'comfy-dev']);
        const pages = reads().slice(before);
        expect(pages.map((q) => q.get('limit'))).toEqual(['1000', '1000', '1000']);
        expect(pages.map((q) => q.has('cursor'))).toEqual([false, true, true]);
        // A page with no pod of the kind asked for is not the end of the list: the one CPU pod is on the second page.
        expect((await p.listServers({ kind: 'cpu' })).map((s) => s.name)).toEqual(['cpu-box']);
        expect((await p.listServers({ kind: 'gpu' })).map((s) => s.name)).toEqual(['b', 'a', 'jupyter', 'comfy-dev']);
    });

    it('gives up on a list that never ends: 200 pages, then an error', async () => {
        const fake = fakeRunPod();
        let reads = 0;
        const endless = (async (url: string | URL | Request, init?: RequestInit) => {
            if (!/\/v2\/(pods|serverless)\?/.test(String(url))) return fake.fetchImpl(url, init);
            reads++;
            return new Response(JSON.stringify({ pods: [], endpoints: [], pagination: { nextCursor: 'more', hasNextPage: true } }), { status: 200, headers: { 'content-type': 'application/json' } });
        }) as typeof fetch;
        const p = new RunPod({ apiKey: 'rp-test', fetchImpl: endless, sleep: noSleep });
        await expect(p.listServers()).rejects.toThrow(/more than 200 pages/);
        expect(reads).toBe(200);
        await expect(p.listEndpoints()).rejects.toThrow(/more than 200 pages/);
        expect(reads).toBe(400);
    });

    it('a 400 that reads as a bad request is not taken for no capacity', async () => {
        const { p } = make();
        const e = await p.createServer({ name: 'x', offer: 'NVIDIA H200 NVL', image: 'img' }).catch((x) => x);
        expect(e).toBeInstanceOf(ProviderError);
        expect(e).not.toBeInstanceOf(CapacityError);
    });

    it('a create that names something RunPod no longer has is a NotFoundError, not "no capacity": no other offer has it either', async () => {
        const { p, fake } = make();
        // A stored login that is gone.
        const login = await p.createServer({ name: 'x', offer: 'NVIDIA RTX A5000', image: 'img', providerOptions: { registry: 'reg_gone' } }).catch((x) => x);
        expect([login.constructor.name, login.message]).toEqual(['NotFoundError', expect.stringMatching(/container registry auth reg_gone not found/)]);
        // A volume deleted after it was read for the create, before the create was sent.
        const vol = await p.createVolume({ name: 'weights', region: 'US-TX-3', sizeGb: 10 });
        const racing = new RunPod({ apiKey: 'rp-test', sleep: noSleep, fetchImpl: (async (url: string, init?: RequestInit) => {
            if (init?.method === 'POST' && new URL(url).pathname === '/v2/pods') fake.state.volumes.delete(vol.id);
            return fake.fetchImpl(url, init);
        }) as typeof fetch });
        const gone = await racing.createServer({ name: 'y', offer: 'NVIDIA RTX A5000', image: 'img', mounts: [{ volume: vol.id }] }).catch((x) => x);
        expect([gone.constructor.name, gone.message]).toEqual(['NotFoundError', expect.stringMatching(/network volume .* not found/)]);
        // Where there is no stock, it is still no capacity.
        await expect(p.createServer({ name: 'z', offer: 'NVIDIA L4', image: 'img' })).rejects.toBeInstanceOf(CapacityError);
    });

    it('a stop or start already done succeeds; an action the pod\'s status does not allow is an error', async () => {
        const { p } = make();
        const s = await p.createServer({ name: 'x', offer: 'NVIDIA RTX A5000', image: 'img' });
        await p.waitUntilRunning(s.id, fast);
        // RunPod answers 409 to both; the pod is already where they would put it.
        await expect(p.startServer(s.id)).resolves.toBeUndefined();
        await p.stopServer(s.id);
        await expect(p.stopServer(s.id)).resolves.toBeUndefined();
        await expect(p.restartServer(s.id)).rejects.toThrow(/409/);
    });

    it('adds a key by writing the whole list back, once', async () => {
        const { p, fake } = make();
        const pub = testPublicKey('me');
        fake.state.keys = [testPublicKey('existing')];
        const a = await p.addSSHKey(pub, 'laptop');
        const b = await p.addSSHKey(pub, 'laptop');
        expect(b.id).toBe(a.id);
        expect(fake.state.keys).toHaveLength(2);
        expect(fake.calls.filter((c) => c.method === 'PUT')).toHaveLength(1);
        expect(a.name).toBe('laptop');
    });

    it('never writes back a key list it could not read: the account\'s keys are left as they are', async () => {
        const fake = fakeRunPod();
        fake.state.keys = [testPublicKey('existing')];
        const misread = (async (url: string | URL | Request, init?: RequestInit) => (String(url).endsWith('/v2/account/ssh-keys') && (init?.method ?? 'GET') === 'GET'
            ? new Response(JSON.stringify({ sshKeys: fake.state.keys }), { status: 200, headers: { 'content-type': 'application/json' } })
            : fake.fetchImpl(url, init))) as typeof fetch;
        const p = new RunPod({ apiKey: 'rp-test', fetchImpl: misread, sleep: noSleep });
        await expect(p.addSSHKey(testPublicKey('me'), 'laptop')).rejects.toThrow(/did not answer a list of keys/);
        await expect(p.deleteSSHKey('SHA256:x')).rejects.toThrow(/did not answer a list of keys/);
        expect(fake.calls.filter((c) => c.method === 'PUT')).toHaveLength(0);
        expect(fake.state.keys).toHaveLength(1);
    });

    it('changes to the key list made at once each take: none writes back a list without another\'s change', async () => {
        const { p, fake } = make();
        const old = await p.addSSHKey(testPublicKey('old'), 'old');
        const names = ['a', 'b', 'c', 'd'];
        // Four adds and a delete, all asked for before any has answered.
        const [gone, ...added] = await Promise.all([p.deleteSSHKey(old.id), ...names.map((n) => p.addSSHKey(testPublicKey(n), n))]);
        expect(gone).toBe(true);
        const listed = await p.listSSHKeys();
        expect(listed.map((k) => k.name).sort()).toEqual(names);
        expect(listed.map((k) => k.id).sort()).toEqual(added.map((k) => (k as { id: string }).id).sort());
        expect(fake.state.keys).toHaveLength(4);
    });

    it('a write whose answer is lost is not sent again as it was: the list is read anew, and what another client added meanwhile is kept', async () => {
        const fake = fakeRunPod();
        const theirs = testPublicKey('theirs');
        // The next write takes, `meanwhile` happens, and then the write's answer is lost on the way back.
        let meanwhile: (() => void) | undefined;
        const losing = (async (url: string | URL | Request, init?: RequestInit) => {
            const r = await fake.fetchImpl(url, init);
            if (init?.method !== 'PUT' || !meanwhile) return r;
            meanwhile();
            meanwhile = undefined;
            throw new TypeError('fetch failed');
        }) as typeof fetch;
        const p = new RunPod({ apiKey: 'rp-test', fetchImpl: losing, sleep: noSleep });
        const writes = () => fake.calls.filter((c) => c.method === 'PUT').length;

        meanwhile = () => fake.state.keys.push(theirs);
        const mine = await p.addSSHKey(testPublicKey('mine'), 'mine');
        expect(mine.name).toBe('mine');
        expect((await p.listSSHKeys()).map((k) => k.name).sort()).toEqual(['mine', 'theirs']);
        // The list was written once: the copy without the other client's key was never sent again.
        expect(writes()).toBe(1);

        // A delete whose answer is lost is a delete that took, and says so.
        meanwhile = () => undefined;
        expect(await p.deleteSSHKey(mine.id)).toBe(true);
        expect((await p.listSSHKeys()).map((k) => k.name)).toEqual(['theirs']);
        expect(writes()).toBe(2);
    });

    it('a write that keeps failing is given up on, with the provider\'s error', async () => {
        const fake = fakeRunPod();
        let writes = 0;
        const down = (async (url: string | URL | Request, init?: RequestInit) =>
            init?.method === 'PUT' && ++writes ? new Response('{"error":"upstream"}', { status: 503 }) : fake.fetchImpl(url, init)) as typeof fetch;
        const waits: number[] = [];
        const p = new RunPod({ apiKey: 'rp-test', fetchImpl: down, sleep: async (ms) => void waits.push(ms) });
        await expect(p.addSSHKey(testPublicKey('k'), 'k')).rejects.toMatchObject({ status: 503 });
        // Three tries, each from a fresh read, with a pause before the second and the third.
        expect(writes).toBe(3);
        expect(waits).toEqual([1000, 2000]);
        expect(fake.calls.filter((c) => c.method === 'GET' && c.path === '/v2/account/ssh-keys')).toHaveLength(3);
        // The next change is not held up by the one that failed.
        const q = new RunPod({ apiKey: 'rp-test', fetchImpl: fake.fetchImpl, sleep: noSleep });
        expect((await q.addSSHKey(testPublicKey('k'), 'k')).name).toBe('k');
        await expect(p.deleteSSHKey('nope')).resolves.toBe(false);
    });

    it('reads log lines from the event stream, dropping a partial event', () => {
        const sse = 'id: 1\ndata: {"ts":"t","source":"container","line":"ready"}\n\nid: 2\ndata: {"line":"hal';
        expect(sseLogLines(sse)).toEqual(['ready']);
    });
});

describe('RunPod API facts', () => {
    const make = (o: Parameters<typeof fakeRunPod>[0] = {}, cloud?: 'SECURE' | 'COMMUNITY', wrap: (f: typeof fetch) => typeof fetch = (f) => f) => {
        const fake = fakeRunPod(o);
        return { fake, p: new RunPod({ apiKey: 'rp-test', fetchImpl: wrap(fake.fetchImpl), sleep: noSleep, cloud }) };
    };
    const created = (fake: ReturnType<typeof fakeRunPod>) => fake.calls.filter((c) => c.method === 'POST' && c.path === '/v2/pods');

    it('a MIG slice is never the card: asking for the card rents the card, and the slice keeps its own name', async () => {
        const { p } = make();
        const card = await p.listOffers({ gpus: ['RTX PRO 6000'] });
        expect(card.map((o) => o.id)).toEqual(['NVIDIA RTX PRO 6000 Blackwell Server Edition']);
        const slice = (await p.listOffers()).find((o) => /MIG/.test(o.id))!;
        expect(slice).toMatchObject({ gpu: 'RTX PRO 6000 MIG 1g.24gb', vramGb: 24 });
        // Cheapest first would otherwise have picked the slice for "RTX PRO 6000".
        expect(slice.pricePerHour).toBeLessThan(card[0].pricePerHour);
        const s = await p.createServer({ name: 'mig', offer: slice.id, image: 'img' });
        expect((await p.waitUntilRunning(s.id, fast)).gpu).toBe(slice.gpu);
        expect(runPodGpuName('NVIDIA B300 SXM6 AC MIG 1g.34gb')).toBe('B300 MIG 1g.34gb');
        expect(runPodGpuName('NVIDIA GeForce RTX 4090')).toBe('RTX 4090');
    });

    it('a type is offered on the cloud its flag says it is sold on, whatever price it lists', async () => {
        let { p } = make();
        expect((await p.listOffers({ includeUnavailable: true })).map((o) => o.id)).not.toContain('NVIDIA RTX 3090');
        ({ p } = make({}, 'COMMUNITY'));
        expect((await p.listOffers({ includeUnavailable: true })).find((o) => o.id === 'NVIDIA RTX 3090')?.pricePerHour).toBe(0.22);
    });

    it('a list comes in pages RunPod cuts, newest first, by a cursor that is the listing operation\'s own; a limit is 1-1000', async () => {
        const fake = fakeRunPod({ pageSize: 1 });
        const get = async (path: string) => {
            const r = await fake.fetchImpl(`https://api.runpod.io${path}`, { headers: { authorization: 'Bearer rp-test' } });
            return { status: r.status, body: await r.json() as any };
        };
        // Fewer rows than asked for, and more to come: only `pagination` says so.
        const first = await get('/v2/pods?limit=1000');
        expect(first.body.pods.map((x: any) => x.name)).toEqual(['jupyter']);
        expect(first.body.pagination).toEqual({ nextCursor: expect.any(String), hasNextPage: true });
        const second = await get(`/v2/pods?limit=1000&cursor=${first.body.pagination.nextCursor}`);
        expect(second.body.pods.map((x: any) => x.name)).toEqual(['comfy-dev']);
        expect(second.body.pagination).toEqual({ nextCursor: null, hasNextPage: false });
        // "A malformed or foreign cursor is rejected with 422" (the spec's words), as is a limit outside 1-1000.
        for (const path of [`/v2/serverless?cursor=${first.body.pagination.nextCursor}`, '/v2/pods?cursor=1', '/v2/pods?cursor=', '/v2/pods?limit=1001', '/v2/pods?limit=0']) {
            expect([path, (await get(path)).status]).toEqual([path, 422]);
        }
    });

    it('pods take no UDP: refused before anything is sent', async () => {
        const { p, fake } = make();
        await expect(p.createServer({ name: 'u', offer: 'NVIDIA RTX A5000', image: 'img', ports: ['9000/udp'] })).rejects.toBeInstanceOf(NotSupportedError);
        expect(created(fake)).toHaveLength(0);
    });

    it('SSH keys expose 22/tcp once, so the pod has sshd\'s direct endpoint and its host\'s address', async () => {
        const { p, fake } = make();
        const key = await p.addSSHKey(testPublicKey('ci'), 'ci');
        const s = await p.createServer({ name: 'ssh', offer: 'NVIDIA RTX A5000', image: 'img', ports: ['8888/http'], sshKeyIds: [key.id] });
        expect(created(fake)[0].body).toMatchObject({ ports: ['8888/http', '22/tcp'], startSsh: true });
        const running = await p.waitUntilRunning(s.id, fast);
        expect(running.ip).toBe('194.68.245.10');
        expect(running.ports?.find((x) => x.privatePort === 22)).toMatchObject({ protocol: 'tcp', publicPort: 40022 });
        expect(running.ssh).toEqual({ host: '194.68.245.10', port: 40022, username: 'root' });
        await p.createServer({ name: 'ssh2', offer: 'NVIDIA RTX A5000', image: 'img', ports: ['22/tcp'], sshKeyIds: [key.id] });
        expect(created(fake)[1].body.ports).toEqual(['22/tcp']);
    });

    it('sshKeyIds authorize exactly those keys (RunPod would put every account key there), and an unknown id is refused', async () => {
        const { p, fake } = make();
        fake.state.keys = [testPublicKey('colleague')];
        const mine = await p.addSSHKey(testPublicKey('ci'), 'ci');
        await p.createServer({ name: 'k', offer: 'NVIDIA RTX A5000', image: 'img', sshKeyIds: [mine.id] });
        expect(created(fake)[0].body.env).toEqual({ PUBLIC_KEY: mine.publicKey });
        await expect(p.createServer({ name: 'k2', offer: 'NVIDIA RTX A5000', image: 'img', sshKeyIds: ['SHA256:not-on-the-account'] }))
            .rejects.toBeInstanceOf(NotFoundError);
        await expect(p.createServer({ name: 'k3', offer: 'NVIDIA RTX A5000', image: 'img', sshKeyIds: [mine.id], env: { PUBLIC_KEY: 'x' } }))
            .rejects.toThrow(/not both/);
        expect(created(fake)).toHaveLength(1);
    });

    it('an http port\'s address is RunPod\'s proxy network, never the server\'s ip', async () => {
        const { p } = make();
        const web = await p.createServer({ name: 'web', offer: 'NVIDIA RTX A5000', image: 'img', ports: ['8888/http'] });
        const w = await p.waitUntilRunning(web.id, fast);
        expect(w.ports?.[0]).toMatchObject({ privatePort: 8888, protocol: 'http', ip: '100.65.0.101' });
        expect(w.ip).toBeUndefined();
        const both = await p.createServer({ name: 'both', offer: 'NVIDIA RTX A5000', image: 'img', ports: ['8888/http', '8080/tcp'] });
        expect((await p.waitUntilRunning(both.id, fast)).ip).toBe('194.68.245.10');
    });

    it('a pod resumed without its GPU is stopped again and reported as no capacity', async () => {
        const { p, fake } = make({ resumeWithoutGpu: true });
        const s = await p.createServer({ name: 'r', offer: 'NVIDIA RTX A5000', image: 'img' });
        await p.waitUntilRunning(s.id, fast);
        await p.stopServer(s.id);
        await expect(p.startServer(s.id)).rejects.toBeInstanceOf(CapacityError);
        expect(fake.state.pods.get(s.id).status).toBe('EXITED');
    });

    it('a start or restart its host has no GPU free for is no capacity, and the pod stays as it was (seen live)', async () => {
        let refuse = false;
        const { p, fake } = make({}, undefined, (f) => (async (url: string, init?: RequestInit) => {
            if (refuse && init?.method === 'POST' && /\/v2\/pods\/[^/]+\/action$/.test(new URL(url).pathname)) {
                return new Response(JSON.stringify({ error: 'not enough free GPUs on the host machine' }), { status: 400, headers: { 'content-type': 'application/json' } });
            }
            return f(url, init);
        }) as typeof fetch);
        const s = await p.createServer({ name: 'r', offer: 'NVIDIA RTX A5000', image: 'img' });
        await p.waitUntilRunning(s.id, fast);
        await p.stopServer(s.id);
        refuse = true;
        await expect(p.startServer(s.id)).rejects.toBeInstanceOf(CapacityError);
        await expect(p.restartServer(s.id)).rejects.toBeInstanceOf(CapacityError);
        expect(fake.state.pods.get(s.id).status).toBe('EXITED');
        // Any other 400 to an action is not taken for no capacity.
        const { p: q } = make({}, undefined, (f) => (async (url: string, init?: RequestInit) => (init?.method === 'POST' && /\/action$/.test(new URL(url).pathname)
            ? new Response(JSON.stringify({ error: 'invalid action' }), { status: 400, headers: { 'content-type': 'application/json' } })
            : f(url, init))) as typeof fetch);
        const e = await q.restartServer('pod_x').catch((x) => x);
        expect(e).toBeInstanceOf(ProviderError);
        expect(e).not.toBeInstanceOf(CapacityError);
    });

    it('logs: the container\'s own lines (not RunPod\'s), the last `tail` of them, at most 5000; a refused key is an AuthError', async () => {
        const { p, fake } = make();
        const s = await p.createServer({ name: 'logs', offer: 'NVIDIA RTX A5000', image: 'img', command: ['nvidia-smi', '-L'], gpuCount: 2 });
        expect(await p.getServerLogs(s.id, { tail: 100_000, windowMs: 200 })).toBe('GPU 0: NVIDIA RTX A5000 (UUID: GPU-0f1e2d30)\nGPU 1: NVIDIA RTX A5000 (UUID: GPU-0f1e2d31)');
        expect(fake.calls.find((c) => c.path.includes('/logs'))?.path).toMatch(/tail=5000$/);
        expect(await p.getServerLogs(s.id, { tail: 1, windowMs: 200 })).toBe('GPU 1: NVIDIA RTX A5000 (UUID: GPU-0f1e2d31)');
        const bad = new RunPod({ apiKey: 'wrong', fetchImpl: fake.fetchImpl, sleep: noSleep });
        await expect(bad.getServerLogs(s.id, { windowMs: 200 })).rejects.toBeInstanceOf(AuthError);
    });

    it('a 422 says why (errors[]), and is not taken for no capacity', async () => {
        const { p } = make();
        const e = await p.createServer({ name: 'x', offer: 'NVIDIA RTX A5000', image: 'img', providerOptions: { bogus: 1 } }).catch((x) => x);
        expect(e).toBeInstanceOf(ProviderError);
        expect(e).not.toBeInstanceOf(CapacityError);
        expect(e.message).toMatch(/additional properties 'bogus' not allowed/);
    });

    it('sizes go as whole GB (the API takes integers)', async () => {
        const { p, fake } = make();
        await p.createServer({ name: 'd', offer: 'NVIDIA RTX A5000', image: 'img', diskGb: 20.5, volume: { sizeGb: 12.2, path: '/workspace' } });
        expect(created(fake)[0].body).toMatchObject({ disk: 21, mounts: { persistent: { size: 13, path: '/workspace' } } });
    });

    it('every pod gets a container disk: RunPod refuses one without, once it has found it a machine', async () => {
        const { p, fake } = make();
        await p.createServer({ name: 'no-disk-asked', offer: 'NVIDIA RTX A5000', image: 'img' });
        expect(created(fake)[0].body.disk).toBe(RunPod.DEFAULT_DISK_GB);
        // What RunPod answers a body without one (observed live): not a capacity problem, so no other offer is tried.
        const e = await p.createServer({ name: 'x', offer: 'NVIDIA RTX A5000', image: 'img', providerOptions: { disk: undefined } }).catch((x) => x);
        expect(e).toBeInstanceOf(ProviderError);
        expect(e).not.toBeInstanceOf(CapacityError);
        expect(e.message).toMatch(/template id or pod configuration parameters/);
    });

    it('a 403 at create is a skipped candidate that says it was forbidden', async () => {
        const forbid = (f: typeof fetch) => (async (url: any, init?: RequestInit) => (init?.method === 'POST' && String(url).endsWith('/v2/pods')
            ? new Response(JSON.stringify({ title: 'Forbidden', status: 403, detail: 'your account cannot access the requested pool' }), { status: 403 })
            : f(url, init))) as typeof fetch;
        const { p } = make({}, undefined, forbid);
        const e = await p.createServer({ name: 'f', offer: 'NVIDIA RTX A5000', image: 'img' }).catch((x) => x);
        expect(e).toBeInstanceOf(CapacityError);
        expect(e.code).toBe('forbidden');
    });

    it('keys of any OpenSSH type on the account (a certificate) neither break the list nor are dropped from it', async () => {
        const { p, fake } = make();
        const cert = `ssh-ed25519-cert-v01@openssh.com ${testPublicKey().split(' ')[1]} ci-cert`;
        fake.state.keys = [cert, testPublicKey('laptop')];
        expect((await p.listSSHKeys()).map((k) => k.name).sort()).toEqual(['ci-cert', 'laptop']);
        const added = await p.addSSHKey(testPublicKey('new'), 'new');
        expect(fake.state.keys).toContain(cert);
        await p.deleteSSHKey(added.id);
        expect(fake.state.keys).toEqual([cert, expect.stringMatching(/ laptop$/)]);
    });

    it('talks to REST v2 only (v1 at rest.runpod.io retires 2026-11-15)', async () => {
        const { p, fake } = make();
        await p.listOffers();
        await p.createServer({ name: 'v2', offer: 'NVIDIA RTX A5000', image: 'img' });
        await p.listServers();
        expect(new Set(fake.calls.map((c) => c.host))).toEqual(new Set(['api.runpod.io']));
        expect(fake.calls.every((c) => c.path.startsWith('/v2/'))).toBe(true);
    });
});

describe('minCudaVersion on RunPod: the catalog scopes stock to hosts that run it, and the create places by it', () => {
    const make = () => {
        const fake = fakeRunPod();
        return { fake, p: new RunPod({ apiKey: 'rp-test', fetchImpl: fake.fetchImpl, sleep: noSleep }) };
    };

    it('offers only stock on hosts new enough, each offer saying the newest CUDA it has free', async () => {
        const { p, fake } = make();
        const all = await p.listOffers();
        expect(all.find((o) => o.id === 'NVIDIA GeForce RTX 4090')).toMatchObject({ cudaVersion: '12.4', regions: ['EU-RO-1'] });
        const recent = await p.listOffers({ minCudaVersion: '12.8' });
        expect(last(fake.calls)?.path).toMatch(/[?&]minCudaVersion=12\.8(&|$)/);
        expect(recent.map((o) => o.id)).not.toContain('NVIDIA GeForce RTX 4090');
        expect(recent.find((o) => o.id === 'NVIDIA RTX A5000')).toMatchObject({ cudaVersion: '12.8', regions: ['US-TX-3'] });
        // AMD runs no CUDA.
        expect(recent.map((o) => o.vendor)).not.toContain('amd');
    });

    it('a create carries the floor as major.minor and lands only where it holds', async () => {
        const { p, fake } = make();
        await expect(p.createServer({ name: 'old', offer: 'NVIDIA GeForce RTX 4090', image: 'img', minCudaVersion: '12.8' })).rejects.toBeInstanceOf(CapacityError);
        const s = await p.createServer({ name: 'new', offer: 'NVIDIA RTX A5000', image: 'img', minCudaVersion: '12' });
        const body = last(fake.calls.filter((c) => c.method === 'POST' && c.path === '/v2/pods'))?.body;
        expect(body.gpu).toEqual({ id: 'NVIDIA RTX A5000', count: 1, minCudaVersion: '12.0' });
        expect(fake.state.pods.get(s.id)).toMatchObject({ dataCenterId: 'US-TX-3', cudaVersion: '12.8' });
    });
});

describe('RunPod network volumes and registry logins', () => {
    const make = () => {
        const fake = fakeRunPod();
        return { fake, p: new RunPod({ apiKey: 'rp-test', fetchImpl: fake.fetchImpl, sleep: noSleep }) };
    };
    const IMAGE = 'nvidia/cuda:12.8.1-base-ubuntu24.04';
    const podBodies = (fake: ReturnType<typeof fakeRunPod>) => fake.calls.filter((c) => c.method === 'POST' && c.path === '/v2/pods').map((c) => c.body);
    /** The A5000 in stock on the secure cloud in both data centers, so where a pod goes is the volume's choice, not the offer's. */
    const inBoth = (fake: ReturnType<typeof fakeRunPod>) => {
        fake.state.gpus.find((g) => g.id === 'NVIDIA RTX A5000')!.dataCenters.forEach((d) => { d.SECURE = ['HIGH', 8]; });
    };

    it('a pod mounting a volume (by id) goes to the volume\'s data center, at /workspace unless the mount says', async () => {
        const { fake, p } = make();
        inBoth(fake);
        const offer = (await p.listOffers()).find((o) => o.id === 'NVIDIA RTX A5000')!;
        expect(offer.regions).toEqual(['US-TX-3', 'EU-RO-1']);
        const vol = await p.createVolume({ name: 'models', region: 'EU-RO-1', sizeGb: 10.2 });
        expect(vol).toMatchObject({ region: 'EU-RO-1', sizeGb: 11, status: 'available', mountPath: '/workspace', raw: { type: 'STANDARD' } });
        const pod = await p.waitUntilRunning((await p.createServer({ name: 'a', offer, image: IMAGE, mounts: [{ volume: vol.id }] })).id, fast);
        expect(pod).toMatchObject({ region: 'EU-RO-1', mounts: [{ volumeId: vol.id, path: '/workspace' }] });
        expect(last(podBodies(fake))).toMatchObject({ dataCenterIds: ['EU-RO-1'], mounts: { network: [{ volumeId: vol.id, path: '/workspace' }] } });
        const custom = await p.createServer({ name: 'b', offer, image: IMAGE, mounts: [{ volume: vol, path: '/models' }] });
        expect(custom.mounts).toEqual([{ volumeId: vol.id, path: '/models' }]);
    });

    it('refuses before anything is sent: two volumes, a volume and a disk of its own, a relative path, an unknown volume, a region the volume is not in', async () => {
        const { fake, p } = make();
        const [offer] = await p.listOffers({ kind: 'gpu' });
        const vol = await p.createVolume({ name: 'models', region: 'US-TX-3', sizeGb: 10 });
        const other = await p.createVolume({ name: 'more', region: 'US-TX-3', sizeGb: 10 });
        const o = { name: 'x', offer, image: IMAGE };
        await expect(p.createServer({ ...o, mounts: [{ volume: vol }, { volume: other }] })).rejects.toThrow(NotSupportedError);
        await expect(p.createServer({ ...o, mounts: [{ volume: vol }], volume: { sizeGb: 20, path: '/data' } })).rejects.toThrow(/"mounts" and "volume"/);
        await expect(p.createServer({ ...o, mounts: [{ volume: vol, path: 'models' }] })).rejects.toThrow(/not absolute/);
        await expect(p.createServer({ ...o, mounts: [{ volume: 'vol_missing' }] })).rejects.toThrow(NotFoundError);
        await expect(p.createServer({ ...o, region: 'EU-RO-1', mounts: [{ volume: vol.id }] })).rejects.toThrow(/is in US-TX-3/);
        expect(podBodies(fake)).toEqual([]);
    });

    it('a volume is 10-4096 GB (rounded up to whole GB), in a data center RunPod knows; providerOptions pick its tier', async () => {
        const { fake, p } = make();
        await expect(p.createVolume({ name: 'v', region: 'US-TX-3', sizeGb: 9 })).rejects.toThrow(/10-4096 GB, not 9/);
        await expect(p.createVolume({ name: 'v', region: 'US-TX-3', sizeGb: 4097 })).rejects.toThrow(/10-4096 GB/);
        await expect(p.createVolume({ name: 'v', region: 'XX-NOWHERE-1', sizeGb: 10 })).rejects.toThrow(ProviderError);
        const fast = await p.createVolume({ name: 'v', region: 'US-TX-3', sizeGb: 100, providerOptions: { type: 'HIGH_PERFORMANCE' } });
        expect(fast.raw).toMatchObject({ size: 100, type: 'HIGH_PERFORMANCE', dataCenter: 'US-TX-3' });
        expect(last(fake.calls.filter((c) => c.path === '/v2/network-volumes'))?.body).toEqual({ name: 'v', size: 100, dataCenter: 'US-TX-3', type: 'HIGH_PERFORMANCE' });
    });

    it('stores a registry login once and reuses it; a new password is a new login; the password is never in its name', async () => {
        const { fake, p } = make();
        const [offer] = await p.listOffers();
        const auth = { username: 'puller', password: 'ghp_one' };
        const a = await p.createServer({ name: 'a', offer, image: 'ghcr.io/acme/worker:1', registryAuth: auth });
        const b = await p.createServer({ name: 'b', offer, image: 'ghcr.io/acme/worker:2', registryAuth: auth });
        const stored = [...fake.state.registries.values()];
        expect(stored).toHaveLength(1);
        expect(stored[0]).toMatchObject({ username: 'puller', password: 'ghp_one' });
        expect(stored[0].name).toMatch(/^asap-vps:puller@ghcr\.io:[0-9a-f]{16}$/);
        expect(podBodies(fake).map((x) => x.registry)).toEqual([stored[0].id, stored[0].id]);
        expect([a.raw.registry, b.raw.registry]).toEqual([stored[0].id, stored[0].id]);
        await p.createServer({ name: 'c', offer, image: 'ghcr.io/acme/worker:2', registryAuth: { ...auth, password: 'ghp_two' } });
        expect(fake.state.registries.size).toBe(2);
        expect([...fake.state.registries.values()].map((r) => r.name).join()).not.toMatch(/ghp_/);
    });

    it('a create that is refused stores no login: the account is left with no credential of a pod or endpoint that was never made', async () => {
        const { fake, p } = make();
        const [offer] = await p.listOffers();
        const login = { image: 'ghcr.io/acme/worker:1', registryAuth: { username: 'puller', password: 'ghp_one' } };
        await expect(p.createServer({ name: 'a', offer, ...login, minCudaVersion: 'twelve' })).rejects.toThrow(/bad CUDA version/);
        await expect(p.createServer({ name: 'a', offer, ...login, sshKeyIds: ['no-such-key'] })).rejects.toBeInstanceOf(ProviderError);
        await expect(p.createServer({ name: 'a', offer, ...login, sshKeyIds: ['k'], env: { PUBLIC_KEY: 'ssh-ed25519 AAAA mine' } })).rejects.toThrow(/sshKeyIds or env.PUBLIC_KEY/);
        await expect(p.createEndpoint({ name: 'e', container: login, region: REGION_TYPES.TORONTO })).rejects.toBeInstanceOf(NotSupportedError);
        expect(fake.state.registries.size).toBe(0);
        expect(podBodies(fake)).toEqual([]);
    });

    it('a login another create stored meanwhile is used, not stored twice; other refusals pass through', async () => {
        const fake = fakeRunPod();
        let race = true;
        // The first POST /v2/registries loses a race: another process stored the same login just before.
        const fetchImpl = (async (url: string, init?: RequestInit) => {
            if (race && init?.method === 'POST' && String(url).endsWith('/v2/registries')) {
                race = false;
                const body = JSON.parse(String(init.body));
                fake.state.registries.set('reg_other', { id: 'reg_other', name: body.name, username: body.username, password: body.password });
                return new Response(JSON.stringify({ title: 'Error', status: 400, detail: 'a registry with this name already exists' }), { status: 400 });
            }
            return fake.fetchImpl(url, init);
        }) as typeof fetch;
        const p = new RunPod({ apiKey: 'rp-test', fetchImpl, sleep: noSleep });
        const [offer] = await p.listOffers();
        const s = await p.createServer({ name: 'a', offer, image: 'ghcr.io/acme/worker:1', registryAuth: { username: 'u', password: 'p' } });
        expect(s.raw.registry).toBe('reg_other');
        expect(fake.state.registries.size).toBe(1);
        // A refusal that is not that race (an invalid login) is thrown.
        await expect(p.createServer({ name: 'b', offer, image: 'ghcr.io/acme/worker:1', registryAuth: { username: 'u', password: '' } })).rejects.toThrow(/username and a password/);
        const bad = new RunPod({ apiKey: 'rp-test', fetchImpl: (async (url: string, init?: RequestInit) => (init?.method === 'POST' && String(url).endsWith('/v2/registries')
            ? new Response(JSON.stringify({ title: 'Error', status: 400, detail: 'registry name taken by nobody' }), { status: 400 }) : fake.fetchImpl(url, init))) as typeof fetch, sleep: noSleep });
        await expect(bad.createServer({ name: 'c', offer, image: 'ghcr.io/acme/worker:1', registryAuth: { username: 'v', password: 'w' } })).rejects.toThrow(/taken by nobody/);
    });

    it('registryAuth or providerOptions.registry, not both', async () => {
        const { fake, p } = make();
        const [offer] = await p.listOffers();
        await expect(p.createServer({ name: 'a', offer, image: IMAGE, registryAuth: { username: 'u', password: 'p' }, providerOptions: { registry: 'reg_1' } }))
            .rejects.toThrow(/not both/);
        expect(podBodies(fake)).toEqual([]);
    });
});

describe('RunPod CPU pods (machines without GPUs)', () => {
    const make = (cloud?: 'SECURE' | 'COMMUNITY') => {
        const fake = fakeRunPod();
        return { fake, p: new RunPod({ apiKey: 'rp-test', fetchImpl: fake.fetchImpl, sleep: noSleep, cloud }) };
    };

    it('offers each flavor at each power-of-two vCPU count in its range, priced per vCPU, in stock where that count is', async () => {
        const { p } = make();
        const cpu = await p.listOffers({ kind: 'cpu', includeUnavailable: true });
        expect(cpu.map((o) => o.id).sort()).toEqual(['cpu3c:16', 'cpu3c:2', 'cpu3c:32', 'cpu3c:4', 'cpu3c:8', 'cpu5g:4', 'cpu5g:8']);
        expect(cpu.find((o) => o.id === 'cpu3c:4')).toMatchObject({ gpu: '', vendor: null, gpuCount: 0, vramGb: 0, vcpus: 4, memoryGb: 8, regions: ['US-TX-3'] });
        expect(cpu.find((o) => o.id === 'cpu3c:4')?.pricePerHour).toBeCloseTo(0.12, 9);
        // Stock is per count: 16 vCPUs of cpu3c are listed only in EU-RO-1, which has none.
        expect(cpu.find((o) => o.id === 'cpu3c:16')?.regions).toEqual([]);
        expect((await p.listOffers({ kind: 'cpu' })).map((o) => o.id).sort()).toEqual(['cpu3c:2', 'cpu3c:4', 'cpu3c:8', 'cpu5g:4', 'cpu5g:8']);
        // A question about GPUs reads no CPU flavor.
        expect((await p.listOffers({ gpus: ['RTX A5000'] })).every((o) => o.gpuCount > 0)).toBe(true);
    });

    it('rents a CPU pod as `cpu: {id, vcpuCount}` on the secure cloud, whatever cloud GPUs are rented on; it lists as a CPU server', async () => {
        const { fake, p } = make('COMMUNITY');
        const offer = (await p.listOffers({ kind: 'cpu' })).find((o) => o.id === 'cpu5g:8')!;
        const s = await p.createServer({ name: 'cpu', offer, image: 'busybox:1.36' });
        expect(last(fake.calls.filter((c) => c.method === 'POST' && c.path === '/v2/pods'))?.body).toMatchObject({ cpu: { id: 'cpu5g', vcpuCount: 8 }, cloud: 'SECURE', dataCenterIds: ['EU-RO-1'] });
        expect(last(fake.calls.filter((c) => c.method === 'POST' && c.path === '/v2/pods'))?.body.gpu).toBeUndefined();
        const running = await p.waitUntilRunning(s.id, fast);
        expect(running).toMatchObject({ offerId: 'cpu5g:8', region: 'EU-RO-1', pricePerHour: 0.4 });
        expect(running.gpu).toBeUndefined();
        expect((await p.listServers({ kind: 'cpu' })).map((x) => x.id)).toEqual([s.id]);
        expect((await p.listServers({ kind: 'gpu' })).map((x) => x.id)).not.toContain(s.id);
    });

    it('a CPU pod mounts a network volume, but takes no GPUs and no disk of its own', async () => {
        const { fake, p } = make();
        const offer = (await p.listOffers({ kind: 'cpu' })).find((o) => o.id === 'cpu3c:2')!;
        const vol = await p.createVolume({ name: 'models', region: 'US-TX-3', sizeGb: 10 });
        const s = await p.createServer({ name: 'cpu', offer, image: 'busybox:1.36', mounts: [{ volume: vol, path: '/models' }] });
        expect(s.mounts).toEqual([{ volumeId: vol.id, path: '/models' }]);
        const before = fake.calls.filter((c) => c.method === 'POST' && c.path === '/v2/pods').length;
        await expect(p.createServer({ name: 'x', offer: 'cpu3c:2', gpuCount: 1, image: 'busybox:1.36' })).rejects.toThrow(/a CPU pod has no GPUs/);
        await expect(p.createServer({ name: 'x', offer: 'cpu3c:2', image: 'busybox:1.36', volume: { sizeGb: 10, path: '/data' } })).rejects.toThrow(/no disk of its own/);
        expect(fake.calls.filter((c) => c.method === 'POST' && c.path === '/v2/pods')).toHaveLength(before);
    });
});

describe('RunPod serverless: load-balancing endpoints (plain HTTP workers, no RunPod SDK)', () => {
    const make = (o: Parameters<typeof fakeRunPod>[0] = {}) => {
        const fake = fakeRunPod(o);
        return { fake, p: new RunPod({ apiKey: 'rp-test', fetchImpl: fake.fetchImpl, sleep: noSleep }) };
    };
    const posts = (fake: ReturnType<typeof fakeRunPod>) => fake.calls.filter((c) => c.method === 'POST' && c.path === '/v2/serverless').map((c) => c.body);
    const WHOAMI = { image: 'traefik/whoami:v1.12.0' };

    it('offers GPU types of serverless pools at their pool\'s flex price, and CPU flavors from 2 vCPUs at their serverless price, cheapest first', async () => {
        const { p } = make();
        const offers = await p.listEndpointOffers();
        expect(offers.map((o) => o.pricePerHour)).toEqual([...offers.map((o) => o.pricePerHour)].sort((a, b) => a - b));
        // A type in no pool (the MIG slice, AMD) is no serverless offer; one out of stock is left out unless asked.
        expect(offers.map((o) => o.id)).not.toContain('AMD Instinct MI300X OAM');
        expect(offers.find((o) => o.id === 'NVIDIA RTX A4000')).toMatchObject({ gpuCount: 1, pricePerHour: 0.58, gpu: 'RTX A4000', regions: ['US-TX-3'] });
        // Serverless stock is the pool's own: the 4090's workers run in Texas, its pods in Romania.
        expect(offers.find((o) => o.id === 'NVIDIA GeForce RTX 4090')?.regions).toEqual(['US-TX-3']);
        expect(offers.find((o) => o.id === 'cpu3c:2')).toMatchObject({ gpuCount: 0, vcpus: 2, pricePerHour: 0.04, regions: ['US-TX-3'] });
        expect(offers.some((o) => o.id.endsWith(':1'))).toBe(false);
        // Each kind lists exactly its offers: the CPU flavors, without GPUs, and the GPU types, with one each.
        const ids = async (kind: 'cpu' | 'gpu') => (await p.listEndpointOffers({ kind })).map((o) => o.id).sort();
        expect(offers.every((o) => o.gpuCount === 0 || o.gpuCount === 1)).toBe(true);
        expect(await ids('cpu')).toEqual(offers.filter((o) => o.gpuCount === 0).map((o) => o.id).sort());
        expect(await ids('gpu')).toEqual(offers.filter((o) => o.gpuCount === 1).map((o) => o.id).sort());
        expect((await p.listEndpointOffers({ includeUnavailable: true })).map((o) => o.id)).toContain('NVIDIA L4');
    });

    it('a CPU endpoint: the image serves HTTP on its port (PORT, PORT_HEALTH and an http port set), scaling on requests from zero', async () => {
        const { fake, p } = make();
        const e = await p.createEndpoint({ name: 'whoami', container: { ...WHOAMI, env: { GREETING: 'hi' }, command: ['--port', '80'] }, offer: 'cpu3c:2', idleTimeoutSeconds: 5 });
        expect(posts(fake).pop()).toEqual({
            name: 'whoami', type: 'LOAD_BALANCER', scaling: { type: 'REQUEST_COUNT', requestCount: 1 }, image: 'traefik/whoami:v1.12.0',
            cpu: [{ id: 'cpu3c', vcpuCount: 2 }], workers: { min: 0, max: 1, idleTimeout: 5 },
            env: { GREETING: 'hi', PORT: '80', PORT_HEALTH: '80' }, ports: ['80/http'], cmd: ['--port', '80'],
        });
        expect(e).toMatchObject({ provider: 'runpod', name: 'whoami', url: `https://${e.id}.api.runpod.ai`, status: 'ready', image: 'traefik/whoami:v1.12.0',
            port: 80, offerId: 'cpu3c:2', minWorkers: 0, maxWorkers: 1, idleTimeoutSeconds: 5, private: true });
        expect(await p.getEndpoint(e.id)).toMatchObject({ id: e.id, url: e.url });
        expect((await p.listEndpoints()).map((x) => x.id)).toEqual([e.id]);
    });

    it('a GPU offer pins the worker to that GPU type: its pool, the pool\'s other types left out', async () => {
        const { fake, p } = make();
        const [a5000] = await p.listEndpointOffers({ gpus: ['RTX A5000'] });
        await p.createEndpoint({ name: 'gpu', container: WHOAMI, offer: a5000, port: 8000, minWorkers: 1, maxWorkers: 2 });
        const body = posts(fake).pop();
        expect(body.gpu).toEqual({ pools: ['AMPERE_24'], excludedTypes: ['NVIDIA L4', 'NVIDIA RTX 3090'], count: 1 });
        expect(body).toMatchObject({ workers: { min: 1, max: 2 }, env: { PORT: '8000', PORT_HEALTH: '8000' }, ports: ['8000/http'] });
        // No offer: the cheapest in stock.
        await p.createEndpoint({ name: 'cheapest', container: WHOAMI });
        expect(posts(fake).pop().cpu).toEqual([{ id: 'cpu3c', vcpuCount: 2 }]);
    });

    it('a private image\'s login is stored once and named by the endpoint', async () => {
        const { fake, p } = make();
        const auth = { username: 'bot', password: 'ghp_pull', server: 'ghcr.io' };
        await p.createEndpoint({ name: 'a', container: { image: 'ghcr.io/acme/app:1', registryAuth: auth }, offer: 'cpu3c:2' });
        await p.createEndpoint({ name: 'b', container: { image: 'ghcr.io/acme/app:1', registryAuth: auth }, offer: 'cpu3c:2' });
        const [a, b] = posts(fake);
        expect(a.registry).toBeTruthy();
        expect(b.registry).toBe(a.registry);
        expect(fake.state.registries.get(a.registry)).toMatchObject({ username: 'bot', password: 'ghp_pull' });
    });

    it('refuses what it cannot make before anything is sent', async () => {
        const { fake, p } = make();
        const refused: Array<[Parameters<RunPod['createEndpoint']>[0], RegExp]> = [
            [{ name: 'x', container: { image: '' }, offer: 'cpu3c:2' }, /needs an image/],
            [{ name: 'x', container: { ...WHOAMI, env: { PORT: '8080' } }, offer: 'cpu3c:2' }, /pass port \(8080\), not env\.PORT/],
            [{ name: 'x', container: WHOAMI, offer: 'cpu3c:2', minWorkers: 2, maxWorkers: 1 }, /minWorkers <= maxWorkers/],
            [{ name: 'x', container: WHOAMI, offer: 'cpu3c:2', maxWorkers: 0 }, /maxWorkers >= 1/],
            [{ name: 'x', container: WHOAMI, offer: 'cpu3c:2', idleTimeoutSeconds: 0 }, /idleTimeoutSeconds is 1-3600/],
            [{ name: 'x', container: WHOAMI, offer: 'cpu3c:1' }, /power-of-two vCPU count from 2, not 1/],
            [{ name: 'x', container: WHOAMI, offer: 'cpu3c:2', port: 70000 }, /bad port/],
            [{ name: 'x', container: WHOAMI, offer: 'NVIDIA RTX PRO 6000 Blackwell Server Edition MIG 1g.24gb' }, /in no serverless pool/],
            [{ name: 'x', container: WHOAMI, offer: 'NVIDIA H200' }, /no GPU type "NVIDIA H200"/],
        ];
        for (const [o, why] of refused) await expect(p.createEndpoint(o)).rejects.toThrow(why);
        const theirs = { ...(await p.listEndpointOffers())[0], provider: 'vast' };
        await expect(p.createEndpoint({ name: 'x', container: WHOAMI, offer: theirs })).rejects.toThrow(/vast's, not runpod's/);
        expect(posts(fake)).toEqual([]);
    });

    it('a request reaches the workers with the account key, the cold start waited out; the key goes to RunPod\'s own host only', async () => {
        const { fake, p } = make({ coldRequests: 2 });
        const e = await p.createEndpoint({ name: 'whoami', container: WHOAMI, offer: 'cpu3c:2' });
        const r = await p.requestEndpoint(e, '/api?x=1', { method: 'GET', headers: { 'x-trace': 't1' }, intervalMs: 0 });
        expect(r.status).toBe(200);
        expect(await r.json()).toMatchObject({ worker: `w-${e.id}`, path: '/api', query: '?x=1', port: 80 });
        const sent = fake.calls.filter((c) => c.host === `${e.id}.api.runpod.ai`);
        expect(sent).toHaveLength(3);
        expect(sent.every((c) => c.auth === 'Bearer rp-test' && c.headers?.['x-trace'] === 't1')).toBe(true);
        // By id too; a record whose url says elsewhere is still sent to RunPod's host, made from its id.
        expect((await p.requestEndpoint(e.id, 'api', { intervalMs: 0 })).status).toBe(200);
        await p.requestEndpoint({ ...e, url: 'https://evil.example.com' }, '/api', { intervalMs: 0 });
        expect(fake.calls.some((c) => c.host === 'evil.example.com')).toBe(false);
        await expect(p.requestEndpoint('../x', '/api')).rejects.toThrow(/bad endpoint id/);
        await expect(p.requestEndpoint({ ...e, provider: 'scaleway' }, '/api')).rejects.toThrow(/scaleway's, not runpod's/);
    });

    it('a cold start that outlasts the wait returns RunPod\'s answer; a body that is a stream is sent once', async () => {
        const { fake, p } = make({ coldRequests: 1e9 });
        const e = await p.createEndpoint({ name: 'cold', container: WHOAMI, offer: 'cpu3c:2' });
        const r = await p.requestEndpoint(e, '/api', { intervalMs: 0, timeoutMs: 30 });
        expect(r.status).toBe(400);
        expect(await r.json()).toEqual({ error: 'no workers available' });
        const before = fake.calls.length;
        expect((await p.requestEndpoint(e, '/api', { method: 'POST', body: new Response('x').body!, duplex: 'half', intervalMs: 0 } as RequestInit)).status).toBe(400);
        expect(fake.calls.length).toBe(before + 1);
    });

    it('a host that does not resolve yet (a fresh endpoint) is tried again; one that never does is the network\'s error', async () => {
        const fake = fakeRunPod({ coldRequests: 0 });
        let unresolved = 2;
        const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
            if (new URL(String(url)).host.endsWith('.api.runpod.ai') && unresolved-- > 0) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } });
            return fake.fetchImpl(url, init);
        }) as typeof fetch;
        const p = new RunPod({ apiKey: 'rp-test', fetchImpl, sleep: noSleep });
        const e = await p.createEndpoint({ name: 'fresh', container: WHOAMI, offer: 'cpu3c:2' });
        expect((await p.requestEndpoint(e, '/api', { intervalMs: 0 })).status).toBe(200);
        unresolved = 1e9;
        await expect(p.requestEndpoint(e, '/api', { intervalMs: 0, timeoutMs: 20 })).rejects.toThrow(/fetch failed/);
        await expect(p.requestEndpoint(e, '/api', { method: 'POST', body: new Response('x').body!, duplex: 'half' } as RequestInit)).rejects.toThrow(/fetch failed/);
    });

    it('deleted: scaled to no workers first, then deleted; gone, and deleting it again is no error', async () => {
        const { fake, p } = make();
        const e = await p.createEndpoint({ name: 'whoami', container: WHOAMI, offer: 'cpu3c:2' });
        await p.requestEndpoint(e, '/', { intervalMs: 0 });
        await p.deleteEndpoint(e.id);
        expect(fake.calls.filter((c) => c.path.startsWith(`/v2/serverless/${e.id}`) && c.method !== 'GET').map((c) => [c.method, c.body])).toEqual([
            ['PATCH', { workers: { min: 0, max: 0 } }], ['DELETE', undefined],
        ]);
        expect(await p.getEndpoint(e.id)).toBeNull();
        expect(await p.listEndpoints()).toEqual([]);
        await expect(p.deleteEndpoint(e.id)).resolves.toBeUndefined();
    });

    it('lists every page of the account\'s endpoints, newest first, each page asked for by the cursor the one before gave', async () => {
        // RunPod cuts its pages at two rows here: five endpoints are three pages.
        const { fake, p } = make({ pageSize: 2 });
        for (let i = 0; i < 5; i++) await p.createEndpoint({ name: `e${i}`, container: WHOAMI, offer: 'cpu3c:2' });
        const reads = () => fake.calls.filter((c) => c.method === 'GET' && c.path.startsWith('/v2/serverless?')).map((c) => new URLSearchParams(c.path.split('?')[1]));
        const before = reads().length;
        expect((await p.listEndpoints()).map((e) => e.name)).toEqual(['e4', 'e3', 'e2', 'e1', 'e0']);
        const pages = reads().slice(before);
        expect(pages.map((q) => q.get('limit'))).toEqual(['1000', '1000', '1000']);
        expect(pages.map((q) => q.has('cursor'))).toEqual([false, true, true]);
    });
});
