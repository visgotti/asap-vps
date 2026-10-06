// DigitalOcean against the fake of DigitalOcean's API v2
// (src/testing/fakes/digitalocean.ts): what is particular to GPU droplets beyond
// the shared contract (../gpuContract.spec.ts). From the API spec
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
import { CapacityError, NotFoundError, NotSupportedError, ProviderError, QuotaError } from '../../errors';
import { fakeDigitalOcean } from '../../testing/fakes/digitalocean';
import { DigitalOcean } from './DigitalOcean';

const noSleep = async () => {};
const fast = { intervalMs: 0, timeoutMs: 5000 };

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
    });

    it('a snapshot that never completes times out instead of waiting forever', async () => {
        const { p } = make({ actionReads: 1_000_000 });
        const s = await p.createServer({ name: 'slow', offer: 'gpu-4000adax1-20gb', region: 'tor1' });
        await expect(p.createImage(s.id, { name: 'never', intervalMs: 0, timeoutMs: 30 })).rejects.toThrow(/timed out/);
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

    it('refuses what is not a file URL before anything is sent', async () => {
        const { fake, p } = make();
        for (const url of ['s3://bucket/key.qcow2', 'https://example.com', 'file:///tmp/disk.img', 'disk.qcow2']) {
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
        const share = await p.createVolume({ name: 'models', region: 'tor1', sizeGb: 49.5 + 50, shared: true });
        const vpc = fake.state.vpcs.find((v) => v.region === 'tor1')!.id;
        expect(fake.calls.find((c) => c.method === 'POST' && c.path === '/v2/nfs')?.body).toEqual({ name: 'models', size_gib: 100, region: 'tor1', vpc_ids: [vpc], performance_tier: 'standard' });
        expect(share).toMatchObject({ provider: 'digitalocean', name: 'models', region: 'tor1', shared: true, sizeGb: 100, status: 'available', providerStatus: 'ACTIVE', mountPath: '/mnt/models' });
        expect(share.raw).toMatchObject({ host: '10.10.0.5', mount_path: `/2559851/${share.id}`, vpc_ids: [vpc] });
        const block = await p.createVolume({ name: 'scratch', region: 'tor1', sizeGb: 10 });
        expect((await p.listVolumes()).map((v) => [v.name, v.shared])).toEqual([['scratch', false], ['models', true]]);
        expect(await p.getVolume(share.id)).toMatchObject({ id: share.id, shared: true });
        expect(await p.getVolume(block.id)).toMatchObject({ id: block.id, shared: false });
        // VPCs of the caller's naming, and a high tier (from 500 GB).
        await p.createVolume({ name: 'fast', region: 'tor1', sizeGb: 500, shared: true, providerOptions: { vpc_ids: [vpc], performance_tier: 'high' } });
        expect(fake.calls.filter((c) => c.method === 'POST' && c.path === '/v2/nfs').pop()?.body).toMatchObject({ vpc_ids: [vpc], performance_tier: 'high' });
    });

    it('a droplet created with a share joins its VPC, carries a tag for it, and mounts it over NFS at its path, now and at every boot', async () => {
        const { fake, p } = make();
        const share = await p.createVolume({ name: 'models', region: 'tor1', sizeGb: 50, shared: true });
        const s = await p.createServer({ name: 'gpu-1', offer: 'gpu-4000adax1-20gb', region: 'tor1', mounts: [{ volume: share, path: '/data/models' }] });
        const body = creates(fake).pop();
        expect(body.vpc_uuid).toBe(share.raw.vpc_ids[0]);
        expect(body.tags).toEqual([`asap-vps-nfs:${share.id}:${Buffer.from('/data/models').toString('hex')}`]);
        expect(body.user_data).toContain(`mount_share '10.10.0.5:/2559851/${share.id}' '/data/models'`);
        expect(body.user_data).toContain('_netdev,nofail,nconnect=8,vers=4.1');
        expect(body.user_data).toContain('apt_get install -y nfs-common');
        expect(() => execFileSync('/bin/bash', ['-n'], { input: body.user_data })).not.toThrow();
        expect((await p.waitUntilRunning(s.id, fast)).mounts).toEqual([{ volumeId: share.id, path: '/data/models' }]);
        // By id, at its mountPath; with a block volume and the caller's tags too: all of it in one droplet.
        const block = await p.createVolume({ name: 'scratch', region: 'tor1', sizeGb: 10 });
        const t = await p.createServer({ name: 'gpu-2', offer: 'gpu-4000adax1-20gb', region: 'tor1', tags: ['team-a'], mounts: [{ volume: block.id }, { volume: share.id }] });
        expect(creates(fake).pop()).toMatchObject({ volumes: [block.id], tags: ['team-a', `asap-vps-nfs:${share.id}:${Buffer.from('/mnt/models').toString('hex')}`] });
        expect((await p.waitUntilRunning(t.id, fast)).mounts).toEqual([{ volumeId: block.id }, { volumeId: share.id, path: '/mnt/models' }]);
    });

    it('refuses before any droplet is asked for: a path for a block volume, a share elsewhere or not ACTIVE, a VPC no share is in', async () => {
        const { fake, p } = make();
        const block = await p.createVolume({ name: 'scratch', region: 'tor1', sizeGb: 10 });
        const share = await p.createVolume({ name: 'models', region: 'tor1', sizeGb: 50, shared: true });
        const far = await p.createVolume({ name: 'far', region: 'nyc1', sizeGb: 50, shared: true });
        const o = { name: 'x', offer: 'gpu-4000adax1-20gb', region: 'tor1' };
        await expect(p.createServer({ ...o, mounts: [{ volume: block, path: '/data' }] })).rejects.toThrow(/a mount path for a Block Storage volume/);
        await expect(p.createServer({ ...o, mounts: [{ volume: far.id }] })).rejects.toThrow(/share far is in nyc1: a droplet in tor1 cannot mount it/);
        await expect(p.createServer({ ...o, mounts: [{ volume: share.id, path: 'data' }] })).rejects.toThrow(/mount path "data" is not absolute/);
        await expect(p.createServer({ ...o, mounts: [{ volume: share.id }], providerOptions: { vpc_uuid: 'elsewhere' } })).rejects.toThrow(/vpc_uuid elsewhere is not a VPC of every share/);
        fake.state.shares.get(share.id).status = 'INACTIVE';
        await expect(p.createServer({ ...o, mounts: [{ volume: share.id }] })).rejects.toThrow(/share models is INACTIVE: it is mounted once ACTIVE/);
        fake.state.shares.get(share.id).status = 'ACTIVE';
        const other = await p.createVolume({ name: 'other', region: 'tor1', sizeGb: 50, shared: true });
        fake.state.shares.get(other.id).vpc_ids = ['another-vpc'];
        await expect(p.createServer({ ...o, mounts: [{ volume: share.id }, { volume: other.id }] })).rejects.toThrow(/have no VPC in common/);
        expect(creates(fake)).toEqual([]);
        // Hot: a share is mounted over the network, not attached.
        const s = await p.waitUntilRunning((await p.createServer(o)).id, fast);
        await expect(p.attachVolume(share.id, s.id, fast)).rejects.toThrow(/attaching a shared volume/);
    });

    it('a size out of bounds, or a region with no default VPC, is refused before anything is made; one that fails to become ACTIVE is deleted, and its failure thrown', async () => {
        const { fake, p } = make();
        await expect(p.createVolume({ name: 'tiny', region: 'tor1', sizeGb: 49, shared: true })).rejects.toThrow(/50-32768 GB, not 49/);
        await expect(p.createVolume({ name: 'huge', region: 'tor1', sizeGb: 40000, shared: true })).rejects.toThrow(/50-32768 GB/);
        fake.state.vpcs = fake.state.vpcs.filter((v) => v.region !== 'nyc1');
        await expect(p.createVolume({ name: 'novpc', region: 'nyc1', sizeGb: 50, shared: true })).rejects.toThrow(/region nyc1 has no default VPC yet/);
        expect(fake.calls.filter((c) => c.method === 'POST' && c.path === '/v2/nfs')).toEqual([]);
        const { fake: f2, p: p2 } = make({ shareReads: 1e9 });
        await expect(p2.createVolume({ name: 'slow', region: 'tor1', sizeGb: 50, shared: true, intervalMs: 0, timeoutMs: 20 })).rejects.toThrow(/waiting for share slow: CREATING/);
        expect(f2.state.shares.size).toBe(0);
    });

    it('deleted, waited for until gone; deleting again is no error', async () => {
        const { p } = make();
        const share = await p.createVolume({ name: 'models', region: 'tor1', sizeGb: 50, shared: true });
        await p.deleteVolume(share.id);
        expect(await p.getVolume(share.id)).toBeNull();
        expect(await p.listVolumes()).toEqual([]);
        await expect(p.deleteVolume(share.id)).resolves.toBeUndefined();
    });
});
