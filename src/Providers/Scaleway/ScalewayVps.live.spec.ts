// Scaleway as a VPS host against the live API: its Instance types without
// GPUs and the Project's SSH keys, then one small Instance
// (STARDUST1-S, about EUR 0.0006 an hour) created with a key, logged into over
// SSH both ways, and deleted, verified, its Block Storage volume with it. Runs
// only when asked, with the secret key and the Project in .env.test (or
// ~/.config/asap-vps/credentials.env):
//   ASAP_VPS_LIVE=scaleway-vps npm run test:live      (or npm run test:scw)
// What the run creates is named after it, deleted at the end, and watched by
// the watchdog (src/testing/live.ts) in case the run dies.

import { writeFileSync } from 'fs';
import { MACHINE_TYPES, REGION_TYPES } from '../../constants';
import { SSHService } from '../../Core/SSHService';
import { sshKeyFingerprint } from '../../Core/utils';
import { AuthError } from '../../errors';
import { deleteRunKeys, liveOptions, liveRequested, loadCredentials, newRunName, runMatcher, startWatchdog, sweepLeftovers, teardown, trackSSHKeys } from '../../testing/live';
import type { SSHKeyData } from '../../types';
import { SCALEWAY_ENUMS } from './mappers';
import { Scaleway } from './Scaleway';
import type { ScalewayZone } from './types';

const requested = liveRequested('scaleway-vps');
const { freeOnly } = liveOptions();
const paid = freeOnly ? it.skip : it;
/** The smallest Instance type, and the zones to look for stock of it in. */
const SIZE = 'STARDUST1-S';
const ZONES: ScalewayZone[] = ['fr-par-1', 'nl-ams-1', 'pl-waw-2'];
const SSH_RETRY = { maxRetries: 30, retryTimeout: 10_000 };

(requested ? describe : describe.skip)(`Scaleway as a VPS host: every method, against the live API${
    requested ? '' : ' (set ASAP_VPS_LIVE=scaleway-vps to run it: it creates a real Instance)'}`, () => {
    const runName = newRunName();
    const run = runMatcher(runName);
    let vps: Scaleway;
    /** The same account through Scaleway, which lists and deletes every Instance: the teardown. */
    let account: Scaleway;
    let watchdog: { doneFile: string } | undefined;
    let keys: SSHKeyData;
    /** Every key the run registers through `vps`: deleted by id at the end, and checked gone (a Project's keys reach every server it boots). */
    let keyIds = new Set<string>();
    /** The key was refused before anything ran: nothing to tear down. */
    let refused = false;

    beforeAll(async () => {
        loadCredentials();
        const apiKey = process.env.SCW_SECRET_KEY?.trim();
        const projectId = process.env.SCW_DEFAULT_PROJECT_ID?.trim();
        if (!apiKey) throw new Error('ASAP_VPS_LIVE asks for scaleway-vps, but SCW_SECRET_KEY is not set');
        if (!projectId) throw new Error('ASAP_VPS_LIVE asks for scaleway-vps, but SCW_DEFAULT_PROJECT_ID is not set (the Project the Instance is created in)');
        const params = { apiKey, projectId, zones: process.env.SCW_ZONES?.trim() || undefined };
        vps = new Scaleway(params);
        account = new Scaleway(params);
        keyIds = trackSSHKeys(vps);
        try {
            await account.listServers();
        } catch (e) {
            if (!(e instanceof AuthError)) throw e;
            refused = true;
            throw new Error(`SCW_SECRET_KEY is refused by Scaleway, so nothing was tried: ${e.message}`);
        }
        if (!freeOnly) {
            expect(await sweepLeftovers(account)).toEqual([]);
            watchdog = await startWatchdog('scaleway', runName, Date.now() + 60 * 60_000);
        }
    }, 10 * 60_000);

    afterAll(async () => {
        if (!account || refused) return;
        const left = await teardown(account, run);
        const keyLeft = await deleteRunKeys(account, run, { ids: keyIds, rounds: 10 });
        if (watchdog && !left.length && !keyLeft.length) writeFileSync(watchdog.doneFile, 'done\n');
        expect({ servers: left, keys: keyLeft }).toEqual({ servers: [], keys: [] });
    }, 15 * 60_000);

    it('offers its Instance types without GPUs, lists the Project\'s keys, and maps the library\'s enums onto zones and Marketplace labels Scaleway has', async () => {
        const offers = await vps.listOffers({ kind: 'cpu', includeUnavailable: true });
        expect(offers.find((o) => o.id === SIZE)).toMatchObject({ gpuCount: 0, vendor: null });
        for (const k of await vps.listSSHKeys()) expect(k).toEqual({ id: expect.any(String), name: expect.any(String), publicKey: expect.any(String), fingerprint: expect.stringMatching(/^SHA256:/) });
        // The zones REGION_TYPES maps onto are zones the account reads.
        for (const r of [REGION_TYPES.PARIS_1, REGION_TYPES.AMSTERDAM, REGION_TYPES.WARSAW_2, REGION_TYPES.MILAN]) {
            expect(vps.api.zones).toContain(SCALEWAY_ENUMS.regions?.[r]);
        }
        // The labels MACHINE_TYPES maps onto are Marketplace's own.
        const labels = (await vps.api.listMarketplaceImages()).map((i) => i.label);
        for (const t of [MACHINE_TYPES.UBUNTU_24, MACHINE_TYPES.UBUNTU_22, MACHINE_TYPES.UBUNTU_20]) expect(labels).toContain(SCALEWAY_ENUMS.machines?.[t]);
    }, 5 * 60_000);

    it('addSSHKey registers a key once and returns that registration for the same key again; deleteSSHKey removes it', async () => {
        keys = await SSHService.createKeys();
        const before = (await vps.api.listSSHKeys()).map((k) => String(k.id)).sort();
        const key = await vps.addSSHKey(keys.publicKey, runName);
        expect(key).toMatchObject({ name: runName, publicKey: keys.publicKey.trim(), fingerprint: sshKeyFingerprint(keys.publicKey) });
        expect((await vps.addSSHKey(keys.publicKey, `${runName}-again`)).id).toBe(key.id);
        expect((await vps.listSSHKeys()).filter((s) => s.id === key.id)).toHaveLength(1);
        expect(await vps.deleteSSHKey(key.id)).toBe(true);
        expect(await vps.deleteSSHKey(key.id)).toBe(false);
        expect((await vps.api.listSSHKeys()).map((k) => String(k.id)).sort()).toEqual(before);
    }, 5 * 60_000);

    paid('createServer: an Instance with the Project\'s key, its IP waited for; SSH logs in as root both ways; restartServer boots it again; deleteServer is idempotent and leaves no volume', async () => {
        const stock = await Promise.all(ZONES.filter((z) => vps.api.zones.includes(z)).map(async (z) => ({ z, a: (await vps.api.availability(z))[SIZE] })));
        const zone = stock.find((s) => s.a === 'available' || s.a === 'scarce')?.z;
        if (!zone) throw new Error(`${SIZE} is not in stock in ${ZONES.join(', ')} right now`);
        const key = await vps.addSSHKey(keys.publicKey, runName);
        const pending = await vps.createServer({ name: runName, offer: SIZE, image: MACHINE_TYPES.UBUNTU_24, region: zone, sshKeyIds: [key.id] });
        const created = await vps.waitUntilRunning(pending.id, { intervalMs: 5000, timeoutMs: 10 * 60_000 });
        expect(created).toMatchObject({ id: expect.stringMatching(new RegExp(`^${zone}/`)), ip: expect.stringMatching(/^\d+\.\d+\.\d+\.\d+$/) });
        const ip = created.ip as string;
        // Its Block Storage volumes, which terminate only detaches: they must be gone at the end.
        const held = Object.values((await account.getServer(created.id))!.raw.volumes).filter((v) => v.volume_type === 'sbs_volume').map((v) => v.id);
        expect(held.length).toBeGreaterThan(0);
        const positional = await SSHService.connect(ip, keys.privateKey, undefined, SSH_RETRY);
        let bootId: string;
        try {
            expect((await positional.execCommand('id -u')).stdout.trim()).toBe('0');
            bootId = (await positional.execCommand('cat /proc/sys/kernel/random/boot_id')).stdout.trim();
        } finally {
            positional.dispose();
        }
        expect(bootId).toMatch(/^[0-9a-f-]{36}$/);
        // A running server it reads as it is (a repeat of what waitUntilRunning waited for).
        expect(await vps.waitUntilRunning(created.id)).toMatchObject({ status: 'running', raw: { state: 'running' } });
        // restartServer is the reboot action: the machine comes up again with another boot id (a bare id names it as well).
        await vps.restartServer(created.id.split('/')[1]);
        const end = Date.now() + 10 * 60_000;
        let again = bootId;
        while (again === bootId && Date.now() < end) {
            await new Promise((r) => setTimeout(r, 10_000));
            const ssh = await SSHService.connect(ip, keys.privateKey, undefined, { maxRetries: 3, retryTimeout: 10_000 }).catch(() => undefined);
            if (!ssh) continue;
            try {
                again = (await ssh.execCommand('cat /proc/sys/kernel/random/boot_id')).stdout.trim() || bootId;
            } finally {
                ssh.dispose();
            }
        }
        expect(again).not.toBe(bootId);
        expect(await vps.waitUntilRunning(created.id, { intervalMs: 5000, timeoutMs: 5 * 60_000 })).toMatchObject({ status: 'running' });
        const options = await SSHService.connect({ host: ip, privateKey: keys.privateKey, retry: SSH_RETRY });
        try {
            expect((await options.execCommand('echo ok')).stdout.trim()).toBe('ok');
        } finally {
            options.dispose();
        }
        await vps.deleteServer(created.id);
        const gone = await account.getServer(created.id);
        expect(gone).toBeNull();
        await expect(vps.deleteServer(created.id)).resolves.toBeUndefined();
        // terminate only detaches Block Storage volumes: none of this Instance's may be left billing.
        for (const id of held) expect(await vps.api.getBlockVolume(zone, id)).toBeNull();
        expect(await vps.deleteSSHKey(key.id)).toBe(true);
    }, 30 * 60_000);
});
