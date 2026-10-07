// LambdaCloud against the fake of Lambda Cloud's API (src/testing/fakes/lambda.ts):
// what is particular to it beyond the shared contract (../contract.spec.ts),
// and Lambda's launch limits (spec 1.10.0, cloud.lambda.ai/api/v1/openapi.json):
// exactly one SSH key, names up to 64 characters, tag keys in Lambda's format,
// each refused before anything is sent; and filesystems (its volumes): no size,
// mounted at launch under /home, /lambda/nfs or /data, never deleted in use.

import { NotSupportedError, ProviderError, QuotaError } from '../../errors';
import { fakeLambda } from '../../testing/fakes/lambda';
import { LambdaCloud } from './LambdaCloud';

const noSleep = async () => {};
const fast = { intervalMs: 0, timeoutMs: 5000 };

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
        expect(fake.calls.filter((c) => c.path === '/api/v1/instance-operations/launch')).toHaveLength(0);
    });

    it('the account quota is a QuotaError', async () => {
        const { p } = make({ instanceQuota: 1 });
        await expect(p.createServer({ name: 'a', offer: 'gpu_1x_a10', region: 'us-east-1', sshKeyIds: ['laptop'] })).rejects.toBeInstanceOf(QuotaError);
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
        expect(launches(fake)).toHaveLength(0);
        await expect(p.createServer({ ...base, name: 'tagged', tags: ['team:gpu=render', 'env'] })).resolves.toMatchObject({ name: 'tagged' });
        expect(launches(fake)[0].body.tags).toEqual([{ key: 'team:gpu', value: 'render' }, { key: 'env', value: '' }]);
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

    it('has no size, and a name Lambda takes: refused before anything is sent otherwise', async () => {
        const { fake, p } = make();
        // Not in its type (a filesystem grows as it fills); code typed for any provider may still pass it.
        await expect(p.createVolume({ name: 'models', region: 'us-east-1', sizeGb: 10 } as Parameters<LambdaCloud['createVolume']>[0])).rejects.toThrow(NotSupportedError);
        await expect(p.createVolume({ name: '1models', region: 'us-east-1' })).rejects.toThrow(/a letter then letters/);
        await expect(p.createVolume({ name: 'm'.repeat(61), region: 'us-east-1' })).rejects.toThrow(/1-60 characters/);
        expect(fake.calls.filter((c) => c.method === 'POST')).toEqual([]);
        const fs = await p.createVolume({ name: 'models', region: 'us-east-1' });
        expect(fs).toMatchObject({ name: 'models', region: 'us-east-1', status: 'available', providerStatus: 'not in use', mountPath: '/lambda/nfs/models' });
        expect(fs.sizeGb).toBeUndefined();
        expect(fs.createdAt).toBeGreaterThan(0);
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
});
