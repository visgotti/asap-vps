// Vast's volumes against the live API: a volume (createVolume: 2 GB, about
// $0.0006 an hour) on the machine of the cheapest GPU offer that runs the test
// image and has storage to rent; an instance rented on that machine mounts it
// at /data and writes a file to it, and is deleted; a second instance rented on
// the same machine (offersOn, once its GPU is free again) mounts it and reads
// the file back; then the volume is deleted, verified. Each instance runs for a
// few minutes. Vast is a marketplace: an offer can be taken in seconds, a host
// can be dead, and the machine can be rented by someone else between the two
// instances (the run then says so). Runs only when asked, with the key in
// .env.test (or ~/.config/asap-vps/credentials.env):
//   ASAP_VPS_LIVE=vast npx jest --config jest.live.config.js VastVolumes.live
// What the run creates is named after it (the volume with underscores: Vast
// takes no hyphens there) and deleted at the end; the watchdog
// (src/testing/live.ts) deletes it if the run dies.

import { writeFileSync } from 'fs';
import { AuthError, CapacityError, ProviderError } from '../../errors';
import {
    deleteRunVolumes, liveOptions, liveRequested, loadCredentials, newRunName, runMatcher, startWatchdog, sweepLeftovers, teardown, TEST_IMAGE, TEST_IMAGE_CUDA, trackVolumes,
} from '../../testing/live';
import type { Offer, Server, Volume } from '../../types';
import type { VastInstance, VastOffer, VastVolume } from './types';
import { VastAI } from './VastAI';

const requested = liveRequested('vast');
const { freeOnly, maxPricePerHour } = liveOptions();
const paid = freeOnly ? it.skip : it;
const WAIT = { intervalMs: 10_000, timeoutMs: 15 * 60_000 };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

(requested ? describe : describe.skip)(`Vast volumes: a volume on one machine, mounted by two instances in turn, against the live API${
    requested ? '' : ' (set ASAP_VPS_LIVE=vast to run it: it rents a real volume and GPU machine)'}`, () => {
    const runName = newRunName();
    const run = runMatcher(runName);
    /** Vast names a volume with letters, digits and underscores only. */
    const volumeName = `${runName}-vol`.replace(/-/g, '_');
    const MARK = `asap-vps-volume=${runName}`;
    let p: VastAI;
    let watchdog: { doneFile: string } | undefined;
    let refused = false;
    let volumeIds = new Set<string>();
    let volume: Volume<VastVolume> | undefined;
    const need = () => {
        if (!volume) throw new Error('no volume (an earlier step failed)');
        return volume;
    };
    const logShows = async (id: string, line: string): Promise<string> => {
        let text = '';
        for (let i = 0; i < 30 && !text.includes(line); i++) {
            if (i) await sleep(10_000);
            text = await p.getServerLogs(id).catch(() => '');
        }
        return text;
    };

    beforeAll(async () => {
        loadCredentials();
        const apiKey = process.env.VAST_API_KEY?.trim();
        if (!apiKey) throw new Error('ASAP_VPS_LIVE asks for vast, but VAST_API_KEY is not set');
        p = new VastAI(apiKey);
        volumeIds = trackVolumes(p);
        try {
            await p.listVolumes();
        } catch (e) {
            if (!(e instanceof AuthError)) throw e;
            refused = true;
            throw new Error(`VAST_API_KEY is refused by Vast, so nothing was tried: ${e.message}`);
        }
        if (!freeOnly) {
            expect(await sweepLeftovers(p)).toEqual([]);
            watchdog = await startWatchdog('vast', runName, Date.now() + 60 * 60_000);
        }
    }, 10 * 60_000);

    afterAll(async () => {
        if (!p || refused) return;
        const servers = await teardown(p, run);
        const volumes = await deleteRunVolumes(p, run, { ids: volumeIds, rounds: 6 });
        if (watchdog && !servers.length && !volumes.length) writeFileSync(watchdog.doneFile, 'done\n');
        expect({ servers, volumes }).toEqual({ servers: [], volumes: [] });
    }, 15 * 60_000);

    paid('createVolume makes a volume on a GPU offer\'s machine; an instance rented there mounts it at /data and writes to it; deleted, it lets go of it', async () => {
        const offers = (await p.listOffers({ maxPricePerHour, minCudaVersion: TEST_IMAGE_CUDA })).slice(0, 8);
        if (!offers.length) throw new Error(`no GPU at or under $${maxPricePerHour}/h runs CUDA ${TEST_IMAGE_CUDA} right now`);
        let first: Server<VastInstance> | undefined;
        // A machine with no room for a volume, a taken offer, a dead host: the next offer's machine.
        for (const offer of offers) {
            const region = offer.regions.find((r) => r.startsWith('machine:'))!;
            let vol: Volume<VastVolume> | undefined;
            let made: Server<VastInstance> | undefined;
            try {
                vol = await p.createVolume({ name: volumeName, region, sizeGb: 2 });
                made = await p.createServer({
                    name: `${runName}-a`, offer, image: TEST_IMAGE, minCudaVersion: TEST_IMAGE_CUDA, mounts: [{ volume: vol, path: '/data' }],
                    command: ['bash', '-c', `echo "${MARK}" > /data/mark && echo "wrote=$(cat /data/mark)"; sleep 3600`],
                });
                first = await p.waitUntilRunning(made.id, WAIT);
                volume = vol;
                break;
            } catch (e) {
                if (!(e instanceof CapacityError) && !(made && e instanceof ProviderError)) throw e;
                if (made) expect(await p.deleteServerAndWait(made.id, WAIT)).toBe(true);
                if (vol) await p.deleteVolume(vol.id);
            }
        }
        if (!first || !volume) throw new Error('no offer\'s machine took a volume and ran an instance with it');
        console.log(`vast volumes: volume ${volume.id} on ${volume.region}, instance ${first.id} (${first.gpu})`);
        expect(volume).toMatchObject({ provider: 'vast', name: volumeName, sizeGb: 2, shared: false, status: 'available', mountPath: '/data' });
        expect(volume.region).toMatch(/^machine:\d+$/);
        expect(first.mounts).toEqual([{ volumeId: volume.id, path: '/data' }]);
        expect(await p.getVolume(volume.id)).toMatchObject({ status: 'attached', serverIds: [first.id] });
        expect((await p.listVolumes()).map((v) => v.id)).toContain(volume.id);
        expect(await logShows(first.id, `wrote=${MARK}`)).toContain(`wrote=${MARK}`);
        // An attached volume is not deleted.
        await expect(p.deleteVolume(volume.id)).rejects.toThrow(/attached to instance/);
        expect(await p.deleteServerAndWait(first.id, WAIT)).toBe(true);
        expect(await p.getVolume(volume.id)).toMatchObject({ status: 'available', serverIds: [] });
    }, 45 * 60_000);

    paid('a second instance rented on the same machine mounts it, and reads the file the first wrote', async () => {
        const vol = need();
        let offers: Offer<VastOffer>[] = [];
        for (let i = 0; i < 30 && !offers.length; i++) {
            if (i) await sleep(10_000);
            offers = await p.offersOn(vol.region);
        }
        if (!offers.length) throw new Error(`${vol.region} offers nothing now (someone else rented it meanwhile): its volume waits for it`);
        const b = await p.createServer({
            name: `${runName}-b`, offer: offers[0], image: TEST_IMAGE, mounts: [{ volume: vol.id }],
            command: ['bash', '-c', 'echo "read=$(cat /data/mark)"; sleep 3600'],
        });
        const second = await p.waitUntilRunning(b.id, WAIT);
        expect(second.mounts).toEqual([{ volumeId: vol.id, path: '/data' }]);
        expect(await logShows(second.id, `read=${MARK}`)).toContain(`read=${MARK}`);
        expect(await p.deleteServerAndWait(second.id, WAIT)).toBe(true);
    }, 45 * 60_000);

    paid('deleteVolume: gone, no longer listed; deleting it again is no error', async () => {
        const vol = need();
        await p.deleteVolume(vol.id);
        expect(await p.getVolume(vol.id)).toBeNull();
        expect((await p.listVolumes()).map((v) => v.id)).not.toContain(vol.id);
        await expect(p.deleteVolume(vol.id)).resolves.toBeUndefined();
    }, 10 * 60_000);
});
