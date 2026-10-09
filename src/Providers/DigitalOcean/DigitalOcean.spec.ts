// DigitalOcean against the fake of DigitalOcean's API v2
// (src/testing/fakes/digitalocean.ts): what is particular to GPU droplets beyond
// the shared contract (../contract.spec.ts). From the API spec
// (DigitalOcean-public.v2.yaml, checked 2026-09-29): GPU droplets are listed only
// with ?type=gpus; an action locks the droplet until it completes; stop is a
// clean shutdown first; 8-GPU sizes take the 8-GPU image; "no stock" has more
// than one wording. Images are droplet snapshots: region-bound, copied to more
// regions by transfer, and listed with the account's other images. CPU sizes
// come only with `includeCpu`: prepare a GPU image on a cheap machine, then
// boot it on GPUs.

import { execFileSync } from 'child_process';
import type { ICompute } from '../../capabilities';
import { REGION_TYPES } from '../../constants';
import { containerBootScript } from '../../Core/utils';
import { CapacityError, NotFoundError, NotSupportedError, ProviderError, QuotaError } from '../../errors';
import { fakeDigitalOcean } from '../../testing/fakes/digitalocean';
import { json } from '../../testing/fakes/util';
import { DigitalOcean } from './DigitalOcean';

const noSleep = async () => {};
const fast = { intervalMs: 0, timeoutMs: 5000 };

/**
 * A provider whose waits take no time and move its clock (Date.now) on by what
 * they waited, each on record: a default timeout is reached at once. A wait
 * that would never end stops at 10 000 pauses.
 */
function clocked(o: Parameters<typeof fakeDigitalOcean>[0] = {}, wrap: (f: typeof fetch) => typeof fetch = (f) => f) {
    const fake = fakeDigitalOcean(o);
    let now = Date.parse('2026-10-09T00:00:00Z');
    const slept: number[] = [];
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    const sleep = async (ms: number) => {
        slept.push(ms);
        if (slept.length > 10_000) throw new Error('a wait without end');
        now += ms;
    };
    return { fake, slept, p: new DigitalOcean({ apiKey: 'do-test', fetchImpl: wrap(fake.fetchImpl), sleep }) };
}

/** A request as `METHOD path`, an action's id left out. */
const asked = (c: { method: string, path: string }) => `${c.method} ${c.path}`.replace(/^GET \/v2\/actions\/\d+$/, 'GET /v2/actions/:id');

afterEach(() => jest.restoreAllMocks());

describe('DigitalOcean', () => {
    const make = (o: Parameters<typeof fakeDigitalOcean>[0] = {}) => {
        const fake = fakeDigitalOcean(o);
        return { fake, p: new DigitalOcean({ apiKey: 'do-test', fetchImpl: fake.fetchImpl, sleep: noSleep }) };
    };

    it('reads every page of sizes; its GPU sizes with VRAM per GPU', async () => {
        const { p } = make();
        const offers = await p.listOffers({ kind: 'gpu', includeUnavailable: true });
        expect(offers.map((o) => o.id).sort()).toEqual(['gpu-4000adax1-20gb', 'gpu-6000adax1-48gb', 'gpu-h100x8-640gb', 'gpu-l40sx1-48gb', 'gpu-mi300x1-192gb']);
        expect(offers.find((o) => o.id === 'gpu-h100x8-640gb')).toMatchObject({ gpu: 'H100', gpuCount: 8, vramGb: 80, vendor: 'nvidia' });
        expect(offers.find((o) => o.id === 'gpu-mi300x1-192gb')).toMatchObject({ gpu: 'MI300X', vendor: 'amd', regions: ['atl1'] });
    });

    it('lists GPU droplets by kind: the account\'s other droplets are not GPU servers', async () => {
        const { p, fake } = make();
        const s = await p.createServer({ name: 'gpu-1', offer: 'gpu-4000adax1-20gb', region: 'tor1' });
        expect(fake.liveServers()).toBe(3);
        expect((await p.listServers({ kind: 'gpu' })).map((x) => x.id)).toEqual([s.id]);
    });

    it('defaults to DigitalOcean\'s GPU image for the size\'s vendor', async () => {
        const { p, fake } = make();
        await p.createServer({ name: 'nv', offer: 'gpu-4000adax1-20gb', region: 'tor1' });
        await p.createServer({ name: 'amd', offer: 'gpu-mi300x1-192gb', region: 'atl1' });
        const images = fake.calls.filter((c) => c.method === 'POST' && c.path === '/v2/droplets').map((c) => c.body.image);
        expect(images).toEqual([DigitalOcean.NVIDIA_IMAGE, DigitalOcean.AMD_IMAGE]);
    });

    it('the droplet limit is a QuotaError; an image missing from the region is not a capacity problem', async () => {
        let { p } = make({ dropletLimit: 2 });
        await expect(p.createServer({ name: 'x', offer: 'gpu-4000adax1-20gb', region: 'tor1' })).rejects.toBeInstanceOf(QuotaError);
        ({ p } = make());
        const e = await p.createServer({ name: 'x', offer: 'gpu-4000adax1-20gb', region: 'tor1', image: '12345' }).catch((x) => x);
        expect(e).toBeInstanceOf(ProviderError);
        expect(e).not.toBeInstanceOf(CapacityError);
        expect(e.message).toMatch(/image is not available/);
    });

    it('reads a GPU count from a size id\'s "x<count>" (gpuCountOf); an id that is not a GPU size\'s, or names no count, has none', () => {
        expect(['gpu-h100x8-640gb', 'gpu-mi300x1-192gb', 'gpu-4000adax1-20gb', 'gpu-b300x16-4608gb'].map((id) => DigitalOcean.gpuCountOf(id))).toEqual([8, 1, 1, 16]);
        expect(['s-8vcpu-16gb', 'gpu-b300-288gb', 'eu-gpu-h100x8-640gb'].map((id) => DigitalOcean.gpuCountOf(id))).toEqual([undefined, undefined, undefined]);
    });

    it('gpuCount with an offer id is held to the count the id names: a plain size has none, and a GPU size whose id names no count cannot be checked; nothing is sent', async () => {
        const { p, fake } = make();
        await expect(p.createServer({ name: 'x8', offer: 'gpu-h100x8-640gb', region: 'nyc2', gpuCount: 1 }))
            .rejects.toThrow('digitalocean: createServer option "gpuCount" 1: this offer has 8 GPU(s); pick an offer with 1');
        await expect(p.createServer({ name: 'cpu', offer: 's-8vcpu-16gb', region: 'nyc1', gpuCount: 1 }))
            .rejects.toThrow('digitalocean: createServer option "gpuCount" 1: this offer has 0 GPU(s); pick an offer with 1');
        await expect(p.createServer({ name: 'b300', offer: 'gpu-b300-288gb', region: 'nyc2', gpuCount: 1 }))
            .rejects.toThrow('digitalocean: createServer option "gpuCount" with an offer id (pass the offer itself, whose GPU count is fixed)');
        expect(fake.calls).toEqual([]);
        await expect(p.createServer({ name: 'x8', offer: 'gpu-h100x8-640gb', region: 'nyc2', gpuCount: 8 })).resolves.toMatchObject({ name: 'x8', offerId: 'gpu-h100x8-640gb' });
    });

    it('a container on a size named by its id gets the GPUs where the id is a GPU size\'s, its count named or not, and none on a plain size', async () => {
        const { p, fake } = make();
        // A GPU size whose id names no count.
        fake.state.sizes.push({ slug: 'gpu-b300-288gb', price_hourly: 9.9, available: true, regions: ['nyc2'], vcpus: 32, memory: 262144, disk: 1000,
            gpu_info: { count: 1, vram: { amount: 288, unit: 'gib' }, model: 'nvidia_b300' } });
        const container = { image: 'busybox' };
        for (const [offer, region, gpu] of [['s-8vcpu-16gb', 'nyc1', false], ['gpu-4000adax1-20gb', 'tor1', true], ['gpu-b300-288gb', 'nyc2', true]] as const) {
            await p.createServer({ name: `c-${offer}`, offer, region, container });
            expect(fake.calls.filter((c) => c.method === 'POST' && c.path === '/v2/droplets').pop()?.body.user_data).toBe(containerBootScript(container, { gpu }));
        }
    });

    it('a droplet needs a region, and a provider needs a key: nothing is sent without them', async () => {
        const { p, fake } = make();
        await expect(p.createServer({ name: 'x', offer: 'gpu-4000adax1-20gb' })).rejects.toThrow(/needs a region/);
        expect(fake.calls).toHaveLength(0);
        expect(() => new DigitalOcean('')).toThrow(/API key is required/);
    });
});

describe('DigitalOcean API facts', () => {
    const make = (o: Parameters<typeof fakeDigitalOcean>[0] = {}) => {
        const fake = fakeDigitalOcean(o);
        return { fake, p: new DigitalOcean({ apiKey: 'do-test', fetchImpl: fake.fetchImpl, sleep: noSleep }) };
    };
    const running = async (p: DigitalOcean, id: string) => p.waitUntilRunning(id, { intervalMs: 0, timeoutMs: 2000 });

    it('San Francisco is sfo3, the datacenter that takes new droplets; the legacy sfo1 only by its own name', async () => {
        const { p, fake } = make();
        fake.state.sizes.find((x) => x.slug === 's-8vcpu-16gb')!.regions.push('sfo3', 'sfo1');
        const regions = async (region: REGION_TYPES) => (await p.createServer({ name: `in-${region}`.replace(/_/g, '-'), offer: 's-8vcpu-16gb', region })).region;
        expect(await regions(REGION_TYPES.SAN_FRANCISCO)).toBe('sfo3');
        expect(await regions(REGION_TYPES.SAN_FRANCISCO_3)).toBe('sfo3');
        expect(await regions(REGION_TYPES.SAN_FRANCISCO_1)).toBe('sfo1');
    });

    it('a droplet names its GPU as its offer does, a model asap-vps does not know included', async () => {
        const { p, fake } = make();
        fake.state.sizes.push({ slug: 'gpu-zz9x1-64gb', price_hourly: 2.5, available: true, regions: ['tor1'], vcpus: 8, memory: 65536, disk: 500,
            gpu_info: { count: 1, vram: { amount: 64, unit: 'gib' }, model: 'nvidia_zz9' } });
        const offers = await p.listOffers({ kind: 'gpu' });
        for (const id of ['gpu-zz9x1-64gb', 'gpu-4000adax1-20gb']) {
            const offer = offers.find((o) => o.id === id)!;
            const s = await running(p, (await p.createServer({ name: `as-${id}`, offer })).id);
            expect([id, s.gpu, s.gpuCount]).toEqual([id, offer.gpu, offer.gpuCount]);
        }
        // DigitalOcean's own name for the model no table has; the canonical one for the other.
        expect(offers.find((o) => o.id === 'gpu-zz9x1-64gb')?.gpu).toBe('nvidia_zz9');
        expect(offers.find((o) => o.id === 'gpu-4000adax1-20gb')?.gpu).toBe('RTX 4000 Ada');
    });

    it('finds GPU droplets through ?type=gpus: the plain list never holds them', async () => {
        const { p, fake } = make();
        const s = await p.createServer({ name: 'gpu-1', offer: 'gpu-4000adax1-20gb', region: 'tor1' });
        expect((await p.listServers({ kind: 'gpu' })).map((x) => x.id)).toEqual([s.id]);
        expect(fake.calls.some((c) => c.method === 'GET' && c.path.startsWith('/v2/droplets?type=gpus'))).toBe(true);
        // What the plain list says, which is how a GPU droplet used to go unseen:
        const plain = await fake.fetchImpl('https://api.digitalocean.com/v2/droplets', { headers: { authorization: 'Bearer do-test' } });
        expect(((await plain.json()) as any).droplets.map((d: any) => String(d.id))).not.toContain(s.id);
        // By default both lists are merged, each droplet once.
        const all = await p.listServers();
        expect(all.filter((x) => x.id === s.id)).toHaveLength(1);
        expect(all.map((x) => x.name).sort()).toEqual(['api-1', 'gpu-1', 'mail.example.com']);
    });

    it('waits for each action: stop then start both succeed on a droplet DigitalOcean locks while one runs', async () => {
        const { p, fake } = make();
        const s = await p.createServer({ name: 'gpu-2', offer: 'gpu-4000adax1-20gb', region: 'tor1' });
        await running(p, s.id);
        await p.stopServer(s.id);
        expect((await p.getServer(s.id))?.status).toBe('stopped');
        await p.startServer(s.id);
        expect((await p.getServer(s.id))?.status).toBe('running');
        const types = fake.calls.filter((c) => c.method === 'POST' && c.path.endsWith('/actions')).map((c) => c.body.type);
        expect(types).toEqual(['shutdown', 'power_on']); // a clean shutdown, not a hard power-off
        await p.stopServer(s.id);
        await p.stopServer(s.id); // already off: nothing sent
        expect(fake.calls.filter((c) => c.method === 'POST' && c.path.endsWith('/actions')).map((c) => c.body.type)).toEqual(['shutdown', 'power_on', 'shutdown']);
    });

    it('falls back to a hard power-off when the clean shutdown errors', async () => {
        const { p, fake } = make({ failShutdown: true });
        const s = await p.createServer({ name: 'gpu-3', offer: 'gpu-4000adax1-20gb', region: 'tor1' });
        await running(p, s.id);
        await p.stopServer(s.id);
        expect((await p.getServer(s.id))?.status).toBe('stopped');
        expect(fake.calls.filter((c) => c.method === 'POST' && c.path.endsWith('/actions')).map((c) => c.body.type)).toEqual(['shutdown', 'power_off']);
    });

    it('a shutdown that completes without turning the droplet off (its guest ignored it) is followed by a hard power-off', async () => {
        const { p, fake } = make({ ignoreShutdown: true });
        const s = await p.createServer({ name: 'gpu-4', offer: 'gpu-4000adax1-20gb', region: 'tor1' });
        await running(p, s.id);
        await p.stopServer(s.id);
        expect((await p.getServer(s.id))?.status).toBe('stopped');
        expect(fake.calls.filter((c) => c.method === 'POST' && c.path.endsWith('/actions')).map((c) => c.body.type)).toEqual(['shutdown', 'power_off']);
    });

    it('stopping a droplet that does not exist, or one deleted while it shuts down, is a NotFoundError that names it, and no power-off is asked for', async () => {
        const fake = fakeDigitalOcean();
        // Deleted (elsewhere) the moment its shutdown completes.
        const deleting = (async (url: string, init?: RequestInit) => {
            const r = await fake.fetchImpl(url, init);
            const m = /^\/v2\/actions\/(\d+)$/.exec(new URL(url).pathname);
            const a = m ? fake.state.actions.get(m[1]) : undefined;
            if (a?.type === 'shutdown' && a.status === 'completed') fake.state.droplets.delete(String(a.dropletId));
            return r;
        }) as typeof fetch;
        const p = new DigitalOcean({ apiKey: 'do-test', fetchImpl: deleting, sleep: noSleep });
        const missing = await p.stopServer('999999').catch((x) => x);
        expect(missing).toBeInstanceOf(NotFoundError);
        expect(missing.message).toBe('digitalocean: no droplet 999999');
        const s = await running(p, (await p.createServer({ name: 'gpu-5', offer: 'gpu-4000adax1-20gb', region: 'tor1' })).id);
        const gone = await p.stopServer(s.id).catch((x) => x);
        expect(gone).toBeInstanceOf(NotFoundError);
        expect(gone.message).toBe(`digitalocean: droplet ${s.id} is gone`);
        expect(fake.calls.filter((c) => c.method === 'POST' && c.path.endsWith('/actions')).map((c) => c.body.type)).toEqual(['shutdown']);
    });

    it('defaults 8-GPU NVIDIA sizes to the 8-GPU image', async () => {
        const { p, fake } = make();
        await p.createServer({ name: 'x8', offer: 'gpu-h100x8-640gb', region: 'nyc2' });
        expect(fake.calls.find((c) => c.method === 'POST' && c.path === '/v2/droplets')?.body.image).toBe('gpu-h100x8-base');
        expect(DigitalOcean.defaultImage('gpu-4000adax1-20gb')).toBe('gpu-h100x1-base');
        expect(DigitalOcean.defaultImage('gpu-mi300x1-192gb')).toBe('gpu-amd-base');
    });

    it('reads every known "no stock" wording as a capacity refusal, and a missing image as not one', async () => {
        const answer = (message: string) => (async () => new Response(JSON.stringify({ id: 'unprocessable_entity', message }), { status: 422 })) as unknown as typeof fetch;
        for (const message of ['Size is not available in this region.', 'This size is unavailable.', 'Region is not available', 'creation is temporarily disabled in this region']) {
            const p = new DigitalOcean({ apiKey: 'k', fetchImpl: answer(message), sleep: noSleep });
            await expect(p.createServer({ name: 'x', offer: 'gpu-4000adax1-20gb', region: 'tor1' })).rejects.toBeInstanceOf(CapacityError);
        }
        const img = new DigitalOcean({ apiKey: 'k', fetchImpl: answer('The image is not available in the requested region.'), sleep: noSleep });
        const e = await img.createServer({ name: 'x', offer: 'gpu-4000adax1-20gb', region: 'tor1', image: '1' }).catch((x) => x);
        expect(e).toBeInstanceOf(ProviderError);
        expect(e).not.toBeInstanceOf(CapacityError);
    });
});

describe('DigitalOcean images (droplet snapshots)', () => {
    const make = (o: Parameters<typeof fakeDigitalOcean>[0] = {}) => {
        const fake = fakeDigitalOcean(o);
        return { fake, p: new DigitalOcean({ apiKey: 'do-test', fetchImpl: fake.fetchImpl, sleep: noSleep }) };
    };
    const baked = async (p: DigitalOcean) => {
        const s = await p.createServer({ name: 'bake-1', offer: 'gpu-4000adax1-20gb', region: 'tor1' });
        await p.stopServer(s.id);
        const img = await p.createImage(s.id, { name: 'worker-r1', ...fast });
        return { s, img };
    };

    it('captures a server, waits for the snapshot, and reports it in the server\'s region', async () => {
        const { p, fake } = make();
        const { s, img } = await baked(p);
        expect(img).toMatchObject({ provider: 'digitalocean', name: 'worker-r1', status: 'available', regions: ['tor1'], sizeGb: 23.25 });
        expect(await p.getImage(img.id)).toMatchObject({ id: img.id, name: 'worker-r1', status: 'available', regions: ['tor1'] });
        // The snapshot was asked of THIS droplet, and waited for through its action.
        const asked = fake.calls.find((c) => c.method === 'POST' && c.path === `/v2/droplets/${s.id}/actions` && c.body.type === 'snapshot');
        expect(asked?.body).toEqual({ type: 'snapshot', name: 'worker-r1' });
        expect(fake.calls.some((c) => c.method === 'GET' && /^\/v2\/actions\/\d+$/.test(c.path))).toBe(true);
    });

    it('boots new servers from the image where it is, and refuses elsewhere without calling it a capacity problem', async () => {
        const { p, fake } = make();
        const { s, img } = await baked(p);
        await p.deleteServer(s.id);
        const boot = await p.createServer({ name: 'from-image', offer: 'gpu-4000adax1-20gb', region: 'tor1', image: img.id });
        expect(boot.name).toBe('from-image');
        expect(fake.calls.find((c) => c.method === 'POST' && c.path === '/v2/droplets' && c.body.name === 'from-image')?.body.image).toBe(Number(img.id));
        const e = await p.createServer({ name: 'elsewhere', offer: 'gpu-6000adax1-48gb', region: 'nyc2', image: img.id }).catch((x) => x);
        expect(e).toBeInstanceOf(ProviderError);
        expect(e).not.toBeInstanceOf(CapacityError);
        expect(e.message).toMatch(/image is not available/);
    });

    it('copies a region-bound image to more regions (one transfer per missing region), then boots there', async () => {
        const { p, fake } = make();
        const { img } = await baked(p);
        const copied = await p.copyImage(img.id, ['nyc2', 'tor1', 'nyc2'], fast);
        expect([...copied.regions].sort()).toEqual(['nyc2', 'tor1']);
        const transfers = fake.calls.filter((c) => c.method === 'POST' && c.path === `/v2/images/${img.id}/actions`);
        expect(transfers.map((c) => c.body)).toEqual([{ type: 'transfer', region: 'nyc2' }]);
        await expect(p.createServer({ name: 'in-nyc2', offer: 'gpu-6000adax1-48gb', region: 'nyc2', image: img.id })).resolves.toMatchObject({ name: 'in-nyc2' });
        // Already everywhere asked: no transfer at all.
        await p.copyImage(img.id, ['tor1'], fast);
        expect(fake.calls.filter((c) => c.method === 'POST' && c.path === `/v2/images/${img.id}/actions`)).toHaveLength(1);
        // A region by the library's own name is sent as DigitalOcean's slug; one it is in already (Toronto) is no transfer.
        const more = await p.copyImage(img.id, [REGION_TYPES.NYC_3, REGION_TYPES.TORONTO], fast);
        expect([...more.regions].sort()).toEqual(['nyc2', 'nyc3', 'tor1']);
        expect(fake.calls.filter((c) => c.method === 'POST' && c.path === `/v2/images/${img.id}/actions`).map((c) => c.body.region)).toEqual(['nyc2', 'nyc3']);
        // A name DigitalOcean has no region by is its refusal, not a copy to nowhere.
        await expect(p.copyImage(img.id, ['mars1'], fast)).rejects.toThrow(/mars1 is not a valid region/);
    });

    it('lists every private image of the account, the ones that are not the caller\'s included', async () => {
        const { p, fake } = make();
        const { img } = await baked(p);
        const all = await p.listImages();
        expect(all.map((i) => i.id).sort()).toEqual([fake.backupImageId, img.id].sort());
        expect(all.find((i) => i.id === fake.backupImageId)).toMatchObject({ name: 'api-1 2026-09-01', status: 'available', regions: ['nyc1'] });
    });

    it('deletes idempotently; a deleted image is gone and cannot be copied', async () => {
        const { p } = make();
        const { img } = await baked(p);
        await p.deleteImage(img.id);
        await p.deleteImage(img.id);
        expect(await p.getImage(img.id)).toBeNull();
        await expect(p.copyImage(img.id, ['nyc2'], fast)).rejects.toBeInstanceOf(NotFoundError);
        await expect(p.copyImage(img.id, ['nyc2'], fast)).rejects.toThrow(`digitalocean: no image ${img.id}`);
    });

    it('an image deleted while it is copied is a NotFoundError that says so', async () => {
        const fake = fakeDigitalOcean();
        // Deleted (elsewhere) as soon as its transfer is asked for.
        const deleting = (async (url: string, init?: RequestInit) => {
            const r = await fake.fetchImpl(url, init);
            const m = /^\/v2\/images\/(\d+)\/actions$/.exec(new URL(url).pathname);
            if (init?.method === 'POST' && m) fake.state.images.delete(m[1]);
            return r;
        }) as typeof fetch;
        const p = new DigitalOcean({ apiKey: 'do-test', fetchImpl: deleting, sleep: noSleep });
        const { img } = await baked(p);
        const e = await p.copyImage(img.id, ['nyc2'], fast).catch((x) => x);
        expect(e).toBeInstanceOf(NotFoundError);
        expect(e.message).toBe(`digitalocean: image ${img.id} disappeared while it was copied`);
    });

    it('the snapshot made is the droplet\'s newest of that name; one the droplet does not list, or an action that errors, is an error that says so', async () => {
        const fake = fakeDigitalOcean();
        let answer: 'unlisted' | 'errored' | undefined;
        const wrapped = (async (url: string, init?: RequestInit) => {
            const path = new URL(url).pathname;
            if (answer === 'unlisted' && /^\/v2\/droplets\/\d+\/snapshots$/.test(path)) return json(200, { snapshots: [], links: {}, meta: { total: 0 } });
            const m = /^\/v2\/actions\/(\d+)$/.exec(path);
            if (answer === 'errored' && m && fake.state.actions.get(m[1])?.type === 'snapshot') return json(200, { action: { id: Number(m[1]), type: 'snapshot', status: 'errored' } });
            return fake.fetchImpl(url, init);
        }) as typeof fetch;
        const p = new DigitalOcean({ apiKey: 'do-test', fetchImpl: wrapped, sleep: noSleep });
        const s = await p.createServer({ name: 'bake-2', offer: 'gpu-4000adax1-20gb', region: 'tor1' });
        const older = await p.createImage(s.id, { name: 'nightly', ...fast });
        // A day older, and listed first.
        fake.state.images.get(older.id).created_at = '2026-01-01T00:00:00Z';
        const newer = await p.createImage(s.id, { name: 'nightly', ...fast });
        expect(newer.id).not.toBe(older.id);
        expect(newer.id).toBe(String(Math.max(...[...fake.state.images.values()].filter((i) => i.name === 'nightly').map((i) => i.id))));
        answer = 'unlisted';
        const unlisted = await p.createImage(s.id, { name: 'ghost', ...fast }).catch((x) => x);
        expect(unlisted).toBeInstanceOf(ProviderError);
        expect(unlisted.message).toBe(`digitalocean: snapshot "ghost" of droplet ${s.id} completed but is not listed`);
        answer = 'errored';
        const errored = await p.createImage(s.id, { name: 'broken', ...fast }).catch((x) => x);
        expect(errored).toBeInstanceOf(ProviderError);
        expect(errored.message).toMatch(/^digitalocean: action \d+ \(snapshot\) errored$/);
    });

    it('an image whose nullable fields are null (as the spec allows) reads with no size, never a null one', async () => {
        const { fake, p } = make();
        fake.state.images.set('777', { id: 777, name: 'bare', distribution: 'Ubuntu', slug: null, public: false, regions: ['nyc1'], created_at: '2026-09-01T00:00:00Z',
            min_disk_size: null, type: 'snapshot', size_gigabytes: null, description: '', tags: null, status: 'available' });
        const img = await p.getImage('777');
        expect(img).toMatchObject({ id: '777', name: 'bare', status: 'available', regions: ['nyc1'] });
        expect(img?.sizeGb).toBeUndefined();
        expect((await p.listImages()).find((i) => i.id === '777')?.sizeGb).toBeUndefined();
    });

    it('a snapshot that never completes times out instead of waiting forever', async () => {
        const { p } = make({ actionReads: 1_000_000 });
        const s = await p.createServer({ name: 'slow', offer: 'gpu-4000adax1-20gb', region: 'tor1' });
        await expect(p.createImage(s.id, { name: 'never', intervalMs: 0, timeoutMs: 30 })).rejects.toThrow(/timed out/);
    });

    it('a snapshot waits 30 min by default, reading its action every 10 s, then is a timeout naming the action and what it saw last', async () => {
        const { p, slept, fake } = clocked({ actionReads: 1e9 });
        const s = await p.waitUntilRunning((await p.createServer({ name: 'slow', offer: 'gpu-4000adax1-20gb', region: 'tor1' })).id);
        slept.length = 0;
        const e = await p.createImage(s.id, { name: 'never' }).catch((x) => x);
        const action = [...fake.state.actions.values()].find((a) => a.type === 'snapshot');
        expect(e).toBeInstanceOf(ProviderError);
        expect(e).toMatchObject({ code: 'timeout', message: `digitalocean: timed out after 1800 s waiting for action ${action.id}: snapshot in-progress` });
        expect(slept).toEqual(Array(180).fill(10_000));
    });
});

describe('DigitalOcean droplet actions: one at a time, its create the first', () => {
    const make = (o: Parameters<typeof fakeDigitalOcean>[0] = {}) => {
        const fake = fakeDigitalOcean(o);
        return { fake, p: new DigitalOcean({ apiKey: 'do-test', fetchImpl: fake.fetchImpl, sleep: noSleep }) };
    };
    const server = { offer: 'gpu-4000adax1-20gb', region: 'tor1' };

    it('an action asked for while the droplet is being created waits for the create to end (DigitalOcean refuses it meanwhile, and starts nothing)', async () => {
        const { fake, p } = make({ bootReads: 3 });
        const asks = (id: string) => fake.calls.filter((c) => c.method === 'POST' && c.path === `/v2/droplets/${id}/actions`).length;
        const a = await p.createServer({ name: 'a', ...server });
        await p.restartServer(a.id);
        expect(asks(a.id)).toBeGreaterThan(1);
        // Its first boot, then the reboot.
        expect(fake.state.droplets.get(a.id).boots).toBe(2);
        const b = await p.createServer({ name: 'b', ...server });
        await expect(p.createImage(b.id, { name: 'early', ...fast })).resolves.toMatchObject({ name: 'early', status: 'available' });
        const vol = await p.createVolume({ name: 'scratch', region: 'tor1', sizeGb: 10 });
        const c = await p.createServer({ name: 'c', ...server });
        await p.attachVolume(vol.id, c.id, fast);
        expect((await p.getVolume(vol.id))?.serverIds).toEqual([c.id]);
    });

    it('a pending event that outlasts the wait is a timeout, and the action is never started', async () => {
        const { fake, p } = make({ bootReads: 1e9 });
        const s = await p.createServer({ name: 'stuck', ...server });
        const e = await p.createImage(s.id, { name: 'never', intervalMs: 0, timeoutMs: 30 }).catch((x) => x);
        expect(e.message).toMatch(/timed out .* waiting for the droplet's pending event to end/);
        expect(e).toMatchObject({ code: 'timeout', message: 'digitalocean: timed out after 0 s waiting for the droplet\'s pending event to end, to ask for {"type":"snapshot","name":"never"}' });
        expect([...fake.state.actions.values()].filter((x) => x.type === 'snapshot')).toEqual([]);
    });

    it('a volume attach waits 10 min by default for the droplet\'s pending event to end, asking every 5 s, then is a timeout that says so', async () => {
        const { p, slept } = clocked({ bootReads: 1e9 });
        const vol = await p.createVolume({ name: 'scratch', region: 'tor1', sizeGb: 10 });
        const s = await p.createServer({ name: 'stuck', ...server });
        const e = await p.attachVolume(vol.id, s.id).catch((x) => x);
        expect(e).toBeInstanceOf(ProviderError);
        expect(e).toMatchObject({ code: 'timeout', message: `digitalocean: timed out after 600 s waiting for the droplet's pending event to end, to ask for {"type":"attach","droplet_id":${s.id},"region":"tor1"}` });
        expect(slept).toEqual(Array(120).fill(5000));
    });

    it('any other refusal of an action is thrown at once, asked once', async () => {
        const fake = fakeDigitalOcean();
        let asked = 0;
        const refuse = (async (url: string, init?: RequestInit) => {
            if (init?.method !== 'POST' || !/\/v2\/droplets\/\d+\/actions$/.test(new URL(url).pathname)) return fake.fetchImpl(url, init);
            asked++;
            return new Response(JSON.stringify({ id: 'unprocessable_entity', message: 'Droplet is in a state that does not allow this action.' }), { status: 422, headers: { 'content-type': 'application/json' } });
        }) as typeof fetch;
        const p = new DigitalOcean({ apiKey: 'do-test', fetchImpl: refuse, sleep: noSleep });
        const s = await p.waitUntilRunning((await p.createServer({ name: 'x', ...server })).id, fast);
        await expect(p.createImage(s.id, { name: 'x', intervalMs: 0, timeoutMs: 1000 })).rejects.toThrow(/does not allow this action/);
        expect(asked).toBe(1);
    });
});

describe('DigitalOcean image import (a custom image from a URL)', () => {
    const make = (o: Parameters<typeof fakeDigitalOcean>[0] = {}) => {
        const fake = fakeDigitalOcean(o);
        return { fake, p: new DigitalOcean({ apiKey: 'do-test', fetchImpl: fake.fetchImpl, sleep: noSleep }) };
    };
    const URL_OK = 'https://cloud-images.ubuntu.com/minimal/releases/noble/release/ubuntu-24.04-minimal-cloudimg-amd64.img';

    it('imports the file, waits until DigitalOcean has it, and boots a droplet from it in its region', async () => {
        const { fake, p } = make();
        const img = await p.importImage({ name: 'noble-min', url: URL_OK, region: REGION_TYPES.TORONTO, providerOptions: { distribution: 'Ubuntu' }, ...fast });
        expect(fake.calls.find((c) => c.method === 'POST' && c.path === '/v2/images')?.body).toEqual({ name: 'noble-min', url: URL_OK, region: 'tor1', distribution: 'Ubuntu' });
        expect(img).toMatchObject({ provider: 'digitalocean', name: 'noble-min', status: 'available', providerStatus: 'available', regions: ['tor1'], sizeGb: 2.36 });
        expect(img.raw).toMatchObject({ type: 'custom', distribution: 'Ubuntu' });
        expect((await p.listImages()).map((i) => i.id)).toContain(img.id);
        const s = await p.createServer({ name: 'from-import', offer: 's-8vcpu-16gb', region: 'tor1', image: img.id });
        expect((await p.waitUntilRunning(s.id, fast)).status).toBe('running');
    });

    it('a file DigitalOcean cannot read fails with its message, and leaves nothing: not listed, gone to getImage, deleted again without error', async () => {
        const { p } = make();
        const err = await p.importImage({ name: 'bad', url: 'https://example.com/corrupt.img.gz', region: 'tor1', ...fast }).catch((e) => e);
        expect(err).toBeInstanceOf(ProviderError);
        expect(err.message).toMatch(/import of bad from https:\/\/example\.com\/corrupt\.img\.gz failed: We had a problem decompressing your file/);
        expect((await p.listImages()).map((i) => i.name)).not.toContain('bad');
        const id = String((await p.api.all<{ id: number, name: string }>('/v2/images?private=true', 'images')).find((i) => i.name === 'bad')!.id);
        expect(await p.getImage(id)).toBeNull();
        await expect(p.deleteImage(id)).resolves.toBeUndefined();
    });

    it('an import that outlasts the wait is deleted, so it does not bill, and the error says so', async () => {
        const { p } = make({ importReads: 1e9 });
        await expect(p.importImage({ name: 'slow', url: URL_OK, region: 'tor1', intervalMs: 0, timeoutMs: 30 })).rejects.toThrow(/import of slow .*timed out.*\(the import was deleted\)/);
        expect(await p.listImages()).toEqual(expect.not.arrayContaining([expect.objectContaining({ name: 'slow' })]));
    });

    it('imports from an http or an ftp URL too', async () => {
        const { fake, p } = make();
        const urls = ['http://mirror.example.com/images/noble.qcow2', 'ftp://mirror.example.com/images/noble.qcow2'];
        for (const url of urls) await expect(p.importImage({ name: 'noble', url, region: 'tor1', ...fast })).resolves.toMatchObject({ name: 'noble', status: 'available' });
        expect(fake.calls.filter((c) => c.method === 'POST' && c.path === '/v2/images').map((c) => c.body.url)).toEqual(urls);
    });

    it('waits an hour for an import by default, reading every 15 s; the timeout is the cause of the error, which says the import was deleted', async () => {
        const { p, slept } = clocked({ importReads: 1e9 });
        const e = await p.importImage({ name: 'slow', url: URL_OK, region: 'tor1' }).catch((x) => x);
        expect(e).toBeInstanceOf(ProviderError);
        expect(e.message).toBe(`digitalocean: import of slow from ${URL_OK}: digitalocean: timed out after 3600 s waiting for import of slow: NEW (the import was deleted)`);
        expect(e.cause).toBeInstanceOf(ProviderError);
        expect(e.cause).toMatchObject({ code: 'timeout', message: 'digitalocean: timed out after 3600 s waiting for import of slow: NEW' });
        expect(slept).toEqual(Array(240).fill(15_000));
    });

    it('refuses what is not a file URL before anything is sent', async () => {
        const { fake, p } = make();
        for (const url of ['s3://bucket/key.qcow2', 'https://example.com', 'file:///tmp/disk.img', 'disk.qcow2', 'git+https://example.com/disk.img']) {
            await expect(p.importImage({ name: 'x', url, region: 'tor1', ...fast })).rejects.toThrow(/an image is imported from an http\(s\) or ftp URL of a file/);
        }
        expect(fake.calls.filter((c) => c.method === 'POST')).toEqual([]);
    });
});

describe('DigitalOcean machines without GPUs (kind)', () => {
    const make = () => {
        const fake = fakeDigitalOcean();
        return { fake, p: new DigitalOcean({ apiKey: 'do-test', fetchImpl: fake.fetchImpl, sleep: noSleep }) };
    };

    it('offers plain sizes as machines with no GPU, by default and with kind cpu; never with kind gpu', async () => {
        const { p } = make();
        expect((await p.listOffers({ kind: 'gpu' })).map((o) => o.id)).not.toContain('s-8vcpu-16gb');
        expect((await p.listOffers()).map((o) => o.id)).toContain('s-8vcpu-16gb');
        const cpu = (await p.listOffers({ kind: 'cpu' })).find((o) => o.id === 's-8vcpu-16gb');
        expect(cpu).toMatchObject({ gpu: '', vendor: null, gpuCount: 0, vramGb: 0, pricePerHour: 0.14286, regions: ['nyc1', 'tor1'], vcpus: 8, memoryGb: 16 });
        // A GPU filter is a question about GPUs: a plain size does not answer it.
        const nvidia = await p.listOffers({ vendor: 'nvidia', minVramGb: 40 });
        expect(nvidia.map((o) => o.id).sort()).toEqual(['gpu-6000adax1-48gb', 'gpu-h100x8-640gb']);
        expect((await p.listOffers({ kind: 'cpu', maxPricePerHour: 0.1 })).map((o) => o.id)).toEqual([]);
    });

    it('lists servers without GPUs by default and with kind cpu, never with kind gpu; the account\'s other droplets come with them', async () => {
        const { p } = make();
        const prep = await p.createServer({ name: 'prep-1', offer: 's-8vcpu-16gb', region: 'tor1' });
        expect((await p.listServers({ kind: 'gpu' })).map((s) => s.id)).not.toContain(prep.id);
        expect((await p.listServers({ kind: 'cpu' })).map((s) => s.id)).toContain(prep.id);
        const all = await p.listServers();
        expect(all.map((s) => s.name).sort()).toEqual(['api-1', 'mail.example.com', 'prep-1']);
        expect(all.find((s) => s.id === prep.id)).toMatchObject({ gpu: undefined, offerId: 's-8vcpu-16gb' });
    });

    it('an image prepared on a CPU machine boots on a GPU size', async () => {
        const { p } = make();
        const prep = await p.createServer({ name: 'prep-2', offer: 's-8vcpu-16gb', region: 'tor1' });
        await p.stopServer(prep.id);
        const img = await p.createImage(prep.id, { name: 'gpu-ready', ...fast });
        await p.deleteServer(prep.id);
        await expect(p.createServer({ name: 'gpu-1', offer: 'gpu-4000adax1-20gb', region: 'tor1', image: img.id })).resolves.toMatchObject({ name: 'gpu-1' });
    });
});

describe('minCudaVersion on a VM provider: the image brings the driver', () => {
    it('offers are not filtered by it (AMD aside), and a create is not refused for it', async () => {
        const fake = fakeDigitalOcean();
        const p = new DigitalOcean({ apiKey: 'do-test', fetchImpl: fake.fetchImpl, sleep: noSleep });
        const all = await p.listOffers({ includeUnavailable: true });
        const cuda = await p.listOffers({ includeUnavailable: true, minCudaVersion: '12.8' });
        // A CUDA floor is a question about GPUs: the plain sizes are left out, the GPU ones kept (AMD aside).
        expect(cuda.map((o) => o.id)).toEqual(all.filter((o) => o.gpuCount > 0 && o.vendor !== 'amd').map((o) => o.id));
        await expect(p.createServer({ name: 'vm', offer: 'gpu-4000adax1-20gb', region: 'tor1', minCudaVersion: '12.8' })).resolves.toMatchObject({ name: 'vm' });
    });
});

describe('DigitalOcean Block Storage volumes', () => {
    const make = () => {
        const fake = fakeDigitalOcean();
        return { fake, p: new DigitalOcean({ apiKey: 'do-test', fetchImpl: fake.fetchImpl, sleep: noSleep }) };
    };
    const creates = (fake: ReturnType<typeof fakeDigitalOcean>) => fake.calls.filter((c) => c.method === 'POST' && c.path === '/v2/droplets').map((c) => c.body);

    it('made formatted ext4, so a droplet mounts it at /mnt/<name> (dashes as underscores); a name and size DigitalOcean takes, refused before anything is sent otherwise', async () => {
        const { fake, p } = make();
        await expect(p.createVolume({ name: 'Models', region: 'tor1', sizeGb: 10 })).rejects.toThrow(/lowercase letters/);
        await expect(p.createVolume({ name: 'models', region: 'tor1', sizeGb: 0 })).rejects.toThrow(/1-16384 GiB/);
        await expect(p.createVolume({ name: 'models', region: 'tor1', sizeGb: 16385 })).rejects.toThrow(/1-16384 GiB/);
        expect(fake.calls.filter((c) => c.path === '/v2/volumes')).toEqual([]);
        const vol = await p.createVolume({ name: 'models', region: 'tor1', sizeGb: 49.5 });
        expect(fake.calls.filter((c) => c.path === '/v2/volumes').pop()?.body).toEqual({ name: 'models', size_gigabytes: 50, region: 'tor1', filesystem_type: 'ext4', tags: ['asap-vps-fs:ext4'] });
        // DigitalOcean says the filesystem only in the create's answer: a read finds it by the tag, and the mountPath with it.
        expect(await p.getVolume(vol.id)).toMatchObject({ raw: { filesystem_type: '', tags: ['asap-vps-fs:ext4'] }, mountPath: '/mnt/models' });
        expect(vol).toMatchObject({ name: 'models', region: 'tor1', sizeGb: 50, status: 'available', providerStatus: 'detached', serverIds: [], mountPath: '/mnt/models' });
        // providerOptions are the request's own fields: an xfs volume, still mounted by DigitalOcean.
        const xfs = await p.createVolume({ name: 'scratch-v2-a', region: 'tor1', sizeGb: 10, providerOptions: { filesystem_type: 'xfs' } });
        expect(xfs.raw.filesystem_type).toBe('xfs');
        // A dash is an underscore in the mount point (systemd's mount unit naming).
        expect(xfs.mountPath).toBe('/mnt/scratch_v2_a');
    });

    it('a name of up to 64 characters and a size of 1 to 16384 GiB are taken; a longer name, or one with a character DigitalOcean refuses after a valid start, is refused before anything is sent', async () => {
        const { fake, p } = make();
        for (const name of ['models_v2', 'models.v2', `a${'b'.repeat(64)}`]) {
            await expect(p.createVolume({ name, region: 'tor1', sizeGb: 10 })).rejects.toThrow(`digitalocean: volume name "${name}": lowercase letters, digits and dashes, starting with a letter (at most 64)`);
        }
        expect(fake.calls.filter((c) => c.path === '/v2/volumes')).toEqual([]);
        const made = [await p.createVolume({ name: `a${'b'.repeat(63)}`, region: 'tor1', sizeGb: 1 }), await p.createVolume({ name: 'big', region: 'tor1', sizeGb: 16384 })];
        expect(made.map((v) => [v.name.length, v.sizeGb])).toEqual([[64, 1], [3, 16384]]);
    });

    it('an attach reads the volume and the droplet, then asks for it; an unknown volume or droplet is a NotFoundError that names it, and nothing is asked', async () => {
        const { fake, p } = make();
        const vol = await p.createVolume({ name: 'scratch', region: 'tor1', sizeGb: 10 });
        const s = await p.waitUntilRunning((await p.createServer({ name: 'gpu-1', offer: 'gpu-4000adax1-20gb', region: 'tor1' })).id, fast);
        const ghost = '00000000-0000-4000-8000-00000000beef';
        const noVolume = await p.attachVolume(ghost, s.id, fast).catch((x) => x);
        expect(noVolume).toBeInstanceOf(NotFoundError);
        expect(noVolume.message).toBe(`digitalocean: no volume ${ghost}`);
        const noDroplet = await p.attachVolume(vol.id, '999999', fast).catch((x) => x);
        expect(noDroplet).toBeInstanceOf(NotFoundError);
        expect(noDroplet.message).toBe('digitalocean: no droplet 999999');
        expect(fake.calls.filter((c) => c.method === 'POST' && c.path.endsWith('/actions'))).toEqual([]);
        const before = fake.calls.length;
        await p.attachVolume(vol.id, s.id, fast);
        expect(fake.calls.slice(before).map(asked)).toEqual([`GET /v2/volumes/${vol.id}`, `GET /v2/droplets/${s.id}`, `POST /v2/volumes/${vol.id}/actions`, 'GET /v2/actions/:id', 'GET /v2/actions/:id']);
        expect((await p.getVolume(vol.id))?.serverIds).toEqual([s.id]);
    });

    it('a volume DigitalOcean reads with droplet_ids null (as its spec allows) is attached to nothing: it is attached, detached (again: nothing to do), mounted at a create, and let go of', async () => {
        const fake = fakeDigitalOcean();
        // Each volume as read: droplet_ids null where it is attached to nothing.
        const nulled = (async (url: string, init?: RequestInit) => {
            const r = await fake.fetchImpl(url, init);
            if ((init?.method ?? 'GET') !== 'GET' || !new URL(url).pathname.startsWith('/v2/volumes') || r.status !== 200) return r;
            const body = await r.json() as { volume?: { droplet_ids: number[] | null }, volumes?: Array<{ droplet_ids: number[] | null }> };
            const nul = <V extends { droplet_ids: number[] | null }>(v: V) => (v.droplet_ids?.length ? v : { ...v, droplet_ids: null });
            return json(200, body.volume ? { volume: nul(body.volume) } : { ...body, volumes: body.volumes?.map(nul) });
        }) as typeof fetch;
        const p = new DigitalOcean({ apiKey: 'do-test', fetchImpl: nulled, sleep: noSleep });
        const vol = await p.createVolume({ name: 'models', region: 'tor1', sizeGb: 10 });
        expect((await p.getVolume(vol.id))?.raw).toMatchObject({ droplet_ids: null });
        const s = await p.waitUntilRunning((await p.createServer({ name: 'gpu-1', offer: 'gpu-4000adax1-20gb', region: 'tor1' })).id, fast);
        let before = fake.calls.length;
        await p.attachVolume(vol.id, s.id, fast);
        expect(fake.calls.slice(before).map(asked)).toEqual([`GET /v2/volumes/${vol.id}`, `GET /v2/droplets/${s.id}`, `POST /v2/volumes/${vol.id}/actions`, 'GET /v2/actions/:id', 'GET /v2/actions/:id']);
        await p.detachVolume(vol.id, s.id, fast);
        before = fake.calls.length;
        await expect(p.detachVolume(vol.id, s.id, fast)).resolves.toBeUndefined();
        expect(fake.calls.slice(before).map(asked)).toEqual([`GET /v2/volumes/${vol.id}`]);
        const t = await p.createServer({ name: 'gpu-2', offer: 'gpu-4000adax1-20gb', region: 'tor1', mounts: [{ volume: vol.id }] });
        expect(creates(fake).pop()?.volumes).toEqual([vol.id]);
        expect(await p.deleteServerAndWait(t.id, fast)).toBe(true);
        expect(await p.getVolume(vol.id)).toMatchObject({ status: 'available', serverIds: [] });
    });

    it('deleteServerAndWait: false for a droplet still there when the wait ends; one that cannot be read first is still deleted, and no volume waited for; a volume deleted meanwhile is not waited for', async () => {
        const fake = fakeDigitalOcean();
        let mode: 'kept' | 'unreadable' | 'volume deleted' | undefined;
        let volumeId = '';
        const wrapped = (async (url: string, init?: RequestInit) => {
            const method = init?.method ?? 'GET';
            const path = new URL(url).pathname;
            const m = /^\/v2\/droplets\/(\d+)$/.exec(path);
            // DigitalOcean takes the delete, and the droplet stays.
            if (mode === 'kept' && m && method === 'DELETE') return new Response(null, { status: 204 });
            // The droplet cannot be read while it is there.
            if (mode === 'unreadable' && m && method === 'GET' && fake.state.droplets.has(m[1])) return json(500, { id: 'server_error', message: 'Server Error' });
            const r = await fake.fetchImpl(url, init);
            // Its volume, deleted (elsewhere) with it.
            if (mode === 'volume deleted' && m && method === 'DELETE') fake.state.volumes.delete(volumeId);
            return r;
        }) as typeof fetch;
        const p = new DigitalOcean({ apiKey: 'do-test', fetchImpl: wrapped, sleep: noSleep });
        const o = { offer: 'gpu-4000adax1-20gb', region: 'tor1' };

        const kept = await p.createServer({ name: 'kept', ...o });
        mode = 'kept';
        expect(await p.deleteServerAndWait(kept.id, { intervalMs: 0, timeoutMs: 20 })).toBe(false);

        mode = 'unreadable';
        const unreadable = await p.createServer({ name: 'unreadable', ...o });
        const before = fake.calls.length;
        expect(await p.deleteServerAndWait(unreadable.id, fast)).toBe(true);
        expect(fake.calls.slice(before).filter((c) => c.path.startsWith('/v2/volumes'))).toEqual([]);

        mode = undefined;
        const vol = await p.createVolume({ name: 'models', region: 'tor1', sizeGb: 10 });
        volumeId = vol.id;
        const holder = await p.createServer({ name: 'holder', ...o, mounts: [{ volume: vol.id }] });
        mode = 'volume deleted';
        expect(await p.deleteServerAndWait(holder.id, fast)).toBe(true);
        expect(fake.state.droplets.has(holder.id)).toBe(false);
    });

    it('a volume deleted while a gone droplet lets go of it is a NotFoundError that names it', async () => {
        const fake = fakeDigitalOcean({ releaseReads: 1e9 });
        let watched = '';
        let reads = 0;
        // Deleted (elsewhere) at the second read of the attach: while it waits for the volume to be let go of.
        const wrapped = (async (url: string, init?: RequestInit) => {
            if (watched && (init?.method ?? 'GET') === 'GET' && new URL(url).pathname === `/v2/volumes/${watched}` && ++reads === 2) fake.state.volumes.delete(watched);
            return fake.fetchImpl(url, init);
        }) as typeof fetch;
        const p = new DigitalOcean({ apiKey: 'do-test', fetchImpl: wrapped, sleep: noSleep });
        const vol = await p.createVolume({ name: 'models', region: 'tor1', sizeGb: 10 });
        await p.deleteServer((await p.createServer({ name: 'gpu-1', offer: 'gpu-4000adax1-20gb', region: 'tor1', mounts: [{ volume: vol.id }] })).id);
        const s = await p.waitUntilRunning((await p.createServer({ name: 'gpu-2', offer: 'gpu-4000adax1-20gb', region: 'tor1' })).id, fast);
        watched = vol.id;
        const e = await p.attachVolume(vol.id, s.id, fast).catch((x) => x);
        expect(e).toBeInstanceOf(NotFoundError);
        expect(e.message).toBe(`digitalocean: no volume ${vol.id}`);
        expect(reads).toBe(2);
    });

    it('attached at create: the droplet reports it, it reports the droplet; deleting the droplet detaches it, and only then can it be deleted', async () => {
        const { fake, p } = make();
        const vol = await p.createVolume({ name: 'models', region: 'tor1', sizeGb: 10 });
        const s = await p.createServer({ name: 'gpu-1', offer: 'gpu-4000adax1-20gb', region: 'tor1', mounts: [{ volume: vol.id }] });
        expect(creates(fake).pop()?.volumes).toEqual([vol.id]);
        expect((await p.waitUntilRunning(s.id, fast)).mounts).toEqual([{ volumeId: vol.id }]);
        expect(await p.getVolume(vol.id)).toMatchObject({ status: 'attached', providerStatus: 'attached', serverIds: [s.id] });
        await expect(p.deleteVolume(vol.id)).rejects.toThrow(/Attached volumes cannot be deleted/);
        expect(await p.deleteServerAndWait(s.id, fast)).toBe(true);
        expect(await p.getVolume(vol.id)).toMatchObject({ status: 'available', serverIds: [] });
        await p.deleteVolume(vol.id);
        expect(await p.listVolumes()).toEqual([]);
    });

    it('a droplet created with volumes mounts each formatted one at its mountPath, at once and at every boot (DigitalOcean does only on the first droplet), after the caller\'s user data and before a container', async () => {
        const { fake, p } = make();
        const models = await p.createVolume({ name: 'models-v2', region: 'tor1', sizeGb: 10 });
        await p.createServer({ name: 'gpu-1', offer: 'gpu-4000adax1-20gb', region: 'tor1', mounts: [{ volume: models }] });
        const script = creates(fake).pop()?.user_data as string;
        expect(script).toMatch(/^#!\/bin\/bash\n/);
        expect(script).toContain("mount_volume 'models-v2' '/mnt/models_v2'");
        expect(script).toContain('/var/lib/cloud/scripts/per-boot/asap-vps-volumes.sh');
        expect(script).toContain('findmnt -n "$2" >/dev/null || mount -o defaults,nofail,discard,noatime "$device" "$2"');
        expect(() => execFileSync('/bin/bash', ['-n'], { input: script })).not.toThrow();
        // With user data of the caller's own and a container: the caller's first, then the mounts, then the container.
        await p.deleteServerAndWait((await p.listServers()).find((s) => s.name === 'gpu-1')!.id, fast);
        await p.createServer({ name: 'gpu-2', offer: 'gpu-4000adax1-20gb', region: 'tor1', mounts: [{ volume: models.id }], userData: '#!/bin/bash\necho mine\n', container: { image: 'busybox' } });
        const doc = creates(fake).pop()?.user_data as string;
        const order = ['echo mine', 'mount_volume', 'asap-vps: the server\'s container'].map((x) => doc.indexOf(x));
        expect(order.every((i) => i > 0)).toBe(true);
        expect(order).toEqual([...order].sort((a, b) => a - b));
        // An unformatted volume is a bare disk: attached, not mounted.
        const bare = await p.createVolume({ name: 'raw', region: 'tor1', sizeGb: 10 });
        Object.assign(fake.state.volumes.get(bare.id), { filesystem_type: undefined, tags: [] });
        expect((await p.getVolume(bare.id))?.mountPath).toBeUndefined();
        await p.createServer({ name: 'gpu-3', offer: 'gpu-4000adax1-20gb', region: 'tor1', mounts: [{ volume: bare.id }] });
        expect(creates(fake).pop()?.user_data).toBeUndefined();
    });

    it('a deleted droplet lets go of its volumes late (seen live): deleteServerAndWait waits for it, and so does a create or an attach that takes one', async () => {
        const fake = fakeDigitalOcean({ releaseReads: 4 });
        const p = new DigitalOcean({ apiKey: 'do-test', fetchImpl: fake.fetchImpl, sleep: noSleep });
        const vol = await p.createVolume({ name: 'models', region: 'tor1', sizeGb: 10 });
        const first = await p.createServer({ name: 'gpu-1', offer: 'gpu-4000adax1-20gb', region: 'tor1', mounts: [{ volume: vol.id }] });
        // Waited for: free the moment it returns.
        expect(await p.deleteServerAndWait(first.id, fast)).toBe(true);
        expect(await p.getVolume(vol.id)).toMatchObject({ status: 'available', serverIds: [] });

        // A plain delete returns at once: the volume still reads as the gone droplet's, and a create that mounts it waits.
        const second = await p.createServer({ name: 'gpu-2', offer: 'gpu-4000adax1-20gb', region: 'tor1', mounts: [{ volume: vol.id }] });
        await p.deleteServer(second.id);
        expect(await p.getVolume(vol.id)).toMatchObject({ status: 'attached', serverIds: [second.id] });
        const third = await p.createServer({ name: 'gpu-3', offer: 'gpu-4000adax1-20gb', region: 'tor1', mounts: [{ volume: vol.id }] });
        expect(await p.getVolume(vol.id)).toMatchObject({ status: 'attached', serverIds: [third.id] });

        // So does an attach to a droplet that runs.
        await p.deleteServer(third.id);
        const fourth = await p.waitUntilRunning((await p.createServer({ name: 'gpu-4', offer: 'gpu-4000adax1-20gb', region: 'tor1' })).id, fast);
        await p.attachVolume(vol.id, fourth.id, fast);
        expect(await p.getVolume(vol.id)).toMatchObject({ status: 'attached', serverIds: [fourth.id] });

        // A droplet that exists holds it: refused, not waited for.
        const fifth = await p.waitUntilRunning((await p.createServer({ name: 'gpu-5', offer: 'gpu-4000adax1-20gb', region: 'tor1' })).id, fast);
        await expect(p.attachVolume(vol.id, fifth.id, fast)).rejects.toThrow(/attached to droplet .*one droplet at a time/);
        await expect(p.createServer({ name: 'gpu-6', offer: 'gpu-4000adax1-20gb', region: 'tor1', mounts: [{ volume: vol.id }] })).rejects.toThrow(/one droplet at a time/);
    });

    it('a volume a gone droplet never lets go of is a timeout that says so', async () => {
        const fake = fakeDigitalOcean({ releaseReads: 1e9 });
        const p = new DigitalOcean({ apiKey: 'do-test', fetchImpl: fake.fetchImpl, sleep: noSleep });
        const vol = await p.createVolume({ name: 'models', region: 'tor1', sizeGb: 10 });
        const s = await p.createServer({ name: 'gpu-1', offer: 'gpu-4000adax1-20gb', region: 'tor1', mounts: [{ volume: vol.id }] });
        await expect(p.deleteServerAndWait(s.id, { intervalMs: 0, timeoutMs: 50 })).rejects.toThrow(/volume models.*attached to droplet .*which is gone/);
    });

    it('refuses before any droplet is asked for: a path (DigitalOcean picks it), an unknown volume, one elsewhere, one already attached', async () => {
        const { fake, p } = make();
        const vol = await p.createVolume({ name: 'models', region: 'tor1', sizeGb: 10 });
        const far = await p.createVolume({ name: 'far', region: 'nyc1', sizeGb: 10 });
        const o = { name: 'gpu-1', offer: 'gpu-4000adax1-20gb', region: 'tor1' };
        // Not in its type even through a cast; code typed for any provider (ICompute) may still pass it.
        const generic: ICompute = p;
        await expect(generic.createServer({ ...o, mounts: [{ volume: vol, path: '/models' }] })).rejects.toThrow(NotSupportedError);
        await expect(p.createServer({ ...o, mounts: [{ volume: '00000000-0000-4000-8000-00000000beef' }] })).rejects.toThrow(NotFoundError);
        await expect(p.createServer({ ...o, mounts: [{ volume: '00000000-0000-4000-8000-00000000beef' }] })).rejects.toThrow('digitalocean: no volume 00000000-0000-4000-8000-00000000beef');
        await expect(p.createServer({ ...o, mounts: [{ volume: far }] })).rejects.toThrow(/is in nyc1/);
        expect(creates(fake)).toEqual([]);
        await p.createServer({ ...o, mounts: [{ volume: vol }] });
        // The volume object says it is free: it is read again, and found attached.
        await expect(p.createServer({ ...o, name: 'gpu-2', mounts: [{ volume: vol }] })).rejects.toThrow(/is attached to droplet/);
        expect(creates(fake)).toHaveLength(1);
    });
});

describe('DigitalOcean shared volumes: Network File Storage shares, mounted over NFS by droplets of their VPC', () => {
    const make = (o: Parameters<typeof fakeDigitalOcean>[0] = {}) => {
        const fake = fakeDigitalOcean(o);
        return { fake, p: new DigitalOcean({ apiKey: 'do-test', fetchImpl: fake.fetchImpl, sleep: noSleep }) };
    };
    const creates = (fake: ReturnType<typeof fakeDigitalOcean>) => fake.calls.filter((c) => c.method === 'POST' && c.path === '/v2/droplets').map((c) => c.body);

    it('made in the region\'s default VPC, standard tier, once ACTIVE; a shared volume mounted at /mnt/<name> unless a mount says otherwise; listed with the block volumes', async () => {
        const { fake, p } = make();
        const share = await p.createVolume({ name: 'models', region: 'nyc2', sizeGb: 49.5 + 50, shared: true });
        const vpc = fake.state.vpcs.find((v) => v.region === 'nyc2')!.id;
        expect(fake.calls.find((c) => c.method === 'POST' && c.path === '/v2/nfs')?.body).toEqual({ name: 'models', size_gib: 100, region: 'nyc2', vpc_ids: [vpc], performance_tier: 'standard' });
        expect(share).toMatchObject({ provider: 'digitalocean', name: 'models', region: 'nyc2', shared: true, sizeGb: 100, status: 'available', providerStatus: 'ACTIVE', mountPath: '/mnt/models' });
        expect(share.raw).toMatchObject({ host: '10.10.0.5', mount_path: `/2559851/${share.id}`, vpc_ids: [vpc] });
        const block = await p.createVolume({ name: 'scratch', region: 'nyc2', sizeGb: 10 });
        expect((await p.listVolumes()).map((v) => [v.name, v.shared])).toEqual([['scratch', false], ['models', true]]);
        expect(await p.getVolume(share.id)).toMatchObject({ id: share.id, shared: true });
        expect(await p.getVolume(block.id)).toMatchObject({ id: block.id, shared: false });
        // VPCs of the caller's naming, and a high tier (from 500 GB).
        await p.createVolume({ name: 'fast', region: 'nyc2', sizeGb: 500, shared: true, providerOptions: { vpc_ids: [vpc], performance_tier: 'high' } });
        expect(fake.calls.filter((c) => c.method === 'POST' && c.path === '/v2/nfs').pop()?.body).toMatchObject({ vpc_ids: [vpc], performance_tier: 'high' });
    });

    it('a droplet created with a share joins its VPC, carries a tag for it, and mounts it over NFS at its path, now and at every boot', async () => {
        const { fake, p } = make();
        const share = await p.createVolume({ name: 'models', region: 'nyc2', sizeGb: 50, shared: true });
        const s = await p.createServer({ name: 'gpu-1', offer: 'gpu-6000adax1-48gb', region: 'nyc2', mounts: [{ volume: share, path: '/data/models' }] });
        const body = creates(fake).pop();
        expect(body.vpc_uuid).toBe(share.raw.vpc_ids[0]);
        expect(body.tags).toEqual([`asap-vps-nfs:${share.id}:${Buffer.from('/data/models').toString('hex')}`]);
        expect(body.user_data).toContain(`mount_share '10.10.0.5:/2559851/${share.id}' '/data/models'`);
        expect(body.user_data).toContain('_netdev,nofail,nconnect=8,vers=4.1');
        expect(body.user_data).toContain('apt_get install -y nfs-common');
        expect(() => execFileSync('/bin/bash', ['-n'], { input: body.user_data })).not.toThrow();
        expect((await p.waitUntilRunning(s.id, fast)).mounts).toEqual([{ volumeId: share.id, path: '/data/models' }]);
        // By id, at its mountPath; with a block volume and the caller's tags too: all of it in one droplet.
        const block = await p.createVolume({ name: 'scratch', region: 'nyc2', sizeGb: 10 });
        const t = await p.createServer({ name: 'gpu-2', offer: 'gpu-6000adax1-48gb', region: 'nyc2', tags: ['team-a'], mounts: [{ volume: block.id }, { volume: share.id }] });
        expect(creates(fake).pop()).toMatchObject({ volumes: [block.id], tags: ['team-a', `asap-vps-nfs:${share.id}:${Buffer.from('/mnt/models').toString('hex')}`] });
        expect((await p.waitUntilRunning(t.id, fast)).mounts).toEqual([{ volumeId: block.id }, { volumeId: share.id, path: '/mnt/models' }]);
    });

    it('refuses before any droplet is asked for: a path for a block volume, a share elsewhere or not ACTIVE, a VPC no share is in', async () => {
        const { fake, p } = make();
        const block = await p.createVolume({ name: 'scratch', region: 'nyc2', sizeGb: 10 });
        const share = await p.createVolume({ name: 'models', region: 'nyc2', sizeGb: 50, shared: true });
        const far = await p.createVolume({ name: 'far', region: 'atl1', sizeGb: 50, shared: true });
        const o = { name: 'x', offer: 'gpu-6000adax1-48gb', region: 'nyc2' };
        await expect(p.createServer({ ...o, mounts: [{ volume: block, path: '/data' }] })).rejects.toThrow(/a mount path for a Block Storage volume/);
        await expect(p.createServer({ ...o, mounts: [{ volume: far.id }] })).rejects.toThrow(/share far is in atl1: a droplet in nyc2 cannot mount it/);
        await expect(p.createServer({ ...o, mounts: [{ volume: share.id, path: 'data' }] })).rejects.toThrow(/mount path "data" is not absolute/);
        await expect(p.createServer({ ...o, mounts: [{ volume: share.id }], providerOptions: { vpc_uuid: 'elsewhere' } })).rejects.toThrow(/vpc_uuid elsewhere is not a VPC of every share/);
        await expect(p.createServer({ ...o, mounts: [{ volume: share.id }], providerOptions: { vpc_uuid: 'elsewhere' } }))
            .rejects.toThrow(`digitalocean: vpc_uuid elsewhere is not a VPC of every share the droplet mounts (${share.raw.vpc_ids[0]})`);
        fake.state.shares.get(share.id).status = 'INACTIVE';
        await expect(p.createServer({ ...o, mounts: [{ volume: share.id }] })).rejects.toThrow(/share models is INACTIVE: it is mounted once ACTIVE/);
        // In no VPC, which is no failure: it does not read as an error, as a share that FAILED does.
        expect(await p.getVolume(share.id)).toMatchObject({ status: 'unknown', providerStatus: 'INACTIVE' });
        fake.state.shares.get(share.id).status = 'FAILED';
        expect(await p.getVolume(share.id)).toMatchObject({ status: 'error', providerStatus: 'FAILED' });
        fake.state.shares.get(share.id).status = 'ACTIVE';
        const other = await p.createVolume({ name: 'other', region: 'nyc2', sizeGb: 50, shared: true });
        fake.state.shares.get(other.id).vpc_ids = ['another-vpc'];
        await expect(p.createServer({ ...o, mounts: [{ volume: share.id }, { volume: other.id }] })).rejects.toThrow(/have no VPC in common/);
        await expect(p.createServer({ ...o, mounts: [{ volume: share.id }, { volume: other.id }] })).rejects.toThrow('digitalocean: the shares models, other have no VPC in common: a droplet is in one VPC');
        expect(creates(fake)).toEqual([]);
        // Hot: a share is mounted over the network, not attached.
        const s = await p.waitUntilRunning((await p.createServer(o)).id, fast);
        await expect(p.attachVolume(share.id, s.id, fast)).rejects.toThrow(/attaching a shared volume/);
        // Nor detached: a detach that did nothing must not say it is done. A volume that is neither kind is still no error.
        await expect(p.detachVolume(share.id, s.id, fast)).rejects.toThrow(/detaching a shared volume/);
        await expect(p.detachVolume('00000000-0000-4000-8000-00000000dead', s.id, fast)).resolves.toBeUndefined();
    });

    it('a droplet that mounts two shares joins the VPC they share (the one asked for, when they share it); a refusal names the VPCs they share, or says they share none', async () => {
        const { fake, p } = make();
        const vpc = fake.state.vpcs.find((v) => v.region === 'nyc2')!.id;
        const second = '00000000-0000-4000-9000-0000000000aa';
        fake.state.vpcs.push({ id: second, name: 'second-nyc2', region: 'nyc2', default: false });
        const models = await p.createVolume({ name: 'models', region: 'nyc2', sizeGb: 50, shared: true, providerOptions: { vpc_ids: [vpc, second] } });
        const data = await p.createVolume({ name: 'data', region: 'nyc2', sizeGb: 50, shared: true, providerOptions: { vpc_ids: [vpc, second] } });
        const o = { offer: 'gpu-6000adax1-48gb', region: 'nyc2', mounts: [{ volume: models.id }, { volume: data.id }] };
        await p.createServer({ ...o, name: 'x' });
        await p.createServer({ ...o, name: 'y', providerOptions: { vpc_uuid: second } });
        expect(creates(fake).map((c) => c.vpc_uuid)).toEqual([vpc, second]);
        await expect(p.createServer({ ...o, name: 'z', providerOptions: { vpc_uuid: 'elsewhere' } }))
            .rejects.toThrow(`digitalocean: vpc_uuid elsewhere is not a VPC of every share the droplet mounts (${vpc}, ${second})`);
        fake.state.shares.get(data.id).vpc_ids = ['another-vpc'];
        await expect(p.createServer({ ...o, name: 'z', providerOptions: { vpc_uuid: vpc } }))
            .rejects.toThrow(`digitalocean: vpc_uuid ${vpc} is not a VPC of every share the droplet mounts (they share none)`);
        await expect(p.createServer({ ...o, name: 'z' })).rejects.toThrow('digitalocean: the shares models, data have no VPC in common: a droplet is in one VPC');
        expect(creates(fake)).toHaveLength(2);
    });

    it('a share DigitalOcean still lists as DELETED is gone: not listed, not found', async () => {
        const { fake, p } = make();
        const [a, b] = [await p.createVolume({ name: 'models', region: 'nyc2', sizeGb: 50, shared: true }), await p.createVolume({ name: 'data', region: 'nyc2', sizeGb: 50, shared: true })];
        fake.state.shares.get(a.id).status = 'DELETED';
        expect((await p.listVolumes()).map((v) => v.id)).toEqual([b.id]);
        fake.state.shares.get(b.id).status = 'DELETED';
        expect(await p.getVolume(b.id)).toBeNull();
    });

    it('a share of the most DigitalOcean makes, 32768 GB, is made', async () => {
        const { p } = make();
        await expect(p.createVolume({ name: 'huge', region: 'nyc2', sizeGb: 32768, shared: true })).resolves.toMatchObject({ sizeGb: 32768, status: 'available' });
    });

    it('a share that fails, or disappears, while it is made is an error that says so, and nothing is left', async () => {
        const fake = fakeDigitalOcean();
        let fate: 'FAILED' | 'gone' = 'FAILED';
        const wrapped = (async (url: string, init?: RequestInit) => {
            const r = await fake.fetchImpl(url, init);
            if (init?.method === 'POST' && new URL(url).pathname === '/v2/nfs' && r.status === 201) {
                const { share } = await r.clone().json() as { share: { id: string } };
                if (fate === 'gone') fake.state.shares.delete(share.id);
                else fake.state.shares.get(share.id).status = 'FAILED';
            }
            return r;
        }) as typeof fetch;
        const p = new DigitalOcean({ apiKey: 'do-test', fetchImpl: wrapped, sleep: noSleep });
        const failed = await p.createVolume({ name: 'broken', region: 'nyc2', sizeGb: 50, shared: true, ...fast }).catch((x) => x);
        expect(failed).toBeInstanceOf(ProviderError);
        expect(failed.message).toBe('digitalocean: share broken is FAILED, not ACTIVE');
        expect(fake.state.shares.size).toBe(0);
        fate = 'gone';
        const gone = await p.createVolume({ name: 'vanished', region: 'nyc2', sizeGb: 50, shared: true, ...fast }).catch((x) => x);
        expect(gone).toBeInstanceOf(NotFoundError);
        expect(gone.message).toBe('digitalocean: share vanished disappeared while it was made');
        expect(fake.state.shares.size).toBe(0);
    });

    it('waits 10 min by default for a share to be made, reading every 5 s; one that is not made by then is deleted', async () => {
        const { fake, p, slept } = clocked({ shareReads: 1e9 });
        const e = await p.createVolume({ name: 'slow', region: 'nyc2', sizeGb: 50, shared: true }).catch((x) => x);
        expect(e).toBeInstanceOf(ProviderError);
        expect(e).toMatchObject({ code: 'timeout', message: 'digitalocean: timed out after 600 s waiting for share slow: CREATING' });
        expect(slept).toEqual(Array(120).fill(5000));
        expect(fake.state.shares.size).toBe(0);
    });

    it('waits 5 min by default for a share to go, reading every 3 s, then is a timeout that says what it saw', async () => {
        let ignored = false;
        // DigitalOcean takes the delete, and the share stays.
        const { p, slept } = clocked({}, (f) => (async (url: string, init?: RequestInit) =>
            (ignored && init?.method === 'DELETE' && new URL(url).pathname.startsWith('/v2/nfs/') ? new Response(null, { status: 204 }) : f(url, init))) as typeof fetch);
        const share = await p.createVolume({ name: 'models', region: 'nyc2', sizeGb: 50, shared: true });
        ignored = true;
        slept.length = 0;
        const e = await p.deleteVolume(share.id).catch((x) => x);
        expect(e).toBeInstanceOf(ProviderError);
        expect(e).toMatchObject({ code: 'timeout', message: 'digitalocean: timed out after 300 s waiting for delete of share models: ACTIVE' });
        expect(slept).toEqual(Array(100).fill(3000));
    });

    it('a size out of bounds, or a region with no default VPC, is refused before anything is made; one that fails to become ACTIVE is deleted, and its failure thrown', async () => {
        const { fake, p } = make();
        await expect(p.createVolume({ name: 'tiny', region: 'nyc2', sizeGb: 49, shared: true })).rejects.toThrow(/50-32768 GB, not 49/);
        await expect(p.createVolume({ name: 'huge', region: 'nyc2', sizeGb: 40000, shared: true })).rejects.toThrow(/50-32768 GB/);
        fake.state.vpcs = fake.state.vpcs.filter((v) => v.region !== 'atl1');
        await expect(p.createVolume({ name: 'novpc', region: 'atl1', sizeGb: 50, shared: true })).rejects.toThrow(/region atl1 has no default VPC yet/);
        expect(fake.calls.filter((c) => c.method === 'POST' && c.path === '/v2/nfs')).toEqual([]);
        const { fake: f2, p: p2 } = make({ shareReads: 1e9 });
        await expect(p2.createVolume({ name: 'slow', region: 'nyc2', sizeGb: 50, shared: true, intervalMs: 0, timeoutMs: 20 })).rejects.toThrow(/waiting for share slow: CREATING/);
        expect(f2.state.shares.size).toBe(0);
    });

    it('a share where DigitalOcean has no Network File Storage is its refusal, and nothing is made', async () => {
        const { fake, p } = make();
        await expect(p.createVolume({ name: 'models', region: 'tor1', sizeGb: 50, shared: true })).rejects.toThrow(/NFS is not available in region tor1/);
        expect(fake.state.shares.size).toBe(0);
    });

    it('deleted, waited for until gone; deleting again is no error', async () => {
        const { p } = make();
        const share = await p.createVolume({ name: 'models', region: 'nyc2', sizeGb: 50, shared: true });
        await p.deleteVolume(share.id);
        expect(await p.getVolume(share.id)).toBeNull();
        expect(await p.listVolumes()).toEqual([]);
        await expect(p.deleteVolume(share.id)).resolves.toBeUndefined();
    });
});
