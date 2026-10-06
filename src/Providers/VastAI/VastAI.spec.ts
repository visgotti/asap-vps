// VastAI against the fake of Vast.ai's API (src/testing/fakes/vast.ts): what is
// particular to it beyond the shared contract (../gpuContract.spec.ts). From
// docs.vast.ai/api-reference, the create guide and the official CLI (checked
// 2026-09-29): at most 64 offers per search, usable (not nominal) VRAM,
// containers that crash or go silent never reach running, and each offer is one
// machine, whose driver's CUDA version is read before it is rented.

import { CapacityError, NotSupportedError, ProviderError } from '../../errors';
import { fakeVast } from '../../testing/fakes/vast';
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
        expect(offers[1]).toMatchObject({ gpu: 'RTX 4000 Ada', vramGb: 20, regions: ['Texas, US'] });
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

    it('fetches the uploaded log without sending the API key to the upload host', async () => {
        const { p, fake } = make();
        const s = await p.createServer({ name: 'logs', offer: '101', image: 'img' });
        expect(await p.getServerLogs(s.id)).toMatch(/hello from logs/);
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
