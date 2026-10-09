// DigitalOcean as a VPS host against the live API: the plain sizes and the
// account's SSH keys, then one small droplet created with a key,
// logged into over SSH both ways, and deleted, verified. Runs only when asked,
// with the key in .env.test:
//   ASAP_VPS_LIVE=digitalocean-vps npm run test:live      (or npm run test:do)
// The account needs one free droplet slot, checked first; what the run creates
// is named after it, deleted at the end, and watched by the watchdog
// (src/testing/live.ts) in case the run dies.

import { writeFileSync } from 'fs';
import { MACHINE_TYPES } from '../../constants';
import { SSHService } from '../../Core/SSHService';
import { sshKeyFingerprint } from '../../Core/utils';
import { AuthError, QuotaError } from '../../errors';
import { deleteRunKeys, liveOptions, liveRequested, loadCredentials, newRunName, runMatcher, startWatchdog, sweepLeftovers, teardown, trackSSHKeys } from '../../testing/live';
import type { InitializedSSHKeyData, SSHKeyData } from '../../types';
import { DigitalOcean } from './DigitalOcean';

const requested = liveRequested('digitalocean-vps');
const { freeOnly } = liveOptions();
const paid = freeOnly ? it.skip : it;
/** The smallest size the existing tests used; and the regions REGION_TYPES names on DigitalOcean. */
const SIZE = 's-1vcpu-1gb';
const REGIONS = ['nyc3', 'nyc1', 'nyc2'];
const SSH_RETRY = { maxRetries: 30, retryTimeout: 10_000 };
/** How long DigitalOcean's list of keys may lag its writes (seconds, observed 2026-10-05) before a key is expected listed, or gone. */
const LIST_LAG_MS = 60_000;

/** The account's keys, read until `ok` accepts them. */
async function keysUntil(p: DigitalOcean, ok: (keys: InitializedSSHKeyData[]) => boolean, what: string): Promise<InitializedSSHKeyData[]> {
    const end = Date.now() + LIST_LAG_MS;
    for (;;) {
        const keys = await p.listSSHKeys();
        if (ok(keys)) return keys;
        if (Date.now() >= end) throw new Error(`the account's SSH keys never showed ${what} (read for ${LIST_LAG_MS / 1000} s)`);
        await new Promise((r) => setTimeout(r, 2000));
    }
}

(requested ? describe : describe.skip)(`DigitalOcean (VPS): every method, against the live API${
    requested ? '' : ' (set ASAP_VPS_LIVE=digitalocean-vps to run it: it creates a real droplet)'}`, () => {
    const runName = newRunName();
    const run = runMatcher(runName);
    let vps: DigitalOcean;
    /** The same account through a second provider: the teardown. */
    let account: DigitalOcean;
    let watchdog: { doneFile: string } | undefined;
    let keys: SSHKeyData;
    /** Every key the run registers through `vps`: deleted by id at the end, though the list may not show it yet. */
    let keyIds = new Set<string>();
    /** The key was refused before anything ran: nothing to tear down. */
    let refused = false;

    beforeAll(async () => {
        loadCredentials();
        const key = process.env.DIGITAL_OCEAN_API_KEY?.trim();
        if (!key) throw new Error('ASAP_VPS_LIVE asks for digitalocean-vps, but DIGITAL_OCEAN_API_KEY is not set');
        vps = new DigitalOcean(key);
        account = new DigitalOcean(key);
        keyIds = trackSSHKeys(vps);
        try {
            await vps.api.call('GET', '/v2/account');
        } catch (e) {
            if (!(e instanceof AuthError)) throw e;
            refused = true;
            throw new Error(`DIGITAL_OCEAN_API_KEY is refused by DigitalOcean, so nothing was tried: ${e.message}`);
        }
        if (!freeOnly) {
            expect(await sweepLeftovers(account, { keyRounds: 3 })).toEqual([]);
            const { limit, used } = await vps.api.dropletUsage();
            if (used >= limit) throw new QuotaError('digitalocean', `the account has ${used} of ${limit} droplets: no room for the test droplet`);
            watchdog = await startWatchdog('digitalocean', runName, Date.now() + 60 * 60_000);
        }
    }, 10 * 60_000);

    afterAll(async () => {
        if (!account || refused) return;
        const servers = await teardown(account, run);
        const keyLeft = await deleteRunKeys(account, run, { ids: keyIds, rounds: 10 });
        if (watchdog && !servers.length && !keyLeft.length) writeFileSync(watchdog.doneFile, 'done\n');
        expect({ servers, keys: keyLeft }).toEqual({ servers: [], keys: [] });
    }, 15 * 60_000);

    it('offers its plain sizes and lists the account\'s keys', async () => {
        const offers = await vps.listOffers({ kind: 'cpu', includeUnavailable: true });
        expect(offers.find((o) => o.id === SIZE)).toMatchObject({ gpuCount: 0, vendor: null });
        for (const k of await vps.listSSHKeys()) expect(k).toEqual({ id: expect.anything(), name: expect.any(String), publicKey: expect.any(String), fingerprint: expect.any(String) });
    }, 5 * 60_000);

    it('addSSHKey registers a key once and returns that registration for the same key again; deleteSSHKey removes it', async () => {
        keys = await SSHService.createKeys();
        const before = (await vps.api.listSSHKeys()).map((k) => String(k.id));
        const key = await vps.addSSHKey(keys.publicKey, runName);
        expect(key).toMatchObject({ name: runName, publicKey: keys.publicKey, fingerprint: sshKeyFingerprint(keys.publicKey) });
        expect((await vps.addSSHKey(keys.publicKey, `${runName}-again`)).id).toBe(key.id);
        const listed = (all: InitializedSSHKeyData[]) => all.some((k) => String(k.id) === String(key.id));
        const during = await keysUntil(vps, listed, `${key.id} listed`);
        expect(during.filter((k) => k.fingerprint === key.fingerprint).map((k) => k.id)).toEqual([key.id]);
        expect(await vps.deleteSSHKey(key.id)).toBe(true);
        expect(await vps.deleteSSHKey(key.id)).toBe(false);
        // Gone from the list, and none of the account's other keys with it (others may add theirs meanwhile).
        const after = await keysUntil(vps, (all) => !listed(all), `${key.id} gone`);
        expect(after.map((k) => String(k.id))).toEqual(expect.arrayContaining(before));
    }, 5 * 60_000);

    paid('createServer: a droplet with the key, its IP waited for; SSH logs in as root both ways; deleteServer is idempotent', async () => {
        const offer = (await vps.listOffers({ kind: 'cpu' })).find((o) => o.id === SIZE);
        const region = REGIONS.find((r) => offer?.regions.includes(r));
        if (!offer || !region) throw new Error(`${SIZE} is not available in ${REGIONS.join(', ')} right now`);
        const key = await vps.addSSHKey(keys.publicKey, runName);
        const pending = await vps.createServer({ name: runName, offer, image: MACHINE_TYPES.UBUNTU_24, region, sshKeyIds: [key.id] });
        const created = await vps.waitUntilRunning(pending.id, { intervalMs: 5000, timeoutMs: 10 * 60_000 });
        expect(created).toMatchObject({ id: expect.any(String), ip: expect.stringMatching(/^\d+\.\d+\.\d+\.\d+$/) });
        const ip = created.ip as string;
        const positional = await SSHService.connect(ip, keys.privateKey, undefined, SSH_RETRY);
        try {
            expect((await positional.execCommand('id -u')).stdout.trim()).toBe('0');
        } finally {
            positional.dispose();
        }
        const options = await SSHService.connect({ host: ip, privateKey: keys.privateKey, retry: SSH_RETRY });
        try {
            expect((await options.execCommand('echo ok')).stdout.trim()).toBe('ok');
        } finally {
            options.dispose();
        }
        await vps.deleteServer(created.id);
        const gone = await account.waitForServer(created.id, (s) => !s || s.status === 'terminated', { intervalMs: 5000, timeoutMs: 5 * 60_000 });
        expect(gone === null || gone.status === 'terminated').toBe(true);
        await expect(vps.deleteServer(created.id)).resolves.toBeUndefined();
        expect(await vps.deleteSSHKey(key.id)).toBe(true);
    }, 30 * 60_000);
});
