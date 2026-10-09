// LambdaCloud against the fake of Lambda Cloud's API (src/testing/fakes/lambda.ts):
// what is particular to it beyond the shared contract (../contract.spec.ts),
// and Lambda's launch limits (spec 1.10.0, cloud.lambda.ai/api/v1/openapi.json):
// exactly one SSH key, names up to 64 characters, tag keys in Lambda's format,
// each refused before anything is sent; and filesystems (its volumes): no size,
// mounted at launch under /home, /lambda/nfs or /data, never deleted in use.

import { AuthError, CapacityError, isRetriable, NotFoundError, NotSupportedError, ProviderError, QuotaError } from '../../errors';
import { fakeLambda } from '../../testing/fakes/lambda';
import { json } from '../../testing/fakes/util';
import { LambdaCloud } from './LambdaCloud';

const noSleep = async () => {};
const fast = { intervalMs: 0, timeoutMs: 5000 };

/** The fake, but for the requests `answer` answers itself: an answer Lambda may give that the fake does not. */
const answering = (fake: ReturnType<typeof fakeLambda>, answer: (method: string, path: string) => Response | undefined) =>
    (async (url: string, init?: RequestInit) => answer(init?.method ?? 'GET', new URL(url).pathname) ?? fake.fetchImpl(url, init)) as typeof fetch;

describe('LambdaCloud', () => {
    const make = (o: Parameters<typeof fakeLambda>[0] = {}) => {
        const fake = fakeLambda(o);
        return { fake, p: new LambdaCloud({ apiKey: 'lambda-test', fetchImpl: fake.fetchImpl, sleep: noSleep }) };
    };

    it('offers GPU types only, VRAM from the description, the price for the whole instance', async () => {
        const { p } = make();
        const offers = await p.listOffers({ includeUnavailable: true });
        expect(offers.map((o) => o.id)).not.toContain('cpu_4x_general');
        expect(offers.find((o) => o.id === 'gpu_8x_a100_80gb_sxm4')).toMatchObject({ gpu: 'A100', gpuCount: 8, vramGb: 80, pricePerHour: 14.32 });
        expect(offers.find((o) => o.id === 'gpu_1x_a10')).toMatchObject({ gpu: 'A10', vramGb: 24, regions: ['us-east-1'] });
    });

    it('launches with key NAMES, an image id or family, and key=value tags', async () => {
        const { p, fake } = make();
        const [key] = await p.listSSHKeys();
        await p.createServer({ name: 'a', offer: 'gpu_1x_a10', region: 'us-east-1', sshKeyIds: [key.id], image: 'lambda-stack-24-04', tags: ['team=ml', 'scratch'] });
        await p.createServer({ name: 'b', offer: 'gpu_1x_a10', region: 'us-east-1', sshKeyIds: ['laptop'], image: '43336648-096d-4cba-9aa2-f9bb7727639d' });
        const bodies = fake.calls.filter((c) => c.path === '/api/v1/instance-operations/launch').map((c) => c.body);
        expect(bodies[0]).toMatchObject({ ssh_key_names: ['laptop'], image: { family: 'lambda-stack-24-04' }, tags: [{ key: 'team', value: 'ml' }, { key: 'scratch', value: '' }] });
        expect(bodies[1]).toMatchObject({ ssh_key_names: ['laptop'], image: { id: '43336648-096d-4cba-9aa2-f9bb7727639d' } });
    });

    it('needs a key and a region; an unknown key is refused before anything launches', async () => {
        const { p, fake } = make();
        await expect(p.createServer({ name: 'a', offer: 'gpu_1x_a10', region: 'us-east-1' })).rejects.toThrow(/SSH key/);
        await expect(p.createServer({ name: 'a', offer: 'gpu_1x_a10', region: 'us-east-1', sshKeyIds: ['nope'] })).rejects.toThrow(/no SSH key "nope"/);
        // An offer given by its id has no regions of its own to pick from.
        await expect(p.createServer({ name: 'a', offer: 'gpu_1x_a10', sshKeyIds: ['laptop'] })).rejects.toThrow('an instance needs a region (one of the offer\'s regions)');
        expect(fake.calls.filter((c) => c.path === '/api/v1/instance-operations/launch')).toHaveLength(0);
    });

    it('an image is an id when the whole of it is 32 hex digits or a UUID, and a family otherwise', async () => {
        const { p, fake } = make();
        const hex = '0123456789abcdef0123456789abcdef';
        const uuid = '43336648-096D-4CBA-9AA2-F9BB7727639D';
        const images: Array<[string, Record<string, string>]> = [
            [hex, { id: hex }], [uuid, { id: uuid }], [`family-${hex}`, { family: `family-${hex}` }], [`${hex}-v2`, { family: `${hex}-v2` }], [`${uuid}-v2`, { family: `${uuid}-v2` }],
        ];
        for (const [image] of images) await p.createServer({ name: 'a', offer: 'gpu_1x_a10', region: 'us-east-1', sshKeyIds: ['laptop'], image });
        expect(fake.calls.filter((c) => c.path === '/api/v1/instance-operations/launch').map((c) => c.body.image)).toEqual(images.map(([, sent]) => sent));
    });

    it('reads the GPU count an instance type\'s name states, and refuses a gpuCount other than it before anything launches', async () => {
        expect(['gpu_8x_a100_80gb_sxm4', 'gpu_1x_a10', 'gpu_16x_b200', 'cpu_4x_general', 'my_gpu_2x_a10'].map((t) => LambdaCloud.gpuCountOf(t))).toEqual([8, 1, 16, undefined, undefined]);
        const { p, fake } = make();
        const o = { name: 'a', offer: 'gpu_8x_a100_80gb_sxm4', region: 'us-east-1', sshKeyIds: ['laptop'] };
        await expect(p.createServer({ ...o, gpuCount: 1 })).rejects.toThrow('createServer option "gpuCount" 1: this offer has 8 GPU(s); pick an offer with 1 is not supported');
        expect(fake.calls.filter((c) => c.path === '/api/v1/instance-operations/launch')).toEqual([]);
        await expect(p.createServer({ ...o, gpuCount: 8 })).resolves.toMatchObject({ name: 'a', gpuCount: 8 });
    });

    it('a launch that answers no instance id is an error; an instance not listed yet is what the launch said of it', async () => {
        const fake = fakeLambda();
        const launch = '/api/v1/instance-operations/launch';
        const none = new LambdaCloud({ apiKey: 'lambda-test', sleep: noSleep,
            fetchImpl: answering(fake, (_, path) => (path === launch ? json(200, { data: { instance_ids: [] } }) : undefined)) });
        await expect(none.createServer({ name: 'a', offer: 'gpu_1x_a10', region: 'us-east-1', sshKeyIds: ['laptop'] })).rejects.toThrow('lambda: the launch returned no instance id');
        // Launched, but the read of it answers that it does not exist (yet).
        const p = new LambdaCloud({ apiKey: 'lambda-test', sleep: noSleep,
            fetchImpl: answering(fake, (method, path) => (method === 'GET' && path.startsWith('/api/v1/instances/')
                ? json(404, { error: { code: 'global/object-does-not-exist', message: 'Specified instance does not exist.' } }) : undefined)) });
        const s = await p.createServer({ name: 'a', offer: 'gpu_1x_a10', region: 'us-east-1', sshKeyIds: ['laptop'] });
        const id = [...fake.state.instances.keys()].pop()!;
        expect(s).toEqual({
            provider: 'lambda', id, name: 'a', status: 'pending', providerStatus: 'booting', offerId: 'gpu_1x_a10', region: 'us-east-1', billing: LambdaCloud.BILLING,
            raw: { id, name: 'a', status: 'booting', ssh_key_names: ['laptop'], region: { name: 'us-east-1', description: '' } },
        });
    });

    it('an answer without its data reads as none: no instances, keys, filesystems or offers', async () => {
        const fake = fakeLambda();
        const p = new LambdaCloud({ apiKey: 'lambda-test', sleep: noSleep, fetchImpl: answering(fake, (method) => (method === 'GET' ? json(200, {}) : undefined)) });
        expect([await p.listServers(), await p.listSSHKeys(), await p.listVolumes(), await p.listOffers()]).toEqual([[], [], [], []]);
    });

    it('the account quota is a QuotaError', async () => {
        const { p } = make({ instanceQuota: 1 });
        await expect(p.createServer({ name: 'a', offer: 'gpu_1x_a10', region: 'us-east-1', sshKeyIds: ['laptop'] })).rejects.toBeInstanceOf(QuotaError);
    });

    it('reads each answer a launch documents by its code, whatever status carries it', async () => {
        // The launch's documented failures (openapi 1.10.0): the status, the code, and what it is to a caller.
        const documented: Array<[number, string, new (...a: never[]) => Error, boolean]> = [
            [400, 'global/object-does-not-exist', NotFoundError, false],
            [404, 'global/object-does-not-exist', NotFoundError, false],
            [400, 'instance-operations/launch/insufficient-capacity', CapacityError, false],
            [400, 'global/quota-exceeded', QuotaError, false],
            // A 403 that is the account's state, not the key's: nothing a new key fixes.
            [403, 'global/account-inactive', QuotaError, false],
            [403, 'global/invalid-address', QuotaError, false],
            [401, 'global/invalid-api-key', AuthError, false],
            [400, 'global/invalid-parameters', ProviderError, false],
            [400, 'instance-operations/launch/file-system-in-wrong-region', ProviderError, false],
            [429, 'global/rate-limited', ProviderError, true],
        ];
        for (const [status, code, kind, retriable] of documented) {
            const fake = fakeLambda();
            const answering = (async (url: string, init?: RequestInit) => (init?.method === 'POST' && new URL(url).pathname.endsWith('/instance-operations/launch')
                ? new Response(JSON.stringify({ error: { code, message: 'refused', suggestion: 'see the docs' } }), { status, headers: { 'content-type': 'application/json' } })
                : fake.fetchImpl(url, init))) as typeof fetch;
            const p = new LambdaCloud({ apiKey: 'lambda-test', fetchImpl: answering, sleep: noSleep });
            const e = await p.createServer({ name: 'a', offer: 'gpu_1x_a10', region: 'us-east-1', sshKeyIds: ['laptop'] }).catch((x) => x);
            expect([code, status, e.constructor.name, e.code, isRetriable(e)]).toEqual([code, status, kind.name, code, retriable]);
            expect(e.message).toContain('(see the docs)');
        }
    });

    it('reads a failure by its status where it has no code: a server error may be retried; a code that says not found is NotFoundError whatever its status', async () => {
        const failing = (status: number, body: unknown) => new LambdaCloud({ apiKey: 'lambda-test', sleep: noSleep,
            fetchImpl: answering(fakeLambda(), (_, path) => (path === '/api/v1/instance-types' ? json(status, body) : undefined)) }).listOffers().catch((e) => e);
        const bare = await failing(400, { error: { message: 'Bad request.' } });
        expect([bare.constructor.name, bare.status, bare.code, isRetriable(bare)]).toEqual(['ProviderError', 400, undefined, false]);
        expect(bare.message).toMatch(/^lambda: GET \/api\/v1\/instance-types -> 400 +Bad request\.$/);
        for (const status of [500, 503]) {
            const e = await failing(status, { error: { code: 'global/unknown', message: 'Something went wrong.' } });
            expect([e.constructor.name, e.status, isRetriable(e)]).toEqual(['ProviderError', status, true]);
        }
        const missing = await failing(400, { error: { code: 'global/not-found', message: 'Not found.' } });
        expect([missing.constructor.name, missing.status, missing.code]).toEqual(['NotFoundError', 400, 'global/not-found']);
    });

    it('lists GPU instances, CPU instances, or both (the default); logs in as ubuntu', async () => {
        const { p } = make();
        const cpu = await p.createServer({ name: 'cpu', offer: 'cpu_4x_general', region: 'us-east-1', sshKeyIds: ['laptop'] });
        const gpu = await p.createServer({ name: 'gpu', offer: 'gpu_1x_a10', region: 'us-east-1', sshKeyIds: ['laptop'] });
        expect((await p.listServers({ kind: 'gpu' })).map((s) => s.id)).not.toContain(cpu.id);
        expect((await p.listServers({ kind: 'cpu' })).map((s) => s.id)).toEqual([cpu.id]);
        expect((await p.listServers()).map((s) => s.id)).toEqual(expect.arrayContaining([cpu.id, gpu.id]));
        expect((await p.waitUntilRunning(gpu.id, fast)).ssh).toMatchObject({ port: 22, username: 'ubuntu' });
    });

    it('a terminating instance is not yet gone', async () => {
        const { p } = make();
        const s = await p.createServer({ name: 'a', offer: 'gpu_1x_a10', region: 'us-east-1', sshKeyIds: ['laptop'] });
        await p.waitUntilRunning(s.id, fast);
        await p.deleteServer(s.id);
        expect((await p.getServer(s.id))?.status).toBe('terminating');
        expect((await p.getServer(s.id))?.status).toBe('terminated');
        expect(await p.getServer(s.id)).toBeNull();
    });

    it('deleteServerAndWait says false when the instance is still terminating at the timeout', async () => {
        const { p } = make({ terminateReads: 1e9 });
        const s = await p.createServer({ name: 'a', offer: 'gpu_1x_a10', region: 'us-east-1', sshKeyIds: ['laptop'] });
        await p.waitUntilRunning(s.id, fast);
        expect(await p.deleteServerAndWait(s.id, { timeoutMs: 0 })).toBe(false);
        expect((await p.getServer(s.id))?.status).toBe('terminating');
    });

    it('reads every status word Lambda reports: unhealthy is an error, preempted is gone', async () => {
        const { fake, p } = make();
        const s = await p.createServer({ name: 'a', offer: 'gpu_1x_a10', region: 'us-east-1', sshKeyIds: ['laptop'] });
        await p.waitUntilRunning(s.id, fast);
        fake.state.instances.get(s.id).status = 'unhealthy';
        expect(await p.getServer(s.id)).toMatchObject({ status: 'error', providerStatus: 'unhealthy' });
        await expect(p.waitUntilRunning(s.id, fast)).rejects.toThrow(/is error \(unhealthy\)/);
        fake.state.instances.get(s.id).status = 'preempted';
        expect(await p.getServer(s.id)).toMatchObject({ status: 'terminated', providerStatus: 'preempted' });
        await expect(p.waitUntilRunning(s.id, fast)).rejects.toThrow(/is terminated \(preempted\)/);
    });
});

describe('LambdaCloud launch limits', () => {
    const make = () => {
        const fake = fakeLambda();
        return { fake, p: new LambdaCloud({ apiKey: 'lambda-test', fetchImpl: fake.fetchImpl, sleep: noSleep }) };
    };
    const launches = (fake: ReturnType<typeof fakeLambda>) => fake.calls.filter((c) => c.method === 'POST' && c.path === '/api/v1/instance-operations/launch');

    it('takes exactly one SSH key, and refuses a second before asking Lambda', async () => {
        const { p, fake } = make();
        const [key] = await p.listSSHKeys();
        const second = await p.addSSHKey('ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOtestsecondkeyonlyAAAAAAAAAAAAAAAAAAAAAAAAAAA two@test', 'second');
        await expect(p.createServer({ name: 'two-keys', offer: 'gpu_1x_a10', region: 'us-east-1', sshKeyIds: [key.id, second.id] }))
            .rejects.toBeInstanceOf(NotSupportedError);
        await expect(p.createServer({ name: 'two-keys', offer: 'gpu_1x_a10', region: 'us-east-1', sshKeyIds: [key.id, second.id] }))
            .rejects.toThrow('more than one SSH key at launch is not supported');
        expect(launches(fake)).toHaveLength(0);
        await expect(p.createServer({ name: 'one-key', offer: 'gpu_1x_a10', region: 'us-east-1', sshKeyIds: [key.id] })).resolves.toMatchObject({ name: 'one-key' });
    });

    it('refuses a name over 64 characters and a tag key Lambda rejects; accepts its own format', async () => {
        const { p, fake } = make();
        const [key] = await p.listSSHKeys();
        const base = { offer: 'gpu_1x_a10', region: 'us-east-1', sshKeyIds: [key.id] };
        await expect(p.createServer({ ...base, name: 'x'.repeat(65) })).rejects.toThrow(/at most 64/);
        for (const tag of ['Owner=me', 'my_tag=1', 'a=1', 'lambda-ai-x=1', `ok=${'v'.repeat(129)}`]) {
            await expect(p.createServer({ ...base, name: 'tagged', tags: [tag] })).rejects.toBeInstanceOf(ProviderError);
        }
        await expect(p.createServer({ ...base, name: 'tagged', tags: ['Owner=me'] }))
            .rejects.toThrow('tag "Owner=me": a key is 2-55 of a-z 0-9 - : starting with a letter (not lambda-ai-), a value at most 128 characters');
        expect(launches(fake)).toHaveLength(0);
        await expect(p.createServer({ ...base, name: 'tagged', tags: ['team:gpu=render', 'env'] })).resolves.toMatchObject({ name: 'tagged' });
        expect(launches(fake)[0].body.tags).toEqual([{ key: 'team:gpu', value: 'render' }, { key: 'env', value: '' }]);
        // A value of 128 characters is Lambda's longest.
        await expect(p.createServer({ ...base, name: 'longest', tags: [`ok=${'v'.repeat(128)}`] })).resolves.toMatchObject({ name: 'longest' });
        expect(launches(fake)[1].body.tags).toEqual([{ key: 'ok', value: 'v'.repeat(128) }]);
        await expect(p.addSSHKey('ssh-ed25519 AAAA x', 'k'.repeat(65))).rejects.toThrow(/1-64 characters/);
    });
});

describe('Lambda filesystems', () => {
    const make = () => {
        const fake = fakeLambda();
        return { fake, p: new LambdaCloud({ apiKey: 'lambda-test', fetchImpl: fake.fetchImpl, sleep: noSleep }) };
    };
    const launches = (fake: ReturnType<typeof fakeLambda>) => fake.calls.filter((c) => c.path === '/api/v1/instance-operations/launch').map((c) => c.body);
    const reads = (fake: ReturnType<typeof fakeLambda>) => fake.calls.filter((c) => c.method === 'GET' && c.path === '/api/v1/filesystems').length;
    /** A provider whose clock moves only as it sleeps: a wait that never ends runs out at once, however long it is. */
    const clocked = async (fake: ReturnType<typeof fakeLambda>, run: (p: LambdaCloud) => Promise<void>) => {
        let now = Date.now();
        const clock = jest.spyOn(Date, 'now').mockImplementation(() => now);
        try {
            await run(new LambdaCloud({ apiKey: 'lambda-test', fetchImpl: fake.fetchImpl, sleep: async (ms) => { now += ms; } }));
        } finally {
            clock.mockRestore();
        }
    };

    it('has no size, and a name Lambda takes: refused before anything is sent otherwise', async () => {
        const { fake, p } = make();
        // Not in its type (a filesystem grows as it fills); code typed for any provider may still pass it.
        await expect(p.createVolume({ name: 'models', region: 'us-east-1', sizeGb: 10 } as Parameters<LambdaCloud['createVolume']>[0])).rejects.toThrow(NotSupportedError);
        await expect(p.createVolume({ name: 'models', region: 'us-east-1', sizeGb: 10 } as Parameters<LambdaCloud['createVolume']>[0]))
            .rejects.toThrow('createVolume option "sizeGb" (a filesystem grows as it fills) is not supported');
        await expect(p.createVolume({ name: '1models', region: 'us-east-1' })).rejects.toThrow(/a letter then letters/);
        await expect(p.createVolume({ name: 'm'.repeat(61), region: 'us-east-1' })).rejects.toThrow(/1-60 characters/);
        expect(fake.calls.filter((c) => c.method === 'POST')).toEqual([]);
        const fs = await p.createVolume({ name: 'models', region: 'us-east-1' });
        expect(fs).toMatchObject({ name: 'models', region: 'us-east-1', status: 'available', providerStatus: 'not in use', mountPath: '/lambda/nfs/models' });
        expect(fs.sizeGb).toBeUndefined();
        expect(fs.createdAt).toBe(Date.parse(fs.raw.created));
        await expect(p.createVolume({ name: 'models', region: 'us-east-1' })).rejects.toThrow(/already exists/);
    });

    it('mounts at its own mount point, or a path under /home, /lambda/nfs or /data; a volume object needs no lookup, an id does', async () => {
        const { fake, p } = make();
        const [offer] = await p.listOffers();
        const [key] = await p.listSSHKeys();
        const fs = await p.createVolume({ name: 'models', region: offer.regions[0] });
        const o = { name: 'a', offer, sshKeyIds: [key.id] };
        const before = reads(fake);
        const a = await p.createServer({ ...o, mounts: [{ volume: fs }] });
        expect(reads(fake)).toBe(before);
        expect(launches(fake).pop()?.file_system_mounts).toEqual([{ file_system_id: fs.id, mount_point: '/lambda/nfs/models' }]);
        const b = await p.createServer({ ...o, name: 'b', mounts: [{ volume: fs.id, path: '/data/models' }] });
        expect(reads(fake)).toBe(before + 1);
        expect((await p.waitUntilRunning(b.id, fast)).mounts).toEqual([{ volumeId: fs.id, path: '/data/models' }]);
        expect((await p.getVolume(fs.id))?.status).toBe('attached');
        const sent = launches(fake).length;
        await expect(p.createServer({ ...o, name: 'c', mounts: [{ volume: fs, path: '/mnt/models' }] })).rejects.toThrow(/under \/home, \/lambda\/nfs or \/data/);
        await expect(p.createServer({ ...o, name: 'c', mounts: [{ volume: fs, path: `/data/${'x'.repeat(260)}` }] })).rejects.toThrow(/under \/home/);
        await expect(p.createServer({ ...o, name: 'c', mounts: [{ volume: 'f'.repeat(32) }] })).rejects.toThrow(/no filesystem/);
        expect(launches(fake)).toHaveLength(sent);
        expect(await p.deleteServerAndWait(a.id, fast)).toBe(true);
        expect(await p.deleteServerAndWait(b.id, fast)).toBe(true);
    });

    it('one an instance mounts is not deleted (filesystems/filesystem-in-use); once nothing does, it is', async () => {
        const { p } = make();
        const [offer] = await p.listOffers();
        const [key] = await p.listSSHKeys();
        const fs = await p.createVolume({ name: 'models', region: offer.regions[0] });
        const s = await p.createServer({ name: 'a', offer, sshKeyIds: [key.id], mounts: [{ volume: fs }] });
        await expect(p.deleteVolume(fs.id)).rejects.toMatchObject({ code: 'filesystems/filesystem-in-use' });
        expect(await p.deleteServerAndWait(s.id, fast)).toBe(true);
        await p.deleteVolume(fs.id);
        expect(await p.listVolumes()).toEqual([]);
    });

    it('deleteServerAndWait returns once Lambda has let go of the filesystems the instance mounted, which it does late', async () => {
        const { fake, p } = make();
        const [offer] = await p.listOffers();
        const [key] = await p.listSSHKeys();
        const fs = await p.createVolume({ name: 'models', region: offer.regions[0] });
        const s = await p.createServer({ name: 'a', offer, sshKeyIds: [key.id], mounts: [{ volume: fs }] });
        await p.waitUntilRunning(s.id, fast);
        expect(await p.deleteServerAndWait(s.id, fast)).toBe(true);
        // Let go of: a delete is taken at once, with no wait of its own.
        expect(await p.getVolume(fs.id)).toMatchObject({ status: 'available' });
        const before = reads(fake);
        await p.deleteVolume(fs.id);
        expect(reads(fake)).toBe(before);
        expect(await p.getVolume(fs.id)).toBeNull();
    });

    it('deleteVolume waits out a filesystem Lambda has not let go of yet; one a live instance mounts is refused at once', async () => {
        const { fake, p } = make();
        const [offer] = await p.listOffers();
        const [key] = await p.listSSHKeys();
        const fs = await p.createVolume({ name: 'models', region: offer.regions[0] });
        const s = await p.createServer({ name: 'a', offer, sshKeyIds: [key.id], mounts: [{ volume: fs }] });
        await p.waitUntilRunning(s.id, fast);
        // The instance goes by a plain delete: nothing waits for its filesystem.
        await p.deleteServer(s.id);
        while (await p.getServer(s.id)) { /* the fake moves on with every read */ }
        expect(await p.getVolume(fs.id)).toMatchObject({ status: 'attached' });
        await p.deleteVolume(fs.id, fast);
        expect(await p.getVolume(fs.id)).toBeNull();
        // In use by a live instance: refused, not waited for.
        const other = await p.createVolume({ name: 'data', region: offer.regions[0] });
        await p.createServer({ name: 'b', offer, sshKeyIds: [key.id], mounts: [{ volume: other }] });
        const t0 = reads(fake);
        await expect(p.deleteVolume(other.id, fast)).rejects.toMatchObject({ code: 'filesystems/filesystem-in-use' });
        expect(reads(fake) - t0).toBeLessThanOrEqual(1);
    });

    it('getVolume reads the one asked for among several; an id the account does not have is none', async () => {
        const { p } = make();
        const models = await p.createVolume({ name: 'models', region: 'us-east-1' });
        const data = await p.createVolume({ name: 'data', region: 'us-west-1' });
        expect([(await p.getVolume(data.id))?.name, (await p.getVolume(models.id))?.name, await p.getVolume('f'.repeat(32))]).toEqual(['data', 'models', null]);
    });

    it('mounts filesystems given as objects and as ids in one launch, at a path of up to 256 characters; one whose record names no region is refused', async () => {
        const { fake, p } = make();
        const models = await p.createVolume({ name: 'models', region: 'us-east-1' });
        const data = await p.createVolume({ name: 'data', region: 'us-east-1' });
        const o = { offer: 'gpu_1x_a10', region: 'us-east-1', sshKeyIds: ['laptop'] };
        const path = `/data/${'x'.repeat(250)}`;
        expect(path).toHaveLength(256);
        await p.createServer({ ...o, name: 'a', mounts: [{ volume: models }, { volume: data.id, path }] });
        expect(launches(fake).pop()?.file_system_mounts).toEqual([{ file_system_id: models.id, mount_point: '/lambda/nfs/models' }, { file_system_id: data.id, mount_point: path }]);
        // Refused as not in the instance's region, never a crash.
        const nowhere = { ...data, raw: { ...data.raw, region: undefined } } as unknown as typeof data;
        const e = await p.createServer({ ...o, name: 'b', mounts: [{ volume: nowhere }] }).catch((x) => x);
        expect(e).toBeInstanceOf(ProviderError);
        expect(e.message).toMatch(/^lambda: filesystem data is in .*: an instance in us-east-1 cannot mount it$/);
    });

    it('deleteVolume refuses at once, waiting for nothing, a filesystem a live instance mounts, and any other failure', async () => {
        const fake = fakeLambda();
        const sent: string[] = [];
        let inactive = false;
        const p = new LambdaCloud({ apiKey: 'lambda-test', sleep: noSleep, fetchImpl: answering(fake, (method, path) => {
            sent.push(`${method} ${path}`);
            return inactive && method === 'DELETE' ? json(403, { error: { code: 'global/account-inactive', message: 'Your account is inactive.' } }) : undefined;
        }) });
        const held = await p.createVolume({ name: 'models', region: 'us-east-1' });
        const free = await p.createVolume({ name: 'data', region: 'us-east-1' });
        await p.createServer({ name: 'a', offer: 'gpu_1x_a10', region: 'us-east-1', sshKeyIds: ['laptop'], mounts: [{ volume: held }] });
        sent.length = 0;
        await expect(p.deleteVolume(held.id, fast)).rejects.toMatchObject({ status: 400, code: 'filesystems/filesystem-in-use' });
        // The refusal, and the read that shows a live instance mounts it: no wait, no second delete.
        expect(sent).toEqual([`DELETE /api/v1/filesystems/${held.id}`, 'GET /api/v1/instances']);
        inactive = true;
        sent.length = 0;
        await expect(p.deleteVolume(free.id, fast)).rejects.toMatchObject({ status: 403, code: 'global/account-inactive' });
        expect(sent).toEqual([`DELETE /api/v1/filesystems/${free.id}`]);
    });

    it('deleteVolume waits as long as Lambda takes to let go of a filesystem whose instance is gone, then deletes it', async () => {
        const fake = fakeLambda({ releaseReads: 5 });
        const p = new LambdaCloud({ apiKey: 'lambda-test', fetchImpl: fake.fetchImpl, sleep: noSleep });
        const fs = await p.createVolume({ name: 'models', region: 'us-east-1' });
        const s = await p.createServer({ name: 'a', offer: 'gpu_1x_a10', region: 'us-east-1', sshKeyIds: ['laptop'], mounts: [{ volume: fs }] });
        await p.waitUntilRunning(s.id, fast);
        await p.deleteServer(s.id);
        while (await p.getServer(s.id)) { /* the fake moves on with every read */ }
        await p.deleteVolume(fs.id, fast);
        expect(await p.getVolume(fs.id)).toBeNull();
        // Refused while Lambda held it, then deleted once it let go.
        expect(fake.calls.filter((c) => c.method === 'DELETE').map((c) => c.path)).toEqual([`/api/v1/filesystems/${fs.id}`, `/api/v1/filesystems/${fs.id}`]);
    });

    it('waits up to 5 minutes by default, reading every 10 s, for Lambda to let go of what an instance mounted; then says which filesystems it still holds', async () => {
        // Lambda never lets go here.
        const fake = fakeLambda({ releaseReads: 1e9 });
        await clocked(fake, async (p) => {
            const models = await p.createVolume({ name: 'models', region: 'us-east-1' });
            const data = await p.createVolume({ name: 'data', region: 'us-east-1' });
            const s = await p.createServer({ name: 'a', offer: 'gpu_1x_a10', region: 'us-east-1', sshKeyIds: ['laptop'], mounts: [{ volume: models }, { volume: data }] });
            await p.waitUntilRunning(s.id, fast);
            const before = reads(fake);
            await expect(p.deleteServerAndWait(s.id)).rejects.toThrow(`timed out after 300 s waiting for filesystem(s) to be let go by instance ${s.id}: models, data in use, by no live instance`);
            // At 0 s, 10 s, ... 300 s.
            expect(reads(fake) - before).toBe(31);
        });
    });

    it('a filesystem only a preempted instance still lists is not held by it: deleteVolume waits for Lambda to let go, and says so when it does not', async () => {
        const fake = fakeLambda();
        await clocked(fake, async (p) => {
            const fs = await p.createVolume({ name: 'models', region: 'us-east-1' });
            const s = await p.createServer({ name: 'a', offer: 'gpu_1x_a10', region: 'us-east-1', sshKeyIds: ['laptop'], mounts: [{ volume: fs }] });
            fake.state.instances.get(s.id).status = 'preempted';
            expect((await p.listServers()).find((x) => x.id === s.id)).toMatchObject({ status: 'terminated', mounts: [{ volumeId: fs.id }] });
            await expect(p.deleteVolume(fs.id, { timeoutMs: 60_000 })).rejects.toThrow('timed out after 60 s waiting for filesystem(s) to be let go: models in use, by no live instance');
        });
    });
});
