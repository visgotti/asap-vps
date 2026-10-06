// DigitalOcean's shared volumes against the live API: a Network File Storage
// share (createVolume({ shared: true }): 50 GB standard, $0.15/GiB-month, a
// fraction of a cent an hour) in a region of the cheapest droplet in stock that
// has NFS, mounted over NFS at a path of its own by a droplet that writes a
// file to it, then (that droplet deleted: the account has one droplet to spare)
// by a second droplet that reads it; then the share deleted, verified. Two
// droplets mounting it at once is held to the contract against the fake. Runs only when asked, with
// the key in .env.test (or ~/.config/asap-vps/credentials.env):
//   ASAP_VPS_LIVE=digitalocean-cpu npx jest --config jest.live.config.js DigitalOceanShares.live
// What the run creates is named after it and deleted at the end (the share
// after the droplets); the watchdog (src/testing/live.ts) deletes it if the run dies.

import { writeFileSync } from 'fs';
import { ProvisionResult, ServerProvisioner } from '../../Core/ServerProvisioner';
import { RunCommandStep } from '../../Core/steps';
import { AuthError } from '../../errors';
import {
    deleteRunKeys, deleteRunVolumes, liveOptions, liveRequested, loadCredentials, newRunName, runMatcher, startWatchdog, sweepLeftovers, teardown, trackSSHKeys, trackVolumes,
} from '../../testing/live';
import type { Offer, Server, Volume } from '../../types';
import { DigitalOcean } from './DigitalOcean';
import type { DigitalOceanDropletData, DigitalOceanNfsShare, DigitalOceanSizeData } from './types';

const requested = liveRequested('digitalocean-cpu');
const { freeOnly, maxPricePerHour } = liveOptions();
const paid = freeOnly ? it.skip : it;
const WAIT = { intervalMs: 5000, timeoutMs: 15 * 60_000 };
/** Where Network File Storage is (docs.digitalocean.com/products/nfs/details/availability, 2026-10-01). */
const NFS_REGIONS = ['nyc2', 'ams3', 'atl1', 'ric1', 'mkc1', 'mem1'];
const PATH = '/mnt/shared';

(requested ? describe : describe.skip)(`DigitalOcean shared volumes: an NFS share droplets mount over NFS, against the live API${
    requested ? '' : ' (set ASAP_VPS_LIVE=digitalocean-cpu to run it: it creates a real share and droplets)'}`, () => {
    const runName = newRunName();
    const run = runMatcher(runName);
    let p: DigitalOcean;
    let watchdog: { doneFile: string } | undefined;
    let refused = false;
    let volumeIds = new Set<string>();
    let keyIds = new Set<string>();
    let offer: Offer<DigitalOceanSizeData>;
    let region: string;
    let share: Volume<DigitalOceanNfsShare>;
    const droplets: Array<ProvisionResult<Server<DigitalOceanDropletData>>> = [];
    const provision = (name: string, commands: string[]) => new ServerProvisioner(p).provision({
        serverOptions: { name, offer, region, mounts: [{ volume: share, path: PATH }] },
        sshKeyName: name,
        wait: WAIT,
        sshRetry: { maxRetries: 30, retryTimeout: 10_000 },
    }, (pipeline) => void pipeline.addStep(new RunCommandStep(commands, 'share'))) as Promise<ProvisionResult<Server<DigitalOceanDropletData>>>;
    /** Until cloud-init is done and the share is mounted: its filesystem type, or a failure on stderr. */
    const mounted = `cloud-init status --wait >/dev/null 2>&1 || true; for i in $(seq 1 60); do findmnt -n ${PATH} >/dev/null && break; sleep 2; done; `
        + `findmnt -n -o FSTYPE ${PATH} || { echo "nothing is mounted at ${PATH}: $(tail -5 /var/log/cloud-init-output.log)" >&2; exit 1; }`;
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

    paid('createVolume({ shared: true }) makes an NFS share, ACTIVE, where the cheapest droplet with NFS is in stock', async () => {
        const offers = await p.listOffers({ kind: 'cpu', maxPricePerHour });
        offer = offers.find((o) => o.regions.some((r) => NFS_REGIONS.includes(r)))!;
        if (!offer) throw new Error(`no droplet size at or under $${maxPricePerHour}/h is in stock in a region with NFS (${NFS_REGIONS.join(', ')})`);
        region = offer.regions.find((r) => NFS_REGIONS.includes(r))!;
        share = await p.createVolume({ name: `${runName}-share`, region, sizeGb: 50, shared: true });
        expect(share).toMatchObject({ provider: 'digitalocean', name: `${runName}-share`, region, shared: true, sizeGb: 50, status: 'available', providerStatus: 'ACTIVE' });
        expect(share.raw.host).toBeTruthy();
        expect(share.raw.mount_path).toMatch(/^\//);
        expect(await p.getVolume(share.id)).toMatchObject({ id: share.id, shared: true });
        expect((await p.listVolumes()).map((v) => v.id)).toContain(share.id);
    }, 20 * 60_000);

    paid('a droplet mounts it over NFS at its path, and writes to it', async () => {
        const a = await provision(`${runName}-a`, [mounted, `echo asap-vps-shared=${runName} > ${PATH}/marker && cat ${PATH}/marker`]);
        droplets.push(a);
        expect(output(a)).toMatch(/nfs4/);
        expect(output(a)).toContain(`asap-vps-shared=${runName}`);
        expect(a.server.mounts).toEqual([{ volumeId: share.id, path: PATH }]);
    }, 25 * 60_000);

    paid('that droplet goes; a second droplet mounts the share, and reads the file', async () => {
        expect(await p.deleteServerAndWait(droplets[0].server.id, WAIT)).toBe(true);
        const b = await provision(`${runName}-b`, [mounted, `cat ${PATH}/marker`]);
        droplets.push(b);
        expect(output(b)).toContain(`asap-vps-shared=${runName}`);
        expect(b.server.mounts).toEqual([{ volumeId: share.id, path: PATH }]);
    }, 25 * 60_000);

    paid('the droplet goes; the share stays until deleteVolume, then it is gone', async () => {
        expect(await p.deleteServerAndWait(droplets[1].server.id, WAIT)).toBe(true);
        expect(await p.getVolume(share.id)).toMatchObject({ status: 'available' });
        await p.deleteVolume(share.id);
        expect(await p.getVolume(share.id)).toBeNull();
        await expect(p.deleteVolume(share.id)).resolves.toBeUndefined();
    }, 20 * 60_000);
});
