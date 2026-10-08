// VastAI against the fake of Vast.ai's API (src/testing/fakes/vast.ts): what is
// particular to it beyond the shared contract (../contract.spec.ts). From
// docs.vast.ai/api-reference, the create guide and the official CLI (checked
// 2026-09-29): at most 64 offers per search, usable (not nominal) VRAM,
// containers that crash or go silent never reach running, and each offer is one
// machine, whose driver's CUDA version is read before it is rented.

import { RegistryClient } from '../../Core/utils';
import { CapacityError, NotSupportedError, ProviderError } from '../../errors';
import { FAKE_SNAPSHOTS, fakeVast } from '../../testing/fakes/vast';
import { VastAI } from './VastAI';

const noSleep = async () => {};
const fast = { intervalMs: 0, timeoutMs: 5000 };
const last = <T>(a: T[]): T | undefined => a[a.length - 1];

describe('VastAI', () => {
    const make = () => {
        const fake = fakeVast();
        return { fake, p: new VastAI({ apiKey: 'vast-test', fetchImpl: fake.fetchImpl, sleep: noSleep }) };
    };

    it('offers each machine once, filters unreliable hosts, and marks bid offers interruptible', async () => {
        const { p } = make();
        const offers = await p.listOffers();
        expect(offers.map((o) => o.id)).toEqual(['104', '101', '102', '106']);
        // Where it is, and the machine it is (where a volume of it is).
        expect(offers[1]).toMatchObject({ gpu: 'RTX 4000 Ada', vramGb: 20, regions: ['Texas, US', 'machine:11'] });
        const withBids = await p.listOffers({ includeInterruptible: true });
        expect(withBids.filter((o) => o.interruptible).map((o) => o.pricePerHour)).toEqual([0.05, 0.12, 0.14, 0.3]);
    });

    it('renting is never retried: a lost answer must not rent a second machine', async () => {
        const { p, fake } = make();
        fake.state.failNextRentWith = 503;
        await expect(p.createServer({ name: 'x', offer: '101', image: 'img' })).rejects.toBeInstanceOf(ProviderError);
        expect(fake.calls.filter((c) => c.method === 'PUT' && c.path.startsWith('/api/v0/asks/'))).toHaveLength(1);
    });

    it('passes env as a JSON object with ports as "-p" keys (a flags string is not applied), and reports the random public ports', async () => {
        // docs.vast.ai create guide, Common Pitfalls: "the env field must be a JSON object (dict), not a Docker flag string";
        // the official CLI (vast.py) sends parse_env(...), a dict.
        const { p, fake } = make();
        const s = await p.createServer({ name: 'x', offer: '101', image: 'img', env: { A: '1', B: 'x=y' }, ports: ['8080/tcp', '9000/udp'], command: ['sleep', 'infinity'] });
        expect(fake.calls.find((c) => c.path === '/api/v0/asks/101/')?.body).toMatchObject({
            env: { A: '1', B: 'x=y', '-p 8080:8080': '1', '-p 9000:9000/udp': '1' }, runtype: 'args', args: ['sleep', 'infinity'], label: 'x', cancel_unavail: true });
        const read = await p.getServer(s.id);
        expect(read?.ports?.map((x) => [x.privatePort, x.protocol, typeof x.publicPort])).toEqual([[8080, 'tcp', 'number'], [9000, 'udp', 'number']]);
        expect(read?.ports?.every((x) => x.publicPort !== x.privatePort)).toBe(true);
        await expect(p.createServer({ name: 'y', offer: '102', image: 'img', env: { A: 'has space' } })).rejects.toThrow(/spaces or quotes/);
    });

    it('rents an interruptible offer with its bid, never at the on-demand price', async () => {
        const { p, fake } = make();
        const bid = (await p.listOffers({ includeInterruptible: true })).find((o) => o.interruptible && o.id.startsWith('101:'));
        expect(bid).toMatchObject({ id: '101:bid:0.12', pricePerHour: 0.12 });
        await p.createServer({ name: 'cheap', offer: bid!.id, image: 'img' });
        expect(fake.calls.find((c) => c.method === 'PUT' && c.path === '/api/v0/asks/101/')?.body).toMatchObject({ price: 0.12 });
    });

    it('follows keyset pages to list every instance', async () => {
        const { p, fake } = make();
        const s = await p.createServer({ name: 'x', offer: '101', image: 'img' });
        const all = await p.listServers();
        expect(all).toHaveLength(fake.liveServers());
        expect(all.length).toBeGreaterThan(25);
        expect(all.map((x) => x.id)).toContain(s.id);
    });

    it('fetches the uploaded log, as many last lines as asked, without sending the API key to the upload host', async () => {
        const { p, fake } = make();
        const s = await p.createServer({ name: 'logs', offer: '101', image: 'img', command: ['sh', '-c', 'nvidia-smi -L; echo "one"; echo "two"; echo "three"'] });
        // Only what the command printed.
        expect(await p.getServerLogs(s.id)).toBe('GPU 0: NVIDIA RTX 4000Ada (UUID: GPU-9a8b7c6d-0)\none\ntwo\nthree\n');
        expect(await p.getServerLogs(s.id, { tail: 2 })).toBe('two\nthree\n');
        const upload = fake.calls.filter((c) => c.host === 'logs.fake');
        expect(upload.length).toBeGreaterThan(1);
        expect(upload.every((c) => c.auth === undefined)).toBe(true);
    });
});

describe('Vast.ai API facts', () => {
    const make = () => {
        const fake = fakeVast();
        return { fake, p: new VastAI({ apiKey: 'vast-test', fetchImpl: fake.fetchImpl, sleep: noSleep }) };
    };

    const cheapCards = (fake: ReturnType<typeof fakeVast>, n = 600) => {
        for (let i = 0; i < n; i++) {
            fake.state.asks.push({ id: 2000 + i, gpu_name: 'RTX 3060', num_gpus: 1, gpu_ram: 12288, dph_total: 0.05 + i * 0.001, min_bid: 0.03,
                geolocation: 'Ohio, US', rentable: true, verified: true, reliability: 0.99, cuda_max_good: 12.8, machine_id: 3000 + i } as any);
        }
    };
    const searches = (fake: ReturnType<typeof fakeVast>) => fake.calls.filter((c) => c.method === 'POST' && c.path === '/api/v0/bundles/');

    it('what is not there, as Vast answers it: an instance (200, none), an offer (a 404 that says no_such_ask only in its message, or a 410), a key (400 no_ssh_key)', async () => {
        const { p, fake } = make();
        const answered = async (method: string, path: string, body?: unknown) => {
            const r = await fake.fetchImpl(`https://console.vast.ai${path}`, { method, headers: { authorization: 'Bearer vast-test' }, ...(body ? { body: JSON.stringify(body) } : {}) });
            return [r.status, await r.json()];
        };
        // An instance Vast does not have: its read answers 200 with none (seen live 2026-10-07), not a 404. No server, and deleting it is no error.
        expect(await answered('GET', '/api/v0/instances/424242/')).toEqual([200, { instances: null }]);
        expect(await p.getServer('424242')).toBeNull();
        expect(await answered('DELETE', '/api/v0/instances/424242/')).toEqual([404, { success: false, error: 'not_found', msg: 'Instance not found' }]);
        await expect(p.deleteServer('424242')).resolves.toBeUndefined();
        // An offer Vast does not have: no stock, like one rented since it was listed.
        const unknown = await p.createServer({ name: 'x', offer: '999', image: 'img' }).catch((e) => e);
        expect(unknown).toBeInstanceOf(CapacityError);
        expect(unknown).toMatchObject({ status: 404, code: 'invalid_args', message: expect.stringMatching(/error 404\/3603: no_such_ask Instance type by id 999 is not available/) });
        fake.state.asks.find((a) => a.id === 101)!.rentable = false;
        const taken = await p.createServer({ name: 'x', offer: '101', image: 'img' }).catch((e) => e);
        expect(taken).toBeInstanceOf(CapacityError);
        expect(taken).toMatchObject({ status: 410, code: 'no_such_ask' });
        // A key that is not there: nothing to delete.
        expect(await answered('DELETE', '/api/v0/ssh/1/')).toEqual([400, { success: false, error: 'no_ssh_key', msg: 'No ssh key provided' }]);
        expect(await p.deleteSSHKey('1')).toBe(false);
    });

    it('asks Vast for the model and vendor it wants: a data-center card behind 600 cheap ones is one search away', async () => {
        const { p, fake } = make();
        cheapCards(fake);
        fake.state.asks.push({ id: 4100, gpu_name: 'H100 SXM', num_gpus: 1, gpu_ram: 81559, dph_total: 2.2, min_bid: 1.1,
            geolocation: 'Texas, US', rentable: true, verified: true, reliability: 0.99, cuda_max_good: 12.9, machine_id: 5100 } as any);
        const h100 = await p.listOffers({ gpus: ['H100'], vendor: 'nvidia' });
        expect(h100.map((o) => [o.id, o.gpu, o.vramGb])).toEqual([['4100', 'H100', 80]]);
        expect(searches(fake)).toHaveLength(1);
        expect(searches(fake)[0].body).toMatchObject({ compute_cap: { in: [900] }, gpu_arch: { eq: 'nvidia' } });
        // A model the table does not know is matched on the client alone: nothing is filtered away unseen.
        await p.listOffers({ gpus: ['Some Future GPU'] });
        expect(searches(fake).at(-1)?.body.compute_cap).toBeUndefined();
    });

    it('pages past the 64-offer cap when nothing narrows the search, cheapest first, each machine once', async () => {
        const { p, fake } = make();
        cheapCards(fake, 150);
        fake.state.asks.push({ id: 4000, gpu_name: 'L4', num_gpus: 1, gpu_ram: 23034, dph_total: 0.4, min_bid: 0.2,
            geolocation: 'Iowa, US', rentable: true, verified: true, reliability: 0.99, cuda_max_good: 12.8, machine_id: 5000 } as any);
        const offers = await p.listOffers({ maxPricePerHour: 1 });
        expect(offers.map((o) => o.id)).toContain('4000');
        expect(searches(fake).length).toBeGreaterThan(1);
        const all = await p.listOffers({ includeUnavailable: true });
        expect(new Set(all.map((o) => o.id)).size).toBe(all.length);
    });

    it('reports a card at its nominal VRAM when Vast lists slightly less usable memory', async () => {
        const { p, fake } = make();
        fake.state.asks.push({ id: 4001, gpu_name: 'L4', num_gpus: 1, gpu_ram: 23034, dph_total: 0.41, min_bid: 0.2,
            geolocation: 'Iowa, US', rentable: true, verified: true, reliability: 0.99, cuda_max_good: 12.8, machine_id: 5001 } as any);
        const offer = (await p.listOffers({ minVramGb: 24 })).find((o) => o.id === '4001');
        expect(offer?.vramGb).toBe(24);
    });

    it('a container that crashed, went silent or went offline is an error, not pending forever', async () => {
        const { p, fake } = make();
        const s = await p.createServer({ name: 'probe', offer: '101', image: 'img', command: ['nvidia-smi', '-L'] });
        const inst = fake.state.instances.get(s.id);
        for (const actual of ['exited', 'unknown', 'offline']) {
            Object.assign(inst, { actual_status: actual, cur_state: 'running', intended_status: 'running', reads: 99 });
            expect((await p.getServer(s.id))?.status).toBe('error');
        }
        // Stopped on purpose, or on its way to stopped:
        Object.assign(inst, { actual_status: 'exited', cur_state: 'stopped', intended_status: 'stopped' });
        expect((await p.getServer(s.id))?.status).toBe('stopped');
        Object.assign(inst, { actual_status: 'running', cur_state: 'running', intended_status: 'stopped' });
        expect((await p.getServer(s.id))?.status).toBe('stopping');
    });
});

describe('minCudaVersion on Vast: every offer is one machine, read before it is rented', () => {
    const make = (minCudaVersion?: number) => {
        const fake = fakeVast();
        return { fake, p: new VastAI({ apiKey: 'vast-test', fetchImpl: fake.fetchImpl, sleep: noSleep, minCudaVersion }) };
    };
    const rents = (fake: ReturnType<typeof fakeVast>) => fake.calls.filter((c) => c.method === 'PUT' && /^\/api\/v0\/asks\//.test(c.path));

    it('searches by the driver\'s CUDA, a query\'s floor over the provider\'s default', async () => {
        const { p, fake } = make(12.9);
        expect((await p.listOffers()).map((o) => o.id)).toEqual(['101']);
        const offers = await p.listOffers({ minCudaVersion: '12.2' });
        expect(last(fake.calls)?.body.cuda_max_good).toEqual({ gte: 12.2 });
        expect(offers.map((o) => [o.id, o.cudaVersion])).toEqual([['104', '12.2'], ['101', '12.9'], ['102', '12.8'], ['106', '12.8']]);
    });

    it('a machine whose driver is older is not rented; a newer one is, on demand or by bid', async () => {
        const { p, fake } = make();
        await expect(p.createServer({ name: 't4', offer: '104', image: 'img', minCudaVersion: '12.8' })).rejects.toThrow(/runs CUDA 12\.2, below 12\.8/);
        expect(rents(fake)).toHaveLength(0);
        await expect(p.createServer({ name: 'ada', offer: '101:bid:0.12', image: 'img', minCudaVersion: '12.8' })).resolves.toMatchObject({ name: 'ada' });
        await expect(p.createServer({ name: 'a5000', offer: '102', image: 'img', minCudaVersion: '12.8' })).resolves.toMatchObject({ name: 'a5000' });
        expect(rents(fake)).toHaveLength(2);
        // The machine is read by ask_contract_id: Vast's search matches no offer by `id` (observed live).
        const reads = fake.calls.filter((c) => c.path === '/api/v0/bundles/' && c.body?.limit === 1);
        expect(reads.map((c) => c.body.ask_contract_id)).toEqual([{ eq: 104 }, { eq: 101 }, { eq: 102 }]);
        expect(reads.every((c) => c.body.id === undefined)).toBe(true);
    });
});

describe('Vast stop and start, as the live API answers them (observed 2026-10-02)', () => {
    const make = () => {
        const fake = fakeVast();
        return { fake, p: new VastAI({ apiKey: 'vast-test', fetchImpl: fake.fetchImpl, sleep: noSleep }) };
    };
    const running = async (p: VastAI) => {
        const [offer] = await p.listOffers();
        const s = await p.createServer({ name: 'cycle', offer, image: 'img', command: ['sleep', 'infinity'] });
        return p.waitUntilRunning(s.id, fast);
    };

    it('a started container reads as starting while Vast still reports it as it was left (exited), then running', async () => {
        const { p, fake } = make();
        const s = await running(p);
        await p.stopServer(s.id);
        expect((await p.waitForServer(s.id, (x) => x?.status === 'stopped', fast))?.status).toBe('stopped');
        await p.startServer(s.id);
        const inst = fake.state.instances.get(s.id);
        expect([inst.actual_status, inst.cur_state, inst.intended_status]).toEqual(['exited', 'running', 'running']);
        expect((await p.getServer(s.id))?.status).toBe('pending');
        expect((await p.waitUntilRunning(s.id, fast)).status).toBe('running');
        // The same report read by an initializer that started nothing is a crash.
        Object.assign(inst, { actual_status: 'exited' });
        const other = new VastAI({ apiKey: 'vast-test', fetchImpl: fake.fetchImpl, sleep: noSleep });
        expect((await other.getServer(s.id))?.status).toBe('error');
    });

    it('a stopped instance bills no run, even before Vast\'s cur_state says so; a running one bills from the rental\'s start', async () => {
        const { p, fake } = make();
        const s = await running(p);
        const inst = fake.state.instances.get(s.id);
        expect((await p.getServerCost(s.id))?.from).toBe(Math.round(inst.start_date * 1000));
        // The container exited on its way to stopped, and cur_state has not caught up.
        Object.assign(inst, { actual_status: 'exited', cur_state: 'running', intended_status: 'stopped' });
        const stopped = await p.getServer(s.id);
        expect(stopped?.status).toBe('stopped');
        expect(stopped?.billingStartedAt).toBeUndefined();
        expect(await p.getServerCost(s.id)).toBeNull();
    });

    it('a start Vast can only queue (its machine\'s GPU is taken) is cancelled: the instance stays stopped, and startServer throws CapacityError', async () => {
        const { p, fake } = make();
        const s = await running(p);
        await p.stopServer(s.id);
        fake.state.queueNextStart = true;
        const e = await p.startServer(s.id).catch((x) => x);
        expect(e).toBeInstanceOf(CapacityError);
        expect(e.message).toMatch(/queued start was cancelled/);
        const states = fake.calls.filter((c) => c.method === 'PUT' && c.path === `/api/v0/instances/${s.id}/`).map((c) => c.body.state);
        expect(states).toEqual(['stopped', 'running', 'stopped']);
        expect((await p.getServer(s.id))?.status).toBe('stopped');
    });
});

describe('Vast private registry login', () => {
    const make = () => {
        const fake = fakeVast();
        return { fake, p: new VastAI({ apiKey: 'vast-test', fetchImpl: fake.fetchImpl, sleep: async () => {} }) };
    };
    const rentals = (fake: ReturnType<typeof fakeVast>) => fake.calls.filter((c) => c.method === 'PUT' && /^\/api\/v0\/asks\/\d+\/$/.test(c.path)).map((c) => c.body);

    it('goes with the rental as docker login arguments, for the host the login names, else the image\'s, else Docker Hub', async () => {
        const { fake, p } = make();
        const offers = await p.listOffers();
        await p.createServer({ name: 'a', offer: offers[0], image: 'ghcr.io/acme/worker:1', registryAuth: { username: 'puller', password: 'ghp_x' } });
        await p.createServer({ name: 'b', offer: offers[1], image: 'acme/worker:1', registryAuth: { username: 'puller', password: 'dckr_x' } });
        await p.createServer({ name: 'c', offer: offers[2], image: 'acme/worker:1', registryAuth: { username: 'puller', password: 'x', server: 'registry.example.com:5000' } });
        await p.createServer({ name: 'd', offer: offers[3], image: 'acme/public:1' });
        expect(rentals(fake).map((b) => b.image_login)).toEqual(['-u puller -p ghp_x ghcr.io', '-u puller -p dckr_x docker.io', '-u puller -p x registry.example.com:5000', undefined]);
    });

    it('a login part with a space or a quote would split the string: refused before anything is rented; so is a second login in providerOptions', async () => {
        const { fake, p } = make();
        const [offer] = await p.listOffers();
        const o = { name: 'a', offer, image: 'ghcr.io/acme/worker:1' };
        await expect(p.createServer({ ...o, registryAuth: { username: 'pull er', password: 'p' } })).rejects.toThrow(/registryAuth username/);
        await expect(p.createServer({ ...o, registryAuth: { username: 'u', password: 'p"q' } })).rejects.toThrow(/registryAuth password/);
        await expect(p.createServer({ ...o, registryAuth: { username: 'u', password: '' } })).rejects.toThrow(/registryAuth password/);
        await expect(p.createServer({ ...o, registryAuth: { username: 'u', password: 'p', server: 'ghcr .io' } })).rejects.toThrow(/registryAuth server/);
        await expect(p.createServer({ ...o, registryAuth: { username: 'u', password: 'p' }, providerOptions: { image_login: '-u a -p b ghcr.io' } })).rejects.toThrow(/not both/);
        expect(rentals(fake)).toEqual([]);
        await expect(p.createServer(o)).resolves.toMatchObject({ name: 'a' });
    });
});

describe('Vast userData: a script run before the command, each time the container starts', () => {
    const make = () => {
        const fake = fakeVast();
        return { fake, p: new VastAI({ apiKey: 'vast-test', fetchImpl: fake.fetchImpl, sleep: async () => {} }) };
    };
    const rentals = (fake: ReturnType<typeof fakeVast>) => fake.calls.filter((c) => c.method === 'PUT' && /^\/api\/v0\/asks\/\d+\/$/.test(c.path)).map((c) => c.body);

    it('becomes the entrypoint `sh -c <script>; exec "$@"` over the command; without one, args are the command as before', async () => {
        const { fake, p } = make();
        const offers = await p.listOffers();
        const script = '#!/bin/bash\necho "asap-vps-boot=ok" > /tmp/booted';
        await p.createServer({ name: 'a', offer: offers[0], image: 'nvidia/cuda:12.8.1-base-ubuntu24.04', userData: script, command: ['bash', '-c', 'echo "asap-vps-cmd=ran"; sleep 1'] });
        await p.createServer({ name: 'b', offer: offers[1], image: 'nvidia/cuda:12.8.1-base-ubuntu24.04', command: ['nvidia-smi', '-L'] });
        const [withScript, plain] = rentals(fake);
        expect(withScript).toMatchObject({ runtype: 'args', onstart: 'sh', args: ['-c', `${script}\nexec "$@"`, 'asap-vps', 'bash', '-c', 'echo "asap-vps-cmd=ran"; sleep 1'] });
        expect(plain).toMatchObject({ runtype: 'args', args: ['nvidia-smi', '-L'] });
        expect(plain.onstart).toBeUndefined();
    });

    it('a cloud-config, or a script with no command to hand over to, is refused before anything is rented', async () => {
        const { fake, p } = make();
        const [offer] = await p.listOffers();
        await expect(p.createServer({ name: 'a', offer, image: 'busybox', userData: '#cloud-config\nruncmd: [true]', command: ['true'] })).rejects.toThrow(NotSupportedError);
        await expect(p.createServer({ name: 'a', offer, image: 'busybox', userData: 'echo hi' })).rejects.toThrow(/without "command"/);
        expect(rentals(fake)).toEqual([]);
    });
});

describe('Vast volumes: storage on one machine, mounted by an instance rented there (observed 2026-10-06)', () => {
    const make = (o: Parameters<typeof fakeVast>[0] = {}) => {
        const fake = fakeVast(o);
        return { fake, p: new VastAI({ apiKey: 'vast-test', fetchImpl: fake.fetchImpl, sleep: noSleep }) };
    };
    const IMAGE = { image: 'nvidia/cuda:12.8.1-base-ubuntu24.04', command: ['sleep', 'infinity'] };
    const rentals = (fake: ReturnType<typeof fakeVast>) => fake.calls.filter((c) => c.method === 'PUT' && /^\/api\/v0\/asks\/\d+\/$/.test(c.path)).map((c) => c.body);

    it('an offer names its machine among its regions; offersOn finds the offers on a machine, interruptible ones when asked', async () => {
        const { p } = make();
        const [offer] = await p.listOffers({ kind: 'gpu' });
        expect(offer.regions).toEqual(['Ohio, US', 'machine:14']);
        expect((await p.offersOn('machine:14')).map((o) => o.id)).toEqual(['104']);
        expect((await p.offersOn('machine:14', { includeInterruptible: true })).map((o) => o.id)).toEqual(['104:bid:0.05', '104']);
        expect(await p.offersOn('machine:999')).toEqual([]);
        await expect(p.offersOn('Ohio, US')).rejects.toThrow(/names no machine/);
    });

    it('createVolume rents the machine\'s storage, named as Vast takes names; read, listed (a withdrawn network volume is not), deleted, idempotently', async () => {
        const { p, fake } = make();
        const vol = await p.createVolume({ name: 'weights_1', region: 'machine:14', sizeGb: 20, ...fast });
        expect(vol).toMatchObject({ provider: 'vast', name: 'weights_1', region: 'machine:14', shared: false, sizeGb: 20, status: 'available', providerStatus: 'created',
            serverIds: [], mountPath: '/data' });
        expect(vol.createdAt).toBe(Math.round(vol.raw.start_date! * 1000));
        // Rented for 30 days, at the machine's storage price (0.2 a GB a month) for 20 GB, charged by the hour over 720.
        expect(vol.raw).toMatchObject({ type: 'machine', machine_id: 14, storage_total_cost: (20 * 0.2) / 720 });
        // (To the second: the two dates are two readings of the clock.)
        expect(vol.raw.end_date! - vol.raw.start_date!).toBeCloseTo(30 * 86_400, 0);
        expect(last(fake.calls.filter((c) => c.method === 'PUT' && c.path === '/api/v0/volumes/'))?.body).toEqual({ id: 5014, size: 20, name: 'weights_1' });
        expect(await p.getVolume(vol.id)).toMatchObject({ id: vol.id });
        expect((await p.listVolumes()).map((v) => v.name)).toEqual(['weights_1']);
        await p.deleteVolume(vol.id, fast);
        expect(await p.getVolume(vol.id)).toBeNull();
        await expect(p.deleteVolume(vol.id)).resolves.toBeUndefined();
        // Deleted by someone else between the read and the delete: still no error.
        const other = await p.createVolume({ name: 'race', region: 'machine:14', sizeGb: 1, ...fast });
        fake.state.volumes.delete(other.id);
        await expect(p.deleteVolume(other.id, fast)).resolves.toBeUndefined();
    });

    it('refuses before anything is made: a name Vast does not take, a size that is not whole GB, a region that is no machine; a machine with no room is a CapacityError', async () => {
        const { p, fake } = make();
        for (const name of ['asap-vps-vol', 'a b', 'x'.repeat(65), '']) {
            await expect(p.createVolume({ name, region: 'machine:14', sizeGb: 1 })).rejects.toThrow(/letters, digits and underscores only, at most 64/);
        }
        for (const sizeGb of [0, 1.5, -2]) await expect(p.createVolume({ name: 'v', region: 'machine:14', sizeGb })).rejects.toThrow(/whole GB, 1 GB or more/);
        await expect(p.createVolume({ name: 'v', region: 'Ohio, US', sizeGb: 1 })).rejects.toThrow(/on one machine: region "Ohio, US" names none/);
        expect(fake.calls).toEqual([]);
        await expect(p.createVolume({ name: 'v', region: 'machine:14', sizeGb: 401 })).rejects.toBeInstanceOf(CapacityError);
        expect(fake.state.volumes.size).toBe(1);
    });

    it('takes the id from the volume\'s name where the answer has no volume_id, and says so where it has neither', async () => {
        const { fake } = make();
        const real = fake.fetchImpl;
        let answer: unknown = { success: true, volume_name: 'V.%ID%' };
        const wrapped = (async (url: string, init?: RequestInit) => {
            const r = await real(url, init);
            if (init?.method !== 'PUT' || !String(url).endsWith('/api/v0/volumes/')) return r;
            const id = ((await r.json()) as { volume_id: number }).volume_id;
            return new Response(JSON.stringify(answer).replace('%ID%', String(id)), { status: 200, headers: { 'content-type': 'application/json' } });
        }) as unknown as typeof fetch;
        const q = new VastAI({ apiKey: 'vast-test', fetchImpl: wrapped, sleep: noSleep });
        expect((await q.createVolume({ name: 'by_name', region: 'machine:14', sizeGb: 1, ...fast })).name).toBe('by_name');
        answer = { success: true };
        await expect(q.createVolume({ name: 'no_id', region: 'machine:14', sizeGb: 1, ...fast })).rejects.toThrow(/returned no volume id/);
    });

    it('an instance rented on its machine mounts it, at /data or the mount\'s path; it is attached till the instance is gone, then free again', async () => {
        const { p, fake } = make({ volumeReleaseReads: 2 });
        const [offer] = await p.listOffers({ kind: 'gpu' });
        const vol = await p.createVolume({ name: 'data', region: 'machine:14', sizeGb: 10, ...fast });
        const s = await p.createServer({ name: 'with-volume', offer, ...IMAGE, mounts: [{ volume: vol }] });
        expect(last(rentals(fake))?.volume_info).toEqual({ create_new: false, volume_id: Number(vol.id), mount_path: '/data' });
        const running = await p.waitUntilRunning(s.id, fast);
        expect(running.mounts).toEqual([{ volumeId: vol.id, path: '/data' }]);
        expect(await p.getVolume(vol.id)).toMatchObject({ status: 'attached', serverIds: [s.id] });
        await expect(p.deleteVolume(vol.id)).rejects.toThrow(`volume ${vol.id} is attached to instance ${s.id}: delete the instance first`);
        // Deleted: verified gone, and the volume no longer lists it (Vast lets go a read or two later).
        expect(await p.deleteServerAndWait(s.id, fast)).toBe(true);
        expect(await p.getVolume(vol.id)).toMatchObject({ status: 'available', serverIds: [] });
        // Mounted again, by id, at a path of its own, by an offer given as its id (its machine read from Vast).
        fake.state.asks.find((a) => a.id === 104)!.rentable = true;
        const again = await p.createServer({ name: 'again', offer: '104', ...IMAGE, mounts: [{ volume: vol.id, path: '/models' }] });
        expect((await p.waitUntilRunning(again.id, fast)).mounts).toEqual([{ volumeId: vol.id, path: '/models' }]);
        expect(await p.deleteServerAndWait(again.id, fast)).toBe(true);
        await p.deleteVolume(vol.id, fast);
    });

    it('refuses before anything is rented: two volumes, a relative path, a volume that is not there, one on another machine, one another instance mounts, a disk of its own', async () => {
        const { p, fake } = make();
        const [offer] = await p.listOffers({ kind: 'gpu' });
        const vol = await p.createVolume({ name: 'here', region: 'machine:14', sizeGb: 10, ...fast });
        const far = await p.createVolume({ name: 'far', region: 'machine:11', sizeGb: 10, ...fast });
        const base = { name: 'x', offer, ...IMAGE };
        await expect(p.createServer({ ...base, mounts: [{ volume: vol }, { volume: far }] })).rejects.toBeInstanceOf(NotSupportedError);
        await expect(p.createServer({ ...base, mounts: [{ volume: vol, path: 'data' }] })).rejects.toThrow(/mount path "data" is not absolute/);
        await expect(p.createServer({ ...base, mounts: [{ volume: '424242' }] })).rejects.toThrow(/no volume 424242/);
        await expect(p.createServer({ ...base, mounts: [{ volume: far.id }] })).rejects.toThrow(`volume ${far.id} is on machine:11: only an instance rented there mounts it, and offer 104 is on machine:14`);
        await expect(p.createServer({ ...base, offer: '104', mounts: [{ volume: far.id }] })).rejects.toThrow(/is on machine:11/);
        expect(rentals(fake)).toEqual([]);
        const holder = await p.createServer({ ...base, name: 'holder', mounts: [{ volume: vol.id }] });
        const other = (await p.listOffers({ kind: 'gpu' }))[0];
        fake.state.asks.find((a) => a.id === Number(other.id))!.machine_id = 14;
        await expect(p.createServer({ ...base, offer: other.id, mounts: [{ volume: vol.id }] })).rejects.toThrow(`volume ${vol.id} is attached to instance ${holder.id}: one instance mounts it at a time`);
        await expect(p.createServer({ ...base, volume: { sizeGb: 10, path: '/x' } } as never)).rejects.toBeInstanceOf(NotSupportedError);
        expect(rentals(fake)).toHaveLength(1);
    });

    it('reads an instance\'s volumes from its volume_info, each at the path its env\'s docker flag gives the volume\'s name; a volume in use is attached', async () => {
        const { instanceMounts, toVolume } = jest.requireActual('./mappers') as typeof import('./mappers');
        // As Vast's instance list has them (observed 2026-10-06): the env as pairs, the mount's flag among them.
        expect(instanceMounts({ id: 1, extra_env: [['-v data_1:/models/x', '1'], ['CONTAINER_RUNTIME', 'gvisor']],
            volume_info: [{ id: 7, label: 'data_1', type: 'machine' }, { id: 8, label: 'unflagged' }, { label: 'no_id' }] })).toEqual([{ volumeId: '7', path: '/models/x' }, { volumeId: '8' }]);
        // The env as an object (as a rental sends it), a volume without a name, no volumes.
        expect(instanceMounts({ id: 1, extra_env: { '-v data_1:/d': '1' }, volume_info: [{ id: 7, label: 'data_1' }] })).toEqual([{ volumeId: '7', path: '/d' }]);
        expect(instanceMounts({ id: 1, volume_info: [{ id: 7, label: null }] })).toEqual([{ volumeId: '7' }]);
        expect(instanceMounts({ id: 1 })).toEqual([]);
        expect(toVolume({ id: 5, machine_id: 3, instances: [{ id: 9 }, { id: null }], status: 'in-use' })).toMatchObject({
            name: '', status: 'attached', providerStatus: 'in-use', serverIds: ['9'], region: 'machine:3',
        });
        // In use a moment after its instance is gone, then created again; a status Vast has not shown is unknown.
        expect(toVolume({ id: 5, machine_id: 3, instances: [], status: 'in-use' }).status).toBe('attached');
        expect(toVolume({ id: 5, machine_id: 3, status: 'weird' })).toMatchObject({ status: 'unknown', serverIds: [] });
        expect(toVolume({ id: 5, machine_id: 3 }).sizeGb).toBeUndefined();
    });
});

describe('Vast images: snapshots an instance pushes to a registry of yours (observed 2026-10-06)', () => {
    const make = (o: Parameters<typeof fakeVast>[0] = {}, snapshots: typeof FAKE_SNAPSHOTS | undefined = FAKE_SNAPSHOTS) => {
        const fake = fakeVast(o);
        return { fake, p: new VastAI({ apiKey: 'vast-test', fetchImpl: fake.fetchImpl, sleep: noSleep, snapshots }) };
    };
    const IMAGE = { image: 'nvidia/cuda:12.8.1-base-ubuntu24.04', command: ['sleep', 'infinity'] };
    const rentals = (fake: ReturnType<typeof fakeVast>) => fake.calls.filter((c) => c.method === 'PUT' && /^\/api\/v0\/asks\/\d+\/$/.test(c.path)).map((c) => c.body);
    const running = async (p: VastAI, offer = '104') => p.waitUntilRunning((await p.createServer({ name: 'source', offer, ...IMAGE })).id, fast);

    it('createImage has Vast push a snapshot (the repository with its registry and no tag, the instance in the URL only), waits for its tag, and names it', async () => {
        const { p, fake } = make();
        const s = await running(p);
        const image = await p.createImage(s.id, { name: 'trained-v1', ...fast });
        expect(last(fake.calls.filter((c) => c.path.startsWith('/api/v0/instances/take_snapshot/')))).toMatchObject({
            method: 'POST', path: `/api/v0/instances/take_snapshot/${s.id}/`,
            body: { container_registry: 'registry.fake', personal_repo: 'registry.fake/acme/snapshots', docker_login_user: 'pusher', docker_login_pass: 'push-secret', pause: 'true' },
        });
        expect(image).toMatchObject({ provider: 'vast', id: 'registry.fake/acme/snapshots:trained-v1', name: 'trained-v1', status: 'available', providerStatus: 'pushed', regions: [] });
        expect(image.raw).toMatchObject({ reference: image.id, tag: 'trained-v1', digest: expect.stringMatching(/^sha256:/) });
        // Its layers as the registry stores them, in GB (1e9 bytes): read back through the Registry API, not from the provider.
        const stored = await new RegistryClient('registry.fake', { username: 'pusher', password: 'push-secret' }, fake.fetchImpl).manifest('acme/snapshots', 'trained-v1');
        expect(image.sizeGb).toBe(stored!.json.layers.reduce((n: number, l: { size: number }) => n + l.size, 0) / 1e9);
        // Vast's own tag and the name are one image: listed once, under its name.
        const tags = fake.registry.tags.get('acme/snapshots')!;
        expect([...tags.keys()].sort()).toEqual([expect.stringMatching(new RegExp(`^instance_${s.id}_at_October_6th_2026_at_\\d+-\\d\\d-\\d\\d_[AP]M_UTC$`)), 'trained-v1'].sort());
        expect(new Set(tags.values()).size).toBe(1);
        expect((await p.listImages()).map((i) => [i.name, i.raw.digest])).toEqual([['trained-v1', image.raw.digest]]);
        expect(await p.getImage(image.id)).toMatchObject({ id: image.id, name: 'trained-v1', raw: { digest: image.raw.digest } });
        // A snapshot taken elsewhere (no name): listed under Vast's tag; a stopped instance can be snapshotted too.
        await p.stopServer(s.id);
        const again = await p.createImage(s.id, { name: 'stopped-v2', ...fast });
        expect(again.name).toBe('stopped-v2');
        fake.registry.push('acme/snapshots', 'instance_1_at_October_1st_2026_at_1-00-00_AM_UTC', 'console');
        expect((await p.listImages()).map((i) => i.name).sort()).toEqual(['instance_1_at_October_1st_2026_at_1-00-00_AM_UTC', 'stopped-v2', 'trained-v1']);
    });

    it('boots on any machine, pulled with the snapshot login unless the create gives one; deleted with every tag of it, idempotently', async () => {
        const { p, fake } = make();
        const image = await p.createImage((await running(p)).id, { name: 'boot-me', ...fast });
        await p.createServer({ name: 'from-snapshot', offer: '101', image: image.id, command: ['nvidia-smi'] });
        expect(last(rentals(fake))).toMatchObject({ image: image.id, image_login: '-u pusher -p push-secret registry.fake' });
        await p.createServer({ name: 'own-login', offer: '102', image: image.id, command: ['nvidia-smi'], registryAuth: { username: 'other', password: 'pw' } });
        expect(last(rentals(fake))?.image_login).toBe('-u other -p pw registry.fake');
        // Another repository's image (or Docker Hub's) goes with no login.
        await p.createServer({ name: 'public', offer: '106', image: 'registry.fake/acme/other:1', command: ['nvidia-smi'] });
        expect(last(rentals(fake))?.image_login).toBeUndefined();
        await p.deleteImage(image.id);
        expect(await p.getImage(image.id)).toBeNull();
        expect(fake.registry.tags.get('acme/snapshots')!.size).toBe(0);
        await expect(p.deleteImage(image.id)).resolves.toBeUndefined();
    });

    it('refuses before anything is asked: no snapshot repository, a name that is no tag, a name the repository has; another repository\'s image is none of its', async () => {
        const { p, fake } = make();
        const s = await running(p);
        const bare = new VastAI({ apiKey: 'vast-test', fetchImpl: fake.fetchImpl, sleep: noSleep });
        await expect(bare.createImage(s.id, { name: 'x' })).rejects.toThrow(/Vast keeps no images: createImage pushes a snapshot to a registry of yours, so pass `snapshots`/);
        expect(await bare.listImages()).toEqual([]);
        expect(await bare.getImage('registry.fake/acme/snapshots:x')).toBeNull();
        await expect(bare.deleteImage('registry.fake/acme/snapshots:x')).resolves.toBeUndefined();
        for (const name of ['-starts-with-dash', 'has space', 'x'.repeat(129), '']) await expect(p.createImage(s.id, { name })).rejects.toThrow(/it is the image's tag/);
        fake.registry.push('acme/snapshots', 'taken');
        await expect(p.createImage(s.id, { name: 'taken' })).rejects.toThrow('image registry.fake/acme/snapshots:taken exists already: delete it, or pick another name');
        expect(fake.calls.filter((c) => c.path.startsWith('/api/v0/instances/take_snapshot/'))).toEqual([]);
        // Not its repository: no image of its, nothing deleted.
        fake.registry.push('acme/other', 'v1');
        expect(await p.getImage('registry.fake/acme/other:v1')).toBeNull();
        await p.deleteImage('registry.fake/acme/other:v1');
        expect(fake.registry.tags.get('acme/other')!.size).toBe(1);
        expect(await p.getImage('ubuntu:24.04')).toBeNull();
    });

    it('a snapshot that never comes times out saying so; another instance\'s snapshot is not taken for it', async () => {
        const { p, fake } = make({ snapshotReads: 1e9 });
        const s = await running(p);
        fake.registry.push('acme/snapshots', 'instance_999_at_October_6th_2026_at_1-00-00_AM_UTC', 'another');
        await expect(p.createImage(s.id, { name: 'never', intervalMs: 0, timeoutMs: 20 })).rejects.toThrow(/timed out after 0 s waiting for the snapshot of instance \d+ in registry.fake\/acme\/snapshots: not pushed yet/);
        expect(fake.registry.tags.get('acme/snapshots')!.has('never')).toBe(false);
    });

    it('a Docker Hub repository is read as Docker Hub names it: its short names are its images too', async () => {
        const { p, fake } = make({}, { server: 'docker.io', repository: 'acme/snaps', username: 'hubber', password: 'hub-token' });
        await p.createServer({ name: 'short', offer: '104', image: 'acme/snaps:v1', command: ['nvidia-smi'] });
        expect(last(rentals(fake))?.image_login).toBe('-u hubber -p hub-token docker.io');
        await p.createServer({ name: 'library', offer: '101', image: 'ubuntu:24.04', command: ['nvidia-smi'] });
        expect(last(rentals(fake))?.image_login).toBeUndefined();
    });
});

describe('Vast regions: an offer is one machine, rented where it is', () => {
    const make = () => {
        const fake = fakeVast();
        return { fake, p: new VastAI({ apiKey: 'vast-test', fetchImpl: fake.fetchImpl, sleep: noSleep }) };
    };
    const IMAGE = { image: 'nvidia/cuda:12.8.1-base-ubuntu24.04', command: ['nvidia-smi', '-L'] };
    const rentals = (fake: ReturnType<typeof fakeVast>) => fake.calls.filter((c) => c.method === 'PUT' && /^\/api\/v0\/asks\/\d+\/$/.test(c.path));

    it('a region that is the offer\'s (its location, or its machine) rents it; an offer given by its id is looked up first', async () => {
        const { p, fake } = make();
        const [offer] = await p.listOffers({ kind: 'gpu' });
        expect(offer.regions).toEqual(['Ohio, US', 'machine:14']);
        await p.createServer({ name: 'by-location', offer, region: 'Ohio, US', ...IMAGE });
        fake.state.asks.find((a) => a.id === 104)!.rentable = true;
        await p.createServer({ name: 'by-machine', offer, region: 'machine:14', ...IMAGE });
        fake.state.asks.find((a) => a.id === 104)!.rentable = true;
        const lookups = () => fake.calls.filter((c) => c.method === 'POST' && c.path === '/api/v0/bundles/' && c.body?.ask_contract_id).length;
        const before = lookups();
        await p.createServer({ name: 'by-id', offer: '104', region: 'machine:14', ...IMAGE });
        expect([lookups() - before, rentals(fake).length]).toEqual([1, 3]);
        // No region asked: no lookup, and rented where it is, as before.
        await p.createServer({ name: 'anywhere', offer: '101', ...IMAGE });
        expect([lookups() - before, rentals(fake).length]).toEqual([1, 4]);
    });

    it('a region that is not the offer\'s is refused before anything is rented; an offer with no stock anywhere is a CapacityError', async () => {
        const { p, fake } = make();
        const [offer] = await p.listOffers({ kind: 'gpu' });
        await expect(p.createServer({ name: 'x', offer, region: 'Texas, US', ...IMAGE })).rejects.toThrow('offer 104 is in Ohio, US, machine:14, not in Texas, US: a Vast offer is one machine, rented where it is');
        await expect(p.createServer({ name: 'x', offer: '104', region: 'machine:11', ...IMAGE })).rejects.toThrow(/offer 104 is in Ohio, US, machine:14, not in machine:11/);
        // The 4090 in Sweden is rented out: no stock anywhere, whatever is asked.
        const taken = (await p.listOffers({ kind: 'gpu', includeUnavailable: true })).find((o) => o.id === '103')!;
        await expect(p.createServer({ name: 'x', offer: taken, region: 'Sweden, SE', ...IMAGE })).rejects.toBeInstanceOf(CapacityError);
        await expect(p.createServer({ name: 'x', offer: '103', region: 'Sweden, SE', ...IMAGE })).rejects.toThrow(/offer 103 has no stock anywhere right now/);
        expect(rentals(fake)).toEqual([]);
    });
});
