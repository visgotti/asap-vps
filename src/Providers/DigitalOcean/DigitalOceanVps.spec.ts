// DigitalOcean as a VPS host: a droplet of a plain size, created, read and
// deleted through the same provider that rents GPU droplets, against the fake
// of DigitalOcean's API v2 (src/testing/fakes/digitalocean.ts).
// DigitalOceanVps.live.spec.ts is the live counterpart (opt-in: it creates a
// real droplet).

import { MACHINE_TYPES, REGION_TYPES } from '../../constants';
import { sshKeyFingerprint } from '../../Core/utils';
import { CapacityError, NotFoundError, NotSupportedError, ProviderError, QuotaError } from '../../errors';
import { fakeDigitalOcean } from '../../testing/fakes/digitalocean';
import { testPublicKey } from '../../testing/fakes/util';
import { DigitalOcean } from './DigitalOcean';

const noSleep = async () => {};
const fast = { intervalMs: 0, timeoutMs: 5000 };

function made(o: Parameters<typeof fakeDigitalOcean>[0] = {}) {
    const fake = fakeDigitalOcean(o);
    const vps = new DigitalOcean({ apiKey: 'do-test', fetchImpl: fake.fetchImpl, sleep: noSleep });
    return { fake, vps };
}

const droplet = { name: 'web-1', offer: 's-8vcpu-16gb', region: 'nyc1', image: MACHINE_TYPES.UBUNTU_22 };

describe('DigitalOcean as a VPS host', () => {
    it('offers its plain sizes (every page) as machines without GPUs, and lists the account keys (SHA256 fingerprints)', async () => {
        const { vps } = made();
        const key = await vps.addSSHKey(testPublicKey('laptop'), 'laptop');
        const sizes = (await vps.listOffers({ kind: 'cpu', includeUnavailable: true })).map((o) => o.id);
        expect(sizes).toContain('s-8vcpu-16gb');
        expect(sizes.some((s) => s.startsWith('gpu-'))).toBe(false);
        expect(await vps.listSSHKeys()).toEqual([key]);
        expect(key.fingerprint).toMatch(/^SHA256:/);
    });

    it('addSSHKey returns the account\'s registration of a key it already holds, whatever it was named', async () => {
        const { vps } = made();
        const pub = testPublicKey();
        const first = await vps.addSSHKey(pub, 'ci');
        expect(first).toMatchObject({ name: 'ci', publicKey: pub, fingerprint: sshKeyFingerprint(pub) });
        expect(typeof first.id).toBe('number');
        expect((await vps.addSSHKey(pub, 'ci-again')).id).toBe(first.id);
        expect((await vps.listSSHKeys()).filter((s) => s.id === first.id)).toHaveLength(1);
    });

    it('creates a droplet with the key it names (the library\'s enums in DigitalOcean\'s names), waits for its public IP, and deletes it idempotently', async () => {
        const { fake, vps } = made({ bootReads: 3 });
        const key = await vps.addSSHKey(testPublicKey(), 'deploy');
        const before = fake.liveServers();
        const created = await vps.createServer({ ...droplet, region: REGION_TYPES.NYC_1, sshKeyIds: [key.id] });
        expect(created.status).toBe('pending');
        const running = await vps.waitUntilRunning(created.id, fast);
        expect(running).toMatchObject({ id: created.id, ip: expect.stringMatching(/^203\.0\.113\./), privateIp: '10.10.0.2', gpu: undefined });
        expect(fake.calls.find((c) => c.method === 'POST' && c.path === '/v2/droplets')?.body)
            .toEqual({ name: 'web-1', region: 'nyc1', size: 's-8vcpu-16gb', image: 'ubuntu-22-04-x64', ssh_keys: [key.id] });
        expect(fake.liveServers()).toBe(before + 1);
        await vps.deleteServer(created.id);
        await expect(vps.deleteServer(created.id)).resolves.toBeUndefined();
        expect(fake.liveServers()).toBe(before);
    });

    it('maps the DigitalOcean members of REGION_TYPES and MACHINE_TYPES, and refuses the others before anything is created', async () => {
        const { fake, vps } = made();
        // The regions the fake has this size in.
        const regions: Array<[REGION_TYPES, string]> = [[REGION_TYPES.TORONTO, 'tor1'], [REGION_TYPES.NYC, 'nyc1'], [REGION_TYPES.NYC_1, 'nyc1']];
        for (const [region, slug] of regions) {
            await vps.deleteServer((await vps.createServer({ ...droplet, region, image: MACHINE_TYPES.UBUNTU_24 })).id);
            expect(fake.calls.filter((c) => c.method === 'POST' && c.path === '/v2/droplets').pop()?.body).toMatchObject({ region: slug, image: 'ubuntu-24-04-x64' });
        }
        const before = fake.liveServers();
        await expect(vps.createServer({ ...droplet, region: REGION_TYPES.PARIS })).rejects.toThrow(NotSupportedError);
        expect(fake.liveServers()).toBe(before);
    });

    it('names a key by id, name, public key, or fingerprint (SHA256, or the MD5 one DigitalOcean shows)', async () => {
        const { fake, vps } = made();
        const pub = testPublicKey();
        const key = await vps.addSSHKey(pub, 'by-ref');
        const md5 = sshKeyFingerprint(pub, 'md5');
        for (const ref of [String(key.id), 'by-ref', pub, key.fingerprint, md5]) {
            const s = await vps.createServer({ ...droplet, sshKeyIds: [ref] });
            await vps.deleteServer(s.id);
        }
        const creates = fake.calls.filter((c) => c.method === 'POST' && c.path === '/v2/droplets');
        // What DigitalOcean takes itself (an id, its MD5 fingerprint) goes as it is; the others are looked up as the key's id.
        expect(creates.map((c) => c.body.ssh_keys)).toEqual([[key.id], [key.id], [key.id], [key.id], [md5]]);
    });

    it('sends a key id it was given without reading the key list, which lags a key added just before (seen live)', async () => {
        const { fake, vps } = made();
        const key = await vps.addSSHKey(testPublicKey(), 'just-added');
        // The account's list does not show the new key yet.
        const lagging = (async (url: string, init?: RequestInit) => {
            if ((init?.method ?? 'GET') === 'GET' && new URL(url).pathname === '/v2/account/keys') {
                return new Response(JSON.stringify({ ssh_keys: [], links: {}, meta: { total: 0 } }), { status: 200, headers: { 'content-type': 'application/json' } });
            }
            return fake.fetchImpl(url, init);
        }) as typeof fetch;
        const lagged = new DigitalOcean({ apiKey: 'do-test', fetchImpl: lagging, sleep: noSleep });
        const reads = fake.calls.length;
        const s = await lagged.createServer({ ...droplet, sshKeyIds: [key.id] });
        expect(fake.calls.slice(reads).filter((c) => c.method === 'POST' && c.path === '/v2/droplets').map((c) => c.body.ssh_keys)).toEqual([[key.id]]);
        await lagged.deleteServer(s.id);
        // A name has to be looked up: a list that does not show it yet refuses it, before anything is created.
        await expect(lagged.createServer({ ...droplet, sshKeyIds: ['just-added'] })).rejects.toBeInstanceOf(NotFoundError);
    });

    it('a key added moments ago: the create, refused while DigitalOcean does not know it yet (422, nothing made), is asked again until it does', async () => {
        const { fake, vps } = made({ keyLag: 4 });
        const key = await vps.addSSHKey(testPublicKey(), 'just-added');
        const before = fake.liveServers();
        const s = await vps.createServer({ ...droplet, sshKeyIds: [key.id] });
        const creates = fake.calls.filter((c) => c.method === 'POST' && c.path === '/v2/droplets');
        expect(creates.length).toBeGreaterThan(1);
        expect(creates.every((c) => JSON.stringify(c.body.ssh_keys) === JSON.stringify([key.id]))).toBe(true);
        expect(fake.liveServers()).toBe(before + 1);
        await vps.deleteServer(s.id);
    });

    it('a key DigitalOcean never knows is refused once the wait is over; a refusal for want of stock is never waited on', async () => {
        const { fake, vps } = made();
        const creates = () => fake.calls.filter((c) => c.method === 'POST' && c.path === '/v2/droplets').length;
        const before = fake.liveServers();
        await expect(vps.createServer({ ...droplet, sshKeyIds: [999_999] })).rejects.toThrow(/999999 are invalid key identifiers/);
        expect(creates()).toBe(1 + DigitalOcean.KEY_LAG_MS / 10_000);
        expect(fake.liveServers()).toBe(before);
        const key = await vps.addSSHKey(testPublicKey(), 'known');
        const n = creates();
        await expect(vps.createServer({ ...droplet, region: 'sfo3', sshKeyIds: [key.id] })).rejects.toBeInstanceOf(CapacityError);
        expect(creates()).toBe(n + 1);
        expect(fake.liveServers()).toBe(before);
    });

    it('a key the account does not hold is refused before anything is created; no key asked for, none sent', async () => {
        const { fake, vps } = made();
        const before = fake.liveServers();
        await expect(vps.createServer({ ...droplet, sshKeyIds: ['nobody'] })).rejects.toBeInstanceOf(NotFoundError);
        expect(fake.liveServers()).toBe(before);
        // A key added elsewhere is found on the account.
        const elsewhere = new DigitalOcean({ apiKey: 'do-test', fetchImpl: fake.fetchImpl, sleep: noSleep });
        const key = await elsewhere.addSSHKey(testPublicKey(), 'added-elsewhere');
        await vps.deleteServer((await vps.createServer({ ...droplet, sshKeyIds: ['added-elsewhere'] })).id);
        // No key: none (not the account's first key).
        await vps.deleteServer((await vps.createServer(droplet)).id);
        const creates = fake.calls.filter((c) => c.method === 'POST' && c.path === '/v2/droplets');
        expect(creates.map((c) => c.body.ssh_keys)).toEqual([[key.id], undefined]);
    });

    it('a plain size boots plain Ubuntu unless told otherwise', async () => {
        const { fake, vps } = made();
        await vps.createServer({ name: 'web-2', offer: 's-8vcpu-16gb', region: 'nyc1' });
        expect(fake.calls.find((c) => c.method === 'POST' && c.path === '/v2/droplets')?.body.image).toBe(DigitalOcean.CPU_IMAGE);
        expect(DigitalOcean.defaultImage('s-1vcpu-1gb')).toBe('ubuntu-24-04-x64');
    });

    it('a create is never retried after a server error (it may have made a droplet); failures are typed', async () => {
        const { fake, vps } = made({ dropletLimit: 3 });
        let posts = 0;
        const flaky = (async (url: string, init?: RequestInit) => {
            if (init?.method === 'POST' && String(url).endsWith('/v2/droplets') && ++posts === 1) {
                return new Response(JSON.stringify({ id: 'server_error', message: 'Server Error' }), { status: 500, headers: { 'content-type': 'application/json' } });
            }
            return fake.fetchImpl(url, init);
        }) as typeof fetch;
        const vps2 = new DigitalOcean({ apiKey: 'do-test', fetchImpl: flaky, sleep: noSleep });
        // Not retriable either: a caller that tried again on isRetriable would rent a second one.
        await expect(vps2.createServer(droplet)).rejects.toMatchObject({ status: 500, retriable: false });
        expect(posts).toBe(1);
        // The account's droplet limit: nothing will be created until it changes.
        await vps.createServer(droplet);
        await expect(vps.createServer(droplet)).rejects.toBeInstanceOf(QuotaError);
        await expect(new DigitalOcean({ apiKey: 'wrong', fetchImpl: fake.fetchImpl, sleep: noSleep }).listOffers()).rejects.toThrow(/401/);
    });

    it('adds a key once while the account\'s list lags (seen live: DigitalOcean then takes the same key twice); deleting it forgets it', async () => {
        const { fake } = made();
        let lag = true;
        let posts = 0;
        // The list does not show new keys yet, and the duplicate check lets the same key in again, as DigitalOcean did live.
        const stale = (async (url: string, init?: RequestInit) => {
            const path = new URL(url).pathname;
            if (lag && (init?.method ?? 'GET') === 'GET' && path === '/v2/account/keys') {
                return new Response(JSON.stringify({ ssh_keys: [], links: {}, meta: { total: 0 } }), { status: 200, headers: { 'content-type': 'application/json' } });
            }
            if (init?.method === 'POST' && path === '/v2/account/keys') {
                const body = JSON.parse(String(init.body));
                return new Response(JSON.stringify({ ssh_key: { id: 7000 + ++posts, name: body.name, public_key: body.public_key, fingerprint: '' } }), { status: 201, headers: { 'content-type': 'application/json' } });
            }
            return fake.fetchImpl(url, init);
        }) as typeof fetch;
        const vps = new DigitalOcean({ apiKey: 'do-test', fetchImpl: stale, sleep: noSleep });
        const pub = testPublicKey();
        const first = await vps.addSSHKey(pub, 'lagging');
        expect((await vps.addSSHKey(pub, 'lagging-again')).id).toBe(first.id);
        expect(posts).toBe(1);
        // Another provider (another process) has no memory of it: during the lag it registers the key again.
        expect((await new DigitalOcean({ apiKey: 'do-test', fetchImpl: stale, sleep: noSleep }).addSSHKey(pub, 'elsewhere')).id).not.toBe(first.id);
        // Deleted through this provider, it is forgotten: adding it again registers it again.
        lag = false;
        await vps.deleteSSHKey(first.id);
        lag = true;
        expect((await vps.addSSHKey(pub, 'again')).id).not.toBe(first.id);
        expect(posts).toBe(3);
    });

    it('deleteSSHKey: true when deleted, false when already gone; a failure is thrown, not hidden', async () => {
        const { fake, vps } = made();
        const key = await vps.addSSHKey(testPublicKey(), 'temp');
        expect(await vps.deleteSSHKey(key.id)).toBe(true);
        expect((await vps.listSSHKeys()).some((s) => s.id === key.id)).toBe(false);
        expect(await vps.deleteSSHKey(key.id)).toBe(false);
        const down = new DigitalOcean({ apiKey: 'do-test', fetchImpl: (async () => { throw new TypeError('fetch failed'); }) as typeof fetch, sleep: noSleep });
        await expect(down.deleteSSHKey(123)).rejects.toThrow(/fetch failed/);
        expect(fake.calls.filter((c) => c.method === 'DELETE')).toHaveLength(2);
    });

    it('a droplet that never gets an address times out naming it, so it can be deleted', async () => {
        const { vps } = made({ bootReads: Number.POSITIVE_INFINITY });
        const s = await vps.createServer({ ...droplet, name: 'stuck' });
        const e = await vps.waitUntilRunning(s.id, { timeoutMs: 20, intervalMs: 1 }).catch((x) => x);
        expect(e).toBeInstanceOf(ProviderError);
        expect(e).toMatchObject({ code: 'timeout', message: expect.stringMatching(new RegExp(`waiting for server ${s.id}: pending \\(new\\)`)) });
        expect(await vps.deleteServerAndWait(s.id, fast)).toBe(true);
    });
});
