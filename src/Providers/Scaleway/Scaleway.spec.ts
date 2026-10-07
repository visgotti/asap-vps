// Scaleway against the fake of Scaleway's API (src/testing/fakes/scaleway.ts):
// what is particular to Scaleway beyond the shared contract (../contract.spec.ts
// and ../lifecycle.spec.ts). From Scaleway's OpenAPI specs (Instance API v1,
// IAM, Block Storage v1, read 2026-10-01) and its real catalog answers: prices
// are euros and memory is bytes; stock is `available`, `scarce` or `shortage` per
// zone; a server is named by zone and id, created powered off, and started by
// an action after its user data is set; `terminate` only detaches Block Storage
// volumes, which then bill until deleted; poweroff releases the GPU; images are
// zone-bound snapshots; SSH keys belong to a Project.

import { ICompute, requireCapability, supports } from '../../capabilities';
import { sshKeyFingerprint } from '../../Core/utils';
import { CapacityError, NotFoundError, NotSupportedError, ProviderError, QuotaError } from '../../errors';
import { FAKE_SCALEWAY_PROJECT, fakeScaleway, FakeScalewayOptions } from '../../testing/fakes/scaleway';
import { SERVER_TYPES } from '../../testing/fakes/scalewayCatalog';
import { followingRedirects, json, testPublicKey } from '../../testing/fakes/util';
import type { Offer } from '../../types';
import { fileSystemMounts, MOUNT_TAG, mountedVolumeIds, toVolume } from './mappers';
import { REGION_TYPES } from '../../constants';
import { Scaleway } from './Scaleway';
import type { ScalewayBlockVolume, ScalewayParams, ScalewayServer, ScalewayZone } from './types';

const noSleep = async () => {};
const fast = { intervalMs: 0, timeoutMs: 5000 };
const GPU_IMAGE = 'ubuntu_noble_gpu_os_13_nvidia';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const make = (o: FakeScalewayOptions = {}, params: Partial<ScalewayParams> = {}) => {
    const fake = fakeScaleway(o);
    return { fake, p: new Scaleway({ apiKey: 'scw-test', projectId: FAKE_SCALEWAY_PROJECT, fetchImpl: fake.fetchImpl, sleep: noSleep, ...params }) };
};
type Fake = ReturnType<typeof fakeScaleway>;
/** Another client of the same account (it has read nothing yet: the type catalog is cached per client). */
const another = (fake: Fake) => new Scaleway({ apiKey: 'scw-test', projectId: FAKE_SCALEWAY_PROJECT, fetchImpl: fake.fetchImpl, sleep: noSleep });
/** The offer of a type that boots from a local disk, as the older types do (every type of the catalog today has Block Storage). */
const withoutBlockStorage = (offer: Offer): Offer => {
    const raw = offer.raw as any;
    return { ...offer, raw: { ...raw, serverType: { ...raw.serverType, capabilities: { ...raw.serverType.capabilities, block_storage: false } } } };
};
const isBackup = (r: { body?: any }) => r.body?.action === 'backup';
const creates = (fake: Fake) => fake.calls.filter((c) => c.method === 'POST' && /\/servers$/.test(c.path));
const actions = (fake: Fake) => fake.calls.filter((c) => c.method === 'POST' && c.body?.action).map((c) => c.body.action as string);
/** The cheapest GPU in stock (the L4 in Warsaw 2), created and running. */
const running = async (p: Scaleway, name = 'gpu') => {
    const [offer] = await p.listOffers({ kind: 'gpu' });
    return p.waitUntilRunning((await p.createServer({ name, offer })).id, fast);
};

describe('Scaleway offers', () => {
    it('is one offer per GPU Instance type: the price in USD at the euro rate, the memory of one GPU, the zones with stock', async () => {
        const { p } = make();
        const offers = await p.listOffers({ kind: 'gpu', includeUnavailable: true });
        expect(offers.map((o) => o.id).sort()).toEqual(['B300-SXM-8-288G', 'H100-1-80G', 'H100-SXM-8-80G', 'L4-1-24G', 'L4-2-24G', 'L40S-1-48G', 'RENDER-S']);
        const l4 = offers.find((o) => o.id === 'L4-1-24G')!;
        expect(l4).toMatchObject({ provider: 'scaleway', gpu: 'L4', vendor: 'nvidia', gpuCount: 1, vramGb: 24, regions: ['pl-waw-2'], vcpus: 8, memoryGb: 48 });
        expect(l4.pricePerHour).toBeCloseTo(0.7875 * 1.15, 6);
        // A GPU type has no local disk: its root volume is Block Storage.
        expect(l4.diskGb).toBeUndefined();
        // The provider's own record keeps the euro price and the stock of every zone the type is in.
        expect(l4.raw).toMatchObject({
            serverType: { hourly_price: 0.7875, gpu_info: { gpu_name: 'L4', gpu_memory: 25769803776 } },
            availability: { 'fr-par-1': 'shortage', 'fr-par-2': 'shortage', 'pl-waw-2': 'available' },
        });
    });

    it('names a model as every provider does, and counts the GPUs of a multi-GPU type', async () => {
        const { p } = make();
        const offers = await p.listOffers({ includeUnavailable: true });
        const by = (id: string) => offers.find((o) => o.id === id)!;
        expect(by('H100-1-80G')).toMatchObject({ gpu: 'H100', vramGb: 80, gpuCount: 1 });
        expect(by('H100-SXM-8-80G')).toMatchObject({ gpu: 'H100', vramGb: 80, gpuCount: 8, vcpus: 128, memoryGb: 960 });
        expect(by('B300-SXM-8-288G')).toMatchObject({ gpu: 'B300', vramGb: 288, gpuCount: 8 });
        // The one type with a local disk: and a Pascal P100, which the shared model list names too.
        expect(by('RENDER-S')).toMatchObject({ gpu: 'P100', vendor: 'nvidia', vramGb: 16, diskGb: 400 });
        expect(by('H100-SXM-8-80G').pricePerHour).toBeCloseTo(25.3308 * 1.15, 4);
    });

    it('counts `scarce` as stock, `shortage` as none, and lists only what is in stock unless asked', async () => {
        const { p } = make();
        const inStock = await p.listOffers({ kind: 'gpu' });
        expect(inStock.map((o) => [o.id, o.regions])).toEqual([
            ['L4-1-24G', ['pl-waw-2']], ['RENDER-S', ['fr-par-2']], ['L40S-1-48G', ['fr-par-2']], ['L4-2-24G', ['pl-waw-2']],
        ]);
        const all = await p.listOffers({ kind: 'gpu', includeUnavailable: true });
        expect(all.find((o) => o.id === 'H100-1-80G')?.regions).toEqual([]);
        // Cheapest first.
        for (let i = 1; i < inStock.length; i++) expect(inStock[i - 1].pricePerHour).toBeLessThanOrEqual(inStock[i].pricePerHour);
    });

    it('prices at the rate it is given', async () => {
        const { p } = make({}, { eurToUsd: 1 });
        expect((await p.listOffers({ kind: 'gpu' })).find((o) => o.id === 'L4-1-24G')?.pricePerHour).toBeCloseTo(0.7875, 6);
    });

    it('offers CPU types by default and with kind cpu, never with kind gpu: x86 only (an Arm image cannot boot on a GPU), with no GPU', async () => {
        const { p } = make();
        expect((await p.listOffers({ kind: 'gpu', includeUnavailable: true })).map((o) => o.id)).not.toContain('DEV1-S');
        expect((await p.listOffers({ kind: 'cpu', includeUnavailable: true })).map((o) => o.id)).not.toContain('L4-1-24G');
        const withCpu = await p.listOffers({ includeUnavailable: true });
        const ids = withCpu.map((o) => o.id);
        expect(ids).toEqual(expect.arrayContaining(['DEV1-S', 'PLAY2-NANO', 'STARDUST1-S']));
        expect(ids).not.toContain('BASIC2-A2C-4G');
        expect(withCpu.find((o) => o.id === 'DEV1-S')).toMatchObject({
            gpu: '', vendor: null, gpuCount: 0, vramGb: 0, vcpus: 2, memoryGb: 2, diskGb: 20, regions: ['fr-par-1', 'fr-par-2', 'nl-ams-1', 'pl-waw-2'],
        });
        // A GPU filter is a question about GPUs: no CPU type answers it.
        expect((await p.listOffers({ minVramGb: 40 })).map((o) => o.id)).toContain('L40S-1-48G');
        expect((await p.listOffers({ minVramGb: 40 })).map((o) => o.id)).not.toContain('L4-1-24G');
        expect((await p.listOffers({ minVramGb: 40 })).map((o) => o.id)).not.toContain('DEV1-S');
    });

    it('leaves out a type at end of service, and reads only the zones it was given', async () => {
        const { p } = make({ endOfService: ['L4-2-24G', 'DEV1-S'] });
        const ids = (await p.listOffers({ includeUnavailable: true })).map((o) => o.id);
        expect(ids).not.toContain('L4-2-24G');
        expect(ids).not.toContain('DEV1-S');
        const paris = make({}, { zones: 'fr-par' });
        const offers = await paris.p.listOffers({ includeUnavailable: true });
        // The L4 is in stock in Warsaw only: a Paris-only provider sees none.
        expect(offers.find((o) => o.id === 'L4-1-24G')?.regions).toEqual([]);
        expect(paris.fake.calls.every((c) => /\/zones\/fr-par-[123]\//.test(c.path))).toBe(true);
    });
});

describe('Scaleway billing', () => {
    it('counts a GPU Instance by the minute, and a CPU Instance and RENDER-S by the hour (Scaleway\'s Instances FAQ)', async () => {
        const { p } = make();
        const offers = await p.listOffers({ includeUnavailable: true });
        const by = (id: string) => offers.find((o) => o.id === id)!;
        expect(by('L4-1-24G').billing).toEqual({ incrementSeconds: 60, minimumSeconds: 0 });
        expect(by('H100-SXM-8-80G').billing).toBe(Scaleway.BILLING_PER_MINUTE);
        expect(by('RENDER-S').billing).toBe(Scaleway.BILLING_PER_HOUR);
        expect(by('DEV1-S').billing).toEqual({ incrementSeconds: 3600, minimumSeconds: 0 });
    });

    it('dates the current run from the server\'s modification date while it bills compute, and not at all once it is powered off', async () => {
        const { p, fake } = make();
        const s = await running(p);
        const record = fake.state.servers.get(s.id);
        expect(s.billing).toBe(Scaleway.BILLING_PER_MINUTE);
        expect(s.billingStartedAt).toBe(Date.parse(record.modification_date));
        // The run began after the create: the record was stamped when the server started and when it ran.
        expect(s.billingStartedAt!).toBeGreaterThanOrEqual(Date.parse(record.creation_date));
        // A priced hour of it is the rate, counted by the minute.
        expect((await p.getServerCost(s.id, s.billingStartedAt! + 3_600_000))?.usd).toBeCloseTo(s.pricePerHour!, 9);
        // Standby bills as running.
        await p.api.serverAction('pl-waw-2', s.id.split('/')[1], { action: 'stop_in_place' });
        expect((await p.getServer(s.id))?.billingStartedAt).toBeDefined();
        // stopServer powers a server in standby off (it reads as stopped, but holds its slot and bills): no compute bills then.
        const offs = fake.calls.filter((c) => c.body?.action === 'poweroff').length;
        await p.stopServer(s.id);
        expect(fake.calls.filter((c) => c.body?.action === 'poweroff')).toHaveLength(offs + 1);
        const stopped = (await p.getServer(s.id))!;
        expect(stopped).toMatchObject({ status: 'stopped', billingStartedAt: undefined });
        expect(stopped.pricePerHour).toBeCloseTo(s.pricePerHour!, 9);
        expect(await p.getServerCost(s.id)).toBeNull();
        // Powered on again, a new run.
        await p.startServer(s.id);
        const again = await p.waitUntilRunning(s.id, fast);
        expect(again.billingStartedAt!).toBeGreaterThan(s.billingStartedAt!);
    });

    it('knows no billing for a type it cannot read, except a RENDER, which is always hourly', async () => {
        const { p, fake } = make();
        const s = await running(p);
        const render = await p.createServer({ name: 'render', offer: 'RENDER-S', region: 'fr-par-2' });
        fake.intercept((r) => /\/products\/servers$/.test(r.path), { answer: () => json(500, { message: 'catalog is down' }) });
        const blind = another(fake);
        expect((await blind.getServer(s.id))?.billing).toBeUndefined();
        expect((await blind.getServer(render.id))?.billing).toBe(Scaleway.BILLING_PER_HOUR);
    });
});

describe('Scaleway createServer', () => {
    it('creates the server, sets its user data, and powers it on, in that order, as the API needs', async () => {
        const { p, fake } = make();
        const [offer] = await p.listOffers({ kind: 'gpu' });
        const s = await p.createServer({ name: 'gpu-1', offer, userData: '#cloud-config\n', tags: ['team=ml', 'scratch'] });
        expect(s).toMatchObject({ provider: 'scaleway', name: 'gpu-1', status: 'pending', providerStatus: 'starting', gpu: 'L4', gpuCount: 1, region: 'pl-waw-2', offerId: 'L4-1-24G' });
        expect(s.id).toMatch(/^pl-waw-2\/[0-9a-f-]{36}$/);
        expect(creates(fake)[0].body).toEqual({
            name: 'gpu-1', commercial_type: 'L4-1-24G', image: GPU_IMAGE, project: FAKE_SCALEWAY_PROJECT, dynamic_ip_required: true, boot_type: 'local', protected: false,
            tags: ['team=ml', 'scratch'],
        });
        const writes = fake.calls.filter((c) => c.method !== 'GET' && c.path.startsWith('/instance/')).map((c) => `${c.method} ${c.path.replace(/[0-9a-f-]{36}/, '<id>')}`);
        expect(writes).toEqual([
            'POST /instance/v1/zones/pl-waw-2/servers',
            'PATCH /instance/v1/zones/pl-waw-2/servers/<id>/user_data/cloud-init',
            'POST /instance/v1/zones/pl-waw-2/servers/<id>/action',
        ]);
        expect(actions(fake)).toEqual(['poweron']);
        expect(fake.state.servers.get(s.id).userData['cloud-init']).toBe('#cloud-config\n');
        // No user data: no call for it.
        const quiet = make();
        await quiet.p.createServer({ name: 'q', offer: 'L4-1-24G', region: 'pl-waw-2' });
        expect(quiet.fake.calls.some((c) => c.method === 'PATCH')).toBe(false);
    });

    it('defaults the image to Scaleway\'s GPU image for a GPU type and plain Ubuntu for a CPU one; any label or id passes through', async () => {
        const { p, fake } = make();
        await p.createServer({ name: 'gpu', offer: 'L4-1-24G', region: 'pl-waw-2' });
        await p.createServer({ name: 'cpu', offer: 'DEV1-S', region: 'fr-par-1' });
        await p.createServer({ name: 'label', offer: 'L4-1-24G', region: 'pl-waw-2', image: 'ubuntu_noble_gpu_os_12' });
        expect(creates(fake).map((c) => c.body.image)).toEqual([GPU_IMAGE, 'ubuntu_noble', 'ubuntu_noble_gpu_os_12']);
        expect([Scaleway.GPU_IMAGE, Scaleway.CPU_IMAGE]).toEqual([GPU_IMAGE, 'ubuntu_noble']);
    });

    it('sends no root volume unless `diskGb` sizes it: Block Storage in bytes, a multiple of 512', async () => {
        const { p, fake } = make();
        const [offer] = await p.listOffers({ kind: 'gpu' });
        await p.createServer({ name: 'default', offer });
        await p.createServer({ name: 'big', offer, diskGb: 100 });
        await p.createServer({ name: 'odd', offer, diskGb: 20.5 });
        const [none, big, odd] = creates(fake).map((c) => c.body.volumes);
        expect(none).toBeUndefined();
        expect(big).toEqual({ 0: { volume_type: 'sbs_volume', size: 100_000_000_000 } });
        expect(odd[0].size % 512).toBe(0);
        expect(odd[0].size).toBeGreaterThan(20_499_999_000);
        expect(odd[0].size).toBeLessThan(20_500_001_000);
        for (const bad of [0, -5]) await expect(p.createServer({ name: 'bad', offer, diskGb: bad })).rejects.toThrow(/diskGb must be a size in GB above 0/);
        expect(creates(fake)).toHaveLength(3);
    });

    it('uses a local SSD only for a type without Block Storage', async () => {
        const { p, fake } = make();
        const render = (await p.listOffers({ kind: 'gpu' })).find((o) => o.id === 'RENDER-S')!;
        await p.createServer({ name: 'block', offer: render, diskGb: 50 });
        await p.createServer({ name: 'local', offer: withoutBlockStorage(render), diskGb: 50 });
        expect(creates(fake).map((c) => c.body.volumes[0].volume_type)).toEqual(['sbs_volume', 'l_ssd']);
    });

    it('merges providerOptions into the create body, last', async () => {
        const { p, fake } = make();
        await p.createServer({ name: 'po', offer: 'L4-1-24G', region: 'pl-waw-2', providerOptions: { protected: true, placement_group: '33333333-3333-4333-8333-333333333333' } });
        expect(creates(fake)[0].body).toMatchObject({ protected: true, placement_group: '33333333-3333-4333-8333-333333333333', commercial_type: 'L4-1-24G' });
    });

    it('refuses what a VM cannot do (a container\'s options), and needs the Project, before anything is sent', async () => {
        const { p, fake } = make();
        for (const o of [{ env: { A: 'b' } }, { command: ['x'] }, { ports: ['22/tcp'] }, { volume: { sizeGb: 10, path: '/data' } }]) {
            await expect(p.createServer({ name: 'x', offer: 'L4-1-24G', region: 'pl-waw-2', ...o })).rejects.toBeInstanceOf(NotSupportedError);
        }
        expect(fake.calls).toHaveLength(0);
        const bare = make({}, { projectId: undefined });
        await expect(bare.p.createServer({ name: 'x', offer: 'L4-1-24G', region: 'pl-waw-2' })).rejects.toMatchObject({ code: 'project_required', message: expect.stringMatching(/SCW_DEFAULT_PROJECT_ID/) });
        expect(creates(bare.fake)).toHaveLength(0);
    });

    it('needs a zone (the offer\'s first with stock, or the one given), one that exists, and one of its own zones', async () => {
        const { p, fake } = make({}, { zones: 'fr-par-2,pl-waw-2' });
        await expect(p.createServer({ name: 'x', offer: 'L4-1-24G' })).rejects.toThrow(/needs a zone/);
        await expect(p.createServer({ name: 'x', offer: 'L4-1-24G', region: 'fr-par-7' })).rejects.toThrow(/unknown Scaleway zone "fr-par-7"/);
        // A server in a zone this provider does not list would not be listed, deleted by a teardown, or found by a sweep.
        await expect(p.createServer({ name: 'x', offer: 'DEV1-S', region: 'nl-ams-1' })).rejects.toThrow(/not one of this provider's zones \(fr-par-2, pl-waw-2\)/);
        expect(creates(fake)).toHaveLength(0);
        const [offer] = await p.listOffers({ kind: 'gpu' });
        expect((await p.createServer({ name: 'ok', offer })).region).toBe('pl-waw-2');
        expect((await p.createServer({ name: 'ok2', offer, region: 'fr-par-2' }).catch((e) => e))).toBeInstanceOf(CapacityError);
    });

    it('checks the GPU count against the type, which it reads when it is given an id', async () => {
        const { p, fake } = make();
        const [offer] = await p.listOffers({ kind: 'gpu' });
        await expect(p.createServer({ name: 'x', offer, gpuCount: 2 })).rejects.toBeInstanceOf(NotSupportedError);
        await expect(p.createServer({ name: 'x', offer: 'L4-2-24G', region: 'pl-waw-2', gpuCount: 1 })).rejects.toThrow(/this offer has 2 GPU/);
        expect(creates(fake)).toHaveLength(0);
        const two = await p.createServer({ name: 'two', offer: 'L4-2-24G', region: 'pl-waw-2', gpuCount: 2 });
        expect((await p.waitUntilRunning(two.id, fast)).gpuCount).toBe(2);
    });

    it('authorizes the Project\'s keys: `sshKeyIds` must be among them (by id or name), and one that is not is refused before anything is created', async () => {
        const { p, fake } = make();
        const [laptop] = await p.listSSHKeys();
        await p.createServer({ name: 'by-id', offer: 'L4-1-24G', region: 'pl-waw-2', sshKeyIds: [laptop.id] });
        await p.createServer({ name: 'by-name', offer: 'L4-1-24G', region: 'pl-waw-2', sshKeyIds: ['laptop'] });
        expect(creates(fake)).toHaveLength(2);
        // Scaleway has no per-server selection: the body names no key.
        expect(creates(fake).every((c) => !('ssh_keys' in c.body) && !('sshKeyIds' in c.body))).toBe(true);
        const theirs = [...fake.state.keys.values()].find((k) => k.name === 'theirs');
        for (const ref of ['nobody', theirs.id, 'theirs']) {
            await expect(p.createServer({ name: 'x', offer: 'L4-1-24G', region: 'pl-waw-2', sshKeyIds: [ref] })).rejects.toBeInstanceOf(NotFoundError);
        }
        expect(creates(fake)).toHaveLength(2);
    });
});

describe('Scaleway without stock, quota, or room', () => {
    it('no stock at the power-on is a CapacityError, and the server and its volume it made are deleted again', async () => {
        const { p, fake } = make();
        const before = { servers: fake.liveServers(), volumes: fake.liveVolumes() };
        await expect(p.createServer({ name: 'none', offer: 'H100-1-80G', region: 'fr-par-2' })).rejects.toBeInstanceOf(CapacityError);
        expect({ servers: fake.liveServers(), volumes: fake.liveVolumes() }).toEqual(before);
        // It never ran, so it is deleted as a stopped server is (no `terminate`: Scaleway refuses it), and its volume with it.
        expect(actions(fake)).toEqual(['poweron']);
        expect(fake.calls.some((c) => c.method === 'DELETE' && /\/instance\/v1\/zones\/fr-par-2\/servers\/[0-9a-f-]{36}$/.test(c.path))).toBe(true);
        expect(fake.calls.some((c) => c.method === 'DELETE' && c.path.startsWith('/block/v1/'))).toBe(true);
    });

    it('no stock at the create is a CapacityError too, and nothing past the create is sent', async () => {
        const { p, fake } = make({ shortageAt: 'create' });
        const before = { servers: fake.liveServers(), volumes: fake.liveVolumes() };
        await expect(p.createServer({ name: 'none', offer: 'H100-1-80G', region: 'fr-par-2' })).rejects.toMatchObject({ name: 'CapacityError', code: 'out_of_stock' });
        expect(fake.calls.filter((c) => c.method !== 'GET').map((c) => c.method)).toEqual(['POST']);
        expect({ servers: fake.liveServers(), volumes: fake.liveVolumes() }).toEqual(before);
    });

    it('`scarce` stock still rents; a type the zone does not offer is a place with no stock for it', async () => {
        const { p } = make();
        const scarce = await p.createServer({ name: 'scarce', offer: 'L40S-1-48G', region: 'fr-par-2' });
        expect(scarce).toMatchObject({ gpu: 'L40S', region: 'fr-par-2' });
        await expect(p.createServer({ name: 'x', offer: 'L40S-1-48G', region: 'fr-par-1' })).rejects.toThrow(/L40S-1-48G is not offered in fr-par-1/);
        await expect(p.createServer({ name: 'x', offer: 'L40S-1-48G', region: 'fr-par-1' })).rejects.toBeInstanceOf(CapacityError);
    });

    it('an account limit is a QuotaError, in either wording, and makes nothing', async () => {
        for (const legacyQuota of [false, true]) {
            const { p, fake } = make({ gpuQuota: 1, legacyQuota });
            await p.createServer({ name: 'first', offer: 'L4-1-24G', region: 'pl-waw-2' });
            const before = fake.liveServers();
            await expect(p.createServer({ name: 'second', offer: 'L4-1-24G', region: 'pl-waw-2' })).rejects.toBeInstanceOf(QuotaError);
            expect(fake.liveServers()).toBe(before);
        }
    });
});

describe('Scaleway servers', () => {
    it('a volume its delete could not delete is no verified delete: deleteServerAndWait names it, and it is still there', async () => {
        const { fake, p } = make();
        const s = await running(p);
        const root = (await p.getServer(s.id))!.raw.volumes['0'].id;
        // A Block Storage failure that reads as transient: the server goes, its volume does not.
        fake.intercept((r) => r.method === 'DELETE' && r.path.startsWith('/block/'), { answer: () => json(500, { message: 'internal error' }) });
        const e = await p.deleteServerAndWait(s.id, fast).catch((x) => x);
        expect(e).toBeInstanceOf(ProviderError);
        expect(e).toMatchObject({ code: 'left_behind', retriable: false });
        expect(e.message).toContain(`block volume ${root}`);
        expect(await p.getServer(s.id)).toBeNull();
        expect(fake.state.volumes.has(root)).toBe(true);
    });

    it('deleteServerAndWait bounds the whole delete by its timeout: a server that will not settle is waited for no longer', async () => {
        const { p } = make({ bootReads: Number.POSITIVE_INFINITY });
        const [offer] = await p.listOffers({ kind: 'gpu' });
        const s = await p.createServer({ name: 'stuck', offer });
        const t0 = Date.now();
        await expect(p.deleteServerAndWait(s.id, { timeoutMs: 50, intervalMs: 0 })).rejects.toThrow(/not deleted after/);
        expect(Date.now() - t0).toBeLessThan(3000);
    });

    it('are named by zone and id; a bare id is asked of every zone, and an id that is nothing\'s is not asked at all', async () => {
        const { p, fake } = make();
        const s = await running(p);
        const bare = s.id.split('/')[1];
        expect((await p.getServer(s.id))?.id).toBe(s.id);
        expect((await p.getServer(bare))?.id).toBe(s.id);
        const before = fake.calls.length;
        expect(await p.getServer('x/y')).toBeNull();
        expect(await p.getServer('00000000-0000-4000-8000-0000000000aa')).toBeNull();
        expect(fake.calls.length).toBe(before + 10);
    });

    it('reads Scaleway\'s states as the shared ones, and keeps its own word', async () => {
        const { p, fake } = make();
        const s = await running(p);
        const expected: Array<[string, string]> = [
            ['running', 'running'], ['starting', 'pending'], ['stopping', 'stopping'], ['stopped', 'stopped'], ['stopped in place', 'stopped'], ['locked', 'error'],
            // A state Scaleway adds one day is not any of the shared ones: it stays 'unknown', in its own word.
            ['migrating', 'unknown'],
        ];
        for (const [state, status] of expected) {
            // A state the fake is not about to leave (it moves a starting or stopping server on with every request).
            Object.assign(fake.state.servers.get(s.id), { state, bootLeft: 1000, stopLeft: 1000 });
            expect(await p.getServer(s.id)).toMatchObject({ status, providerStatus: state });
        }
    });

    it('reports its SSH endpoint (root on 22) once it has a public IP, with the GPU, region and price Scaleway lists', async () => {
        const { p } = make();
        const [offer] = await p.listOffers({ kind: 'gpu' });
        const created = await p.createServer({ name: 'ssh', offer });
        expect(created.ip).toBeUndefined();
        expect(created.ssh).toBeUndefined();
        const up = await p.waitUntilRunning(created.id, fast);
        expect(up.ip).toMatch(/^51\.159\.0\.\d+$/);
        expect(up.ssh).toEqual({ host: up.ip, port: 22, username: 'root' });
        expect(up).toMatchObject({ gpu: 'L4', gpuCount: 1, region: 'pl-waw-2', createdAt: expect.any(Number) });
        expect(up.pricePerHour).toBeCloseTo(offer.pricePerHour, 6);
    });

    it('lists GPU servers by kind (the account\'s other servers are not GPU servers), in every zone; by default, every server', async () => {
        const { p, fake } = make();
        const gpu = await p.createServer({ name: 'g', offer: 'L4-1-24G', region: 'pl-waw-2' });
        const cpu = await p.createServer({ name: 'c', offer: 'DEV1-S', region: 'nl-ams-1' });
        expect((await p.listServers({ kind: 'gpu' })).map((s) => s.id)).toEqual([gpu.id]);
        expect((await p.listServers({ kind: 'cpu' })).map((s) => s.name).sort()).toEqual(['api-1', 'c', 'mail']);
        const all = await p.listServers();
        expect(all.map((s) => s.name).sort()).toEqual(['api-1', 'c', 'g', 'mail']);
        expect(all.find((s) => s.id === cpu.id)).toMatchObject({ gpu: undefined, gpuCount: undefined, offerId: 'DEV1-S' });
        // A GPU server of a type the catalog no longer lists is still listed (a sweep must see it).
        fake.state.servers.get(gpu.id).commercial_type = 'GPU-3070-S';
        expect((await p.listServers({ kind: 'gpu' })).map((s) => s.id)).toContain(gpu.id);
        expect((await p.listServers({ kind: 'cpu' })).map((s) => s.id)).toContain(gpu.id);
    });

    it('are still read when the type catalog is not: what the server says stays, its GPU and price are left out', async () => {
        const { p, fake } = make();
        const s = await running(p);
        fake.intercept((r) => /\/products\/servers$/.test(r.path), { answer: () => json(500, { message: 'catalog is down' }) });
        const blind = another(fake);
        expect(await blind.getServer(s.id)).toMatchObject({ id: s.id, status: 'running', offerId: 'L4-1-24G', gpu: undefined, gpuCount: undefined, pricePerHour: undefined });
        // Without the catalog a GPU server cannot be told from a CPU one, so every server is listed (a sweep must see them all).
        expect((await blind.listServers()).map((x) => x.name).sort()).toEqual(['api-1', 'gpu', 'mail']);
        // Offers are made of the catalog: that failure is not hidden.
        await expect(blind.listOffers()).rejects.toBeInstanceOf(ProviderError);
    });

    it('deletes: the server is gone and so is its Block Storage volume; a bare id works; deleting what is not there succeeds', async () => {
        const { p, fake } = make();
        const before = { servers: fake.liveServers(), volumes: fake.liveVolumes() };
        const a = await running(p, 'a');
        const b = await running(p, 'b');
        expect(fake.liveVolumes()).toBe(before.volumes + 2);
        await p.deleteServer(a.id);
        await p.deleteServer(b.id.split('/')[1]);
        expect({ servers: fake.liveServers(), volumes: fake.liveVolumes() }).toEqual(before);
        expect(await p.getServer(a.id)).toBeNull();
        await expect(p.deleteServer(a.id)).resolves.toBeUndefined();
        await expect(p.deleteServer('nonsense')).resolves.toBeUndefined();
        // The account's own server and its volume are untouched.
        expect(fake.state.servers.has(`nl-ams-1/${[...fake.state.servers.values()].find((s) => s.name === 'mail').id}`)).toBe(true);
    });
});

describe('Scaleway stop, start, restart', () => {
    it('stops with poweroff, which releases the GPU (stop_in_place keeps it, and bills), and waits until it is stopped', async () => {
        const { p, fake } = make();
        const s = await running(p);
        await p.stopServer(s.id);
        expect((await p.getServer(s.id))?.status).toBe('stopped');
        expect(actions(fake)).toEqual(['poweron', 'poweroff']);
        expect(p.capabilities.power).toEqual({ stoppedBilling: 'storage' });
        // Already stopped: nothing is sent.
        await p.stopServer(s.id);
        expect(actions(fake)).toEqual(['poweron', 'poweroff']);
        await expect(p.stopServer('00000000-0000-4000-8000-0000000000aa')).rejects.toBeInstanceOf(NotFoundError);
    });

    it('starts a stopped server with poweron, and leaves one that runs or starts alone', async () => {
        const { p, fake } = make();
        const s = await running(p);
        await p.stopServer(s.id);
        await p.startServer(s.id);
        expect(['pending', 'running']).toContain((await p.getServer(s.id))?.status);
        await p.startServer(s.id);
        expect(actions(fake)).toEqual(['poweron', 'poweroff', 'poweron']);
        expect((await p.waitUntilRunning(s.id, fast)).status).toBe('running');
    });

    it('starting after the GPU was released needs stock: a CapacityError, and the server stays stopped', async () => {
        const { p, fake } = make();
        const s = await running(p);
        await p.stopServer(s.id);
        fake.state.stock['pl-waw-2'] = { 'L4-1-24G': 'shortage' };
        await expect(p.startServer(s.id)).rejects.toBeInstanceOf(CapacityError);
        expect((await p.getServer(s.id))?.status).toBe('stopped');
        fake.state.stock['pl-waw-2'] = { 'L4-1-24G': 'available' };
        await p.startServer(s.id);
        expect((await p.waitUntilRunning(s.id, fast)).status).toBe('running');
    });

    it('restarts with the reboot action, which is not repeated on a transient failure', async () => {
        const { p, fake } = make();
        const s = await running(p);
        await p.restartServer(s.id);
        expect(actions(fake)).toEqual(['poweron', 'reboot']);
        expect((await p.waitUntilRunning(s.id, fast)).status).toBe('running');
        await expect(p.restartServer('00000000-0000-4000-8000-0000000000aa')).rejects.toBeInstanceOf(NotFoundError);
    });

    it('a server that locks while it stops is an error, not a stop', async () => {
        for (const detail of ['locked for abuse', '']) {
            const { p, fake } = make();
            const s = await running(p);
            // The administrative lock arrives as soon as the power-off is accepted.
            fake.intercept((r) => r.body?.action === 'poweroff', { after: () => Object.assign(fake.state.servers.get(s.id), { state: 'locked', state_detail: detail }) });
            await expect(p.stopServer(s.id)).rejects.toThrow(new RegExp(`locked \\(${detail || 'no detail'}\\): it did not stop`));
            expect((await p.getServer(s.id))?.status).toBe('error');
        }
    });

    it('a server that does not stop in ten minutes is reported as what it still is, not waited for forever', async () => {
        // A clock the waits advance: ten minutes pass at once.
        let offset = 0;
        const real = Date.now.bind(Date);
        const clock = jest.spyOn(Date, 'now').mockImplementation(() => real() + offset);
        try {
            const fake = fakeScaleway({ stopReads: 1_000_000 });
            const p = new Scaleway({ apiKey: 'scw-test', projectId: FAKE_SCALEWAY_PROJECT, fetchImpl: fake.fetchImpl, sleep: async (ms) => { offset += ms; } });
            const s = await running(p);
            await expect(p.stopServer(s.id)).rejects.toMatchObject({ code: 'timeout', message: expect.stringMatching(new RegExp(`timed out after 600 s waiting for server ${s.id} to stop: stopping`)) });
        } finally {
            clock.mockRestore();
        }
    });

    it('a server that is deleted while it stops is gone, not stopped', async () => {
        const { p, fake } = make();
        const s = await running(p);
        fake.intercept((r) => r.body?.action === 'poweroff', { after: () => fake.state.servers.delete(s.id) });
        await expect(p.stopServer(s.id)).rejects.toThrow(/disappeared while it was stopping/);
    });

    it('starts a server that is still stopping only once it has stopped', async () => {
        const { p, fake } = make({ stopReads: 6 });
        const s = await running(p);
        const [zone, id] = s.id.split('/');
        await p.api.serverAction(zone as ScalewayZone, id, { action: 'poweroff' });
        const before = fake.calls.length;
        await p.startServer(s.id);
        expect(actions(fake)).toEqual(['poweron', 'poweroff', 'poweron']);
        // It read the server until it stopped, and only then powered it on.
        expect(fake.calls.slice(before).filter((c) => c.method === 'GET').length).toBeGreaterThan(2);
        expect((await p.waitUntilRunning(s.id, fast)).status).toBe('running');
    });
});

describe('Scaleway images', () => {
    const stopped = async (o: FakeScalewayOptions = {}, params: Partial<ScalewayParams> = {}) => {
        const m = make(o, params);
        const s = await running(m.p);
        await m.p.stopServer(s.id);
        return { ...m, s };
    };

    it('captures a server with the backup action, waits for the image, and reports it in the server\'s zone only', async () => {
        const { p, fake, s } = await stopped();
        const image = await p.createImage(s.id, { name: 'worker-r1', ...fast });
        expect(image).toMatchObject({ provider: 'scaleway', name: 'worker-r1', status: 'available', providerStatus: 'available', regions: ['pl-waw-2'] });
        expect(image.id).toMatch(/^pl-waw-2\/[0-9a-f-]{36}$/);
        expect(image.sizeGb).toBeCloseTo(10, 6);
        expect(fake.calls.find((c) => c.body?.action === 'backup')?.body).toEqual({ action: 'backup', name: 'worker-r1' });
        expect(await p.getImage(image.id)).toMatchObject({ id: image.id, name: 'worker-r1', status: 'available' });
        expect(await p.getImage(image.id.split('/')[1])).toMatchObject({ id: image.id });
        expect(p.capabilities.images.scope).toBe('region');
    });

    it('waits on its own schedule unless it is given one', async () => {
        const { p, s } = await stopped();
        expect(await p.createImage(s.id, { name: 'defaults' })).toMatchObject({ name: 'defaults', status: 'available' });
    });

    it('finds the image by name when the backup does not say which it makes: the newest, an image with no date being the oldest', async () => {
        const { p, fake, s } = await stopped({ noTaskHref: true });
        const first = await p.createImage(s.id, { name: 'by-name', ...fast });
        expect(first).toMatchObject({ name: 'by-name', status: 'available' });
        // `creation_date` may be null.
        fake.state.images.get(first.id.split('/')[1]).creation_date = null;
        const second = await p.createImage(s.id, { name: 'by-name', ...fast });
        const third = await p.createImage(s.id, { name: 'by-name', ...fast });
        expect(new Set([first.id, second.id, third.id]).size).toBe(3);
        expect(fake.state.images.get(second.id.split('/')[1]).creation_date <= fake.state.images.get(third.id.split('/')[1]).creation_date).toBe(true);
    });

    it('an image it cannot find is an error (the backup did not say which, and none is named so)', async () => {
        const { p, fake, s } = await stopped({ noTaskHref: true });
        fake.intercept(isBackup, { after: () => fake.state.images.clear() });
        await expect(p.createImage(s.id, { name: 'lost', ...fast })).rejects.toThrow(/did not say which image it makes/);
    });

    it('an image that disappears while it is made, or ends in an error, is an error', async () => {
        const gone = await stopped();
        gone.fake.intercept(isBackup, { after: () => gone.fake.state.images.clear() });
        await expect(gone.p.createImage(gone.s.id, { name: 'gone', ...fast })).rejects.toBeInstanceOf(NotFoundError);
        const failed = await stopped({ imageFails: true });
        await expect(failed.p.createImage(failed.s.id, { name: 'failed', ...fast })).rejects.toThrow(/of server .* ended in an error/);
        // Nothing is left billing: the image that failed is deleted, its snapshots with it.
        expect([...failed.fake.state.images.values()].filter((i) => i.name === 'failed')).toEqual([]);
    });

    it('an image still being made when the wait is over is deleted; one Scaleway will not delete is named, left_behind', async () => {
        const { p, fake, s } = await stopped();
        fake.intercept(isBackup, { after: () => { for (const i of fake.state.images.values()) if (i.state === 'creating') i.left = 1e9; }, times: 1 });
        await expect(p.createImage(s.id, { name: 'slow', intervalMs: 0, timeoutMs: 20 })).rejects.toThrow(/timed out after 0 s waiting for image pl-waw-2\/[0-9a-f-]{36}: creating/);
        expect([...fake.state.images.values()].filter((i) => i.name === 'slow')).toEqual([]);
        fake.intercept(isBackup, { after: () => { for (const i of fake.state.images.values()) if (i.state === 'creating') i.left = 1e9; }, times: 1 });
        fake.intercept((r) => r.method === 'DELETE' && /\/images\/[0-9a-f-]{36}$/.test(r.path), { answer: () => json(403, { type: 'permissions_denied', message: 'insufficient permissions' }), times: 1 });
        const kept = p.createImage(s.id, { name: 'kept', intervalMs: 0, timeoutMs: 20 });
        await expect(kept).rejects.toThrow(/waiting for image pl-waw-2\/([0-9a-f-]{36}): creating; and image pl-waw-2\/\1, made for it, is not deleted \(.*insufficient permissions.*\): it stays, and bills, until deleted/);
        await expect(kept).rejects.toMatchObject({ code: 'left_behind' });
    });

    it('keeps a state it does not know as its own word', async () => {
        const { p, fake, s } = await stopped();
        const image = await p.createImage(s.id, { name: 'odd', ...fast });
        fake.state.images.get(image.id.split('/')[1]).state = 'archived';
        expect(await p.getImage(image.id)).toMatchObject({ status: 'unknown', providerStatus: 'archived' });
    });

    it('reports an image with no volume as it is: no size', async () => {
        const { p, fake, s } = await stopped();
        const image = await p.createImage(s.id, { name: 'empty', ...fast });
        Object.assign(fake.state.images.get(image.id.split('/')[1]), { root_volume: null, extra_volumes: {} });
        expect((await p.getImage(image.id))?.sizeGb).toBeUndefined();
        expect(await p.getImage('00000000-0000-4000-8000-0000000000aa')).toBeNull();
    });

    it('an image that never gets ready times out instead of waiting forever', async () => {
        const { p, s } = await stopped({ imageReads: 1_000_000 });
        await expect(p.createImage(s.id, { name: 'slow', intervalMs: 0, timeoutMs: 30 })).rejects.toThrow(/timed out/);
    });

    it('lists the account\'s own images in every zone (the ones that are not yours too: pick by name), never a public one', async () => {
        const { p, fake, s } = await stopped();
        const image = await p.createImage(s.id, { name: 'mine', ...fast });
        const all = await p.listImages();
        expect(all.map((i) => i.id).sort()).toEqual([`fr-par-1/${fake.backupImageId}`, image.id].sort());
        expect(all.find((i) => i.id.endsWith(fake.backupImageId))).toMatchObject({ name: 'api-1 backup 2026-09-01', status: 'available', regions: ['fr-par-1'] });
        expect(fake.calls.filter((c) => c.method === 'GET' && /\/images\?/.test(c.path)).every((c) => c.path.includes('public=false'))).toBe(true);
    });

    it('boots a new server from the image, in its zone: the zone follows the image, and another zone is refused', async () => {
        const { p, fake, s } = await stopped();
        const image = await p.createImage(s.id, { name: 'boot', ...fast });
        await p.deleteServer(s.id);
        const before = creates(fake).length;
        const from = await p.createServer({ name: 'from-image', offer: 'L4-1-24G', image: image.id });
        expect(from.region).toBe('pl-waw-2');
        // The API is given the image's id, not the zonal one.
        expect(creates(fake)[before].body.image).toBe(image.id.split('/')[1]);
        await expect(p.createServer({ name: 'elsewhere', offer: 'L40S-1-48G', region: 'fr-par-2', image: image.id })).rejects.toThrow(/is in pl-waw-2, not fr-par-2: a Scaleway image boots in its own zone only/);
        expect(creates(fake)).toHaveLength(before + 1);
        // A bare image id with a zone given passes through.
        await p.createServer({ name: 'bare', offer: 'L4-1-24G', region: 'pl-waw-2', image: image.id.split('/')[1] });
        expect(creates(fake)[before + 1].body.image).toBe(image.id.split('/')[1]);
    });

    it('deleting an image deletes its snapshots too, idempotently; a snapshot another image still uses stays', async () => {
        const { p, fake, s } = await stopped();
        const a = await p.createImage(s.id, { name: 'a', ...fast });
        const b = await p.createImage(s.id, { name: 'b', ...fast });
        const snapshots = fake.liveSnapshots();
        // b shares a's root snapshot.
        const aRoot = fake.state.images.get(a.id.split('/')[1]).root_volume.id;
        fake.state.images.get(b.id.split('/')[1]).root_volume = { ...fake.state.images.get(b.id.split('/')[1]).root_volume, id: aRoot };
        await p.deleteImage(a.id);
        expect(await p.getImage(a.id)).toBeNull();
        // a's snapshot is still b's; b's old one was never b's root any more, and nothing else is touched.
        expect(fake.state.snapshots.has(aRoot)).toBe(true);
        await p.deleteImage(b.id);
        expect(fake.liveSnapshots()).toBeLessThan(snapshots);
        expect(fake.state.snapshots.has(aRoot)).toBe(false);
        await expect(p.deleteImage(a.id)).resolves.toBeUndefined();
        await expect(p.deleteImage('nonsense')).resolves.toBeUndefined();
    });

    it('deletes the snapshots of a local-disk server\'s image through the Instance API (Block Storage has none of those), and names one it cannot delete', async () => {
        const { p, fake } = make();
        const dev = (await p.listOffers({ kind: 'cpu' })).find((o) => o.id === 'DEV1-S')!;
        const cpu = await p.createServer({ name: 'cpu', offer: withoutBlockStorage(dev), region: 'nl-ams-1', diskGb: 10 });
        await p.waitUntilRunning(cpu.id, fast);
        await p.stopServer(cpu.id);
        const first = await p.createImage(cpu.id, { name: 'local-1', ...fast });
        await p.deleteImage(first.id);
        expect(fake.liveSnapshots()).toBe(0);
        expect(fake.calls.filter((c) => c.method === 'DELETE' && /\/snapshots\//.test(c.path)).map((c) => c.path.split('/')[1])).toEqual(['instance']);
        // A snapshot Scaleway fails to delete is not lost silently: the image is gone, and the error says which snapshot bills on.
        const second = await p.createImage(cpu.id, { name: 'local-2', ...fast });
        fake.intercept((r) => r.method === 'DELETE' && /\/snapshots\//.test(r.path), { answer: () => json(500, { message: 'try later' }) });
        const [snapshot] = [...fake.state.snapshots.keys()];
        await expect(p.deleteImage(second.id)).rejects.toThrow(new RegExp(`is deleted, but its snapshot\\(s\\) ${snapshot} are not: they bill until deleted`));
        expect(await p.getImage(second.id)).toBeNull();
        expect(fake.liveSnapshots()).toBe(1);
    });

    it('copies an image to other zones through Object Storage, in its region and in another; the copy boots for the source\'s id, and goes with it', async () => {
        const { fake, p, s } = await stopped({}, { accessKey: 'SCWFAKEACCESSKEY0000' });
        const image = await p.createImage(s.id, { name: 'copy', ...fast });
        expect(image.regions).toEqual(['pl-waw-2']);
        expect(supports(p, 'imageCopy')).toBe(true);
        const copied = await p.copyImage(image.id, ['pl-waw-3', 'fr-par-2', 'pl-waw-2'], fast);
        expect(copied).toMatchObject({ id: image.id, regions: ['pl-waw-2', 'pl-waw-3', 'fr-par-2'] });
        // One export in its region; one move to the other region's bucket; an import and an image in each zone; every bucket deleted.
        expect(fake.calls.filter((c) => /export/.test(c.path)).length).toBe(1);
        expect(Object.values(fake.state.s3).every((x) => x.buckets.size === 0)).toBe(true);
        const copies = [...fake.state.images.values()].filter((i) => (i.tags ?? []).includes(`asap-vps-copy-of:${image.id.split('/')[1]}`));
        expect(copies.map((c) => [c.zone, c.name]).sort()).toEqual([['fr-par-2', 'copy'], ['pl-waw-3', 'copy']]);
        expect((await p.getImage(image.id))?.regions.sort()).toEqual(['fr-par-2', 'pl-waw-2', 'pl-waw-3']);
        // Again: nothing more to copy.
        expect((await p.copyImage(image.id, ['fr-par-2'], fast)).regions.sort()).toEqual(['fr-par-2', 'pl-waw-2', 'pl-waw-3']);
        expect(fake.calls.filter((c) => /export/.test(c.path)).length).toBe(1);
        // Booted by the source's id in a copy's zone: the copy.
        await p.createServer({ name: 'from-copy', offer: 'DEV1-S', region: 'fr-par-2', image: image.id });
        const body = fake.calls.filter((c) => c.method === 'POST' && /\/servers$/.test(c.path)).pop();
        expect(body?.path).toContain('/zones/fr-par-2/');
        expect(body?.body.image).toBe(copies.find((c) => c.zone === 'fr-par-2').id);
        // Deleted with the source.
        await p.deleteServerAndWait((await p.listServers()).find((x) => x.name === 'from-copy')!.id, fast);
        await p.deleteImage(image.id);
        expect([...fake.state.images.values()].filter((i) => i.name === 'copy')).toEqual([]);
    });

    it('copies the root of an image on local storage (an Instance snapshot) too; refuses one with more volumes, one not available, and one not there', async () => {
        const { fake, p } = make({}, { accessKey: 'SCWFAKEACCESSKEY0000' });
        const local = await p.createServer({ name: 'local-1', offer: 'DEV1-S', region: 'pl-waw-2', providerOptions: { volumes: { 0: { volume_type: 'l_ssd', size: 20e9 } } } });
        await p.waitUntilRunning(local.id, fast);
        await p.stopServer(local.id);
        const image = await p.createImage(local.id, { name: 'local', ...fast });
        expect(image.raw.root_volume?.volume_type).toBe('unified');
        expect((await p.copyImage(image.id, ['pl-waw-3'], fast)).regions.sort()).toEqual(['pl-waw-2', 'pl-waw-3']);
        expect(fake.calls.some((c) => /\/instance\/v1\/zones\/pl-waw-2\/snapshots\/[0-9a-f-]{36}\/export$/.test(c.path))).toBe(true);
        // Its snapshot gone while it is exported: thrown, the bucket deleted.
        const root = image.raw.root_volume!.id;
        expect((await p.api.listInstanceSnapshots('pl-waw-2')).map((x) => [x.id, x.volume_type, x.state])).toEqual([[root, 'unified', 'available']]);
        fake.intercept((r) => r.method === 'POST' && r.path.endsWith(`/snapshots/${root}/export`), { after: () => void fake.state.snapshots.delete(root), times: 1 });
        await expect(p.copyImage(image.id, ['fr-par-2'], fast)).rejects.toThrow(`the export of snapshot pl-waw-2/${root} is gone`);
        expect(Object.values(fake.state.s3).every((x) => x.buckets.size === 0)).toBe(true);
        const raw = fake.state.images.get(image.id.split('/')[1]);
        raw.extra_volumes = { 1: { id: 'x', name: 'data', size: 1, volume_type: 'unified' } };
        await expect(p.copyImage(image.id, ['fr-par-2'], fast)).rejects.toThrow(/more than its root volume/);
        raw.extra_volumes = {};
        Object.assign(raw, { state: 'creating', left: 1e6 });
        await expect(p.copyImage(image.id, ['fr-par-2'], fast)).rejects.toThrow(/is creating: it is copied once available/);
        raw.state = 'available';
        raw.root_volume = null;
        await expect(p.copyImage(image.id, ['fr-par-2'], fast)).rejects.toThrow(/has no root volume/);
        await expect(p.copyImage('pl-waw-2/00000000-0000-4000-8000-0000000000ee', ['fr-par-2'], fast)).rejects.toBeInstanceOf(NotFoundError);
        await expect(make().p.copyImage(image.id, ['fr-par-2'], fast)).rejects.toBeInstanceOf(NotFoundError);
    });

    it('an export that ends in an error, or never ends, is thrown saying so, and its bucket deleted; with no wait given, a copy waits with its own defaults', async () => {
        const { fake, p, s } = await stopped({}, { accessKey: 'SCWFAKEACCESSKEY0000' });
        const image = await p.createImage(s.id, { name: 'copy', ...fast });
        const snap = () => fake.state.snapshots.get(image.raw.root_volume!.id);
        const exported = (then: () => void) => fake.intercept((r) => r.method === 'POST' && r.path.endsWith('/export-to-object-storage'), { after: then, times: 1 });
        exported(() => Object.assign(snap(), { status: 'error', exportTo: undefined }));
        await expect(p.copyImage(image.id, ['pl-waw-3'], fast)).rejects.toThrow(/the export of snapshot pl-waw-2\/[0-9a-f-]{36} is error/);
        exported(() => { snap().exportTo.left = 1e9; });
        await expect(p.copyImage(image.id, ['pl-waw-3'], { intervalMs: 0, timeoutMs: 20 }))
            .rejects.toThrow(/timed out after 0 s waiting for export of snapshot pl-waw-2\/[0-9a-f-]{36}: exporting/);
        expect(Object.values(fake.state.s3).every((x) => x.buckets.size === 0)).toBe(true);
        Object.assign(snap(), { status: 'available', exportTo: undefined });
        expect((await p.copyImage(image.id, ['pl-waw-3'])).regions).toEqual(['pl-waw-2', 'pl-waw-3']);
        expect((await p.copyImage(image.id, ['pl-waw-3'])).regions).toEqual(['pl-waw-2', 'pl-waw-3']);
    });

    it('a copy to another region moves the export by its ranges into that region\'s bucket (no file staged here); an export gone before it moves is thrown, its buckets deleted', async () => {
        const { fake, p, s: server } = await stopped({}, { accessKey: 'SCWFAKEACCESSKEY0000' });
        const image = await p.createImage(server.id, { name: 'copy', ...fast });
        await p.copyImage(image.id, ['fr-par-2'], fast);
        const read = fake.state.s3['pl-waw'].calls.filter((c) => c.method === 'GET' && /\.qcow2$/.test(c.path));
        expect(read.length).toBeGreaterThan(0);
        expect(read.every((c) => /^bytes=\d+-\d+$/.test(c.range ?? ''))).toBe(true);
        // Each part read whole first, then sent signed with its hash.
        expect(fake.state.s3['fr-par'].calls.some((c) => c.method === 'PUT' && /\.qcow2$/.test(c.path) && /^[0-9a-f]{64}$/.test(c.payloadHash))).toBe(true);
        // The export is there for the wait, and gone by the time it is to move.
        const fake2 = fakeScaleway();
        const seen = new Set<string>();
        const q = new Scaleway({
            apiKey: 'scw-test', projectId: FAKE_SCALEWAY_PROJECT, accessKey: 'SCWFAKEACCESSKEY0000', sleep: noSleep,
            fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
                const u = new URL(String(url));
                const r = await fake2.fetchImpl(url, init);
                if (u.host === 's3.pl-waw.scw.cloud' && init?.method === 'HEAD' && /\.qcow2$/.test(u.pathname) && r.status === 200 && !seen.has(u.pathname)) {
                    seen.add(u.pathname);
                    const [, bucket, key] = u.pathname.split('/');
                    fake2.state.s3['pl-waw'].buckets.get(bucket)!.delete(key);
                }
                return r;
            }) as typeof fetch,
        });
        const s2 = await running(q);
        await q.stopServer(s2.id);
        const other = await q.createImage(s2.id, { name: 'gone', ...fast });
        await expect(q.copyImage(other.id, ['fr-par-2'], fast)).rejects.toThrow(/the export asap-vps-tmp-[0-9a-f]+\/[0-9a-f-]+\.qcow2 went before it was copied to fr-par/);
        expect(Object.values(fake2.state.s3).every((x) => x.buckets.size === 0)).toBe(true);
    });

    it('an image prepared on a CPU machine boots on a GPU in the same zone', async () => {
        const { p } = make();
        const prep = await p.createServer({ name: 'prep', offer: 'DEV1-S', region: 'pl-waw-2' });
        await p.waitUntilRunning(prep.id, fast);
        await p.stopServer(prep.id);
        const image = await p.createImage(prep.id, { name: 'gpu-ready', ...fast });
        await p.deleteServer(prep.id);
        await expect(p.createServer({ name: 'gpu-1', offer: 'L4-1-24G', image: image.id })).resolves.toMatchObject({ name: 'gpu-1', region: 'pl-waw-2' });
    });
});

describe('Scaleway SSH keys', () => {
    it('are the Project\'s: another Project\'s key is not listed; each is reported with its SHA256 fingerprint, not Scaleway\'s own', async () => {
        const { p } = make();
        const keys = await p.listSSHKeys();
        expect(keys.map((k) => k.name)).toEqual(['laptop']);
        expect(keys[0].fingerprint).toMatch(/^SHA256:/);
        expect(keys[0].id).toMatch(UUID);
    });

    it('adds a key to the Project once, and returns that registration for the same key again, whatever it is named', async () => {
        const { p, fake } = make();
        const pub = testPublicKey('ci');
        const key = await p.addSSHKey(pub, 'ci');
        expect(key).toMatchObject({ name: 'ci', publicKey: pub, fingerprint: sshKeyFingerprint(pub) });
        expect(fake.calls.find((c) => c.method === 'POST' && c.path === '/iam/v1alpha1/ssh-keys')?.body).toEqual({ name: 'ci', public_key: pub, project_id: FAKE_SCALEWAY_PROJECT });
        expect((await p.addSSHKey(pub, 'ci-again')).id).toBe(key.id);
        expect(fake.calls.filter((c) => c.method === 'POST' && c.path === '/iam/v1alpha1/ssh-keys')).toHaveLength(1);
        expect((await p.listSSHKeys()).filter((k) => k.fingerprint === key.fingerprint)).toHaveLength(1);
    });

    it('Scaleway accepts the same key twice (checked live), so addSSHKey looks before it adds, and a copy made behind its back is a second registration', async () => {
        const { p } = make();
        const pub = testPublicKey('race');
        const key = await p.addSSHKey(pub, 'race');
        expect((await p.addSSHKey(pub, 'race-again')).id).toBe(key.id);
        const copy = await p.api.registerSSHKey(pub, 'race-2');
        expect(copy.id).not.toBe(key.id);
        // The first found one is what addSSHKey returns from then on; deleting it leaves the copy, which still authorizes the key.
        expect((await p.listSSHKeys()).filter((k) => k.fingerprint === key.fingerprint)).toHaveLength(2);
        expect(await p.deleteSSHKey(key.id)).toBe(true);
        expect((await p.addSSHKey(pub, 'race-3')).id).toBe(copy.id);
    });

    it('are read by a server at every boot, so a key deleted from the Project is refused at the next reboot or power-on (checked live)', async () => {
        const { p, fake } = make();
        const pub = testPublicKey('boot');
        const key = await p.addSSHKey(pub, 'boot');
        const s = await p.waitUntilRunning((await p.createServer({ name: 'keyed', offer: 'L4-1-24G', region: 'pl-waw-2', sshKeyIds: [key.id] })).id, fast);
        expect(fake.authorized!(s.ip!, pub)).toBe(true);
        // Deleting the key changes nothing until the server boots again.
        await p.deleteSSHKey(key.id);
        expect(fake.authorized!(s.ip!, pub)).toBe(true);
        await p.restartServer(s.id);
        await p.waitUntilRunning(s.id, fast);
        expect(fake.authorized!(s.ip!, pub)).toBe(false);
        // The same key added back is read at the next boot (a reboot keeps the IP, a power-on after a stop does not).
        await p.addSSHKey(pub, 'boot-again');
        await p.stopServer(s.id);
        await p.startServer(s.id);
        const again = await p.waitUntilRunning(s.id, fast);
        expect(fake.authorized!(again.ip!, pub)).toBe(true);
        // A server that is not running accepts no one.
        await p.stopServer(s.id);
        expect(fake.authorized!(again.ip!, pub)).toBe(false);
    });

    it('deletes by id: true once, false when it is gone or cannot be an id; a disabled key is not listed', async () => {
        const { p, fake } = make();
        const key = await p.addSSHKey(testPublicKey(), 'temp');
        expect(await p.deleteSSHKey(key.id)).toBe(true);
        expect(await p.deleteSSHKey(key.id)).toBe(false);
        const before = fake.calls.length;
        expect(await p.deleteSSHKey('not-a-uuid')).toBe(false);
        expect(fake.calls.length).toBe(before);
        const [laptop] = await p.listSSHKeys();
        fake.state.keys.get(String(laptop.id)).disabled = true;
        expect(await p.listSSHKeys()).toEqual([]);
    });

    it('need the Project, and say how to give it', async () => {
        const { p, fake } = make({}, { projectId: undefined });
        await expect(p.listSSHKeys()).rejects.toMatchObject({ code: 'project_required' });
        await expect(p.addSSHKey(testPublicKey(), 'x')).rejects.toBeInstanceOf(ProviderError);
        expect(fake.calls).toHaveLength(0);
    });
});

describe('Scaleway configuration', () => {
  it('is Scaleway, a VM provider with every capability but logs and image copies, and takes a bare key', () => {
    const p = new Scaleway('secret');
    expect(p.id).toBe('scaleway');
    expect(p.capabilities).toEqual({
        compute: { kind: 'vm', gpu: true, cpu: true, userData: true, liveAvailability: true },
        power: { stoppedBilling: 'storage' },
        restart: {},
        sshKeys: { appliedAtBoot: true },
        images: { scope: 'region' },
        volumes: { block: { mount: 'device', size: 'fixed', minGb: 1 }, shared: { mount: 'path', size: 'fixed', minGb: 25, maxGb: 50000 } },
        imageCopy: {},
        imageImport: { formats: ['qcow2'], compressions: [], maxGb: 1000 },
        volumeAttach: {},
        serverless: { gpu: false, cpu: true, registryAuth: false },
    });
    expect(Scaleway.capabilities).toBe(p.capabilities);
    expect(p.apiKey).toBe('secret');
    expect(() => new Scaleway('')).toThrow(/API key is required/);
  });
});

describe('Scaleway volumes (Block Storage)', () => {
    const UNKNOWN = '00000000-0000-4000-8000-00000000beef';
    /** A volume in Warsaw 2, where the cheapest GPU (the L4) is in stock. */
    const volume = (p: Scaleway, name = 'models', zone = 'pl-waw-2') => p.createVolume({ name, region: zone, sizeGb: 20 });
    const blockVolume = (fake: Fake, zonedId: string) => fake.state.volumes.get(zonedId.split('/')[1]);

    it('is made empty, 5000 IOPS, by whole GB, waited for until available; read by zoned id or bare id; listed in every zone', async () => {
        const { fake, p } = make();
        const v = await p.createVolume({ name: 'models', region: 'pl-waw-2', sizeGb: 19.5 });
        expect(fake.calls.filter((c) => c.method === 'POST' && /\/block\/v1\/zones\/pl-waw-2\/volumes$/.test(c.path)).map((c) => c.body))
            .toEqual([{ name: 'models', perf_iops: 5000, project_id: FAKE_SCALEWAY_PROJECT, from_empty: { size: 20e9 } }]);
        expect(v).toMatchObject({ provider: 'scaleway', name: 'models', region: 'pl-waw-2', sizeGb: 20, status: 'available', providerStatus: 'available', serverIds: [] });
        expect(v.id).toMatch(/^pl-waw-2\//);
        expect(v.createdAt).toBeGreaterThan(0);
        expect((await p.getVolume(v.id))?.id).toBe(v.id);
        expect((await p.getVolume(v.id.split('/')[1]))?.id).toBe(v.id);
        expect(await p.getVolume(UNKNOWN)).toBeNull();
        expect(await p.getVolume('not-a-volume')).toBeNull();
        const listed = await p.listVolumes();
        expect(listed.map((x) => x.id)).toContain(v.id);
        // The Project's only: the volumes of the account's own servers are listed too, another Project's are not.
        expect(fake.calls.filter((c) => c.method === 'GET' && /\/block\/v1\/zones\/[a-z0-9-]+\/volumes\?/.test(c.path)).every((c) => c.path.includes(`project_id=${FAKE_SCALEWAY_PROJECT}`))).toBe(true);
    });

    it('a volume made needs a zone of this provider, a size from 1 GB, and the Project; one that vanishes or fails while it is made says so', async () => {
        const { fake, p } = make();
        await expect(p.createVolume({ name: 'v', region: 'mars-1', sizeGb: 20 })).rejects.toThrow(/unknown Scaleway zone/);
        await expect(p.createVolume({ name: 'v', region: 'pl-waw-2', sizeGb: 0.5 })).rejects.toThrow(/at least 1 GB/);
        await expect(make({}, { projectId: undefined }).p.createVolume({ name: 'v', region: 'pl-waw-2', sizeGb: 20 })).rejects.toMatchObject({ code: 'project_required' });
        fake.intercept((r) => r.method === 'GET' && /\/block\/v1\/zones\/pl-waw-2\/volumes\/[^/]+$/.test(r.path), { times: 1, answer: (r) => json(404, { type: 'not_found', message: `volume ${r.path} is not found` }) });
        await expect(volume(p)).rejects.toThrow(/disappeared while it was made/);
        fake.intercept((r) => r.method === 'GET' && /\/block\/v1\/zones\/pl-waw-2\/volumes\/[^/]+$/.test(r.path), { times: 1, answer: (r) => json(200, { ...blockVolume(fake, `x/${r.path.split('/').pop()}`), status: 'error' }) });
        await expect(volume(p)).rejects.toThrow(/is error, not available/);
        // The two that failed are gone: none of them is left billing.
        expect([...fake.state.volumes.values()].filter((v) => v.name === 'v')).toEqual([]);
        // One still being made when the wait is over (and for as long again): the wait says what it saw, and that the volume is left.
        fake.intercept((r) => r.method === 'GET' && /\/block\/v1\/zones\/pl-waw-2\/volumes\/[^/]+$/.test(r.path), { answer: (r) => json(200, { ...blockVolume(fake, `x/${r.path.split('/').pop()}`), status: 'creating' }) });
        const slow = p.createVolume({ name: 'slow', region: 'pl-waw-2', sizeGb: 20, timeoutMs: 0, intervalMs: 0 });
        await expect(slow).rejects.toThrow(/waiting for volume pl-waw-2\/.*: creating; and volume pl-waw-2\/[0-9a-f-]+, made for it, is not deleted \(.*\): it stays, and bills, until deleted/);
        await expect(slow).rejects.toMatchObject({ code: 'left_behind' });
    });

    it('is attached at create after the image\'s own volumes, named in a tag; it outlives the server, which still deletes its own', async () => {
        const { fake, p } = make();
        const [offer] = await p.listOffers({ kind: 'gpu' });
        const v = await volume(p);
        const s = await p.createServer({ name: 'gpu', offer, mounts: [{ volume: v }] });
        const body = creates(fake).pop()?.body;
        expect(body.volumes).toEqual({ 1: { id: v.id.split('/')[1], volume_type: 'sbs_volume' } });
        expect(body.tags).toEqual([`${MOUNT_TAG}${v.id.split('/')[1]}`]);
        expect((await p.waitUntilRunning(s.id, fast)).mounts).toEqual([{ volumeId: v.id }]);
        expect(await p.getVolume(v.id)).toMatchObject({ status: 'attached', serverIds: [s.id] });
        const root = (await p.getServer(s.id))!.raw.volumes['0'].id;
        expect(await p.deleteServerAndWait(s.id, fast)).toBe(true);
        expect(fake.state.volumes.has(root)).toBe(false);
        expect(await p.getVolume(v.id)).toMatchObject({ status: 'available', serverIds: [] });
        await p.deleteVolume(v.id);
        expect(await p.getVolume(v.id)).toBeNull();
        await expect(p.deleteVolume(v.id)).resolves.toBeUndefined();
        await expect(p.deleteVolume('not-a-volume')).resolves.toBeUndefined();
    });

    it('providerOptions add tags and may name volumes, but never drop what marks a volume as the caller\'s: it outlives the server', async () => {
        const { fake, p } = make();
        const [offer] = await p.listOffers({ kind: 'gpu' });
        // A mount, with tags of the caller's own in providerOptions.
        const v = await volume(p);
        const s = await p.createServer({ name: 'gpu', offer, mounts: [{ volume: v }], providerOptions: { tags: ['team-a'] } });
        expect(creates(fake).pop()?.body.tags).toEqual(['team-a', `${MOUNT_TAG}${v.id.split('/')[1]}`]);
        expect(await p.deleteServerAndWait(s.id, fast)).toBe(true);
        expect(await p.getVolume(v.id)).toMatchObject({ status: 'available' });
        // A volume named in providerOptions.volumes exists already: it is the caller's too.
        const w = await volume(p);
        const raw = await p.createServer({ name: 'gpu-raw', offer, providerOptions: { volumes: { 1: { id: w.id.split('/')[1], volume_type: 'sbs_volume' } } } });
        expect(creates(fake).pop()?.body.tags).toEqual([`${MOUNT_TAG}${w.id.split('/')[1]}`]);
        expect(await p.deleteServerAndWait(raw.id, fast)).toBe(true);
        expect(await p.getVolume(w.id)).toMatchObject({ status: 'available' });
        // Both ways of naming the server's volumes at once are refused before anything is made.
        const before = creates(fake).length;
        await expect(p.createServer({ name: 'x', offer, diskGb: 50, providerOptions: { volumes: { 1: { id: w.id.split('/')[1] } } } })).rejects.toThrow(/providerOptions.volumes with diskGb or mounts/);
        expect(creates(fake)).toHaveLength(before);
    });

    it('an account image\'s extra volumes keep keys 1..n: the volume goes after them, and they go with the server while it stays', async () => {
        const { fake, p } = make();
        const [offer] = await p.listOffers({ kind: 'gpu' });
        const v = await volume(p);
        const image = '00000000-0000-4000-8000-0000000a11ce';
        const snapshot = (name: string) => ({ id: `${name}-snap`, name, size: 20e9, volume_type: 'sbs_snapshot' });
        fake.state.images.set(image, { id: image, name: 'two-disks', arch: 'x86_64', from_server: UNKNOWN, organization: FAKE_SCALEWAY_PROJECT, project: FAKE_SCALEWAY_PROJECT,
            public: false, root_volume: snapshot('root'), extra_volumes: { 1: { ...snapshot('data'), organization: FAKE_SCALEWAY_PROJECT, project: FAKE_SCALEWAY_PROJECT, tags: [], server: null,
                state: 'available', zone: 'pl-waw-2' } }, state: 'available', tags: [], zone: 'pl-waw-2', creation_date: '2026-10-01T00:00:00Z', modification_date: '2026-10-01T00:00:00Z', left: 0 });
        const s = await p.createServer({ name: 'gpu', offer, image: `pl-waw-2/${image}`, mounts: [{ volume: v.id }] });
        expect(creates(fake).pop()?.body.volumes).toEqual({ 2: { id: v.id.split('/')[1], volume_type: 'sbs_volume' } });
        const own = Object.values((await p.getServer(s.id))!.raw.volumes).map((x) => x.id).filter((id) => id !== v.id.split('/')[1]);
        expect(own).toHaveLength(2);
        expect(await p.deleteServerAndWait(s.id, fast)).toBe(true);
        expect(own.filter((id) => fake.state.volumes.has(id))).toEqual([]);
        expect((await p.getVolume(v.id))?.status).toBe('available');
    });

    it('refuses before anything is created: a path, an id that is not one, a volume not in the zone, one in use, one in another zone than asked', async () => {
        const { fake, p } = make();
        const [offer] = await p.listOffers({ kind: 'gpu' });
        const v = await volume(p);
        const far = await volume(p, 'far', 'fr-par-2');
        const o = { name: 'gpu', offer };
        const generic: ICompute = p;
        await expect(generic.createServer({ ...o, mounts: [{ volume: v, path: '/models' }] })).rejects.toThrow(NotSupportedError);
        await expect(p.createServer({ ...o, mounts: [{ volume: 'models' }] })).rejects.toThrow(/is not a volume id/);
        await expect(p.createServer({ ...o, mounts: [{ volume: far.id.split('/')[1] }] })).rejects.toThrow(/no volume .* in pl-waw-2/);
        await expect(p.createServer({ ...o, region: 'pl-waw-2', mounts: [{ volume: far }] })).rejects.toThrow(/is in fr-par-2, not pl-waw-2/);
        // An image of another zone fixes the zone: the volume is refused there.
        await expect(p.createServer({ ...o, image: `fr-par-1/${UNKNOWN}`, mounts: [{ volume: v }] })).rejects.toThrow(/volume pl-waw-2\/.* is in pl-waw-2, not fr-par-1/);
        expect(creates(fake)).toEqual([]);
        await p.createServer({ ...o, mounts: [{ volume: v }] });
        await expect(p.createServer({ ...o, name: 'gpu-2', mounts: [{ volume: v }] })).rejects.toThrow(/is in_use/);
        // An image that is not there: no extra volumes to count, and the create is refused by Scaleway.
        await expect(p.createServer({ ...o, name: 'gpu-3', image: UNKNOWN, mounts: [{ volume: far.id }] })).rejects.toThrow(ProviderError);
        expect(creates(fake)).toHaveLength(2);
        await expect(p.deleteVolume(v.id)).rejects.toMatchObject({ code: 'precondition_failed' });
    });

    it('a zoned volume fixes the zone of a create that names none', async () => {
        const { fake, p } = make();
        const v = await volume(p);
        const s = await p.createServer({ name: 'gpu', offer: 'L4-1-24G', mounts: [{ volume: v.id }] });
        expect(s.region).toBe('pl-waw-2');
        expect(creates(fake).pop()?.path).toMatch(/\/zones\/pl-waw-2\//);
    });

    it('an image of a server leaves the volumes it mounts out: they are the caller\'s', async () => {
        const { fake, p } = make();
        const [offer] = await p.listOffers({ kind: 'gpu' });
        const v = await volume(p);
        const s = await p.createServer({ name: 'gpu', offer, mounts: [{ volume: v }] });
        await p.waitUntilRunning(s.id, fast);
        const root = (await p.getServer(s.id))!.raw.volumes['0'].id;
        const image = await p.createImage(s.id, { name: 'baked', ...fast });
        expect(fake.calls.filter(isBackup).pop()?.body).toEqual({ action: 'backup', name: 'baked', volumes: { [root]: {} } });
        expect(image.raw.extra_volumes).toEqual({});
        // A server without mounts names no volumes: Scaleway takes them all.
        const plain = await running(p, 'plain');
        await p.createImage(plain.id, { name: 'plain', ...fast });
        expect(fake.calls.filter(isBackup).pop()?.body).toEqual({ action: 'backup', name: 'plain' });
    });

    it('reads a Block Storage volume as a volume: its state, its servers (attached or attaching), its date', () => {
        const raw: ScalewayBlockVolume = { id: UNKNOWN, name: 'v', type: 'sbs_5k', size: 5e9, project_id: FAKE_SCALEWAY_PROJECT, references: [
            { id: 'r1', product_resource_type: 'instance_server', product_resource_id: 'a', type: 'exclusive', status: 'attached' },
            { id: 'r2', product_resource_type: 'instance_server', product_resource_id: 'b', type: 'exclusive', status: 'attaching' },
            { id: 'r3', product_resource_type: 'instance_server', product_resource_id: 'c', type: 'exclusive', status: 'detached' },
            { id: 'r4', product_resource_type: 'snapshot', product_resource_id: 'd', type: 'link', status: 'attached' },
        ], status: 'in_use', tags: [], zone: 'fr-par-2', created_at: null };
        expect(toVolume(raw)).toMatchObject({ id: `fr-par-2/${UNKNOWN}`, sizeGb: 5, status: 'attached', serverIds: ['fr-par-2/a', 'fr-par-2/b'], createdAt: undefined });
        expect(toVolume({ ...raw, references: undefined as any, status: 'resizing' })).toMatchObject({ status: 'pending', serverIds: [] });
        expect(toVolume({ ...raw, status: 'teleporting' as any }).status).toBe('unknown');
        expect(mountedVolumeIds({ tags: ['prod', `${MOUNT_TAG}abc`] })).toEqual(['abc']);
        expect(mountedVolumeIds({ tags: undefined as any })).toEqual([]);
    });
});

describe('Scaleway volumes attached to a server that runs (volumeAttach)', () => {
    const UNKNOWN = '00000000-0000-4000-8000-00000000beef';
    const volume = (p: Scaleway, name = 'models', zone = 'pl-waw-2') => p.createVolume({ name, region: zone, sizeGb: 20 });
    const attaches = (fake: Fake) => fake.calls.filter((c) => c.method === 'POST' && /\/attach-volume$/.test(c.path));

    it('attaches it as the next disk, tags the server so its deletion and images leave it, and waits until it is in use', async () => {
        const { fake, p } = make();
        const s = await running(p);
        const v = await volume(p);
        // The default wait (the fake settles at once).
        await p.attachVolume(v.id, s.id);
        expect(attaches(fake).map((c) => c.body)).toEqual([{ volume_id: v.id.split('/')[1], volume_type: 'sbs_volume' }]);
        const after = (await p.getServer(s.id))!;
        expect(after.raw.tags).toContain(`${MOUNT_TAG}${v.id.split('/')[1]}`);
        expect(after.mounts).toEqual([{ volumeId: v.id }]);
        expect(after.raw.volumes['1'].id).toBe(v.id.split('/')[1]);
        // Held already: no second attach; a tag it lacked (attached by hand) is added.
        await p.api.setServerTags('pl-waw-2', s.id.split('/')[1], []);
        await p.attachVolume(v.id.split('/')[1], s.id, fast);
        expect(attaches(fake)).toHaveLength(1);
        expect((await p.getServer(s.id))!.raw.tags).toEqual([`${MOUNT_TAG}${v.id.split('/')[1]}`]);
        // Tagged already: nothing to set.
        const patches = fake.calls.filter((c) => c.method === 'PATCH').length;
        await p.attachVolume(v.id, s.id, fast);
        expect(fake.calls.filter((c) => c.method === 'PATCH')).toHaveLength(patches);
    });

    it('detaches it, drops its tag, and waits until it is available; what the server does not hold is left as it is', async () => {
        const { fake, p } = make();
        const s = await running(p);
        const v = await volume(p);
        await p.attachVolume(v.id, s.id, fast);
        // The default wait.
        await p.detachVolume(v.id, s.id);
        expect(await p.getVolume(v.id)).toMatchObject({ status: 'available', serverIds: [] });
        expect((await p.getServer(s.id))!.raw.tags).toEqual([]);
        const detaches = () => fake.calls.filter((c) => c.method === 'POST' && /\/detach-volume$/.test(c.path)).length;
        const sent = detaches();
        await p.detachVolume(v.id, s.id, fast);
        await p.detachVolume(v.id, '00000000-0000-4000-8000-00000000dead', fast);
        await p.detachVolume('not-a-volume', s.id, fast);
        expect(detaches()).toBe(sent);
        // A stale tag (the volume detached by hand) is dropped.
        await p.api.setServerTags('pl-waw-2', s.id.split('/')[1], [`${MOUNT_TAG}${v.id.split('/')[1]}`, 'prod']);
        await p.detachVolume(v.id, s.id, fast);
        expect((await p.getServer(s.id))!.raw.tags).toEqual(['prod']);
    });

    it('refuses an id that is not one, a volume of another zone, one the zone lacks, and one another server holds', async () => {
        const { fake, p } = make();
        const s = await running(p);
        const other = await running(p, 'other');
        const far = await volume(p, 'far', 'fr-par-2');
        const v = await volume(p);
        await p.attachVolume(v.id, other.id, fast);
        await expect(p.attachVolume('models', s.id, fast)).rejects.toThrow(/is not a volume id/);
        await expect(p.attachVolume(far.id, s.id, fast)).rejects.toThrow(/is in fr-par-2, not pl-waw-2/);
        await expect(p.attachVolume(UNKNOWN, s.id, fast)).rejects.toThrow(NotFoundError);
        await expect(p.attachVolume(v.id, s.id, fast)).rejects.toThrow(/is in_use/);
        await expect(p.attachVolume(v.id, '00000000-0000-4000-8000-00000000dead', fast)).rejects.toThrow(NotFoundError);
        expect(attaches(fake)).toHaveLength(1);
    });

    it('a volume that vanishes, or does not settle, while it is attached says so', async () => {
        const { fake, p } = make();
        const s = await running(p);
        const v = await volume(p);
        const block = /\/block\/v1\/zones\/pl-waw-2\/volumes\/[^/]+$/;
        let reads = 0;
        // The first read finds it; the wait's reads find it gone.
        fake.intercept((r) => r.method === 'GET' && block.test(r.path), { answer: (r) => (reads++ === 0
            ? json(200, { ...fake.state.volumes.get(r.path.split('/').pop()!), left: undefined })
            : json(404, { type: 'not_found', message: 'gone' })), times: 2 });
        await expect(p.attachVolume(v.id, s.id, fast)).rejects.toThrow(/disappeared/);
        const w = await volume(p, 'slow');
        fake.intercept((r) => r.method === 'GET' && block.test(r.path), { answer: (r) => json(200, { ...fake.state.volumes.get(r.path.split('/').pop()!), status: 'available' }) });
        await expect(p.attachVolume(w.id, s.id, { intervalMs: 0, timeoutMs: 0 })).rejects.toThrow(/to be in_use.*: available/);
    });
});

describe('Scaleway serverless: Serverless Containers (CPU), one namespace and one private container per endpoint', () => {
    const WHOAMI = { image: 'traefik/whoami:v1.12.0' };
    const containerCalls = (fake: Fake) => fake.calls.filter((c) => c.path.startsWith('/containers/v1/') && c.method !== 'GET').map((c) => [c.method, c.path.replace(/[0-9a-f-]{36}/g, '<id>'), c.body]);

    it('offers container sizes, CPU in proportion to memory, priced per second in USD in every region, cheapest first; no GPU', async () => {
        const { p } = make();
        const offers = await p.listEndpointOffers();
        expect(offers.map((o) => o.id)).toEqual(['70mvcpu-128mb', '140mvcpu-256mb', '280mvcpu-512mb', '560mvcpu-1024mb', '1120mvcpu-2048mb', '1680mvcpu-3072mb', '2240mvcpu-4096mb']);
        expect(offers[4]).toMatchObject({ provider: 'scaleway', gpuCount: 0, vendor: null, vcpus: 1.12, memoryGb: 2.048, regions: ['fr-par', 'nl-ams', 'pl-waw', 'it-mil'],
            billing: { incrementSeconds: 1, minimumSeconds: 0 }, raw: { mvcpu: 1120, memoryBytes: 2048e6 } });
        // EUR 0.00001 a vCPU-s and 0.000002 a GB-s, in USD.
        expect(offers[4].pricePerHour).toBeCloseTo((1.12 * 0.00001 + 2.048 * 0.000002) * 3600 * p.api.eurToUsd, 9);
        expect(await p.listEndpointOffers({ kind: 'gpu' })).toEqual([]);
        expect((await p.listEndpointOffers({ maxPricePerHour: 0.01 })).length).toBeLessThan(offers.length);
    });

    it('made: a namespace for it, then the container, private, deployed; read back by its regional id or a bare one, listed', async () => {
        const { fake, p } = make();
        const e = await p.createEndpoint({ name: 'whoami', container: { ...WHOAMI, env: { GREETING: 'hi' }, command: ['--verbose'] }, offer: '1120mvcpu-2048mb', minWorkers: 1, maxWorkers: 3, ...fast });
        expect(containerCalls(fake)).toEqual([
            ['POST', '/containers/v1/regions/fr-par/namespaces', { project_id: FAKE_SCALEWAY_PROJECT, name: 'whoami', tags: ['asap-vps-endpoint'] }],
            ['POST', '/containers/v1/regions/fr-par/containers', { namespace_id: expect.any(String), name: 'whoami', image: 'traefik/whoami:v1.12.0', port: 80, min_scale: 1, max_scale: 3,
                mvcpu_limit: 1120, memory_limit_bytes: 2048e6, privacy: 'private', environment_variables: { GREETING: 'hi' }, args: ['--verbose'], tags: ['asap-vps-endpoint'] }],
        ]);
        expect(e).toMatchObject({ provider: 'scaleway', name: 'whoami', status: 'ready', providerStatus: 'ready', image: 'traefik/whoami:v1.12.0', port: 80, offerId: '1120mvcpu-2048mb',
            region: 'fr-par', minWorkers: 1, maxWorkers: 3, idleTimeoutSeconds: 900, private: true });
        expect(e.id).toMatch(/^fr-par\/[0-9a-f-]{36}$/);
        expect(e.url).toMatch(/^https:\/\/whoami[0-9a-f]{8}-whoami\.functions\.fnc\.fr-par\.scw\.cloud$/);
        expect(e.createdAt).toBeGreaterThan(0);
        expect(await p.getEndpoint(e.id)).toMatchObject({ id: e.id });
        expect(await p.getEndpoint(e.id.split('/')[1])).toMatchObject({ id: e.id });
        expect(await p.getEndpoint('fr-par/00000000-0000-4000-8000-0000000000ff')).toBeNull();
        expect(await p.getEndpoint('not-an-id')).toBeNull();
        expect((await p.listEndpoints()).map((x) => x.id)).toEqual([e.id]);
    });

    it('defaults: the smallest size, the region of the first zone; a region by name, by zone, or by the library\'s enum', async () => {
        const { fake, p } = make({}, { zones: ['pl-waw-1', 'nl-ams-2'] });
        const body = () => fake.calls.filter((c) => c.method === 'POST' && /\/containers$/.test(c.path)).pop();
        await p.createEndpoint({ name: 'ea', container: WHOAMI, ...fast });
        expect(body()).toMatchObject({ path: '/containers/v1/regions/nl-ams/containers', body: { mvcpu_limit: 70, memory_limit_bytes: 128e6, min_scale: 0, max_scale: 1 } });
        const [offer] = await p.listEndpointOffers();
        await p.createEndpoint({ name: 'eb', container: WHOAMI, offer, region: 'pl-waw', ...fast });
        expect(body()?.path).toBe('/containers/v1/regions/pl-waw/containers');
        await p.createEndpoint({ name: 'ec', container: WHOAMI, region: 'pl-waw-3', ...fast });
        expect(body()?.path).toBe('/containers/v1/regions/pl-waw/containers');
        // A region outside the provider's zones: its endpoints would not be listed there.
        await expect(p.createEndpoint({ name: 'ef', container: WHOAMI, region: 'fr-par-2', ...fast })).rejects.toThrow(/region fr-par is outside this provider's zones \(nl-ams-2, pl-waw-1\)/);
        await p.createEndpoint({ name: 'ed', container: { ...WHOAMI, env: { PORT: '8080' } }, port: 8080, region: REGION_TYPES.AMSTERDAM, ...fast });
        expect(body()).toMatchObject({ path: '/containers/v1/regions/nl-ams/containers', body: { port: 8080, environment_variables: { PORT: '8080' } } });
        // Listed from the regions of the provider's zones.
        expect((await p.listEndpoints()).map((e) => e.region).sort()).toEqual(['nl-ams', 'nl-ams', 'pl-waw', 'pl-waw']);
    });

    it('refuses what it cannot make before anything is sent', async () => {
        const { fake, p } = make();
        const refused: Array<[Parameters<Scaleway['createEndpoint']>[0], RegExp | typeof NotSupportedError]> = [
            [{ name: 'x1', container: { ...WHOAMI, registryAuth: { username: 'u', password: 'p' } } }, NotSupportedError],
            [{ name: 'x1', container: WHOAMI, idleTimeoutSeconds: 60 }, NotSupportedError],
            [{ name: 'X1', container: WHOAMI }, /2-34 lowercase letters/],
            [{ name: 'x', container: WHOAMI }, /2-34 lowercase letters/],
            [{ name: 'x1-', container: WHOAMI }, /2-34 lowercase letters/],
            [{ name: 'x1', container: { image: '' } }, /needs an image/],
            [{ name: 'x1', container: WHOAMI, port: 0 }, /bad port 0/],
            [{ name: 'x1', container: { ...WHOAMI, env: { PORT: '8080' } } }, /pass port \(8080\), not env\.PORT/],
            [{ name: 'x1', container: WHOAMI, minWorkers: 11, maxWorkers: 20 }, /minWorkers 0-10/],
            [{ name: 'x1', container: WHOAMI, maxWorkers: 201 }, /maxWorkers 1-200/],
            [{ name: 'x1', container: WHOAMI, minWorkers: 2, maxWorkers: 1 }, /min <= max/],
            [{ name: 'x1', container: WHOAMI, offer: '2vcpu' }, /bad container size "2vcpu"/],
            [{ name: 'x1', container: WHOAMI, region: 'us-east' }, /"us-east" is no Scaleway region/],
        ];
        for (const [o, why] of refused) await expect(p.createEndpoint({ ...o, ...fast })).rejects.toThrow(why);
        const theirs = { ...(await p.listEndpointOffers())[0], provider: 'runpod' };
        await expect(p.createEndpoint({ name: 'x1', container: WHOAMI, offer: theirs })).rejects.toThrow(/runpod's, not scaleway's/);
        const custom = { ...(await p.listEndpointOffers())[0], id: 'big' };
        await expect(p.createEndpoint({ name: 'x1', container: WHOAMI, offer: custom })).rejects.toThrow(/bad container size "big"/);
        await expect(make({}, { projectId: undefined }).p.createEndpoint({ name: 'x1', container: WHOAMI })).rejects.toThrow(/Project/);
        expect(containerCalls(fake)).toEqual([]);
    });

    it('a deploy that fails is thrown with Scaleway\'s message, and leaves nothing: the namespace goes, its container with it', async () => {
        const { fake, p } = make();
        await expect(p.createEndpoint({ name: 'broken', container: { image: 'acme/missing:1' }, ...fast })).rejects.toThrow(/endpoint broken is error: image "acme\/missing:1" could not be pulled/);
        expect(containerCalls(fake).map(([m, path]) => [m, path])).toEqual([
            ['POST', '/containers/v1/regions/fr-par/namespaces'], ['POST', '/containers/v1/regions/fr-par/containers'], ['DELETE', '/containers/v1/regions/fr-par/namespaces/<id>'],
        ]);
        expect(await p.listEndpoints()).toEqual([]);
    });

    it('a deploy that fails, whose clean-up fails too, is thrown as the deploy\'s failure', async () => {
        const { fake, p } = make();
        fake.intercept((r) => r.method === 'DELETE' && /\/namespaces\//.test(r.path), { answer: () => json(403, { type: 'permissions_denied', message: 'no' }) });
        await expect(p.createEndpoint({ name: 'broken', container: { image: 'acme/missing:1' }, ...fast })).rejects.toThrow(/endpoint broken is error: image "acme\/missing:1"/);
    });

    it('a container that disappears while it deploys, or settles locked, is an error too', async () => {
        const { fake, p } = make();
        fake.intercept((r) => r.method === 'GET' && /\/containers\/[0-9a-f-]{36}$/.test(r.path), { answer: () => json(404, { type: 'not_found', message: 'gone' }), times: 1 });
        await expect(p.createEndpoint({ name: 'vanishes', container: WHOAMI, ...fast })).rejects.toThrow(/endpoint vanishes disappeared while it was made/);
        fake.intercept((r) => r.method === 'GET' && /\/containers\/[0-9a-f-]{36}$/.test(r.path), {
            answer: (r) => json(200, { ...fake.state.containers.get(r.path.split('/').pop()!), status: 'locked', error_message: null }), times: 1,
        });
        await expect(p.createEndpoint({ name: 'locked', container: WHOAMI, ...fast })).rejects.toThrow(/endpoint locked is locked$/);
    });

    it('a request carries the account\'s key to a private container, none to a public one, and waits out a cold start; the key goes to Scaleway\'s hosts only', async () => {
        const { fake, p } = make({ coldRequests: 2 });
        const e = await p.createEndpoint({ name: 'whoami', container: WHOAMI, ...fast });
        const r = await p.requestEndpoint(e, 'api?x=1', { intervalMs: 0 });
        expect(r.status).toBe(200);
        expect(await r.json()).toMatchObject({ container: 'whoami', path: '/api', query: '?x=1', port: 80 });
        const sent = fake.calls.filter((c) => c.host?.endsWith('.scw.cloud') && c.host !== 'api.scaleway.com');
        expect(sent).toHaveLength(3);
        expect(sent.every((c) => c.headers?.['x-auth-token'] === 'scw-test')).toBe(true);
        // Public: anyone may call it, and no key is sent.
        const pub = await p.createEndpoint({ name: 'open', container: WHOAMI, providerOptions: { privacy: 'public' }, ...fast });
        expect(pub.private).toBe(false);
        fake.state.containers.get(pub.id.split('/')[1]).cold = 0;
        expect((await p.requestEndpoint(pub.id, '/', { intervalMs: 0 })).status).toBe(200);
        expect(fake.calls.pop()?.headers?.['x-auth-token']).toBeUndefined();
        // A container whose endpoint is not Scaleway's: nothing is sent there.
        fake.state.containers.get(e.id.split('/')[1]).public_endpoint = 'https://evil.example.com';
        await expect(p.requestEndpoint(e, '/')).rejects.toThrow(/answers on evil\.example\.com, not on a Scaleway host/);
        await expect(p.requestEndpoint('fr-par/00000000-0000-4000-8000-0000000000ff', '/')).rejects.toBeInstanceOf(NotFoundError);
        await expect(p.requestEndpoint({ ...e, provider: 'runpod' }, '/')).rejects.toThrow(/runpod's, not scaleway's/);
    });

    it('a redirect from a private container is answered, never followed: the key does not reach the host it points to', async () => {
        const fake = fakeScaleway();
        const sent: Array<{ host: string, key: string | undefined }> = [];
        let redirecting = '';
        // The network as fetch sees it: the container redirects elsewhere, and fetch follows unless told not to.
        const fetchImpl = followingRedirects((async (url: string | URL | Request, init?: RequestInit) => {
            const host = new URL(String(url)).host;
            if (host === redirecting) return new Response(null, { status: 302, headers: { location: 'https://evil.example.com/steal' } });
            if (host === 'evil.example.com') {
                sent.push({ host, key: new Headers(init?.headers).get('x-auth-token') ?? undefined });
                return new Response('thanks', { status: 200 });
            }
            return fake.fetchImpl(url, init);
        }) as typeof fetch);
        const p = new Scaleway({ apiKey: 'scw-test', projectId: FAKE_SCALEWAY_PROJECT, fetchImpl, sleep: noSleep });
        const e = await p.createEndpoint({ name: 'whoami', container: WHOAMI, ...fast });
        redirecting = new URL(e.url).host;
        const r = await p.requestEndpoint(e, '/api', { intervalMs: 0 });
        expect([r.status, r.headers.get('location')]).toEqual([302, 'https://evil.example.com/steal']);
        expect(sent).toEqual([]);
        // What the helper stands for: fetch, left to follow, would have sent the key on.
        await fetchImpl(`https://${redirecting}/api`, { headers: { 'x-auth-token': 'scw-test' } });
        expect(sent).toEqual([{ host: 'evil.example.com', key: 'scw-test' }]);
    });

    it('deleted: the container, then the namespace made for it, both waited until gone; a namespace of the caller\'s own stays; deleting again is no error', async () => {
        const { fake, p } = make();
        const e = await p.createEndpoint({ name: 'whoami', container: WHOAMI, ...fast });
        await p.deleteEndpoint(e.id);
        expect(await p.getEndpoint(e.id)).toBeNull();
        expect(fake.state.namespaces.size).toBe(0);
        await p.deleteEndpoint(e.id);
        // In a namespace the caller made (no asap-vps tag): the container goes, the namespace stays.
        const ns = await p.api.createContainerNamespace('fr-par', { project_id: FAKE_SCALEWAY_PROJECT, name: 'mine' });
        await p.api.getContainerNamespace('fr-par', ns.id);
        const c = await p.api.createContainer('fr-par', { namespace_id: ns.id, name: 'theirs', image: 'traefik/whoami:v1.12.0' });
        await p.deleteEndpoint(`fr-par/${c.id}`);
        expect(await p.api.getContainer('fr-par', c.id)).toBeNull();
        expect(await p.api.getContainerNamespace('fr-par', ns.id)).toMatchObject({ name: 'mine', status: 'ready' });
        expect(await p.api.deleteContainer('fr-par', c.id)).toBe(false);
        expect(await p.api.deleteContainerNamespace('fr-par', ns.id)).toBe(true);
    });

    it('waits with its own defaults; a deploy, a delete or a namespace that never settles times out, naming it', async () => {
        const { fake, p } = make();
        expect((await p.createEndpoint({ name: 'defaults', container: WHOAMI })).status).toBe('ready');
        const stuck = (re: RegExp, status: string) => fake.intercept((r) => r.method === 'GET' && re.test(r.path), {
            answer: (r) => json(200, { ...(fake.state.containers.get(r.path.split('/').pop()!) ?? fake.state.namespaces.get(r.path.split('/').pop()!)), status }),
        });
        stuck(/\/containers\/[0-9a-f-]{36}$/, 'creating');
        await expect(p.createEndpoint({ name: 'slow', container: WHOAMI, intervalMs: 0, timeoutMs: 20 })).rejects.toThrow(/timed out after 0 s waiting for endpoint slow: creating/);
        // Its namespace, which Scaleway will not delete: named with the failure, left_behind.
        const { fake: f2, p: p2 } = make();
        f2.intercept((r) => r.method === 'GET' && /\/containers\/[0-9a-f-]{36}$/.test(r.path), { answer: (r) => json(200, { ...f2.state.containers.get(r.path.split('/').pop()!), status: 'creating' }) });
        f2.intercept((r) => r.method === 'DELETE' && /\/namespaces\/[0-9a-f-]{36}$/.test(r.path), { answer: () => json(403, { type: 'permissions_denied', message: 'insufficient permissions' }) });
        const kept = p2.createEndpoint({ name: 'kept', container: WHOAMI, intervalMs: 0, timeoutMs: 20 });
        await expect(kept).rejects.toThrow(/waiting for endpoint kept: creating; and namespace kept \(fr-par\/[0-9a-f-]{36}, with its container\), made for it, is not deleted \(.*insufficient permissions.*\)/);
        await expect(kept).rejects.toMatchObject({ code: 'left_behind' });
    });

    it('a container that is never gone, or a namespace that is never gone, is a timeout that says so', async () => {
        const { fake, p } = make();
        const e = await p.createEndpoint({ name: 'sticky', container: WHOAMI, ...fast });
        const id = e.id.split('/')[1];
        const ns = fake.state.containers.get(id).namespace_id;
        fake.intercept((r) => r.method === 'GET' && r.path.endsWith(`/containers/${id}`), { answer: () => json(200, { ...fake.state.containers.get(id), status: 'deleting' }), times: 1e9 });
        await expect(p.deleteEndpoint(e.id, { intervalMs: 0, timeoutMs: 20 })).rejects.toThrow(/timed out after 0 s waiting for delete of endpoint sticky: deleting/);
        const { fake: f2, p: p2 } = make();
        const e2 = await p2.createEndpoint({ name: 'nsticky', container: WHOAMI, ...fast });
        const ns2 = f2.state.containers.get(e2.id.split('/')[1]).namespace_id;
        f2.intercept((r) => r.method === 'GET' && r.path.endsWith(`/namespaces/${ns2}`), { answer: () => json(200, { ...f2.state.namespaces.get(ns2), status: 'deleting' }), times: 1e9 });
        await expect(p2.deleteEndpoint(e2.id, { intervalMs: 0, timeoutMs: 20 })).rejects.toThrow(/timed out after 0 s waiting for delete of namespace nsticky: deleting/);
        expect(ns).toBeTruthy();
    });

    it('reads a status it does not know as unknown; a regional id of a region that is not Scaleway\'s names nothing', async () => {
        const { fake, p } = make();
        const e = await p.createEndpoint({ name: 'odd', container: WHOAMI, ...fast });
        fake.intercept((r) => r.method === 'GET' && r.path.endsWith(`/containers/${e.id.split('/')[1]}`), {
            answer: (r) => json(200, { ...fake.state.containers.get(r.path.split('/').pop()!), status: 'hibernating' }), times: 1,
        });
        expect(await p.getEndpoint(e.id)).toMatchObject({ status: 'unknown', providerStatus: 'hibernating' });
        expect(await p.getEndpoint(`us-east/${e.id.split('/')[1]}`)).toBeNull();
    });
});

describe('Scaleway shared volumes: File Storage filesystems, attached to Instances and mounted with virtiofs', () => {
    const GPU_FS = 'L40S-1-48G';
    const shareOf = (p: Scaleway, name = 'models', sizeGb = 25) => p.createVolume({ name, region: 'fr-par-2', sizeGb, shared: true, ...fast });
    const fsCalls = (fake: Fake) => fake.calls.filter((c) => /filesystem/.test(c.path) && c.method !== 'GET').map((c) => [c.method, c.path.replace(/[0-9a-f-]{36}/g, '<id>'), c.body]);

    it('made in the zone\'s region (Paris), in GB steps, once available; read by its regional id or a bare one; listed with the block volumes', async () => {
        const { fake, p } = make();
        const share = await p.createVolume({ name: 'models', region: 'fr-par-2', sizeGb: 24.5 + 1, shared: true, providerOptions: { tags: ['team-a'] }, ...fast });
        expect(fsCalls(fake)).toEqual([['POST', '/file/v1alpha1/regions/fr-par/filesystems', { name: 'models', project_id: FAKE_SCALEWAY_PROJECT, size: 26e9, tags: ['team-a'] }]]);
        expect(share).toMatchObject({ provider: 'scaleway', name: 'models', region: 'fr-par', shared: true, sizeGb: 26, status: 'available', providerStatus: 'available', mountPath: '/mnt/models' });
        expect(share.id).toMatch(/^fr-par\/[0-9a-f-]{36}$/);
        expect(await p.getVolume(share.id)).toMatchObject({ id: share.id, shared: true });
        expect(await p.getVolume(share.id.split('/')[1])).toMatchObject({ id: share.id });
        expect(await p.getVolume('fr-par/00000000-0000-4000-8000-0000000000aa')).toBeNull();
        const block = await p.createVolume({ name: 'scratch', region: 'fr-par-2', sizeGb: 1, ...fast });
        // The account's own (a production server's disk) aside.
        expect((await p.listVolumes()).filter((v) => ['scratch', 'models'].includes(v.name)).map((v) => [v.name, v.shared])).toEqual([['scratch', false], ['models', true]]);
        expect(block.shared).toBe(false);
    });

    it('refuses a size out of bounds, a region without File Storage, and one outside the provider\'s zones; one that fails is deleted, and its failure thrown', async () => {
        const { fake, p } = make();
        await expect(shareOf(p, 'tiny', 24)).rejects.toThrow(/25-50000 GB, not 24/);
        await expect(shareOf(p, 'huge', 50001)).rejects.toThrow(/25-50000 GB/);
        await expect(p.createVolume({ name: 'x', region: 'nl-ams-1', sizeGb: 25, shared: true })).rejects.toThrow(/File Storage is in fr-par, not nl-ams/);
        expect(fsCalls(fake)).toEqual([]);
        fake.intercept((r) => r.method === 'GET' && /\/filesystems\/[0-9a-f-]{36}$/.test(r.path), { answer: (r) => json(200, { ...fake.state.filesystems.get(r.path.split('/').pop()!), status: 'error' }), times: 1 });
        await expect(shareOf(p, 'broken')).rejects.toThrow(/filesystem broken is error, not available/);
        fake.intercept((r) => r.method === 'GET' && /\/filesystems\/[0-9a-f-]{36}$/.test(r.path), { answer: () => json(404, { type: 'not_found', message: 'gone' }), times: 1 });
        await expect(shareOf(p, 'vanishes')).rejects.toThrow(/filesystem vanishes disappeared while it was made/);
        expect(fake.state.filesystems.size).toBe(0);
        // Its clean-up refused too: the failure thrown is the filesystem's own.
        fake.intercept((r) => r.method === 'GET' && /\/filesystems\/[0-9a-f-]{36}$/.test(r.path), { answer: (r) => json(200, { ...fake.state.filesystems.get(r.path.split('/').pop()!), status: 'error' }), times: 1 });
        fake.intercept((r) => r.method === 'DELETE' && /\/filesystems\//.test(r.path), { answer: () => json(403, { type: 'permissions_denied', message: 'no' }), times: 1 });
        await expect(shareOf(p, 'stuck')).rejects.toThrow(/filesystem stuck is error, not available/);
    });

    it('a server created with it has it attached before it boots, carries a tag for it, and mounts it with virtiofs at its path', async () => {
        const { fake, p } = make();
        const share = await shareOf(p);
        const s = await p.createServer({ name: 'gpu-1', offer: GPU_FS, region: 'fr-par-2', mounts: [{ volume: share, path: '/data/models' }] });
        const order = fake.calls.filter((c) => c.method !== 'GET' && /servers/.test(c.path)).map((c) => c.path.replace(/.*servers(\/[0-9a-f-]{36})?/, '').replace(/^\//, '') || 'create');
        expect(order.indexOf('attach-filesystem')).toBeGreaterThan(order.indexOf('create'));
        expect(order.indexOf('attach-filesystem')).toBeLessThan(order.indexOf('action'));
        const userData = fake.calls.find((c) => c.method === 'PATCH' && /user_data\/cloud-init$/.test(c.path))?.body as string;
        expect(userData).toContain(`mount_fs '${share.id.split('/')[1]}' '/data/models'`);
        expect(userData).toContain('virtiofs defaults,nofail 0 0');
        const running = await p.waitUntilRunning(s.id, fast);
        expect(running.mounts).toEqual([{ volumeId: share.id, path: '/data/models' }]);
        expect(running.raw.tags).toContain(`asap-vps-fs:${share.id.split('/')[1]}=/data/models`);
        expect(running.raw.filesystems).toEqual([{ filesystem_id: share.id.split('/')[1], state: 'available' }]);
        expect(await p.getVolume(share.id)).toMatchObject({ status: 'attached' });
        // Attached: not deleted from under it.
        await expect(p.deleteVolume(share.id)).rejects.toThrow(/attached/);
        expect(await p.deleteServerAndWait(s.id, fast)).toBe(true);
        expect(await p.getVolume(share.id)).toMatchObject({ status: 'available' });
        await p.deleteVolume(share.id);
        expect(await p.getVolume(share.id)).toBeNull();
        await p.deleteVolume(share.id);
    });

    it('refuses before anything is made: a type that attaches none, another region, one not available, one that is not there, a relative path', async () => {
        const { fake, p } = make();
        const share = await shareOf(p);
        const o = { name: 'x', offer: GPU_FS, region: 'fr-par-2' };
        await expect(p.createServer({ ...o, offer: 'DEV1-S', mounts: [{ volume: share }] })).rejects.toThrow(/1 filesystems on .*it attaches 0/);
        await expect(p.createServer({ ...o, region: 'pl-waw-2', mounts: [{ volume: share }] })).rejects.toThrow(/filesystem models is in fr-par: an Instance in pl-waw-2 cannot attach it/);
        await expect(p.createServer({ ...o, mounts: [{ volume: 'fr-par/00000000-0000-4000-8000-0000000000aa' }] })).rejects.toThrow(/no filesystem/);
        await expect(p.createServer({ ...o, mounts: [{ volume: share, path: 'models' }] })).rejects.toThrow(/mount path "models" is not absolute/);
        fake.state.filesystems.get(share.id.split('/')[1]).status = 'updating';
        await expect(p.createServer({ ...o, mounts: [{ volume: share }] })).rejects.toThrow(/filesystem models is updating: it is attached once available/);
        expect(fake.calls.filter((c) => c.method === 'POST' && /\/servers$/.test(c.path))).toEqual([]);
    });

    it('attached to a server that runs, and detached, both idempotent; the server holds no more than its type takes', async () => {
        const { fake, p } = make();
        const share = await shareOf(p);
        const s = await p.waitUntilRunning((await p.createServer({ name: 'gpu-1', offer: GPU_FS, region: 'fr-par-2' })).id, fast);
        await p.attachVolume(share.id, s.id, fast);
        await p.attachVolume(share.id, s.id, fast);
        expect((await p.getServer(s.id))?.mounts).toEqual([{ volumeId: share.id, path: '/mnt/models' }]);
        expect(fake.calls.filter((c) => c.path.endsWith('/attach-filesystem'))).toHaveLength(1);
        await p.detachVolume(share.id, s.id, fast);
        await p.detachVolume(share.id, s.id, fast);
        expect((await p.getServer(s.id))?.mounts ?? []).toEqual([]);
        expect(fake.calls.filter((c) => c.path.endsWith('/detach-filesystem'))).toHaveLength(1);
        // A tag left behind with no attachment: dropped.
        await p.api.setServerTags(s.raw.zone, s.raw.id, [`asap-vps-fs:${share.id.split('/')[1]}=/x`]);
        await p.detachVolume(share.id, s.id, fast);
        expect((await p.getServer(s.id))?.raw.tags).toEqual([]);
        // An L40S attaches two: a third is refused.
        const [b, c] = [await shareOf(p, 'b'), await shareOf(p, 'c')];
        await p.attachVolume(share.id, s.id, fast);
        await p.attachVolume(b.id, s.id, fast);
        await expect(p.attachVolume(c.id, s.id, fast)).rejects.toThrow(/3 filesystems on .*it attaches 2/);
        // One of the two it holds, asked for again: no third, and nothing to send.
        await expect(p.attachVolume(b.id, s.id, fast)).resolves.toBeUndefined();
        expect(fake.calls.filter((c) => c.path.endsWith('/attach-filesystem'))).toHaveLength(3);
        await expect(p.attachVolume('fr-par/00000000-0000-4000-8000-0000000000aa', s.id, fast)).rejects.toThrow(/no filesystem/);
        // A bare id of a filesystem works too.
        await p.detachVolume(b.id.split('/')[1], s.id, fast);
        expect((await p.getServer(s.id))?.mounts).toEqual([{ volumeId: share.id, path: '/mnt/models' }]);
    });

    it('waits with its own defaults; a filesystem that never settles, or never goes, is a timeout that names it; a status it does not know reads as unknown', async () => {
        const { fake, p } = make();
        expect((await p.createVolume({ name: 'defaults', region: 'fr-par-2', sizeGb: 25, shared: true })).status).toBe('available');
        const stuck = (status: string) => fake.intercept((r) => r.method === 'GET' && /\/filesystems\/[0-9a-f-]{36}$/.test(r.path),
            { answer: (r) => json(200, { ...fake.state.filesystems.get(r.path.split('/').pop()!), status }), times: 1e9 });
        stuck('creating');
        await expect(p.createVolume({ name: 'slow', region: 'fr-par-2', sizeGb: 25, shared: true, intervalMs: 0, timeoutMs: 20 })).rejects.toThrow(/waiting for filesystem slow: creating/);
        // Deleted: nothing left billing. One Scaleway will not delete is named, left_behind.
        expect([...fake.state.filesystems.values()].filter((x) => x.name === 'slow')).toEqual([]);
        fake.intercept((r) => r.method === 'DELETE' && /\/filesystems\/[0-9a-f-]{36}$/.test(r.path), { answer: () => json(403, { type: 'permissions_denied', message: 'insufficient permissions' }), times: 1 });
        const kept = p.createVolume({ name: 'kept', region: 'fr-par-2', sizeGb: 25, shared: true, intervalMs: 0, timeoutMs: 20 });
        await expect(kept).rejects.toThrow(/waiting for filesystem kept: creating; and filesystem kept \(fr-par\/[0-9a-f-]{36}\), made for it, is not deleted/);
        await expect(kept).rejects.toMatchObject({ code: 'left_behind' });
        const { fake: f2, p: p2 } = make();
        const share = await p2.createVolume({ name: 'sticky', region: 'fr-par-2', sizeGb: 25, shared: true, ...fast });
        f2.intercept((r) => r.method === 'GET' && r.path.endsWith(share.id.split('/')[1]), { answer: () => json(200, { ...[...f2.state.filesystems.values()][0] ?? {}, id: share.id.split('/')[1], status: 'available' }), times: 1e9 });
        await expect(p2.deleteVolume(share.id, { intervalMs: 0, timeoutMs: 20 })).rejects.toThrow(/waiting for delete of filesystem sticky: available/);
        const { fake: f3, p: p3 } = make();
        const odd = await p3.createVolume({ name: 'odd', region: 'fr-par-2', sizeGb: 25, shared: true, ...fast });
        f3.intercept((r) => r.method === 'GET' && r.path.endsWith(odd.id.split('/')[1]), { answer: () => json(200, { ...f3.state.filesystems.get(odd.id.split('/')[1]), status: 'hibernating' }), times: 1 });
        expect(await p3.getVolume(odd.id)).toMatchObject({ status: 'unknown', providerStatus: 'hibernating' });
        expect(fileSystemMounts({ zone: 'fr-par-2' } as ScalewayServer)).toEqual([]);
    });

    it('a server record without filesystems, or a type without capabilities, attaches as one that has none', async () => {
        const { fake, p } = make();
        const share = await shareOf(p);
        const s = await p.waitUntilRunning((await p.createServer({ name: 'gpu-1', offer: GPU_FS, region: 'fr-par-2' })).id, fast);
        fake.intercept((r) => r.method === 'GET' && r.path.endsWith(`/servers/${s.raw.id}`), {
            answer: () => { const { filesystems: _f, ...rest } = fake.state.servers.get(`${s.raw.zone}/${s.raw.id}`); return json(200, { server: { ...rest, allowed_actions: [] } }); }, times: 1,
        });
        await p.attachVolume(share.id, s.id, fast);
        expect((await p.getServer(s.id))?.mounts).toEqual([{ volumeId: share.id, path: '/mnt/models' }]);
        const { fake: f2, p: p2 } = make();
        const share2 = await shareOf(p2);
        f2.intercept((r) => /\/products\/servers$/.test(r.path), {
            answer: (r) => { const body: any = { servers: {} }; for (const [k, v] of Object.entries<any>(SERVER_TYPES)) body.servers[k] = k === GPU_FS ? { ...v, capabilities: undefined } : v; return json(200, body, 'application/json', { 'x-total-count': String(Object.keys(body.servers).length) }); },
        });
        await expect(p2.createServer({ name: 'x', offer: GPU_FS, region: 'fr-par-2', mounts: [{ volume: share2 }] })).rejects.toThrow(/it attaches 0/);
    });

    it('an attachment whose server cannot be read in time is a timeout that says it was never read', async () => {
        const { fake, p } = make();
        const share = await shareOf(p);
        const s = await p.waitUntilRunning((await p.createServer({ name: 'gpu-1', offer: GPU_FS, region: 'fr-par-2' })).id, fast);
        fake.intercept((r) => r.method === 'GET' && r.path.endsWith(`/servers/${s.raw.id}`), { answer: () => json(503, { message: 'busy' }), times: 1e9 });
        await expect(p.api.fileSystemState(s.raw.zone, s.raw.id, share.id.split('/')[1], 'available', { intervalMs: 0, timeoutMs: 20 })).rejects.toThrow(/still unread, not available/);
    });

    it('waits for an attachment until it settles: one that never does is a timeout; one that goes instead is an error', async () => {
        const { fake, p } = make();
        const share = await shareOf(p);
        const s = await p.waitUntilRunning((await p.createServer({ name: 'gpu-1', offer: GPU_FS, region: 'fr-par-2' })).id, fast);
        const [zone, id] = [s.raw.zone, s.raw.id];
        const fsId = share.id.split('/')[1];
        fake.intercept((r) => r.method === 'GET' && r.path.endsWith(`/servers/${id}`), {
            answer: () => json(200, { server: { ...fake.state.servers.get(`${zone}/${id}`), filesystems: [{ filesystem_id: fsId, state: 'attaching' }], allowed_actions: [] } }), times: 1e9,
        });
        await expect(p.api.fileSystemState(zone as ScalewayZone, id, fsId, 'available', { intervalMs: 0, timeoutMs: 20 })).rejects.toThrow(/still attaching, not available/);
        const { fake: f2, p: p2 } = make();
        const s2 = await p2.waitUntilRunning((await p2.createServer({ name: 'gpu-2', offer: GPU_FS, region: 'fr-par-2' })).id, fast);
        await expect(p2.api.fileSystemState(s2.raw.zone, s2.raw.id, fsId, 'available', fast)).rejects.toThrow(/is no longer attached/);
        expect(f2).toBeTruthy();
    });
});

describe('Scaleway image import: a QCOW2 from a URL, through a bucket of its own, imported as a Block snapshot and imaged', () => {
    const ACCESS = 'SCWFAKEACCESSKEY0000';
    const withKey = (o: FakeScalewayOptions = {}) => make(o, { accessKey: ACCESS });
    const URL_OK = 'https://cloud-images.example.com/noble-minimal.qcow2';
    const blockCalls = (fake: Fake) => fake.calls.filter((c) => /import-from-object-storage|\/images$|s3\./.test(`${c.host}${c.path}`) && c.method !== 'GET')
        .map((c) => `${c.method} ${c.host?.startsWith('s3.') ? `s3 ${c.path.replace(/asap-vps-tmp-[0-9a-f]+/, '<bucket>')}` : c.path.replace(/[0-9a-f-]{36}/g, '<id>')}`);

    it('downloads the file (its server serves no ranges), puts it in a bucket made for it (streamed, its MD5 checked), imports it, images it, and deletes the bucket', async () => {
        const { fake, p } = withKey();
        const image = await p.importImage({ name: 'noble-min', url: URL_OK, region: 'fr-par-2', providerOptions: { tags: ['imported'] }, ...fast });
        expect(blockCalls(fake)).toEqual([
            'PUT s3 /<bucket>', 'PUT s3 /<bucket>/image.qcow2', 'POST /block/v1/zones/fr-par-2/snapshots/import-from-object-storage', 'POST /instance/v1/zones/fr-par-2/images',
            'DELETE s3 /<bucket>/image.qcow2', 'DELETE s3 /<bucket>',
        ]);
        const put = fake.state.s3['fr-par'].calls.find((c) => c.method === 'PUT' && c.path.endsWith('/image.qcow2'))!;
        expect([put.payloadHash, put.duplex]).toEqual(['UNSIGNED-PAYLOAD', 'half']);
        // Asked for its size and ranges first (it has none), then downloaded whole.
        expect(fake.calls.filter((c) => c.host === 'cloud-images.example.com').map((c) => c.method)).toEqual(['HEAD', 'GET']);
        expect(fake.state.s3['fr-par'].buckets.size).toBe(0);
        expect(image).toMatchObject({ provider: 'scaleway', name: 'noble-min', status: 'available', regions: ['fr-par-2'] });
        expect(image.raw).toMatchObject({ arch: 'x86_64', root_volume: { volume_type: 'sbs_snapshot' }, tags: ['imported'] });
        // Its root, a Block snapshot of the zone's, named as it is.
        expect((await p.api.listBlockSnapshots('fr-par-2')).map((x) => [x.id, x.name])).toEqual([[image.raw.root_volume!.id, 'noble-min']]);
        // One of the account's images, booted like any other.
        const s = await p.createServer({ name: 'from-import', offer: 'DEV1-S', region: 'fr-par-2', image: image.id });
        expect((await p.waitUntilRunning(s.id, fast)).status).toBe('running');
    });

    it('a file whose server serves ranges goes straight from it into the bucket, a range a part, several at a time: nothing downloaded here first', async () => {
        const { fake, p } = withKey();
        const image = await p.importImage({ name: 'big', url: 'https://cloud-images.example.com/ranged-big-noble.qcow2', region: 'fr-par-2', ...fast });
        expect(image.status).toBe('available');
        const file = fake.calls.filter((c) => c.host === 'cloud-images.example.com');
        // 20 MiB in parts of 16 MiB: two ranges, no whole download.
        expect(file.map((c) => `${c.method} ${c.headers?.range ?? ''}`.trim()).sort()).toEqual(['GET bytes=0-16777215', 'GET bytes=16777216-20971519', 'HEAD']);
        const s3 = fake.state.s3['fr-par'].calls.map((c) => `${c.method} ${c.query.replace(/=[0-9a-f]{24}/, '=<id>')}`);
        expect(s3).toEqual(expect.arrayContaining(['POST ?uploads=', 'PUT ?partNumber=1&uploadId=<id>', 'PUT ?partNumber=2&uploadId=<id>', 'POST ?uploadId=<id>']));
        expect([fake.state.s3['fr-par'].buckets.size, fake.state.s3['fr-par'].uploads.size]).toEqual([0, 0]);
    });

    it('refuses before anything is made: no access key, a URL that is no file\'s', async () => {
        const { fake, p } = make();
        await expect(p.importImage({ name: 'x', url: URL_OK, region: 'fr-par-2' })).rejects.toThrow(/needs the API key's access key: pass accessKey \(SCW_ACCESS_KEY\)/);
        const { p: q } = withKey();
        for (const url of ['s3://bucket/x.qcow2', 'https://example.com', 'disk.qcow2']) await expect(q.importImage({ name: 'x', url, region: 'fr-par-2' })).rejects.toThrow(/http\(s\) URL of a file/);
        expect(blockCalls(fake)).toEqual([]);
    });

    it('a download that fails, a file Scaleway cannot read, an image that errors: each thrown, and nothing left (bucket, snapshot, image)', async () => {
        const { fake, p } = withKey();
        await expect(p.importImage({ name: 'gone', url: 'https://cloud-images.example.com/missing.qcow2', region: 'fr-par-2', ...fast })).rejects.toThrow(/missing\.qcow2: 404 Not Found/);
        await expect(p.importImage({ name: 'bad', url: 'https://cloud-images.example.com/corrupt.qcow2', region: 'fr-par-2', ...fast })).rejects.toThrow(/the import of bad is error: Scaleway could not read the file/);
        fake.intercept((r) => r.method === 'GET' && /\/images\/[0-9a-f-]{36}$/.test(r.path), { answer: (r) => json(200, { image: { ...fake.state.images.get(r.path.split('/').pop()!), state: 'error' } }), times: 1 });
        await expect(p.importImage({ name: 'broken', url: URL_OK, region: 'fr-par-2', ...fast })).rejects.toThrow(/of broken is error, not available/);
        fake.intercept((r) => r.method === 'GET' && /\/snapshots\/[0-9a-f-]{36}$/.test(r.path), { answer: () => json(404, { type: 'not_found', message: 'gone' }), times: 1 });
        await expect(p.importImage({ name: 'vanishes', url: URL_OK, region: 'fr-par-2', ...fast })).rejects.toThrow(/the snapshot of vanishes disappeared/);
        expect(fake.state.s3['fr-par'].buckets.size).toBe(0);
        expect([...fake.state.snapshots.values()].filter((x) => ['gone', 'bad', 'broken', 'vanishes'].includes(x.name))).toEqual([]);
        expect([...fake.state.images.values()].filter((x) => x.name === 'broken')).toEqual([]);
    });

    it('waits with its own defaults', async () => {
        const { p } = withKey();
        expect((await p.importImage({ name: 'defaults', url: URL_OK, region: 'fr-par-2' })).status).toBe('available');
    });

    it('an import or an image that never ends times out saying what it last saw, and leaves nothing; an image that goes is thrown; a cleanup refused is named, left_behind', async () => {
        const { fake, p } = withKey();
        const slow = { intervalMs: 0, timeoutMs: 20 };
        const refused = () => json(403, { type: 'permissions_denied', message: 'insufficient permissions', details: [] });
        fake.intercept((r) => r.method === 'POST' && r.path.endsWith('/import-from-object-storage'), {
            after: () => { for (const x of fake.state.snapshots.values()) if (x.status === 'creating') x.left = 1e9; }, times: 1,
        });
        await expect(p.importImage({ name: 'slow-import', url: URL_OK, region: 'fr-par-2', ...slow })).rejects.toThrow(/timed out after 0 s waiting for import of slow-import: creating/);
        fake.intercept((r) => r.method === 'POST' && r.path === '/instance/v1/zones/fr-par-2/images', {
            after: () => { for (const x of fake.state.images.values()) if (x.state === 'creating') x.left = 1e9; }, times: 1,
        });
        await expect(p.importImage({ name: 'slow-image', url: URL_OK, region: 'fr-par-2', ...slow })).rejects.toThrow(/timed out after 0 s waiting for image fr-par-2\/[0-9a-f-]{36}: creating/);
        // Neither the import that never ended nor the image that never did is left: no snapshot, no image.
        expect([...fake.state.snapshots.values()].filter((x) => ['slow-import', 'slow-image'].includes(x.name))).toEqual([]);
        expect([...fake.state.images.values()].filter((x) => x.name === 'slow-image')).toEqual([]);
        fake.intercept((r) => r.method === 'GET' && /\/images\/[0-9a-f-]{36}$/.test(r.path), { answer: () => json(404, { type: 'not_found', message: 'gone' }), times: 1 });
        await expect(p.importImage({ name: 'vanished', url: URL_OK, region: 'fr-par-2', ...fast })).rejects.toThrow(/of vanished is gone, not available/);
        // The snapshot of a file Scaleway cannot read, an image that errors: their deletes refused, each is named with the failure (left_behind).
        fake.intercept((r) => r.method === 'DELETE' && r.path.startsWith('/block/v1/zones/fr-par-2/snapshots/'), { answer: refused, times: 1 });
        const bad = p.importImage({ name: 'bad', url: 'https://cloud-images.example.com/corrupt.qcow2', region: 'fr-par-2', ...fast });
        await expect(bad).rejects.toThrow(/the import of bad is error: .*; and snapshot fr-par-2\/[0-9a-f-]{36}, made for it, is not deleted \(.*insufficient permissions.*\)/);
        await expect(bad).rejects.toMatchObject({ code: 'left_behind' });
        fake.intercept((r) => r.method === 'GET' && /\/images\/[0-9a-f-]{36}$/.test(r.path), { answer: (r) => json(200, { image: { ...fake.state.images.get(r.path.split('/').pop()!), state: 'error' } }), times: 1 });
        fake.intercept((r) => r.method === 'DELETE' && /\/images\/[0-9a-f-]{36}$/.test(r.path), { answer: refused, times: 1 });
        const broken = p.importImage({ name: 'broken', url: URL_OK, region: 'fr-par-2', ...fast });
        await expect(broken).rejects.toThrow(/of broken is error, not available; and image fr-par-2\/[0-9a-f-]{36} and snapshot fr-par-2\/[0-9a-f-]{36}, made for it, is not deleted/);
        await expect(broken).rejects.toMatchObject({ code: 'left_behind' });
        expect(fake.state.s3['fr-par'].buckets.size).toBe(0);
    });

    it('a temporary bucket Object Storage will not delete is left (asap-vps-tmp-…), not thrown: the import and its copy are made', async () => {
        const { fake } = withKey();
        // Object Storage refuses every bucket delete (its objects go).
        const fetchImpl = (async (url: string, init?: RequestInit) => {
            const u = new URL(url);
            if (u.host.startsWith('s3.') && init?.method === 'DELETE' && !u.pathname.slice(1).includes('/')) {
                return new Response('<Error><Code>AccessDenied</Code><Message>Access Denied</Message></Error>', { status: 403, headers: { 'content-type': 'application/xml' } });
            }
            return fake.fetchImpl(url, init);
        }) as unknown as typeof fetch;
        const p = new Scaleway({ apiKey: 'scw-test', projectId: FAKE_SCALEWAY_PROJECT, accessKey: ACCESS, fetchImpl, sleep: noSleep });
        const image = await p.importImage({ name: 'kept', url: URL_OK, region: 'fr-par-2', ...fast });
        expect(image.status).toBe('available');
        expect((await p.copyImage(image.id, ['pl-waw-2'], fast)).regions).toEqual(['fr-par-2', 'pl-waw-2']);
        const left = Object.entries(fake.state.s3).flatMap(([region, x]) => [...x.buckets.entries()].map(([name, objects]) => [region, name, objects.size]));
        expect(left).toEqual([
            ['fr-par', expect.stringMatching(/^asap-vps-tmp-[0-9a-f]{12}$/), 0], ['fr-par', expect.stringMatching(/^asap-vps-tmp-[0-9a-f]{12}$/), 0],
            ['pl-waw', expect.stringMatching(/^asap-vps-tmp-[0-9a-f]{12}$/), 0],
        ]);
    });
});
