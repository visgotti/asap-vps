// RunPod against the fake of its REST v2 API (src/testing/fakes/runpod.ts): what
// is particular to it beyond the shared contract (../contract.spec.ts). From
// api.runpod.io/v2/openapi.json and docs.runpod.io (checked 2026-09-29): MIG
// slices are GPU types of their own, the catalog's secure/community flags say
// where a type is sold, pods take no UDP, sshd's direct endpoint needs 22/tcp, a
// resumed pod can come back without its GPU, logs backfill at most 5000 lines, a
// 422 explains itself in errors[], sizes are whole GB, the account's key list
// holds any OpenSSH key type, and minCudaVersion scopes the catalog's stock and
// places the pod.

import { CUDA_TYPES, MACHINE_TYPES, REGION_TYPES } from '../../constants';
import { AuthError, CapacityError, NotFoundError, NotSupportedError, ProviderError } from '../../errors';
import { sshdBootScript } from '../../Core/utils';
import { fakeRunPod } from '../../testing/fakes/runpod';
import { followingRedirects, testPublicKey, waitingClock } from '../../testing/fakes/util';
import { runPodGpuName, sseLogLines } from './mappers';
import { RunPod } from './RunPod';

const noSleep = async () => {};
const fast = { intervalMs: 0, timeoutMs: 5000 };
const last = <T>(a: T[]): T | undefined => a[a.length - 1];
/** An answer as RunPod's API (or a worker) sends one: JSON, with its status. */
const answer = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

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

    it('starting a pod RunPod does not have is a NotFoundError, and no action is sent', async () => {
        const { p, fake } = make();
        const e = await p.startServer('pod_gone').catch((x) => x);
        expect([e.constructor.name, e.message]).toEqual(['NotFoundError', 'runpod: pod pod_gone not found']);
        expect(fake.calls.filter((c) => c.method === 'POST')).toEqual([]);
    });

    it('only a 409 means an action is done already, and only when the pod is where the action would put it', async () => {
        const fake = fakeRunPod();
        // A key that may read but not act: RunPod answers its actions 403.
        let readOnly = false;
        const p = new RunPod({ apiKey: 'rp-test', sleep: noSleep, fetchImpl: (async (url: string, init?: RequestInit) => (readOnly && init?.method === 'POST' && /\/action$/.test(new URL(url).pathname)
            ? answer(403, { title: 'Forbidden', status: 403, detail: 'this API key cannot act on pods' }) : fake.fetchImpl(url, init))) as typeof fetch });
        const s = await p.createServer({ name: 'x', offer: 'NVIDIA RTX A5000', image: 'img' });
        await p.waitUntilRunning(s.id, fast);
        await p.stopServer(s.id);
        readOnly = true;
        // Stopped already, but the key is told it cannot act.
        const refused = await p.stopServer(s.id).catch((x) => x);
        expect([refused?.constructor.name, refused?.status]).toEqual(['AuthError', 403]);
        readOnly = false;
        // A stop of a pod in ERROR: RunPod's 409, and the pod is not stopped.
        fake.state.pods.get(s.id).status = 'ERROR';
        const stuck = await p.stopServer(s.id).catch((x) => x);
        expect([stuck?.constructor.name, stuck?.message]).toEqual(['ProviderError', `runpod: POST /v2/pods/${s.id}/action -> 409 cannot stop a pod that is ERROR`]);
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

    it('a write RunPod refuses is not sent again; one it fails with any server error is, each time from a fresh read', async () => {
        for (const [status, writes, waits] of [[422, 1, []], [500, 3, [1000, 2000]]] as const) {
            const fake = fakeRunPod();
            let sent = 0;
            const failing = (async (url: string | URL | Request, init?: RequestInit) => (init?.method === 'PUT' && ++sent
                ? answer(status, { title: 'Error', status, detail: 'refused' }) : fake.fetchImpl(url, init))) as typeof fetch;
            const slept: number[] = [];
            const p = new RunPod({ apiKey: 'rp-test', fetchImpl: failing, sleep: async (ms) => void slept.push(ms) });
            await expect(p.addSSHKey(testPublicKey('k'), 'k')).rejects.toMatchObject({ status });
            expect([status, sent, slept]).toEqual([status, writes, waits]);
        }
    });

    it('a key added with no name is its bare line', async () => {
        const { p, fake } = make();
        const pub = testPublicKey('its-own-comment');
        const bare = pub.split(' ').slice(0, 2).join(' ');
        const k = await p.addSSHKey(pub, '');
        expect(fake.state.keys).toEqual([bare]);
        expect([k.publicKey, k.name]).toEqual([bare, '']);
    });

    it('a line of the key list this parser cannot read is left out of the list, and kept on the account', async () => {
        const { p, fake } = make();
        // A line RunPod's pattern takes, whose key is not base64.
        const odd = 'ssh-ed25519 not-base64! old-laptop';
        const laptop = testPublicKey('laptop');
        fake.state.keys = [odd, laptop];
        expect((await p.listSSHKeys()).map((k) => k.name)).toEqual(['laptop']);
        const added = await p.addSSHKey(testPublicKey('new'), 'new');
        expect(await p.deleteSSHKey(added.id)).toBe(true);
        expect(fake.state.keys).toEqual([odd, laptop]);
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
        await expect(p.createServer({ name: 'u', offer: 'NVIDIA RTX A5000', image: 'img', ports: ['8080/tcp', '9000/UDP'] }))
            .rejects.toThrow(/^runpod: createServer option "ports" with udp is not supported$/);
        expect(created(fake)).toHaveLength(0);
    });

    it('SSH keys expose 22/tcp once, so the pod has sshd\'s direct endpoint and its host\'s address', async () => {
        const { p, fake } = make();
        const key = await p.addSSHKey(testPublicKey('ci'), 'ci');
        const run = { offer: 'NVIDIA RTX A5000', image: 'img', command: ['serve'], sshKeyIds: [key.id] };
        const s = await p.createServer({ name: 'ssh', ...run, ports: ['8888/http'] });
        expect(created(fake)[0].body).toMatchObject({ ports: ['8888/http', '22/tcp'], startSsh: true });
        const running = await p.waitUntilRunning(s.id, fast);
        expect(running.ip).toBe('194.68.245.10');
        expect(running.ports?.find((x) => x.privatePort === 22)).toMatchObject({ protocol: 'tcp', publicPort: 40022 });
        expect(running.ssh).toEqual({ host: '194.68.245.10', port: 40022, username: 'root' });
        await p.createServer({ name: 'ssh2', ...run, ports: ['22/tcp'] });
        expect(created(fake)[1].body.ports).toEqual(['22/tcp']);
        // Added to no ports at all, and to a port that only ends in 22; not to 22/tcp among others.
        const ports = async (asked?: string[]) => {
            await p.createServer({ name: 'ssh3', ...run, ...(asked ? { ports: asked } : {}) });
            return last(created(fake))?.body.ports;
        };
        expect(await ports()).toEqual(['22/tcp']);
        expect(await ports(['8022/tcp'])).toEqual(['8022/tcp', '22/tcp']);
        expect(await ports(['22/tcp', '8888/http'])).toEqual(['22/tcp', '8888/http']);
    });

    it('sshKeyIds are the keys that log in, and no other (RunPod would hand the pod every account key), and an unknown id is refused', async () => {
        const { p, fake } = make();
        fake.state.keys = [testPublicKey('colleague')];
        const mine = await p.addSSHKey(testPublicKey('ci'), 'ci');
        const run = { offer: 'NVIDIA RTX A5000', image: 'img', command: ['serve'] };
        await p.createServer({ name: 'k', ...run, sshKeyIds: [mine.id] });
        expect(created(fake)[0].body.env).toEqual({ PUBLIC_KEY: mine.publicKey });
        await expect(p.createServer({ name: 'k2', ...run, sshKeyIds: ['SHA256:not-on-the-account'] })).rejects.toBeInstanceOf(NotFoundError);
        await expect(p.createServer({ name: 'k3', ...run, sshKeyIds: [mine.id], env: { PUBLIC_KEY: 'x' } })).rejects.toThrow(/not both/);
        expect(created(fake)).toHaveLength(1);
        // Several keys: one a line, as authorized_keys holds them.
        const other = await p.addSSHKey(testPublicKey('ci2'), 'ci2');
        await p.createServer({ name: 'k4', ...run, sshKeyIds: [mine.id, other.id] });
        expect(last(created(fake))?.body.env).toEqual({ PUBLIC_KEY: `${mine.publicKey}\n${other.publicKey}` });
    });

    it('a pod that keys log in to starts an SSH server before its command: RunPod gives a container none, so its entrypoint is the library\'s, and its command what that hands over to', async () => {
        const { p, fake } = make();
        const [a, b] = [await p.addSSHKey(testPublicKey('a'), 'a'), await p.addSSHKey(testPublicKey('b'), 'b')];
        const s = await p.createServer({ name: 'ssh', offer: 'NVIDIA RTX A5000', image: 'ghcr.io/acme/app:1', command: ['python', 'serve.py'], sshKeyIds: [a.id, b.id] });
        const body = last(created(fake))?.body;
        expect(body.entrypoint).toEqual(['sh', '-c', `${sshdBootScript([a.publicKey, b.publicKey])}exec "$@"`, 'asap-vps']);
        expect(body.cmd).toEqual(['python', 'serve.py']);
        // Something answers at its endpoint once it runs, and takes those two keys alone.
        const running = await p.waitUntilRunning(s.id, fast);
        expect(fake.machine!(running.ssh!.host, running.ssh!.port)?.keys).toEqual([a.publicKey, b.publicKey]);
        // A pod without keys keeps the image's own entrypoint, and nothing answers there.
        const plain = await p.waitUntilRunning((await p.createServer({ name: 'plain', offer: 'NVIDIA RTX A5000', image: 'ghcr.io/acme/app:1', ports: ['22/tcp'] })).id, fast);
        expect(last(created(fake))?.body.entrypoint).toBeUndefined();
        expect(fake.machine!(plain.ssh!.host, plain.ssh!.port)).toBeUndefined();
    });

    it('an image named by the library\'s enums is logged in to as it is: kept up after its SSH server; an image of the caller\'s own with no command is refused before anything is read or rented', async () => {
        const { p, fake } = make();
        const key = await p.addSSHKey(testPublicKey('ci'), 'ci');
        await p.createServer({ name: 'ubuntu', offer: 'NVIDIA RTX A5000', image: MACHINE_TYPES.UBUNTU_24, sshKeyIds: [key.id] });
        expect(last(created(fake))?.body).toMatchObject({ image: 'ubuntu:24.04', entrypoint: ['sh', '-c', `${sshdBootScript([key.publicKey])}exec "$@"`, 'asap-vps'], cmd: ['sleep', 'infinity'] });
        const asked = fake.calls.length;
        await expect(p.createServer({ name: 'own', offer: 'NVIDIA RTX A5000', image: 'ghcr.io/acme/app:1', sshKeyIds: [key.id] })).rejects.toMatchObject({
            name: 'NotSupportedError',
            message: 'runpod: createServer option "sshKeyIds" without "command" on an image of your own (the SSH server is started before the command, which replaces the image\'s own start: say what it runs) is not supported',
        });
        expect(fake.calls).toHaveLength(asked);
        // An image that starts sshd itself from PUBLIC_KEY (RunPod's own do) is given the key the way it reads it.
        await p.createServer({ name: 'runpod-image', offer: 'NVIDIA RTX A5000', image: 'runpod/base:1', env: { PUBLIC_KEY: key.publicKey }, ports: ['22/tcp'] });
        expect(last(created(fake))?.body).toMatchObject({ env: { PUBLIC_KEY: key.publicKey }, ports: ['22/tcp'] });
        expect(last(created(fake))?.body.entrypoint).toBeUndefined();
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

    describe('a pod reads as RUNNING before RunPod has published its ports (seen live): waitUntilRunning returns it once it says where it is reached', () => {
        const slow = (publishReads: number, fetchImpl?: (inner: typeof fetch) => typeof fetch, sleep: (ms: number) => Promise<void> = noSleep) => {
            const fake = fakeRunPod({ publishReads });
            return { fake, p: new RunPod({ apiKey: 'rp-test', fetchImpl: fetchImpl ? fetchImpl(fake.fetchImpl) : fake.fetchImpl, sleep }) };
        };
        const readsOf = (fake: ReturnType<typeof fakeRunPod>) => fake.calls.filter((c) => c.method === 'GET' && /^\/v2\/pods\/[^/]+$/.test(c.path)).length;
        const shown = (s: { ports?: Array<{ privatePort: number, protocol?: string }> }) => s.ports?.map((x) => `${x.privatePort}/${x.protocol}`).sort();

        it('one made to be logged in to: with its SSH endpoint and every port it exposes, no sooner and not a read later', async () => {
            const { p, fake } = slow(3);
            const key = await p.addSSHKey(testPublicKey('laptop'), 'laptop');
            const pod = await p.createServer({ name: 'ssh', offer: 'NVIDIA RTX A5000', image: 'img', command: ['sleep', 'infinity'], ports: ['8080/tcp'], sshKeyIds: [key.id] });
            // What RunPod says of a pod that has just come up: it runs, and is nowhere yet. Its record says what it was made to expose.
            const early = await p.waitForServer(pod.id, (s) => s?.status === 'running', fast);
            expect([early?.status, early?.ssh, early?.ports, early?.raw.ports]).toEqual(['running', undefined, [], ['8080/tcp', '22/tcp']]);
            const before = readsOf(fake);
            const s = await p.waitUntilRunning(pod.id, fast);
            expect([s.ssh, shown(s)]).toEqual([{ host: '194.68.245.10', port: expect.any(Number), username: 'root' }, ['22/tcp', '8080/tcp']]);
            expect(readsOf(fake) - before).toBe(3);
        });

        it('one that only exposes ports: with each of them, http and tcp; one that exposes none is returned as soon as it runs', async () => {
            const { p, fake } = slow(2);
            const web = await p.createServer({ name: 'web', offer: 'NVIDIA RTX A5000', image: 'img', ports: ['8888/http', '8080/tcp'] });
            expect((await p.waitForServer(web.id, (s) => s?.status === 'running', fast))?.ports).toEqual([]);
            let before = readsOf(fake);
            expect(shown(await p.waitUntilRunning(web.id, fast))).toEqual(['8080/tcp', '8888/http']);
            expect(readsOf(fake) - before).toBe(2);
            // Each port, and its public one: a read that lists one of the two, and then both with one not given a public port yet, is no place to stop.
            let read = 0;
            const partly = slow(1, (inner) => async (url, init) => {
                const r = await inner(url, init);
                if ((init?.method ?? 'GET') !== 'GET' || !/\/v2\/pods\/[^/?]+$/.test(String(url))) return r;
                const pod = await r.json();
                if (!pod.runtime?.ports?.length) return answer(r.status, pod);
                read++;
                if (read === 1) pod.runtime.ports = pod.runtime.ports.filter((x: { type: string }) => x.type === 'http');
                if (read === 2) pod.runtime.ports = pod.runtime.ports.map((x: { type: string }) => (x.type === 'tcp' ? { ...x, public: null } : x));
                return answer(r.status, pod);
            });
            const two = await partly.p.createServer({ name: 'two', offer: 'NVIDIA RTX A5000', image: 'img', ports: ['8888/http', '8080/tcp'] });
            await partly.p.waitForServer(two.id, (s) => s?.status === 'running', fast);
            before = readsOf(partly.fake);
            const whole = await partly.p.waitUntilRunning(two.id, fast);
            expect([whole.ports?.map((x) => [`${x.privatePort}/${x.protocol}`, typeof x.publicPort]).sort(), readsOf(partly.fake) - before]).toEqual([[['8080/tcp', 'number'], ['8888/http', 'number']], 3]);
            // Nothing to publish: nothing to wait for, however long RunPod would take.
            const never = slow(Infinity);
            const bare = await never.p.createServer({ name: 'bare', offer: 'NVIDIA RTX A5000', image: 'img' });
            await never.p.waitForServer(bare.id, (s) => s?.status === 'running', fast);
            before = readsOf(never.fake);
            const s = await never.p.waitUntilRunning(bare.id, fast);
            expect([s.status, s.ports, s.ssh, readsOf(never.fake) - before]).toEqual(['running', [], undefined, 1]);
        });

        it('what a pod was made to expose is read as the library reads a port, and an http port is published once RunPod lists it: a pod that is up is never waited on for a spelling, or for a public port an http port need not have', async () => {
            // RunPod's spec makes a pod's `ports` any strings ("formatted as port/protocol") and lets a runtime port's `public` be null.
            // Each of these is a pod that is up and reachable; before this, every one was waited on until the wait ran out.
            const cases: Array<[string, string[], (ports: Array<{ private: number, type: string, public: number | null }>) => unknown[], string[]]> = [
                ['spelled in capitals, and a bare port (tcp)', ['8888/HTTP', '8080'], (ports) => ports, ['8080/tcp', '8888/http']],
                ['blank space around them', [' 8888/http ', '8080/tcp\n'], (ports) => ports, ['8080/tcp', '8888/http']],
                ['an http port listed with no public port: it is reached through the proxy, by its own number', ['8888/http', '8080/tcp'], (ports) => ports.map((x) => (x.type === 'http' ? { ...x, public: null } : x)), ['8080/tcp', '8888/http']],
                ['the type RunPod lists in capitals: a server\'s ports say it as the library writes a protocol', ['8888/http', '8080/tcp'], (ports) => ports.map((x) => ({ ...x, type: x.type.toUpperCase() })), ['8080/tcp', '8888/http']],
                ['a string that is no port names nothing to wait for', ['8888/http', '8080/tcp', 'not-a-port', '70000/tcp', '53/sctp'], (ports) => ports, ['8080/tcp', '8888/http']],
            ];
            for (const [what, asked, listed, expected] of cases) {
                const { p, fake } = slow(1, (inner) => async (url, init) => {
                    const r = await inner(url, init);
                    if ((init?.method ?? 'GET') !== 'GET' || !/\/v2\/pods\/[^/?]+$/.test(String(url))) return r;
                    const pod = await r.json();
                    pod.ports = asked;
                    if (pod.runtime?.ports?.length) pod.runtime.ports = listed(pod.runtime.ports);
                    return answer(r.status, pod);
                });
                const made = await p.createServer({ name: 'web', offer: 'NVIDIA RTX A5000', image: 'img', ports: ['8888/http', '8080/tcp'] });
                expect([what, (await p.waitForServer(made.id, (s) => s?.status === 'running', fast))?.ports]).toEqual([what, []]);
                const before = readsOf(fake);
                const s = await p.waitUntilRunning(made.id, fast);
                // At the first read that lists its ports: not one later, and not at the read before, which listed none.
                expect([what, shown(s), readsOf(fake) - before]).toEqual([what, expected, 1]);
            }
        });

        it('a tcp port with no public port is still nowhere to reach, however it is spelled: waited for, as its SSH endpoint is where 22 is among them', async () => {
            let read = 0;
            const { p, fake } = slow(1, (inner) => async (url, init) => {
                const r = await inner(url, init);
                if ((init?.method ?? 'GET') !== 'GET' || !/\/v2\/pods\/[^/?]+$/.test(String(url))) return r;
                const pod = await r.json();
                pod.ports = ['8080/TCP', '22'];
                if (!pod.runtime?.ports?.length) return answer(r.status, pod);
                read++;
                if (read === 1) pod.runtime.ports = pod.runtime.ports.map((x: { private: number }) => (x.private === 8080 ? { ...x, public: null } : x));
                if (read <= 2) pod.ssh.direct = null;
                return answer(r.status, pod);
            });
            const key = await p.addSSHKey(testPublicKey('laptop'), 'laptop');
            const pod = await p.createServer({ name: 'ssh', offer: 'NVIDIA RTX A5000', image: 'img', command: ['sleep', 'infinity'], ports: ['8080/tcp'], sshKeyIds: [key.id] });
            await p.waitForServer(pod.id, (s) => s?.status === 'running', fast);
            const before = readsOf(fake);
            const s = await p.waitUntilRunning(pod.id, fast);
            expect([shown(s), s.ssh !== undefined, readsOf(fake) - before]).toEqual([['22/tcp', '8080/tcp'], true, 3]);
        });

        it('its SSH port published but its endpoint not named yet: still waited for; a record that names no ports at all is one to return', async () => {
            // RunPod's answers once it lists the pod's ports: first with no public port for them yet (null, as its reference allows),
            // then with the ports published and the endpoint still left out, then whole.
            let read = 0;
            const { p, fake } = slow(1, (inner) => async (url, init) => {
                const r = await inner(url, init);
                if ((init?.method ?? 'GET') !== 'GET' || !/\/v2\/pods\/[^/?]+$/.test(String(url))) return r;
                const pod = await r.json();
                if (!pod.runtime?.ports?.length) return answer(r.status, pod);
                read++;
                if (read === 1) pod.runtime.ports = pod.runtime.ports.map((x: object) => ({ ...x, public: null }));
                if (read <= 2) pod.ssh.direct = null;
                return answer(r.status, pod);
            });
            const key = await p.addSSHKey(testPublicKey('laptop'), 'laptop');
            const pod = await p.createServer({ name: 'ssh', offer: 'NVIDIA RTX A5000', image: 'img', command: ['sleep', 'infinity'], sshKeyIds: [key.id] });
            await p.waitForServer(pod.id, (s) => s?.status === 'running', fast);
            const before = readsOf(fake);
            const s = await p.waitUntilRunning(pod.id, fast);
            expect([s.ssh?.username, shown(s), s.ports?.[0].publicPort === undefined, readsOf(fake) - before]).toEqual(['root', ['22/tcp'], false, 3]);
            // A record with no list of what the pod exposes (a field RunPod may leave out): nothing is known to wait for.
            const other = slow(Infinity, (inner) => async (url, init) => {
                const r = await inner(url, init);
                if ((init?.method ?? 'GET') !== 'GET' || !/\/v2\/pods\/[^/?]+$/.test(String(url))) return r;
                const { ports, ...rest } = await r.json();
                return answer(r.status, rest);
            });
            const old = await other.p.createServer({ name: 'old', offer: 'NVIDIA RTX A5000', image: 'img', ports: ['8080/tcp'] });
            expect((await other.p.waitUntilRunning(old.id, fast)).status).toBe('running');
        });

        it('one whose ports are never published is not returned as if it could be reached: the wait runs out, and says what it was waiting for', async () => {
            const clock = waitingClock();
            try {
                const { p } = slow(Infinity, undefined, clock.sleep);
                const pod = await p.createServer({ name: 'nowhere', offer: 'NVIDIA RTX A5000', image: 'img', ports: ['8080/tcp'] });
                await expect(p.waitUntilRunning(pod.id, { timeoutMs: 30_000, intervalMs: 10_000 })).rejects.toMatchObject({
                    name: 'ProviderError', code: 'timeout',
                    message: `runpod: timed out after 30 s waiting for server ${pod.id}: running (RUNNING), which has not said where it is reached yet (its SSH endpoint, its ports)`,
                });
                // One that never came to run is reported as what it still was, and no more: where it is reached is no question yet.
                const fake = fakeRunPod({ bootReads: Infinity });
                const stuck = new RunPod({ apiKey: 'rp-test', fetchImpl: fake.fetchImpl, sleep: clock.sleep });
                const starting = await stuck.createServer({ name: 'starting', offer: 'NVIDIA RTX A5000', image: 'img', ports: ['8080/tcp'] });
                await expect(stuck.waitUntilRunning(starting.id, { timeoutMs: 30_000, intervalMs: 10_000 })).rejects.toMatchObject({
                    code: 'timeout', message: `runpod: timed out after 30 s waiting for server ${starting.id}: pending (STARTING)`,
                });
            } finally {
                clock.restore();
            }
        });
    });

    it('a pod resumed without its GPU is stopped again and reported as no capacity', async () => {
        const { p, fake } = make({ resumeWithoutGpu: true });
        const s = await p.createServer({ name: 'r', offer: 'NVIDIA RTX A5000', image: 'img' });
        await p.waitUntilRunning(s.id, fast);
        await p.stopServer(s.id);
        const e = await p.startServer(s.id).catch((x) => x);
        expect(e).toBeInstanceOf(CapacityError);
        expect(e.message).toBe(`runpod: pod ${s.id} resumed without a GPU (its host has none free now): stopped it again`);
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

    it('a host with no GPU free is no capacity however RunPod words it: one GPU or several, "not enough free" or "no free/available"', async () => {
        let detail = '';
        const { p } = make({}, undefined, (f) => (async (url: string, init?: RequestInit) => (init?.method === 'POST' && new URL(url).pathname.endsWith('/action')
            ? answer(400, { title: 'Bad Request', status: 400, detail }) : f(url, init))) as typeof fetch);
        for (detail of ['not enough free GPU on the host machine', 'no free GPU on this host', 'no available GPUs']) {
            const e = await p.restartServer('pod_x').catch((x) => x);
            expect([detail, e.constructor.name]).toEqual([detail, 'CapacityError']);
        }
    });

    it('the log stream stays open: the window closing ends the read with what arrived; a stream that breaks before is a retriable error', async () => {
        // An open stream, as RunPod's is: fetch errors the body when its request is aborted (the Fetch standard's "abort fetch").
        let breaks = false;
        const { p } = make({}, undefined, (f) => (async (url: string, init?: RequestInit) => {
            if (!new URL(url).pathname.endsWith('/logs')) return f(url, init);
            const signal = init?.signal;
            const body = new ReadableStream<Uint8Array>({
                start(c) {
                    c.enqueue(new TextEncoder().encode('data: {"source":"container","line":"ready"}\n\n'));
                    if (breaks) c.error(new TypeError('terminated'));
                    signal?.addEventListener('abort', () => c.error(signal.reason));
                },
            });
            return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
        }) as typeof fetch);
        const s = await p.createServer({ name: 'logs', offer: 'NVIDIA RTX A5000', image: 'img' });
        expect(await p.getServerLogs(s.id, { windowMs: 20 })).toBe('ready');
        breaks = true;
        const e = await p.getServerLogs(s.id, { windowMs: 5000 }).catch((x) => x);
        expect([e.constructor.name, e.message, e.retriable, e.cause?.constructor.name, e.cause?.message])
            .toEqual(['ProviderError', `runpod: logs of pod ${s.id}: terminated`, true, 'TypeError', 'terminated']);
    });

    it('a log read RunPod fails with a body that is not JSON, or is cut off, is its failure all the same', async () => {
        let body: () => BodyInit = () => 'upstream connect error';
        const { p } = make({}, undefined, (f) => (async (url: string, init?: RequestInit) => (new URL(url).pathname.endsWith('/logs')
            ? new Response(body(), { status: 503, headers: { 'content-type': 'text/plain' } }) : f(url, init))) as typeof fetch);
        const s = await p.createServer({ name: 'logs', offer: 'NVIDIA RTX A5000', image: 'img' });
        const read = `runpod: GET /v2/pods/${s.id}/logs?source=container&tail=1000 -> 503`;
        const e = await p.getServerLogs(s.id).catch((x) => x);
        expect([e.constructor.name, e.message, e.status, e.retriable]).toEqual(['ProviderError', `${read} upstream connect error`, 503, true]);
        body = () => new ReadableStream({ start: (c) => c.error(new TypeError('terminated')) });
        const cut = await p.getServerLogs(s.id).catch((x) => x);
        expect([cut.constructor.name, cut.message, cut.status, cut.retriable]).toEqual(['ProviderError', `${read} `, 503, true]);
    });

    it('a refusal is read by its status first: a rate limit or server error stays one (retriable when a read outlasts its retries), whatever its text says; a 403 means "this pool" only at a pod\'s create', async () => {
        let refuse: (method: string, path: string) => Response | undefined = () => undefined;
        const { p } = make({}, undefined, (f) => (async (url: string, init?: RequestInit) => refuse(init?.method ?? 'GET', new URL(url).pathname) ?? f(url, init)) as typeof fetch);
        const s = await p.createServer({ name: 'x', offer: 'NVIDIA RTX A5000', image: 'img' });
        const failure = async (what: Promise<unknown>) => {
            const e = await what.then(() => undefined, (x: ProviderError) => x);
            return [e?.constructor.name, e?.status, e?.retriable];
        };
        for (const status of [429, 500]) {
            refuse = (m, path) => (path === '/v2/network-volumes' ? answer(status, { title: 'Error', status, detail: 'try again later' }) : undefined);
            expect([status, ...await failure(p.listVolumes())]).toEqual([status, 'ProviderError', status, true]);
        }
        // Words that read like "not found" or "no capacity", in a server error (one sent once: a create, an action), say nothing of either.
        refuse = (m, path) => (m === 'POST' && path === '/v2/pods' ? answer(500, { title: 'Error', status: 500, detail: 'dial tcp: lookup scheduler: no such host' }) : undefined);
        expect(await failure(p.createServer({ name: 'y', offer: 'NVIDIA RTX A5000', image: 'img' }))).toEqual(['ProviderError', 500, false]);
        refuse = (m, path) => (m === 'POST' && path.endsWith('/action') ? answer(500, { title: 'Error', status: 500, detail: 'not enough free GPUs on the host machine' }) : undefined);
        expect(await failure(p.restartServer(s.id))).toEqual(['ProviderError', 500, false]);
        // A read-only key, refused a volume.
        refuse = (m, path) => (m === 'POST' && path === '/v2/network-volumes' ? answer(403, { title: 'Forbidden', status: 403, detail: 'read-only API key' }) : undefined);
        expect(await failure(p.createVolume({ name: 'v', region: 'US-TX-3', sizeGb: 10 }))).toEqual(['AuthError', 403, false]);
    });

    it('an answer that leaves out its rows, or its pages, reads as none: nothing made up, no crash', async () => {
        // What each read's answer is left without.
        let strip: (path: string, body: any) => void = () => undefined;
        const { p } = make({}, undefined, (f) => (async (url: string, init?: RequestInit) => {
            const r = await f(url, init);
            if ((init?.method ?? 'GET') !== 'GET' || r.status !== 200) return r;
            const body = await r.json();
            strip(new URL(url).pathname + new URL(url).search, body);
            return answer(200, body);
        }) as typeof fetch);
        strip = (path, body) => ['pods', 'endpoints', 'networkVolumes', 'pagination'].forEach((k) => delete body[k]);
        expect(await p.listServers()).toEqual([]);
        expect(await p.listEndpoints()).toEqual([]);
        expect(await p.listVolumes()).toEqual([]);
        // The CPU catalog without its flavors; then a vCPU count's stock without them.
        for (const perCount of [false, true]) {
            strip = (path, body) => {
                if (path.startsWith('/v2/catalog/cpus') && path.includes('vcpuCount=') === perCount) delete body.cpus;
            };
            expect([perCount, await p.listOffers({ kind: 'cpu' }), await p.listEndpointOffers({ kind: 'cpu' })]).toEqual([perCount, [], []]);
        }
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

    it('a log read RunPod refuses reads like any other refusal: a 422 with its reasons, a pod that is gone as not found', async () => {
        // RunPod is asked for a longer backfill than it gives, as if its limit were lower than the one this client keeps to.
        const { p } = make({}, undefined, (f) => ((url, init) => f(String(url).replace(/tail=\d+/, 'tail=6000'), init)) as typeof fetch);
        const s = await p.createServer({ name: 'logs', offer: 'NVIDIA RTX A5000', image: 'img' });
        const e = await p.getServerLogs(s.id, { windowMs: 200 }).catch((x) => x);
        expect(e).toBeInstanceOf(ProviderError);
        expect(e).toMatchObject({ status: 422, retriable: false });
        expect(e.message).toMatch(/^runpod: GET \/v2\/pods\/[^/]+\/logs\?source=container&tail=\d+ -> 422 .*\(tail: must be between 0 and 5000\)$/);
        const gone = await p.getServerLogs('pod_gone', { windowMs: 200 }).catch((x) => x);
        expect(gone).toBeInstanceOf(NotFoundError);
        expect(gone.message).toMatch(/^runpod: GET \/v2\/pods\/pod_gone\/logs\?/);
    });

    it('a 422 says why (errors[]), and is not taken for no capacity', async () => {
        const { p } = make();
        const e = await p.createServer({ name: 'x', offer: 'NVIDIA RTX A5000', image: 'img', providerOptions: { bogus: 1 } }).catch((x) => x);
        expect(e).toBeInstanceOf(ProviderError);
        expect(e).not.toBeInstanceOf(CapacityError);
        expect(e.message).toMatch(/additional properties 'bogus' not allowed/);
        // Every reason, in RunPod's order.
        const two = await p.createServer({ name: 'x', offer: 'NVIDIA RTX A5000', image: 'img', providerOptions: { bogus: 1, other: 2 } }).catch((x) => x);
        expect(two.message).toBe("runpod: POST /v2/pods -> 422 Request validation failed. ($: additional properties 'bogus' not allowed; $: additional properties 'other' not allowed)");
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

describe('RunPod stop, start and restart return when it is done', () => {
    /**
     * A provider on the fake whose answers about `id` can lag: the next `lag`
     * answers about it (an action's, a read's) say `status` instead of what
     * the fake has; `slept`: its waits, each also given to `onSleep`.
     */
    const lagging = (onSleep: (ms: number) => void = () => undefined) => {
        const fake = fakeRunPod();
        const slept: number[] = [];
        const late = { lag: 0, status: 'RUNNING' };
        const fetchImpl = (async (url: string, init?: RequestInit) => {
            const r = await fake.fetchImpl(url, init);
            if (late.lag <= 0 || r.status !== 200 || !/^\/v2\/pods\/[^/]+(\/action)?$/.test(new URL(url).pathname)) return r;
            late.lag--;
            return answer(200, { ...(await r.json()), status: late.status });
        }) as typeof fetch;
        return { fake, slept, late, p: new RunPod({ apiKey: 'rp-test', fetchImpl, sleep: async (ms) => { slept.push(ms); onSleep(ms); } }) };
    };
    const up = async (p: RunPod) => (await p.waitUntilRunning((await p.createServer({ name: 'x', offer: 'NVIDIA RTX A5000', image: 'img' })).id, fast)).id;
    const since = (fake: ReturnType<typeof fakeRunPod>, from: number) => fake.calls.slice(from).map((c) => `${c.method} ${c.path}`);

    it('a stop RunPod answers with the pod stopped is done: nothing more is read', async () => {
        const { p, fake, slept } = lagging();
        const id = await up(p);
        const [from, pauses] = [fake.calls.length, slept.length];
        await p.stopServer(id);
        expect(since(fake, from)).toEqual([`POST /v2/pods/${id}/action`]);
        expect(slept).toHaveLength(pauses);
        expect(fake.state.pods.get(id).status).toBe('EXITED');
    });

    it('a stop RunPod answers with the pod still running is waited for, every 5 s unless told, until it reads as stopped', async () => {
        for (const [o, interval] of [[undefined, 5000], [{ intervalMs: 7, timeoutMs: 60_000 }, 7]] as const) {
            const { p, fake, slept, late } = lagging();
            const id = await up(p);
            const [from, pauses] = [fake.calls.length, slept.length];
            // The action's answer and the two reads after it still say RUNNING.
            late.lag = 3;
            await p.stopServer(id, o);
            expect(since(fake, from)).toEqual([`POST /v2/pods/${id}/action`, `GET /v2/pods/${id}`, `GET /v2/pods/${id}`, `GET /v2/pods/${id}`]);
            expect(slept.slice(pauses)).toEqual([interval, interval]);
        }
    });

    it('a pod that does not stop is reported as what it still is, after 10 minutes or the time given; one deleted meanwhile is gone', async () => {
        // A clock the waits advance: the minutes pass at once.
        const clock = waitingClock();
        try {
            for (const [o, seconds, pauses] of [[undefined, 600, 120], [{ timeoutMs: 30_000 }, 30, 6], [{ timeoutMs: 30_000, intervalMs: 10_000 }, 30, 3]] as const) {
                const { p, late, slept } = lagging((ms) => void clock.sleep(ms));
                const id = await up(p);
                late.lag = Infinity;
                slept.length = 0;
                await expect(p.stopServer(id, o)).rejects.toMatchObject({ name: 'ProviderError', code: 'timeout', message: `runpod: timed out after ${seconds} s waiting for server ${id}: running (RUNNING)` });
                expect(slept).toHaveLength(pauses);
            }
        } finally {
            clock.restore();
        }
        const { p, fake, late } = lagging();
        const id = await up(p);
        late.lag = 1;
        const from = fake.calls.length;
        const stop = p.stopServer(id, fast);
        fake.state.pods.delete(id);
        await expect(stop).rejects.toMatchObject({ name: 'NotFoundError', message: `runpod: server ${id} disappeared while it was stopping` });
        expect(since(fake, from)).toEqual([`POST /v2/pods/${id}/action`, `GET /v2/pods/${id}`]);
    });

    it('a start returns once the pod runs: it is read until then, and not at all when RunPod answers that it runs', async () => {
        const { p, fake } = lagging();
        const id = await up(p);
        await p.stopServer(id);
        let from = fake.calls.length;
        await p.startServer(id, fast);
        // The pod before the start, the start (answered STARTING), then reads until it runs.
        expect(since(fake, from)).toEqual([`GET /v2/pods/${id}`, `POST /v2/pods/${id}/action`, `GET /v2/pods/${id}`, `GET /v2/pods/${id}`]);
        expect(fake.state.pods.get(id).status).toBe('RUNNING');
        // Running already: RunPod's 409, the pod read to see it is where a start would put it, and nothing to wait for.
        from = fake.calls.length;
        await p.startServer(id);
        expect(since(fake, from)).toEqual([`GET /v2/pods/${id}`, `POST /v2/pods/${id}/action`, `GET /v2/pods/${id}`]);
    });

    it('a start whose pod errors instead of running throws what it became', async () => {
        const { p, late } = lagging();
        const id = await up(p);
        await p.stopServer(id);
        // The start is accepted, and the pod reads as ERROR from then on.
        Object.assign(late, { lag: Infinity, status: 'ERROR' });
        await expect(p.startServer(id, fast)).rejects.toMatchObject({ name: 'ProviderError', message: `runpod: server ${id} is error (ERROR)` });
    });

    it('a restart is read until the pod runs again: RunPod\'s answer to it, the pod as it was, says nothing, and a pod never read otherwise is back on its fourth read', async () => {
        const { p, fake, slept } = lagging();
        const id = await up(p);
        const [from, pauses] = [fake.calls.length, slept.length];
        await p.restartServer(id);
        expect(since(fake, from)).toEqual([`POST /v2/pods/${id}/action`, ...Array(4).fill(`GET /v2/pods/${id}`)]);
        expect(slept.slice(pauses)).toEqual([10_000, 10_000, 10_000]);
    });

    it('a pod RunPod stops on its way to restarting is waited through, and is back the first time it runs; one that errors did not restart, said at once', async () => {
        const { p, fake, late } = lagging();
        const id = await up(p);
        const from = fake.calls.length;
        // The answer to the restart and the two reads after it say EXITED; then it runs.
        Object.assign(late, { lag: 3, status: 'EXITED' });
        await p.restartServer(id, fast);
        expect(since(fake, from)).toEqual([`POST /v2/pods/${id}/action`, `GET /v2/pods/${id}`, `GET /v2/pods/${id}`, `GET /v2/pods/${id}`]);
        Object.assign(late, { lag: Infinity, status: 'ERROR' });
        const read = fake.calls.length;
        await expect(p.restartServer(id, fast)).rejects.toMatchObject({ name: 'ProviderError', message: `runpod: server ${id} is error (ERROR): it did not restart` });
        expect(since(fake, read)).toEqual([`POST /v2/pods/${id}/action`, `GET /v2/pods/${id}`]);
        // One that stays stopped is the timeout, which says so.
        Object.assign(late, { lag: Infinity, status: 'EXITED' });
        await expect(p.restartServer(id, { intervalMs: 0, timeoutMs: 0 })).rejects.toMatchObject({ code: 'timeout', message: `runpod: timed out after 0 s waiting for server ${id}: stopped (EXITED)` });
    });

    it('a restart of a pod that is stopped is refused by RunPod, at once: nothing is waited for', async () => {
        const { p, fake } = lagging();
        const id = await up(p);
        await p.stopServer(id);
        const from = fake.calls.length;
        await expect(p.restartServer(id)).rejects.toMatchObject({ name: 'ProviderError', status: 409, message: `runpod: POST /v2/pods/${id}/action -> 409 cannot restart a pod that is EXITED` });
        expect(since(fake, from)).toEqual([`POST /v2/pods/${id}/action`]);
        expect(fake.state.pods.get(id).status).toBe('EXITED');
    });

    it('a start of a pod deleted meanwhile is not found, as a stop\'s and a restart\'s is', async () => {
        const { p, fake } = lagging();
        const id = await up(p);
        await p.stopServer(id);
        // The start is answered (the pod starting), and the pod is gone when it is next read.
        const read = p.getServer.bind(p);
        jest.spyOn(p, 'getServer').mockImplementationOnce(async (x) => {
            fake.state.pods.delete(id);
            return read(x);
        });
        await expect(p.startServer(id, fast)).rejects.toMatchObject({ name: 'NotFoundError', message: `runpod: server ${id} disappeared before it was running` });
    });
});

describe('RunPod rents an offer in its first data center that can place the pod', () => {
    const make = () => {
        const fake = fakeRunPod();
        // The 4090 in two data centers of the secure cloud: Romania's hosts run CUDA 12.4, Texas's 12.8.
        fake.state.gpus.find((g) => g.id === 'NVIDIA GeForce RTX 4090')!.dataCenters[1].SECURE = ['HIGH', 2];
        return { fake, p: new RunPod({ apiKey: 'rp-test', fetchImpl: fake.fetchImpl, sleep: noSleep }) };
    };
    const pods = (fake: ReturnType<typeof fakeRunPod>) => fake.calls.filter((c) => c.method === 'POST' && c.path === '/v2/pods').map((c) => c.body);
    const the4090 = async (p: RunPod) => (await p.listOffers({ kind: 'gpu' })).find((o) => o.id === 'NVIDIA GeForce RTX 4090')!;

    it('its first data center with stock, as on every provider: asked alone, and nothing else when it has room', async () => {
        const { p, fake } = make();
        const offer = await the4090(p);
        expect(offer.regions).toEqual(['EU-RO-1', 'US-TX-3']);
        const plain = await p.createServer({ name: 'plain', offer, image: 'img' });
        expect(pods(fake).map((b) => b.dataCenterIds)).toEqual([['EU-RO-1']]);
        expect(fake.state.pods.get(plain.id)).toMatchObject({ dataCenterId: 'EU-RO-1' });
        expect(plain.region).toBe(offer.regions[0]);
    });

    it('its next, where the first cannot place it: an image that needs CUDA 12.8 is rented where the hosts run it, not refused for want of it in the first', async () => {
        const { p, fake } = make();
        const offer = await the4090(p);
        const rented = fake.state.pods.size;
        const cuda = await p.createServer({ name: 'cuda', offer, image: { os: MACHINE_TYPES.UBUNTU_24, cuda: CUDA_TYPES.CUDA_12_8 } });
        // Asked of Romania first (refused: nothing rented), then of Texas.
        expect(pods(fake).map((b) => [b.dataCenterIds, b.gpu])).toEqual([
            [['EU-RO-1'], { id: 'NVIDIA GeForce RTX 4090', count: 1, minCudaVersion: '12.8' }], [['US-TX-3'], { id: 'NVIDIA GeForce RTX 4090', count: 1, minCudaVersion: '12.8' }],
        ]);
        expect(fake.state.pods.get(cuda.id)).toMatchObject({ dataCenterId: 'US-TX-3', cudaVersion: '12.8' });
        expect(fake.state.pods.size).toBe(rented + 1);
        const floor = await p.createServer({ name: 'floor', offer, image: 'img', minCudaVersion: '12.8' });
        expect(fake.state.pods.get(floor.id)).toMatchObject({ dataCenterId: 'US-TX-3' });
    });

    it('where none of them can, the last one\'s refusal is the create\'s; a refusal that is not for want of room ends it at the first', async () => {
        const { p, fake } = make();
        const offer = await the4090(p);
        const none = await p.createServer({ name: 'none', offer, image: 'img', minCudaVersion: '13.0' }).catch((e) => e);
        expect(none).toBeInstanceOf(CapacityError);
        expect(pods(fake).map((b) => b.dataCenterIds)).toEqual([['EU-RO-1'], ['US-TX-3']]);
        // A request RunPod refuses as it is (422) is not asked again elsewhere.
        const before = pods(fake).length;
        const bad = await p.createServer({ name: 'bad', offer, image: 'img', providerOptions: { nope: true } }).catch((e) => e);
        expect([bad.name, bad.status]).toEqual(['ProviderError', 422]);
        expect(pods(fake)).toHaveLength(before + 1);
    });

    it('a region asked for pins it there, with the offer or with its id alone; an id alone and no region names no data center; the caller\'s own dataCenterIds stand', async () => {
        const { p, fake } = make();
        const offer = await the4090(p);
        await p.createServer({ name: 'tx', offer, region: 'US-TX-3', image: 'img' });
        expect(pods(fake).pop().dataCenterIds).toEqual(['US-TX-3']);
        await p.createServer({ name: 'ro', offer: offer.id, region: 'EU-RO-1', image: 'img' });
        expect(pods(fake).pop().dataCenterIds).toEqual(['EU-RO-1']);
        // Pinned where the hosts are too old for it, there is no capacity for it: the caller's choice stands, and is asked once.
        const asked = pods(fake).length;
        await expect(p.createServer({ name: 'old', offer, region: 'EU-RO-1', image: 'img', minCudaVersion: '12.8' })).rejects.toBeInstanceOf(CapacityError);
        expect(pods(fake)).toHaveLength(asked + 1);
        await p.createServer({ name: 'any', offer: offer.id, image: 'img' });
        expect(pods(fake).pop().dataCenterIds).toBeUndefined();
        await p.createServer({ name: 'own', offer, image: 'img', providerOptions: { dataCenterIds: ['US-TX-3', 'EU-RO-1'] } });
        expect(pods(fake).pop().dataCenterIds).toEqual(['US-TX-3', 'EU-RO-1']);
        expect(pods(fake)).toHaveLength(asked + 3);
        // Refused there, they are asked once: the same request is not sent again for each data center of the offer.
        await expect(p.createServer({ name: 'own-old', offer, image: 'img', minCudaVersion: '12.8', providerOptions: { dataCenterIds: ['EU-RO-1'] } })).rejects.toBeInstanceOf(CapacityError);
        expect(pods(fake).slice(asked + 3).map((b) => b.dataCenterIds)).toEqual([['EU-RO-1']]);
    });

    it('a pod that mounts a network volume goes where the volume is, whatever the offer brings', async () => {
        const { p, fake } = make();
        const offer = await the4090(p);
        const volume = await p.createVolume({ name: 'models', region: 'US-TX-3', sizeGb: 10 });
        await p.createServer({ name: 'v', offer, image: 'img', mounts: [{ volume }] });
        expect(pods(fake).map((b) => b.dataCenterIds)).toEqual([['US-TX-3']]);
    });
});

describe('RunPod reads ports as every provider does', () => {
    const make = () => {
        const fake = fakeRunPod();
        return { fake, p: new RunPod({ apiKey: 'rp-test', fetchImpl: fake.fetchImpl, sleep: noSleep }) };
    };
    const pods = (fake: ReturnType<typeof fakeRunPod>) => fake.calls.filter((c) => c.method === 'POST' && c.path === '/v2/pods').map((c) => c.body);

    it('each goes to RunPod as <port>/<protocol>: a bare port is tcp, either case is read, and what is no port is refused before anything is sent', async () => {
        const { p, fake } = make();
        await p.createServer({ name: 'a', offer: 'NVIDIA RTX A5000', image: 'img', ports: ['8888/HTTP', '8000', ' 22/tcp '] });
        expect(pods(fake).pop().ports).toEqual(['8888/http', '8000/tcp', '22/tcp']);
        for (const [ports, error] of [
            [['80:8080'], { name: 'ProviderError', message: 'runpod: bad port "80:8080": use <port>/<tcp|udp|http>, the port from 1 to 65535' }],
            [['70000/tcp'], { name: 'ProviderError', message: 'runpod: bad port "70000/tcp": use <port>/<tcp|udp|http>, the port from 1 to 65535' }],
            [['53/UDP'], { name: 'NotSupportedError', message: 'runpod: createServer option "ports" with udp is not supported' }],
        ] as const) {
            await expect(p.createServer({ name: 'x', offer: 'NVIDIA RTX A5000', image: 'img', ports: [...ports] })).rejects.toMatchObject(error);
        }
        expect(pods(fake)).toHaveLength(1);
    });

    it('a key\'s port 22 is added once, however the caller wrote theirs', async () => {
        const { p, fake } = make();
        const key = await p.addSSHKey(testPublicKey('ports'), 'ports');
        await p.createServer({ name: 'a', offer: 'NVIDIA RTX A5000', image: 'img', command: ['serve'], ports: ['22'], sshKeyIds: [key.id] });
        expect(pods(fake).pop().ports).toEqual(['22/tcp']);
        await p.createServer({ name: 'b', offer: 'NVIDIA RTX A5000', image: 'img', command: ['serve'], ports: ['8000/tcp'], sshKeyIds: [key.id] });
        expect(pods(fake).pop().ports).toEqual(['8000/tcp', '22/tcp']);
    });
});

describe('images by the library\'s names on RunPod: Docker Hub\'s ubuntu and nvidia/cuda', () => {
    const make = () => {
        const fake = fakeRunPod();
        return { fake, p: new RunPod({ apiKey: 'rp-test', fetchImpl: fake.fetchImpl, sleep: noSleep }) };
    };
    const pods = (fake: ReturnType<typeof fakeRunPod>) => fake.calls.filter((c) => c.method === 'POST' && c.path === '/v2/pods').map((c) => c.body);

    it('a MACHINE_TYPES member is that Ubuntu, placed by no CUDA version; top-level or in `container`', async () => {
        const { p, fake } = make();
        await p.createServer({ name: 'a', offer: 'NVIDIA RTX A5000', image: MACHINE_TYPES.UBUNTU_24 });
        await p.createServer({ name: 'b', offer: 'NVIDIA RTX A5000', container: { image: { os: MACHINE_TYPES.UBUNTU_22 }, command: ['sleep', 'infinity'] } });
        await p.createServer({ name: 'c', offer: 'NVIDIA RTX A5000', container: { image: MACHINE_TYPES.UBUNTU_20, command: ['nvidia-smi', '-L'] } });
        // Given no command it is kept up, as the VM this names elsewhere stays up: a bare Ubuntu's own command exits at once.
        expect(pods(fake).map((b) => [b.image, b.gpu, b.cmd])).toEqual([
            ['ubuntu:24.04', { id: 'NVIDIA RTX A5000', count: 1 }, ['sleep', 'infinity']],
            ['ubuntu:22.04', { id: 'NVIDIA RTX A5000', count: 1 }, ['sleep', 'infinity']],
            ['ubuntu:20.04', { id: 'NVIDIA RTX A5000', count: 1 }, ['nvidia-smi', '-L']],
        ]);
        // An image of the caller's own runs its own command.
        await p.createServer({ name: 'd', offer: 'NVIDIA RTX A5000', image: 'ubuntu:24.04' });
        expect(pods(fake).pop().cmd).toBeUndefined();
    });

    it('`{ os, cuda }` is NVIDIA\'s image of that CUDA, on a host whose driver runs it: placed by that version unless minCudaVersion names another', async () => {
        const { p, fake } = make();
        const image = { os: MACHINE_TYPES.UBUNTU_24, cuda: CUDA_TYPES.CUDA_12_8 };
        const s = await p.createServer({ name: 'cuda', offer: 'NVIDIA RTX A5000', image });
        expect(pods(fake).pop()).toMatchObject({ image: 'nvidia/cuda:12.8.2-base-ubuntu24.04', gpu: { id: 'NVIDIA RTX A5000', count: 1, minCudaVersion: '12.8' } });
        expect(fake.state.pods.get(s.id)).toMatchObject({ cudaVersion: '12.8' });
        // The 4090's hosts run 12.4: no pod there for an image that needs 12.8.
        await expect(p.createServer({ name: 'old', offer: 'NVIDIA GeForce RTX 4090', container: { image } })).rejects.toBeInstanceOf(CapacityError);
        await p.createServer({ name: 'floor', offer: 'NVIDIA RTX A5000', image: { os: 'ubuntu22', cuda: '12.1' }, minCudaVersion: '12.8' });
        expect(pods(fake).pop()).toMatchObject({ image: 'nvidia/cuda:12.1.1-base-ubuntu22.04', gpu: { minCudaVersion: '12.8' } });
    });

    it('a CPU pod runs it with no GPU to place by', async () => {
        const { p, fake } = make();
        await p.createServer({ name: 'cpu', offer: 'cpu3c:2', image: { os: 'ubuntu24', cuda: '12.8' } });
        expect(pods(fake).pop()).toMatchObject({ image: 'nvidia/cuda:12.8.2-base-ubuntu24.04', cpu: { id: 'cpu3c', vcpuCount: 2 } });
        expect(pods(fake).pop().gpu).toBeUndefined();
    });

    it('a CUDA version NVIDIA has no image of for that Ubuntu is refused before anything is sent', async () => {
        const { p, fake } = make();
        await expect(p.createServer({ name: 'x', offer: 'NVIDIA RTX A5000', image: { os: 'ubuntu24', cuda: '12.4' } })).rejects.toMatchObject({
            name: 'NotSupportedError', message: 'runpod: image "ubuntu24" with cuda "12.4" (NVIDIA publishes no CUDA 12.4 image of Ubuntu 24.04: it has 20.04, 22.04) is not supported',
        });
        await expect(p.createServer({ name: 'x', offer: 'NVIDIA RTX A5000', image: { os: 'ubuntu24', cuda: '12.7' } as never })).rejects.toMatchObject({
            name: 'ProviderError', message: expect.stringMatching(/^runpod: bad image cuda "12\.7": use a CUDA_TYPES member/),
        });
        expect(pods(fake)).toEqual([]);
    });

    it('an endpoint\'s GPU workers go where the driver runs the image\'s CUDA, or the floor it is given; a CPU worker has none to place by', async () => {
        const { p, fake } = make();
        const posts = () => fake.calls.filter((c) => c.method === 'POST' && c.path === '/v2/serverless').map((c) => c.body);
        const image = { os: MACHINE_TYPES.UBUNTU_24, cuda: CUDA_TYPES.CUDA_12_8 };
        const byImage = await p.createEndpoint({ name: 'cuda', offer: 'NVIDIA GeForce RTX 4090', container: { image } });
        expect(posts().pop()).toMatchObject({ image: 'nvidia/cuda:12.8.2-base-ubuntu24.04', gpu: { pools: ['ADA_24'], count: 1, minCudaVersion: '12.8' } });
        expect(byImage.raw.gpu).toMatchObject({ minCudaVersion: '12.8' });
        await p.createEndpoint({ name: 'floor', offer: 'NVIDIA GeForce RTX 4090', container: { image: 'acme/app:1' }, minCudaVersion: '13' });
        expect(posts().pop().gpu).toEqual({ pools: ['ADA_24'], count: 1, minCudaVersion: '13.0' });
        // The floor given stands over the image's own.
        await p.createEndpoint({ name: 'both', offer: 'NVIDIA GeForce RTX 4090', container: { image }, minCudaVersion: '12.9' });
        expect(posts().pop().gpu).toEqual({ pools: ['ADA_24'], count: 1, minCudaVersion: '12.9' });
        await p.createEndpoint({ name: 'none', offer: 'NVIDIA GeForce RTX 4090', container: { image: 'acme/app:1' } });
        expect(posts().pop().gpu).toEqual({ pools: ['ADA_24'], count: 1 });
        await p.createEndpoint({ name: 'cpu', offer: 'cpu3c:2', container: { image }, minCudaVersion: '12.8' });
        expect(posts().pop()).toMatchObject({ image: 'nvidia/cuda:12.8.2-base-ubuntu24.04', cpu: [{ id: 'cpu3c', vcpuCount: 2 }] });
        expect(posts().pop().gpu).toBeUndefined();
        // A floor that is no version is refused before the endpoint is made.
        const before = posts().length;
        await expect(p.createEndpoint({ name: 'bad', offer: 'NVIDIA GeForce RTX 4090', container: { image: 'acme/app:1' }, minCudaVersion: 'twelve' })).rejects.toThrow(/bad CUDA version "twelve"/);
        expect(posts()).toHaveLength(before);
    });

    it('an endpoint runs it too', async () => {
        const { p, fake } = make();
        const e = await p.createEndpoint({ name: 'u', container: { image: MACHINE_TYPES.UBUNTU_24 }, offer: 'cpu3c:2' });
        expect(fake.calls.filter((c) => c.method === 'POST' && c.path === '/v2/serverless').pop()?.body.image).toBe('ubuntu:24.04');
        expect(e.image).toBe('ubuntu:24.04');
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
        await expect(p.createServer({ ...o, mounts: [{ volume: vol }, { volume: other }] }))
            .rejects.toThrow(/^runpod: createServer option "mounts" with more than one volume \(a pod mounts one network volume\) is not supported$/);
        await expect(p.createServer({ ...o, mounts: [{ volume: vol }], volume: { sizeGb: 20, path: '/data' } })).rejects.toThrow(/"mounts" and "volume"/);
        await expect(p.createServer({ ...o, mounts: [{ volume: vol, path: 'models' }] })).rejects.toThrow(/not absolute/);
        await expect(p.createServer({ ...o, mounts: [{ volume: 'vol_missing' }] })).rejects.toThrow(NotFoundError);
        await expect(p.createServer({ ...o, mounts: [{ volume: 'vol_missing' }] })).rejects.toThrow(/^runpod: no network volume vol_missing$/);
        await expect(p.createServer({ ...o, region: 'EU-RO-1', mounts: [{ volume: vol.id }] })).rejects.toThrow(/is in US-TX-3/);
        expect(podBodies(fake)).toEqual([]);
    });

    it('a volume is 10-4096 GB (rounded up to whole GB), in a data center RunPod knows; providerOptions pick its tier', async () => {
        const { fake, p } = make();
        await expect(p.createVolume({ name: 'v', region: 'US-TX-3', sizeGb: 9 })).rejects.toThrow(/10-4096 GB, not 9/);
        await expect(p.createVolume({ name: 'v', region: 'US-TX-3', sizeGb: 4097 })).rejects.toThrow(/10-4096 GB/);
        // The bounds themselves are sizes RunPod takes.
        expect((await p.createVolume({ name: 'v', region: 'US-TX-3', sizeGb: 4096 })).sizeGb).toBe(4096);
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

    it('a 409 to storing a login is that race too; a server error is thrown, and the login it stored serves the next create', async () => {
        const fake = fakeRunPod();
        // Each POST /v2/registries stores the login, then is answered `status` (409: another create stored it just before; 500: it took, and the answer failed).
        let status: number | undefined = 409;
        const fetchImpl = (async (url: string, init?: RequestInit) => {
            if (!status || init?.method !== 'POST' || !String(url).endsWith('/v2/registries')) return fake.fetchImpl(url, init);
            const body = JSON.parse(String(init.body));
            fake.state.registries.set(`reg_${status}`, { id: `reg_${status}`, name: body.name, username: body.username, password: body.password });
            return answer(status, { title: 'Error', status, detail: status === 409 ? 'a registry with this name already exists' : 'internal error' });
        }) as typeof fetch;
        const p = new RunPod({ apiKey: 'rp-test', fetchImpl, sleep: noSleep });
        const [offer] = await p.listOffers();
        const create = (name: string, username: string) => p.createServer({ name, offer, image: 'ghcr.io/acme/worker:1', registryAuth: { username, password: 'p' } });
        expect((await create('a', 'u')).raw.registry).toBe('reg_409');
        status = 500;
        const e = await create('b', 'v').catch((x) => x);
        expect([e.constructor.name, e.status]).toEqual(['ProviderError', 500]);
        status = undefined;
        expect((await create('c', 'v')).raw.registry).toBe('reg_500');
        expect([...fake.state.registries.keys()].sort()).toEqual(['reg_409', 'reg_500']);
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

    it('each kind reads only its own catalog, and a CPU flavor is offered only at the vCPU counts it is rented in', async () => {
        const { fake, p } = make();
        const read = async (kind: 'cpu' | 'gpu') => {
            const before = fake.calls.length;
            const ids = (await p.listEndpointOffers({ kind, includeUnavailable: true })).map((o) => o.id).sort();
            return { ids, catalogs: [...new Set(fake.calls.slice(before).map((c) => c.path.split('?')[0]))] };
        };
        expect(await read('cpu')).toEqual({ ids: ['cpu3c:16', 'cpu3c:2', 'cpu3c:32', 'cpu3c:4', 'cpu3c:8', 'cpu5g:4', 'cpu5g:8'], catalogs: ['/v2/catalog/cpus'] });
        expect((await read('gpu')).catalogs).toEqual(['/v2/catalog/gpus']);
    });

    it('workers equally cheap are listed fewest vCPUs first, whatever order RunPod lists its flavors in', async () => {
        // Two flavors, the bigger first: cpuA at 8 vCPUs costs what cpuB does at 4.
        const flavors = [
            { id: 'cpuA', name: 'A', group: 'Gen 5', vcpu: { min: 8, max: 8 }, ramGbPerVcpu: 2, price: { securePerVcpu: 0.02, serverlessPerVcpu: 0.01 } },
            { id: 'cpuB', name: 'B', group: 'Gen 5', vcpu: { min: 2, max: 4 }, ramGbPerVcpu: 2, price: { securePerVcpu: 0.04, serverlessPerVcpu: 0.02 } },
        ];
        const catalog = (async () => answer(200, { cpus: flavors.map((c) => ({ ...c, availability: 'HIGH', dataCenters: [{ id: 'US-TX-3', availability: 'HIGH' }] })) })) as typeof fetch;
        const p = new RunPod({ apiKey: 'rp-test', fetchImpl: catalog, sleep: noSleep });
        expect((await p.listEndpointOffers({ kind: 'cpu' })).map((o) => [o.id, o.pricePerHour])).toEqual([['cpuB:2', 0.04], ['cpuB:4', 0.08], ['cpuA:8', 0.08]]);
    });

    it('with no offer named and nothing in stock, an endpoint is no capacity, and nothing is sent', async () => {
        const fake = fakeRunPod();
        // Every data center of both catalogs out of stock.
        const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
            const r = await fake.fetchImpl(url, init);
            if (!new URL(String(url)).pathname.startsWith('/v2/catalog/')) return r;
            const body = await r.json();
            for (const t of [...(body.gpus ?? []), ...(body.cpus ?? [])]) for (const d of t.dataCenters ?? []) d.availability = 'NONE';
            return answer(200, body);
        }) as typeof fetch;
        const p = new RunPod({ apiKey: 'rp-test', fetchImpl, sleep: noSleep });
        const e = await p.createEndpoint({ name: 'none', container: WHOAMI }).catch((x) => x);
        expect([e.constructor.name, e.message]).toEqual(['CapacityError', 'runpod: no serverless worker of any kind is in stock right now']);
        expect(posts(fake)).toEqual([]);
    });

    it('takes the bounds as they are (ports 1 and 65535, PORT and PORT_HEALTH equal to the port, as many workers at least as at most, idle timeouts of 1 and 3600 s); a region is where the workers run', async () => {
        const { fake, p } = make();
        const e = await p.createEndpoint({ name: 'top', container: { ...WHOAMI, env: { PORT: '65535', PORT_HEALTH: '65535' } }, offer: 'cpu3c:2', port: 65535,
            minWorkers: 2, maxWorkers: 2, idleTimeoutSeconds: 3600, region: 'US-TX-3' });
        expect(posts(fake).pop()).toMatchObject({ env: { PORT: '65535', PORT_HEALTH: '65535' }, ports: ['65535/http'], workers: { min: 2, max: 2, idleTimeout: 3600 }, dataCenterIds: ['US-TX-3'] });
        expect(e).toMatchObject({ port: 65535, minWorkers: 2, maxWorkers: 2, idleTimeoutSeconds: 3600, region: 'US-TX-3' });
        await p.createEndpoint({ name: 'low', container: WHOAMI, offer: 'cpu3c:2', port: 1, idleTimeoutSeconds: 1 });
        expect(posts(fake).pop()).toMatchObject({ ports: ['1/http'], workers: { min: 0, max: 1, idleTimeout: 1 } });
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
        // One login stored, the one both endpoints name.
        expect([...fake.state.registries.keys()]).toEqual([a.registry]);
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
            [{ name: 'x', container: WHOAMI, offer: 'cpu3c:2', port: 0 }, /^runpod: bad port 0$/],
            [{ name: 'x', container: WHOAMI, offer: 'cpu3c:2', port: 80.5 }, /^runpod: bad port 80\.5$/],
            [{ name: 'x', container: WHOAMI, offer: 'cpu3c:2', port: 65536 }, /^runpod: bad port 65536$/],
            [{ name: 'x', container: { ...WHOAMI, env: { PORT_HEALTH: '9000' } }, offer: 'cpu3c:2' }, /^runpod: env\.PORT_HEALTH is the endpoint's port: pass port \(9000\), not env\.PORT_HEALTH$/],
            [{ name: 'x', container: WHOAMI, offer: 'cpu3c:2', minWorkers: -1 }, /^runpod: workers: 0 <= minWorkers <= maxWorkers, maxWorkers >= 1 \(not -1 and 1\)$/],
            [{ name: 'x', container: WHOAMI, offer: 'cpu3c:2', minWorkers: 0.5 }, /^runpod: workers: 0 <= minWorkers <= maxWorkers, maxWorkers >= 1 \(not 0\.5 and 1\)$/],
            [{ name: 'x', container: WHOAMI, offer: 'cpu3c:2', idleTimeoutSeconds: 3601 }, /^runpod: idleTimeoutSeconds is 1-3600, not 3601$/],
            [{ name: 'x', container: WHOAMI, offer: 'cpu3c:6' }, /^runpod: a serverless CPU worker has a power-of-two vCPU count from 2, not 6$/],
            [{ name: 'x', container: { ...WHOAMI, registryAuth: { username: 'u', password: 'p' } }, offer: 'cpu3c:2', providerOptions: { registry: 'reg_1' } },
                /^runpod: pass registryAuth or providerOptions\.registry, not both$/],
        ];
        for (const [o, why] of refused) await expect(p.createEndpoint(o)).rejects.toThrow(why);
        expect(fake.state.registries.size).toBe(0);
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
        // A path without its slash is given one.
        expect(await (await p.requestEndpoint(e.id, 'api?y=2', { intervalMs: 0 })).json()).toMatchObject({ path: '/api', query: '?y=2' });
        await p.requestEndpoint({ ...e, url: 'https://evil.example.com' }, '/api', { intervalMs: 0 });
        expect(fake.calls.some((c) => c.host === 'evil.example.com')).toBe(false);
        await expect(p.requestEndpoint('../x', '/api')).rejects.toThrow(/bad endpoint id/);
        // An id that would put another host in the URL is refused before anything is sent.
        await expect(p.requestEndpoint('evil.example.com?', '/api')).rejects.toThrow(/^runpod: bad endpoint id "evil\.example\.com\?"$/);
        expect(fake.calls.some((c) => c.host === 'evil.example.com')).toBe(false);
        await expect(p.requestEndpoint({ ...e, provider: 'scaleway' }, '/api')).rejects.toThrow(/scaleway's, not runpod's/);
    });

    it('only RunPod\'s cold answers are waited out (502-504, and a 400 that says no worker is available); any other answer is the workers\' own', async () => {
        const fake = fakeRunPod({ coldRequests: 0 });
        // What the workers' host answers next, before the fake's warm worker does.
        let script: Response[] = [];
        let sent = 0;
        const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
            if (!new URL(String(url)).host.endsWith('.api.runpod.ai')) return fake.fetchImpl(url, init);
            sent++;
            return script.shift() ?? fake.fetchImpl(url, init);
        }) as typeof fetch;
        const p = new RunPod({ apiKey: 'rp-test', fetchImpl, sleep: noSleep });
        const e = await p.createEndpoint({ name: 'w', container: WHOAMI, offer: 'cpu3c:2' });
        const request = async (answers: Response[]) => {
            [script, sent] = [answers, 0];
            const r = await p.requestEndpoint(e, '/api', { intervalMs: 0 });
            return [r.status, sent];
        };
        expect(await request([502, 503, 504].map((status) => new Response('', { status })))).toEqual([200, 4]);
        // The workers' own refusal, and an answer of theirs that happens to say the words.
        expect(await request([answer(400, { error: 'bad prompt' })])).toEqual([400, 1]);
        expect(await request([answer(200, { status: 'no workers available in the job pool' })])).toEqual([200, 1]);
    });

    it('a redirect from the workers is answered, never followed: nothing of the request goes where it points', async () => {
        const fake = fakeRunPod({ coldRequests: 0 });
        const elsewhere: string[] = [];
        let redirecting = '';
        const p = new RunPod({ apiKey: 'rp-test', sleep: noSleep, fetchImpl: followingRedirects((async (url: string | URL | Request, init?: RequestInit) => {
            const host = new URL(String(url)).host;
            if (host === redirecting) return new Response(null, { status: 307, headers: { location: 'https://evil.example.com/steal' } });
            if (host === 'evil.example.com') {
                elsewhere.push(`${init?.method ?? 'GET'} ${String(url)}`);
                return new Response('thanks', { status: 200 });
            }
            return fake.fetchImpl(url, init);
        }) as typeof fetch) });
        const e = await p.createEndpoint({ name: 'whoami', container: WHOAMI, offer: 'cpu3c:2' });
        redirecting = `${e.id}.api.runpod.ai`;
        const r = await p.requestEndpoint(e, '/api', { method: 'POST', body: '{"prompt":"secret"}', intervalMs: 0 });
        expect([r.status, r.headers.get('location')]).toEqual([307, 'https://evil.example.com/steal']);
        expect(elsewhere).toEqual([]);
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
