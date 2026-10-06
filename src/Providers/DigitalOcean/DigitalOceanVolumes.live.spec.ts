// DigitalOcean's Block Storage volumes against the live API, on the cheapest
// plain droplet (one at a time: the account's droplet limit is near full): a
// volume made with createVolume (formatted ext4; $0.10/GiB-month: 1 GiB is
// a fraction of a cent an hour), mounted by DigitalOcean at /mnt/<name> (each
// dash an underscore: its mountPath) on a droplet created with it (CreateServerOptions.mounts), a file written to it;
// detached from the droplet and attached again while it runs (volumeAttach),
// the file still there; kept when the droplet is deleted, and mounted by a
// second droplet, which reads the file. Runs only when asked, with the key in
// .env.test (or ~/.config/asap-vps/credentials.env):
//   ASAP_VPS_LIVE=digitalocean-cpu npx jest --config jest.live.config.js DigitalOceanVolumes.live
// What the run creates is named after it and deleted at the end (the volume
// after the droplets, so none holds it); the watchdog (src/testing/live.ts)
// deletes it if the run dies.

import { writeFileSync } from 'fs';
import { ProvisionResult, ServerProvisioner } from '../../Core/ServerProvisioner';
import { RunCommandStep } from '../../Core/steps';
import { AuthError } from '../../errors';
import {
    deleteRunKeys, deleteRunVolumes, liveOptions, liveRequested, loadCredentials, newRunName, runMatcher, sshRun, startWatchdog, sweepLeftovers, teardown,
    trackSSHKeys, trackVolumes,
} from '../../testing/live';
import type { Offer, Server, Volume } from '../../types';
import { DigitalOcean } from './DigitalOcean';
import type { DigitalOceanDropletData, DigitalOceanSizeData, DigitalOceanVolumeData } from './types';

const requested = liveRequested('digitalocean-cpu');
const { freeOnly, maxPricePerHour } = liveOptions();
const paid = freeOnly ? it.skip : it;
const WAIT = { intervalMs: 5000, timeoutMs: 15 * 60_000 };
const SSH_RETRY = { maxRetries: 30, retryTimeout: 10_000 };

(requested ? describe : describe.skip)(`DigitalOcean volumes: a Block Storage volume mounted, detached and attached again, kept, and mounted by another droplet, against the live API${
    requested ? '' : ' (set ASAP_VPS_LIVE=digitalocean-cpu to run it: it creates a real volume and droplets)'}`, () => {
    const runName = newRunName();
    const run = runMatcher(runName);
    let p: DigitalOcean;
    let watchdog: { doneFile: string } | undefined;
    let refused = false;
    let volumeIds = new Set<string>();
    let keyIds = new Set<string>();
    let offer: Offer<DigitalOceanSizeData>;
    let region: string;
    let vol: Volume<DigitalOceanVolumeData>;
    let first: ProvisionResult<Server<DigitalOceanDropletData>>;
    /** Where DigitalOcean mounts the volume (its mountPath). */
    const at = () => vol.mountPath!;
    /**
     * Until cloud-init is done and the volume is mounted (DigitalOcean mounts it on the first boot):
     * its filesystem type, or a failure on stderr (a RunCommandStep fails a command that writes there).
     */
    const mounted = () => `cloud-init status --wait >/dev/null 2>&1 || true; for i in $(seq 1 60); do findmnt -n ${at()} >/dev/null && break; sleep 2; done; `
        + `findmnt -n -o FSTYPE ${at()} || { echo "nothing is mounted at ${at()}: $(ls /mnt)" >&2; exit 1; }`;
    const provision = (name: string, commands: string[]) => new ServerProvisioner(p).provision({
        serverOptions: { name, offer, region, mounts: [{ volume: vol }] },
        sshKeyName: name,
        wait: WAIT,
        sshRetry: SSH_RETRY,
    }, (pipeline) => void pipeline.addStep(new RunCommandStep(commands, 'volume'))) as Promise<ProvisionResult<Server<DigitalOceanDropletData>>>;
    const output = (r: ProvisionResult) => r.setupResults.map((x) => `${x.output ?? ''}${x.message ?? ''}`).join('\n');

    beforeAll(async () => {
        loadCredentials();
        const apiKey = process.env.DIGITAL_OCEAN_API_KEY?.trim();
        if (!apiKey) throw new Error('ASAP_VPS_LIVE asks for digitalocean-cpu, but DIGITAL_OCEAN_API_KEY is not set');
        p = new DigitalOcean(apiKey);
        volumeIds = trackVolumes(p);
        keyIds = trackSSHKeys(p);
        try {
            await p.listVolumes();
        } catch (e) {
            if (!(e instanceof AuthError)) throw e;
            refused = true;
            throw new Error(`DIGITAL_OCEAN_API_KEY is refused by DigitalOcean, so nothing was tried: ${e.message}`);
        }
        if (!freeOnly) {
            const { limit, used } = await p.api.dropletUsage();
            if (used >= limit) throw new Error(`the account has no droplet to spare (${used} of ${limit}): nothing was created`);
            expect(await sweepLeftovers(p, { keyRounds: 3 })).toEqual([]);
            watchdog = await startWatchdog('digitalocean', runName, Date.now() + 60 * 60_000);
        }
    }, 10 * 60_000);

    afterAll(async () => {
        if (!p || refused) return;
        const servers = await teardown(p, run);
        const keys = await deleteRunKeys(p, run, { ids: keyIds, rounds: 6 });
        const volumes = await deleteRunVolumes(p, run, { ids: volumeIds, rounds: 12 });
        if (watchdog && !servers.length && !keys.length && !volumes.length) writeFileSync(watchdog.doneFile, 'done\n');
        expect({ servers, keys, volumes }).toEqual({ servers: [], keys: [], volumes: [] });
    }, 20 * 60_000);

    paid('createVolume makes an ext4 volume where the cheapest droplet is in stock, mounted at /mnt/<name> (dashes as underscores)', async () => {
        [offer] = await p.listOffers({ kind: 'cpu', maxPricePerHour });
        if (!offer) throw new Error(`no droplet size at or under $${maxPricePerHour}/h is in stock right now`);
        region = offer.regions[0];
        vol = await p.createVolume({ name: `${runName}-models`, region, sizeGb: 1 });
        expect(vol).toMatchObject({ provider: 'digitalocean', name: `${runName}-models`, region, sizeGb: 1, status: 'available', serverIds: [], mountPath: `/mnt/${runName.replace(/-/g, '_')}_models` });
        expect(vol.raw.filesystem_type).toBe('ext4');
        expect((await p.getVolume(vol.id))?.id).toBe(vol.id);
        // The list lags a create by seconds (seen live): listed within a minute.
        let listed: string[] = [];
        for (let i = 0; i < 12 && !listed.includes(vol.id); i++) {
            if (i) await new Promise((r) => setTimeout(r, 5000));
            listed = (await p.listVolumes()).map((v) => v.id);
        }
        expect(listed).toContain(vol.id);
    }, 5 * 60_000);

    paid('a droplet created with it has it mounted at its mountPath (ext4), and writes to it', async () => {
        first = await provision(`${runName}-a`, [mounted(), `echo asap-vps-wrote=${runName} > ${at()}/marker && cat ${at()}/marker`]);
        expect(first.server.mounts).toEqual([{ volumeId: vol.id }]);
        expect(output(first)).toContain('ext4');
        expect(output(first)).toContain(`asap-vps-wrote=${runName}`);
        expect(await p.getVolume(vol.id)).toMatchObject({ status: 'attached', serverIds: [first.server.id] });
    }, 20 * 60_000);

    paid('detached while the droplet runs, then attached again: it shows up as the same disk, the file on it', async () => {
        const key = first.sshKeyData.privateKey;
        await sshRun(first.server, key, `umount ${at()}`);
        await p.detachVolume(vol.id, first.server.id, WAIT);
        expect(await p.getVolume(vol.id)).toMatchObject({ status: 'available', serverIds: [] });
        expect((await p.getServer(first.server.id))?.mounts ?? []).toEqual([]);
        await p.attachVolume(vol.id, first.server.id, WAIT);
        expect(await p.getVolume(vol.id)).toMatchObject({ status: 'attached', serverIds: [first.server.id] });
        // Attached to a droplet that runs, its device shows up by name; mounted by hand unless the
        // droplet's own udev rule (written at the create) has mounted it again already.
        const device = `/dev/disk/by-id/scsi-0DO_Volume_${vol.name}`;
        expect(await sshRun(first.server, key, `for i in $(seq 1 30); do test -e ${device} && break; sleep 2; done; sleep 3; `
            + `findmnt -n ${at()} >/dev/null && echo remounted-by-droplet || mount ${device} ${at()}; cat ${at()}/marker`))
            .toContain(`asap-vps-wrote=${runName}`);
    }, 20 * 60_000);

    paid('the droplet goes; the volume stays, and a second droplet created with it reads the file', async () => {
        expect(await p.deleteServerAndWait(first.server.id, WAIT)).toBe(true);
        expect(await p.getVolume(vol.id)).toMatchObject({ status: 'available', serverIds: [] });
        const second = await provision(`${runName}-b`, [mounted(), `cat ${at()}/marker`]);
        expect(output(second)).toContain(`asap-vps-wrote=${runName}`);
        expect(await p.deleteServerAndWait(second.server.id, WAIT)).toBe(true);
        await p.deleteVolume(vol.id);
        expect(await p.getVolume(vol.id)).toBeNull();
        await expect(p.deleteVolume(vol.id)).resolves.toBeUndefined();
    }, 30 * 60_000);
});
