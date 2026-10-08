// ONE scenario, every provider: each runs against a fake of its platform's
// REST API (src/testing/fakes, written from that platform's spec; the list is
// src/testing/subjects.ts) and must pass the same contract, for each
// capability it declares. A provider that maps a status word wrongly, reads
// "no stock" as a generic failure, drops an option it cannot honor, or has a
// method its capabilities do not declare fails here, not on a rented GPU.

import { CAPABILITY_METHODS, CapabilityName, requireCapability, supports } from '../capabilities';
import { canonicalGpu, sshKeyFingerprint } from '../Core/utils';
import { AuthError, CapacityError, NotSupportedError } from '../errors';
import { testPublicKey } from '../testing/fakes/util';
import { CONTRACT_SUBJECTS } from '../testing/subjects';
import type { VolumeKindTraits } from '../capabilities';
import type { ContainerSpec, Offer, OfferQuery } from '../types';
import type { AnyProvider } from './registry';

const fast = { intervalMs: 0, timeoutMs: 5000 };
/** The contract rents GPUs: what each provider is first of all asked for. */
const GPU = { kind: 'gpu' } as const;

describe.each(CONTRACT_SUBJECTS)('contract: $name', (subject) => {
    it('has exactly the methods its capabilities declare: every one of a declared capability, none of any other', () => {
        const { provider } = subject.make();
        const methods = provider as unknown as Record<string, unknown>;
        for (const c of Object.keys(CAPABILITY_METHODS) as CapabilityName[]) {
            for (const m of CAPABILITY_METHODS[c]) expect([c, m, typeof methods[m]]).toEqual([c, m, supports(provider, c) ? 'function' : 'undefined']);
        }
        expect(provider.supports('compute')).toBe(true);
        expect(provider.capabilities.compute.gpu).toBe(true);
    });

    it('offers are well-formed, cheapest first, in stock by default', async () => {
        const { provider } = subject.make();
        const offers = await provider.listOffers(GPU);
        expect(offers.length).toBeGreaterThan(0);
        // The cheapest, field by field, as the fake's catalog record has it (subjects.ts says what each value comes from).
        const { raw: _raw, ...cheapest } = offers[0];
        expect(cheapest).toEqual(subject.cheapestGpuOffer);
        // Each offer once.
        expect(new Set(offers.map((o) => o.id)).size).toBe(offers.length);
        for (const o of offers) {
            expect(o.provider).toBe(provider.id);
            expect(o.id).toMatch(/\S/);
            expect(o.gpu).toMatch(/\S/);
            expect(['nvidia', 'amd']).toContain(o.vendor);
            expect(o.gpuCount).toBeGreaterThanOrEqual(1);
            expect(o.vramGb).toBeGreaterThan(0);
            expect(o.pricePerHour).toBeGreaterThan(0);
            expect(o.regions.length).toBeGreaterThan(0);
            expect(o.interruptible ?? false).toBe(false);
            expect(o.billing?.incrementSeconds).toBeGreaterThanOrEqual(1);
            expect(o.billing?.minimumSeconds).toBeGreaterThanOrEqual(0);
        }
        for (let i = 1; i < offers.length; i++) expect(offers[i - 1].pricePerHour).toBeLessThanOrEqual(offers[i].pricePerHour);
        const all = await provider.listOffers({ ...GPU, includeUnavailable: true });
        expect(all.length).toBeGreaterThan(offers.length);
        // A model asap-vps knows goes by its one name (a MIG slice's: the name and its profile) and its maker, whatever the platform calls it.
        for (const o of all) {
            const known = canonicalGpu(o.gpu);
            if (known) expect([o.id, o.gpu.replace(/ MIG \S+$/, ''), o.vendor]).toEqual([o.id, known.name, known.vendor]);
        }
    });

    it('offer filters mean the same on every provider: each keeps exactly the offers it should', async () => {
        const { provider } = subject.make();
        const all = await provider.listOffers({ ...GPU, includeUnavailable: true });
        const ids = (offers: Offer[]) => offers.map((o) => o.id).sort();
        /** The query lists exactly the offers of `all` that `keep` keeps. */
        const exactly = async (q: OfferQuery, keep: (o: Offer) => boolean) => {
            expect([q, ids(await provider.listOffers({ ...GPU, ...q, includeUnavailable: true }))]).toEqual([q, ids(all.filter(keep))]);
        };
        /** A threshold in the middle of what is listed: it keeps some offers and leaves some, so neither ignoring it nor dropping too many passes. */
        const middle = (values: number[]) => {
            const v = [...new Set(values)].sort((a, b) => a - b);
            expect(v.length).toBeGreaterThan(1);
            return v[Math.floor((v.length - 1) / 2)];
        };
        const minVramGb = middle(all.map((o) => o.vramGb));
        await exactly({ minVramGb }, (o) => o.vramGb >= minVramGb);
        const maxPricePerHour = middle(all.map((o) => o.pricePerHour));
        await exactly({ maxPricePerHour }, (o) => o.pricePerHour <= maxPricePerHour);
        const models = [...new Set(all.map((o) => o.gpu))];
        expect(models.length).toBeGreaterThan(2);
        await exactly({ gpus: [models[0]] }, (o) => o.gpu === models[0]);
        await exactly({ gpus: models.slice(1, 3) }, (o) => models.slice(1, 3).includes(o.gpu));
        // Where every offer is NVIDIA's, asking for AMD lists none.
        await exactly({ vendor: 'nvidia' }, (o) => o.vendor === 'nvidia');
        await exactly({ vendor: 'amd' }, (o) => o.vendor === 'amd');
    });

    it('a create where there is no stock is a CapacityError, and makes nothing', async () => {
        const { provider, fake } = subject.make();
        const empty = (await provider.listOffers({ ...GPU, includeUnavailable: true })).find((o) => o.regions.length === 0);
        expect(empty).toBeDefined();
        const before = fake.liveServers();
        await expect(provider.createServer({ name: 'gpu-contract-none', offer: empty!.id, region: subject.anyRegion, ...(await subject.extra(provider)) }))
            .rejects.toBeInstanceOf(CapacityError);
        // The offer itself, as listOffers gave it, with no region asked for: no capacity too, on every provider, so a
        // "next offer on CapacityError" loop moves on rather than stopping.
        await expect(provider.createServer({ name: 'gpu-contract-none', offer: empty!, ...(await subject.extra(provider)) }))
            .rejects.toBeInstanceOf(CapacityError);
        expect(fake.liveServers()).toBe(before);
    });

    it('create -> running -> listed -> deleted and verified gone; delete is idempotent', async () => {
        const { provider, fake } = subject.make();
        const [offer] = await provider.listOffers(GPU);
        const before = fake.liveServers();
        const createdAfter = Date.now();
        const created = await provider.createServer({ name: 'gpu-contract', offer, ...(await subject.extra(provider)) });
        expect(created).toMatchObject({ provider: provider.id, name: 'gpu-contract' });
        expect(created.id).toMatch(/\S/);
        expect(['pending', 'running']).toContain(created.status);
        expect(fake.liveServers()).toBe(before + 1);

        const running = await provider.waitUntilRunning(created.id, fast);
        expect(running).toMatchObject({ id: created.id, status: 'running', gpu: offer.gpu });
        expect(running.region).toBe(offer.regions[0]);
        if (provider.capabilities.compute.kind === 'vm') {
            expect(running.ip).toMatch(/^\d{1,3}(\.\d{1,3}){3}$/);
            expect(running.ssh).toEqual({ host: running.ip, port: 22, username: subject.sshUser });
        }
        expect((await provider.getServer(created.id))?.status).toBe('running');
        expect((await provider.listServers()).find((s) => s.id === created.id)?.status).toBe('running');

        // What it costs: the offer's rate, billed as the offer said, from the start of the run (not before the create); an hour of it is an hour's price.
        expect(running.pricePerHour).toBeCloseTo(offer.pricePerHour, 9);
        expect(running.billing).toEqual(offer.billing);
        const billedFrom = running.billingStartedAt as number;
        expect(billedFrom).toBeGreaterThanOrEqual(createdAfter);
        expect(billedFrom).toBeLessThanOrEqual(Date.now() + 60_000);
        const hour = await provider.getServerCost(created.id, billedFrom + 3_600_000);
        expect(hour).toMatchObject({ pricePerHour: running.pricePerHour, from: billedFrom, to: billedFrom + 3_600_000, billedSeconds: 3600 });
        expect(hour?.usd).toBeCloseTo(running.pricePerHour as number, 6);

        expect(await provider.deleteServerAndWait(created.id, fast)).toBe(true);
        const gone = await provider.getServer(created.id);
        expect(gone === null || gone.status === 'terminated').toBe(true);
        expect(await provider.getServerCost(created.id)).toBeNull();
        expect((await provider.listServers()).map((s) => s.id)).not.toContain(created.id);
        await expect(provider.deleteServer(created.id)).resolves.toBeUndefined();
        expect(fake.liveServers()).toBe(before);
    });

    it(`takes the offer as the offer says: its GPU count passes, another count is ${subject.anyGpuCount ? 'rented as asked' : 'refused'}, another provider's offer is refused`, async () => {
        const { provider, fake } = subject.make();
        const [offer] = await provider.listOffers(GPU);
        const extra = await subject.extra(provider);
        const before = fake.liveServers();
        /** A server of `offer` with `gpuCount` GPUs asked for: running, with that many, then deleted. */
        const rents = async (o: Offer, gpuCount: number) => {
            const s = await provider.createServer({ name: 'gpu-contract-count', offer: o, gpuCount, ...extra });
            expect((await provider.waitUntilRunning(s.id, fast)).gpuCount).toBe(gpuCount);
            expect(await provider.deleteServerAndWait(s.id, fast)).toBe(true);
        };
        await rents(offer, offer.gpuCount);
        if (subject.anyGpuCount) {
            // More than the offer was listed for, and fewer: what is asked is what is rented.
            await rents(offer, offer.gpuCount + 1);
            const [two] = await provider.listOffers({ ...GPU, gpuCount: 2 });
            expect(two.gpuCount).toBe(2);
            await rents(two, 1);
        } else {
            await expect(provider.createServer({ name: 'x', offer, gpuCount: offer.gpuCount + 1, ...extra })).rejects.toBeInstanceOf(NotSupportedError);
        }
        await expect(provider.createServer({ name: 'x', offer: { ...offer, provider: 'elsewhere' }, ...extra })).rejects.toThrow(/elsewhere's/);
        expect(fake.liveServers()).toBe(before);
    });

    it('getServer of an id no server has is null', async () => {
        const { provider } = subject.make();
        await expect(provider.getServer(subject.unknownId)).resolves.toBeNull();
    });

    it('stops and starts where it can', async () => {
        const made = subject.make().provider;
        if (!supports(made, 'power')) {
            expect(() => requireCapability(made, 'power')).toThrow(NotSupportedError);
            return;
        }
        const provider = made;
        const [offer] = await provider.listOffers(GPU);
        const s = await provider.createServer({ name: 'gpu-contract-stop', offer: offer.id, region: offer.regions[0], ...(await subject.extra(provider)) });
        await provider.waitUntilRunning(s.id, fast);
        await provider.stopServer(s.id);
        expect((await provider.waitForServer(s.id, (x) => x?.status === 'stopped', fast))?.status).toBe('stopped');
        // Stopped, it bills only its disk: no run bills at its rate. Where a stopped server bills in full, its run goes on.
        const whileStopped = await provider.getServerCost(s.id);
        if (provider.capabilities.power.stoppedBilling === 'full') expect(whileStopped?.pricePerHour).toBeCloseTo(offer.pricePerHour, 9);
        else expect(whileStopped).toBeNull();
        await provider.startServer(s.id);
        expect((await provider.waitUntilRunning(s.id, fast)).status).toBe('running');
        // Running again, it bills at its rate again.
        expect((await provider.getServerCost(s.id))?.pricePerHour).toBeCloseTo(offer.pricePerHour, 9);
        expect(await provider.deleteServerAndWait(s.id, fast)).toBe(true);
    });

    it('restarts where it can', async () => {
        const provider = requireCapability(subject.make().provider, 'restart');
        const [offer] = await provider.listOffers(GPU);
        const s = await provider.createServer({ name: 'gpu-contract-restart', offer: offer.id, region: offer.regions[0], ...(await subject.extra(provider)) });
        await provider.waitUntilRunning(s.id, fast);
        await expect(provider.restartServer(s.id)).resolves.toBeUndefined();
        expect(await provider.deleteServerAndWait(s.id, fast)).toBe(true);
    });

    it('manages SSH keys where it can', async () => {
        const provider = requireCapability(subject.make().provider, 'sshKeys');
        const pub = testPublicKey('contract');
        const key = await provider.addSSHKey(pub, 'gpu-contract-key');
        expect(String(key.id)).toMatch(/^\S+$/);
        expect(key.fingerprint).toBe(sshKeyFingerprint(pub));
        expect((await provider.listSSHKeys()).map((k) => k.id)).toContain(key.id);
        // Idempotent: the same key again is the same registration, whatever it is called.
        expect((await provider.addSSHKey(pub, 'gpu-contract-key-again')).id).toBe(key.id);
        expect((await provider.listSSHKeys()).filter((k) => k.fingerprint === key.fingerprint)).toHaveLength(1);
        expect(await provider.deleteSSHKey(key.id)).toBe(true);
        expect((await provider.listSSHKeys()).map((k) => k.id)).not.toContain(key.id);
        // Already gone: false, not an error.
        await expect(provider.deleteSSHKey(key.id)).resolves.toBe(false);
    });

    it('reads a container\'s logs where it can', async () => {
        const made = subject.make().provider;
        if (!supports(made, 'logs')) {
            expect(made.capabilities.compute.kind).toBe('vm');
            return;
        }
        const provider = made;
        const [offer] = await provider.listOffers(GPU);
        const s = await provider.createServer({ name: 'gpu-contract', offer: offer.id, region: offer.regions[0], ...(await subject.extra(provider)) });
        await provider.waitUntilRunning(s.id, fast);
        expect(await provider.getServerLogs(s.id)).toMatch(subject.logLine!);
        expect(await provider.deleteServerAndWait(s.id, fast)).toBe(true);
    });

    it('refuses an option it cannot honor, rather than dropping it', async () => {
        const { provider, fake } = subject.make();
        const [offer] = await provider.listOffers(GPU);
        const before = fake.liveServers();
        await expect(provider.createServer({ name: 'gpu-contract', offer: offer.id, region: offer.regions[0], ...(await subject.extra(provider)), ...subject.refused }))
            .rejects.toBeInstanceOf(NotSupportedError);
        expect(fake.liveServers()).toBe(before);
    });

    it('a wrong API key is an AuthError', async () => {
        const { provider } = subject.make({ apiKey: 'wrong-key' });
        await expect(provider.listOffers()).rejects.toBeInstanceOf(AuthError);
    });
});

describe('machines without GPUs: offered where the platform rents them, and asked for by kind', () => {
    for (const subject of CONTRACT_SUBJECTS) {
        it(`${subject.name}: kind 'cpu' is what capabilities.compute.cpu says; 'any' is both`, async () => {
            const { provider } = subject.make();
            const cpu = await provider.listOffers({ kind: 'cpu', includeUnavailable: true });
            const gpu = await provider.listOffers({ kind: 'gpu', includeUnavailable: true });
            const any = await provider.listOffers({ includeUnavailable: true });
            expect(gpu.length).toBeGreaterThan(0);
            expect(gpu.every((o) => o.gpuCount > 0 && o.vendor !== null)).toBe(true);
            expect(cpu.every((o) => o.gpuCount === 0 && o.vendor === null && o.gpu === '' && o.vramGb === 0)).toBe(true);
            expect(cpu.length > 0).toBe(provider.capabilities.compute.cpu);
            expect(any.map((o) => o.id).sort()).toEqual([...cpu, ...gpu].map((o) => o.id).sort());
            // A GPU filter is a question about GPUs: no machine without them answers it.
            expect((await provider.listOffers({ vendor: 'nvidia', includeUnavailable: true })).every((o) => o.gpuCount > 0)).toBe(true);
        });
    }

    for (const subject of CONTRACT_SUBJECTS.filter((x) => x.make().provider.capabilities.compute.cpu)) {
        it(`${subject.name}: a server without GPUs is created, listed by kind, and deleted like any other`, async () => {
            const { provider, fake } = subject.make();
            const [offer] = await provider.listOffers({ kind: 'cpu' });
            const before = fake.liveServers();
            // What it boots: a VM's own OS (with its user data), a container provider's image.
            const { userData, image } = await subject.extra(provider);
            const created = await provider.createServer({ name: 'cpu-contract', offer, ...(userData ? { userData } : {}), ...(image ? { image } : {}) });
            const running = await provider.waitUntilRunning(created.id, fast);
            expect(running).toMatchObject({ status: 'running', offerId: offer.id, region: offer.regions[0] });
            expect(running.gpu).toBeUndefined();
            expect((await provider.listServers({ kind: 'cpu' })).map((s) => s.id)).toContain(created.id);
            expect((await provider.listServers({ kind: 'gpu' })).map((s) => s.id)).not.toContain(created.id);
            expect(await provider.deleteServerAndWait(created.id, fast)).toBe(true);
            expect(fake.liveServers()).toBe(before);
        });
    }
});

describe('images where the platform has them', () => {
    for (const subject of CONTRACT_SUBJECTS) {
        it(`${subject.name}: capabilities.images matches the image calls`, async () => {
            const made = subject.make().provider;
            if (!supports(made, 'images')) {
                expect(() => requireCapability(made, 'images')).toThrow(/the "images" capability/);
                expect(supports(made, 'imageCopy')).toBe(false);
                return;
            }
            // Each image listed is the provider's, with a status of the library's and the places it boots.
            for (const i of await made.listImages()) {
                expect([i.provider, ['pending', 'available', 'error', 'unknown'].includes(i.status), Array.isArray(i.regions)]).toEqual([made.id, true, true]);
            }
            expect(['region', 'global']).toContain(made.capabilities.images.scope);
        });
    }
});

describe('serverless endpoints where the platform has them', () => {
    for (const subject of CONTRACT_SUBJECTS) {
        if (!supports(subject.make().provider, 'serverless')) {
            it(`${subject.name}: has no serverless`, () => {
                expect(() => requireCapability(subject.make().provider, 'serverless')).toThrow(/the "serverless" capability/);
            });
            continue;
        }
        it(`${subject.name}: an endpoint of an image serving plain HTTP: made, requested (its cold start waited out), read, listed, deleted, idempotently`, async () => {
            const p = requireCapability(subject.make().provider, 'serverless');
            const offers = await p.listEndpointOffers();
            expect(offers.length).toBeGreaterThan(0);
            expect(offers.map((o) => o.pricePerHour)).toEqual([...offers.map((o) => o.pricePerHour)].sort((a, b) => a - b));
            // A kind lists exactly its offers: one that listed none would leave createEndpoint to pick its own.
            const kind = p.capabilities.serverless.cpu ? 'cpu' : 'gpu';
            const kinded = await p.listEndpointOffers({ kind });
            expect(kinded.map((o) => o.id).sort()).toEqual(offers.filter((o) => (o.gpuCount > 0) === (kind === 'gpu')).map((o) => o.id).sort());
            // Not the cheapest, which createEndpoint picks when given no offer: the endpoint runs on the one it was given.
            const offer = kinded[kinded.length - 1];
            expect(offer.id).not.toBe(offers[0].id);
            const e = await p.createEndpoint({ name: 'contract-endpoint', container: { image: 'traefik/whoami:v1.12.0', env: { MODE: 'probe' } }, offer, ...fast });
            expect(e).toMatchObject({ provider: p.id, name: 'contract-endpoint', status: 'ready', image: 'traefik/whoami:v1.12.0', port: 80, minWorkers: 0, maxWorkers: 1, offerId: offer.id });
            expect(e.url).toMatch(/^https:\/\/[^/]+$/);
            expect((await p.requestEndpoint(e, '/hello', { intervalMs: 0 })).status).toBe(200);
            expect((await p.getEndpoint(e.id))?.id).toBe(e.id);
            expect((await p.listEndpoints()).map((x) => x.id)).toContain(e.id);
            await p.deleteEndpoint(e.id);
            expect(await p.getEndpoint(e.id)).toBeNull();
            await expect(p.deleteEndpoint(e.id)).resolves.toBeUndefined();
        });
    }
});

describe('image import where the platform has it', () => {
    for (const subject of CONTRACT_SUBJECTS) {
        if (!supports(subject.make().provider, 'imageImport')) {
            it(`${subject.name}: has no imageImport`, () => {
                expect(() => requireCapability(subject.make().provider, 'imageImport')).toThrow(/the "imageImport" capability/);
            });
            continue;
        }
        it(`${subject.name}: imports a disk image file from a URL as an image of its own: listed, booted, deleted like any other`, async () => {
            const { provider: made, fake } = subject.make();
            // An imported image is one of the account's images.
            const p = requireCapability(requireCapability(made, 'imageImport'), 'images');
            expect(p.capabilities.imageImport.formats).toContain('qcow2');
            const [offer] = await p.listOffers({ kind: 'cpu' });
            const region = offer.regions[0];
            const img = await p.importImage({ name: 'imported-contract', url: 'https://images.example.com/noble-server-cloudimg-amd64.qcow2', region, ...fast });
            expect(img).toMatchObject({ provider: p.id, name: 'imported-contract', status: 'available' });
            if (p.capabilities.images.scope === 'region') expect(img.regions).toEqual([region]);
            expect((await p.listImages()).map((i) => i.id)).toContain(img.id);
            const before = fake.liveServers();
            const s = await p.createServer({ name: 'cpu-contract-imported', offer, region, image: img.id, ...(await subject.extra(p)) });
            expect((await p.waitUntilRunning(s.id, fast)).status).toBe('running');
            expect(await p.deleteServerAndWait(s.id, fast)).toBe(true);
            expect(fake.liveServers()).toBe(before);
            await p.deleteImage(img.id);
            expect(await p.getImage(img.id)).toBeNull();
            await p.deleteImage(img.id);
        });
    }
});

describe('volumes where the platform has them, each kind it makes', () => {
    /** An id no volume has, in a form every platform reads (a UUID). */
    const UNKNOWN_VOLUME = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    const withVolumes = CONTRACT_SUBJECTS.filter((x) => supports(x.make().provider, 'volumes'));

    for (const subject of CONTRACT_SUBJECTS.filter((x) => !withVolumes.includes(x))) {
        it(`${subject.name}: has no volumes, and createServer refuses mounts before anything is rented`, async () => {
            const { provider, fake } = subject.make();
            expect(() => requireCapability(provider, 'volumes')).toThrow(/the "volumes" capability/);
            const [offer] = await provider.listOffers(GPU);
            const before = fake.liveServers();
            await expect(provider.createServer({ name: 'gpu-contract', offer: offer.id, region: offer.regions[0], ...(await subject.extra(provider)), mounts: [{ volume: 'vol-1' }] }))
                .rejects.toBeInstanceOf(NotSupportedError);
            expect(fake.liveServers()).toBe(before);
        });
    }

    for (const subject of withVolumes) {
        const kinds = requireCapability(subject.make().provider, 'volumes').capabilities.volumes;
        const both = !!(kinds.block && kinds.shared);
        for (const kind of ['block', 'shared'] as const) {
            const traits: VolumeKindTraits | undefined = kinds[kind];
            if (!traits) continue;
            const shared = kind === 'shared';
            const label = `${subject.name}${both ? ` (${kind})` : ''}`;
            /** What createVolume takes for this kind: a size where it is sized when made (10 GB, or its least), and the kind where the platform makes both. */
            /** Where its servers go: the subject's place for the kind, else the cheapest GPU offer, in its first region. */
            const place = async (provider: AnyProvider) => {
                const placed = await subject.volumePlace?.(provider, kind);
                if (placed) return placed;
                const [offer] = await provider.listOffers(GPU);
                return { offer, region: offer.regions[0] };
            };
            const options = {
                ...(traits.size === 'fixed' ? { sizeGb: Math.max(10, traits.minGb ?? 0) } : {}),
                ...(both ? { shared } : {}),
            };
            /** A test volume's name, as the platform takes names. */
            const named = (name: string) => subject.volumeName?.(name) ?? name;

            it(`${label}: made, read and listed; mounted by a new server; outlives it; deleted, idempotently`, async () => {
                const { provider: made, fake } = subject.make();
                const provider = requireCapability(made, 'volumes');
                const { offer, region } = await place(provider);
                const before = fake.liveServers();
                await expect(provider.getVolume(UNKNOWN_VOLUME)).resolves.toBeNull();

                const vol = await provider.createVolume({ name: named('gpu-contract-vol'), region, ...options });
                expect(vol).toMatchObject({ provider: provider.id, name: named('gpu-contract-vol'), shared, status: 'available' });
                // Where the server is: its region, or the region its zone is in (a regional volume).
                expect(region === vol.region || region.startsWith(`${vol.region}-`)).toBe(true);
                expect(vol.sizeGb).toBe(traits.size === 'fixed' ? options.sizeGb : undefined);
                // Where it mounts unless a mount says otherwise: the platform's own place, where the platform picks one.
                if (traits.mount !== 'device') expect(vol.mountPath).toMatch(/^\//);
                expect((await provider.getVolume(vol.id))?.id).toBe(vol.id);
                expect((await provider.listVolumes()).map((v) => v.id)).toContain(vol.id);

                const server = await provider.createServer({ name: 'gpu-contract-mount', offer, region, ...(await subject.extra(provider)), mounts: [{ volume: vol }] });
                const running = await provider.waitUntilRunning(server.id, fast);
                expect(running.mounts?.map((m) => m.volumeId)).toEqual([vol.id]);
                if (traits.mount === 'path') expect(running.mounts?.[0].path).toBe(vol.mountPath);
                if (!shared) expect((await provider.getVolume(vol.id))?.status).toBe('attached');

                expect(await provider.deleteServerAndWait(server.id, fast)).toBe(true);
                // The server is gone; its volume is not, and is free to mount again.
                expect((await provider.getVolume(vol.id))?.status).toBe('available');
                await provider.deleteVolume(vol.id);
                expect(await provider.getVolume(vol.id)).toBeNull();
                expect((await provider.listVolumes()).map((v) => v.id)).not.toContain(vol.id);
                await expect(provider.deleteVolume(vol.id)).resolves.toBeUndefined();
                expect(fake.liveServers()).toBe(before);
            });

            it(`${label}: a volume in another region than the server is refused before anything is rented`, async () => {
                const { provider: made, fake } = subject.make();
                const provider = requireCapability(made, 'volumes');
                const { offer, region } = await place(provider);
                const elsewhere = subject.elsewhere!(region, kind);
                // A kind made in one region only has nowhere else to be.
                if (elsewhere === undefined) return;
                const far = await provider.createVolume({ name: named('gpu-contract-far'), region: elsewhere, ...options });
                expect(far.region).not.toBe(region);
                const before = fake.liveServers();
                // By id: the provider reads where it is.
                await expect(provider.createServer({ name: 'gpu-contract-far', offer, region, ...(await subject.extra(provider)), mounts: [{ volume: far.id }] }))
                    .rejects.toThrow(far.region);
                expect(fake.liveServers()).toBe(before);
                await provider.deleteVolume(far.id);
            });

            it(`${label}: ${shared ? 'two servers mount one volume at once' : 'a volume one server holds is mounted by no other: refused before anything is rented'}`, async () => {
                const { provider: made, fake } = subject.make();
                const provider = requireCapability(made, 'volumes');
                const { offer, region } = await place(provider);
                const extra = await subject.extra(provider);
                const before = fake.liveServers();
                const vol = await provider.createVolume({ name: named('gpu-contract-shared'), region, ...options });
                const first = await provider.createServer({ name: 'gpu-contract-a', offer, region, ...extra, mounts: [{ volume: vol.id }] });
                await provider.waitUntilRunning(first.id, fast);
                if (shared) {
                    const second = await provider.createServer({ name: 'gpu-contract-b', offer, region, ...extra, mounts: [{ volume: vol.id }] });
                    expect((await provider.waitUntilRunning(second.id, fast)).mounts?.map((m) => m.volumeId)).toEqual([vol.id]);
                    expect(await provider.deleteServerAndWait(second.id, fast)).toBe(true);
                } else {
                    await expect(provider.createServer({ name: 'gpu-contract-b', offer, region, ...extra, mounts: [{ volume: vol.id }] })).rejects.toThrow(/attached|in_use/);
                    expect(fake.liveServers()).toBe(before + 1);
                }
                expect(await provider.deleteServerAndWait(first.id, fast)).toBe(true);
                await provider.deleteVolume(vol.id);
                expect(fake.liveServers()).toBe(before);
            });

            if (traits.size === 'fixed' && traits.minGb !== undefined && traits.minGb > 1) {
                it(`${label}: a size under its least (${traits.minGb} GB) is refused before anything is made`, async () => {
                    const { provider: made } = subject.make();
                    const provider = requireCapability(made, 'volumes');
                    const { region } = await place(provider);
                    await expect(provider.createVolume({ name: named('gpu-contract-tiny'), region, ...options, sizeGb: traits.minGb! - 1 })).rejects.toThrow(/GB/);
                    expect((await provider.listVolumes()).map((v) => v.name)).not.toContain(named('gpu-contract-tiny'));
                });
            }
        }

        it(`${subject.name}: the same volume twice in one create is refused`, async () => {
            const provider = requireCapability(subject.make().provider, 'volumes');
            const [offer] = await provider.listOffers(GPU);
            await expect(provider.createServer({ name: 'x', offer, ...(await subject.extra(provider)), mounts: [{ volume: 'v' }, { volume: 'v' }] })).rejects.toThrow(/mounted twice/);
            const theirs = { provider: 'elsewhere', id: 'v', name: 'v', region: offer.regions[0], shared: false, status: 'available' as const, providerStatus: '', raw: {} };
            await expect(provider.createServer({ name: 'x', offer, ...(await subject.extra(provider)), mounts: [{ volume: theirs }] })).rejects.toThrow(/elsewhere's/);
        });
    }
});

describe('private registry login', () => {
    const auth = { username: 'puller', password: 'ghp_pullOnly0', server: 'ghcr.io' };

    for (const subject of CONTRACT_SUBJECTS) {
        const vm = subject.make().provider.capabilities.compute.kind === 'vm';
        it(`${subject.name}: ${vm ? 'a VM refuses registryAuth before anything is rented' : 'the platform pulls the image with the login it was given'}`, async () => {
            const { provider, fake } = subject.make();
            const [offer] = await provider.listOffers(GPU);
            const before = fake.liveServers();
            const o = { name: 'gpu-contract-private', offer, region: offer.regions[0], ...(await subject.extra(provider)), image: 'ghcr.io/acme/worker:1', registryAuth: auth };
            if (vm) {
                await expect(provider.createServer(o)).rejects.toBeInstanceOf(NotSupportedError);
                expect(fake.liveServers()).toBe(before);
                return;
            }
            const s = await provider.createServer(o);
            expect(subject.loginOf!(fake)).toMatchObject({ username: auth.username, password: auth.password });
            expect(await provider.deleteServerAndWait(s.id, fast)).toBe(true);
            expect(fake.liveServers()).toBe(before);
        });
    }
});

describe('container: one image to run, the same option on every platform', () => {
    const spec: ContainerSpec = { image: 'ghcr.io/acme/app:1', env: { MODE: 'serve' }, command: ['serve', '--port', '8000'], ports: ['8000/tcp'] };
    const auth = { username: 'puller', password: 'ghp_pullOnly0', server: 'ghcr.io' };
    /** What createServer needs beyond the container (a container platform's own image and the rest go: the container says them). */
    const needs = async (subject: (typeof CONTRACT_SUBJECTS)[number], provider: AnyProvider) => {
        const { image: _i, env: _e, command: _c, ports: _p, registryAuth: _r, ...rest } = await subject.extra(provider);
        return rest;
    };

    for (const subject of CONTRACT_SUBJECTS) {
        const { capabilities } = subject.make().provider;
        const vm = capabilities.compute.kind === 'vm';

        it(`${subject.name}: ${vm ? 'a VM runs it with Docker from its first boot (its GPUs passed through, its login used on the machine), and its own user data too'
            : 'the platform runs it as its own container, pulled with its login'}`, async () => {
            const { provider, fake } = subject.make();
            const [offer] = await provider.listOffers(GPU);
            const before = fake.liveServers();
            const rest = await needs(subject, provider);
            const s = await provider.createServer({ name: 'gpu-contract-container', offer, region: offer.regions[0], ...rest, container: { ...spec, registryAuth: auth } });
            if (vm) {
                const userData = subject.userDataOf!(fake) ?? '';
                // The caller's user data and the container's script, as one cloud-init document, the caller's first.
                expect(rest.userData).toMatch(/\S/);
                expect(userData).toMatch(/^Content-Type: multipart\/mixed; boundary="/);
                expect(userData.indexOf(rest.userData!)).toBeLessThan(userData.indexOf('# asap-vps: the server\'s container'));
                expect(userData).toContain(`'--env-file' '/etc/asap-vps/container.env' '-p' '8000:8000/tcp' $GPUS 'ghcr.io/acme/app:1' 'serve' '--port' '8000'`);
                expect(userData).toContain('\nMODE=serve\n');
                expect(userData).toContain('GPUS="--gpus all"');
                expect(userData).toContain(`printf '%s' 'ghp_pullOnly0' | docker login -u 'puller' --password-stdin 'ghcr.io'`);
            } else {
                expect(subject.runOf!(fake)).toEqual({ image: spec.image, env: spec.env, command: spec.command, ports: spec.ports });
                expect(subject.loginOf!(fake)).toMatchObject({ username: auth.username, password: auth.password });
            }
            expect(await provider.deleteServerAndWait(s.id, fast)).toBe(true);
            expect(fake.liveServers()).toBe(before);
        });

        if (vm && capabilities.compute.cpu) {
            it(`${subject.name}: a VM without GPUs runs it with no GPU set-up, and the container's script alone without user data of its own`, async () => {
                const { provider, fake } = subject.make();
                const [offer] = await provider.listOffers({ kind: 'cpu' });
                const { userData: _u, ...rest } = await needs(subject, provider);
                const s = await provider.createServer({ name: 'cpu-contract-container', offer, region: offer.regions[0], ...rest, container: { image: 'busybox:1.36' } });
                const userData = subject.userDataOf!(fake) ?? '';
                expect(userData).toMatch(/^#!\/bin\/bash\n/);
                expect(userData).not.toContain('nvidia');
                expect(userData).toContain(`$GPUS 'busybox:1.36'\n`);
                expect(await provider.deleteServerAndWait(s.id, fast)).toBe(true);
            });
        }

        it(`${subject.name}: ${vm ? 'a container its machine cannot run (no image, a bad env name or port) is refused' : 'container, or the top-level image and the rest, never both; no image is refused'} before anything is rented`, async () => {
            const { provider, fake } = subject.make();
            const [offer] = await provider.listOffers(GPU);
            const before = fake.liveServers();
            const creates = fake.calls.filter((c) => c.method !== 'GET').length;
            const o = { name: 'gpu-contract-container-refused', offer, region: offer.regions[0], ...(await needs(subject, provider)) };
            await expect(provider.createServer({ ...o, container: { image: '' } })).rejects.toThrow(/needs an image/);
            if (vm) {
                await expect(provider.createServer({ ...o, container: { ...spec, env: { 'NOT-A-NAME': '1' } } })).rejects.toThrow(/container: bad env name "NOT-A-NAME"/);
                await expect(provider.createServer({ ...o, container: { ...spec, ports: ['80:8080'] } })).rejects.toThrow(/container: bad port "80:8080"/);
            } else {
                await expect(provider.createServer({ ...o, container: spec, image: 'ghcr.io/acme/other:2' })).rejects.toThrow(/pass "container" or "image", not both/);
                await expect(provider.createServer({ ...o, container: spec, env: { A: '1' }, command: ['x'] })).rejects.toThrow(/pass "container" or "env", "command", not both/);
            }
            expect(fake.liveServers()).toBe(before);
            // Nothing was written: no key, no stored login, no server.
            expect(fake.calls.filter((c) => c.method !== 'GET').length).toBe(creates);
        });
    }
});

describe('attaching a volume to a server that runs, where the platform can', () => {
    const withAttach = CONTRACT_SUBJECTS.filter((x) => supports(x.make().provider, 'volumeAttach'));

    for (const subject of CONTRACT_SUBJECTS.filter((x) => !withAttach.includes(x))) {
        it(`${subject.name}: has no volumeAttach (its volumes, if any, are mounted when a server is created)`, () => {
            expect(() => requireCapability(subject.make().provider, 'volumeAttach')).toThrow(/the "volumeAttach" capability/);
        });
    }

    for (const subject of withAttach) {
        it(`${subject.name}: attach and detach while it runs, both idempotent; an attached volume outlives the server`, async () => {
            const { provider: made, fake } = subject.make();
            const provider = requireCapability(requireCapability(made, 'volumes'), 'volumeAttach');
            const [offer] = await provider.listOffers(GPU);
            const region = offer.regions[0];
            const before = fake.liveServers();
            const vol = await provider.createVolume({ name: 'gpu-contract-hot', region, sizeGb: 10 });
            const s = await provider.createServer({ name: 'gpu-contract-hot', offer, region, ...(await subject.extra(provider)) });
            await provider.waitUntilRunning(s.id, fast);
            await provider.attachVolume(vol.id, s.id, fast);
            expect(await provider.getVolume(vol.id)).toMatchObject({ status: 'attached', serverIds: [s.id] });
            expect((await provider.getServer(s.id))?.mounts?.map((m) => m.volumeId)).toEqual([vol.id]);
            await expect(provider.attachVolume(vol.id, s.id, fast)).resolves.toBeUndefined();
            await provider.detachVolume(vol.id, s.id, fast);
            expect(await provider.getVolume(vol.id)).toMatchObject({ status: 'available', serverIds: [] });
            expect((await provider.getServer(s.id))?.mounts ?? []).toEqual([]);
            await expect(provider.detachVolume(vol.id, s.id, fast)).resolves.toBeUndefined();
            // Attached again, it is kept when the server is deleted.
            await provider.attachVolume(vol.id, s.id, fast);
            expect(await provider.deleteServerAndWait(s.id, fast)).toBe(true);
            expect(await provider.getVolume(vol.id)).toMatchObject({ status: 'available' });
            await provider.deleteVolume(vol.id);
            expect(fake.liveServers()).toBe(before);
        });

        it(`${subject.name}: a volume elsewhere, or one another server holds, is refused`, async () => {
            const provider = requireCapability(requireCapability(subject.make().provider, 'volumes'), 'volumeAttach');
            const [offer] = await provider.listOffers(GPU);
            const region = offer.regions[0];
            const far = await provider.createVolume({ name: 'gpu-contract-far', region: subject.elsewhere!(region, 'block')!, sizeGb: 10 });
            const vol = await provider.createVolume({ name: 'gpu-contract-held', region, sizeGb: 10 });
            const a = await provider.createServer({ name: 'gpu-contract-a', offer, region, ...(await subject.extra(provider)), mounts: [{ volume: vol }] });
            const b = await provider.createServer({ name: 'gpu-contract-b', offer, region, ...(await subject.extra(provider)) });
            await provider.waitUntilRunning(a.id, fast);
            await provider.waitUntilRunning(b.id, fast);
            await expect(provider.attachVolume(far.id, b.id, fast)).rejects.toThrow(far.region);
            await expect(provider.attachVolume(vol.id, b.id, fast)).rejects.toThrow(/attached|in_use/);
            expect(await provider.getVolume(vol.id)).toMatchObject({ serverIds: [a.id] });
        });
    }
});
