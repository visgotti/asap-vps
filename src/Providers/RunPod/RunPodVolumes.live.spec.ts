// RunPod's network volumes against the live API: a network volume made with
// createVolume (it bills until deleteVolume: 10 GB is about $0.001 an hour),
// mounted by two pods at once in its data center (CreateServerOptions.mounts),
// a file one pod writes read by the other, a pod's container disk sized by
// diskGb, and the volume kept when the pods are deleted. Each pod is the
// cheapest GPU in stock in a data center that has network volumes, under
// ASAP_VPS_LIVE_MAX_PRICE (default $1/h), for a few minutes. Runs only when asked,
// with the key in .env.test (or ~/.config/asap-vps/credentials.env):
//   ASAP_VPS_LIVE=runpod npx jest --config jest.live.config.js RunPodVolumes.live
// What the run creates is named after it and deleted at the end (the volume
// after the pods, so nothing holds it); the watchdog (src/testing/live.ts)
// deletes it if the run dies.

import { writeFileSync } from 'fs';
import { AuthError, CapacityError } from '../../errors';
import {
    deleteRunVolumes, liveOptions, liveRequested, loadCredentials, newRunName, runMatcher, startWatchdog, sweepLeftovers, teardown, TEST_IMAGE, TEST_IMAGE_CUDA,
    trackVolumes,
} from '../../testing/live';
import type { CreateServerOptions, Offer, Server, Volume } from '../../types';
import { RunPod } from './RunPod';
import type { RunPodCpuOffer, RunPodGpuType, RunPodNetworkVolume, RunPodPod, RunPodTypes } from './types';

const requested = liveRequested('runpod');
const { freeOnly, maxPricePerHour } = liveOptions();
const paid = freeOnly ? it.skip : it;
const WAIT = { intervalMs: 5000, timeoutMs: 15 * 60_000 };

(requested ? describe : describe.skip)(`RunPod network volumes: one volume mounted by two pods at once, against the live API${
    requested ? '' : ' (set ASAP_VPS_LIVE=runpod to run it: it creates a real volume and pods)'}`, () => {
    const runName = newRunName();
    const run = runMatcher(runName);
    let p: RunPod;
    let watchdog: { doneFile: string } | undefined;
    let refused = false;
    let volumeIds = new Set<string>();
    let offer: Offer<RunPodGpuType | RunPodCpuOffer>;
    let dc: string;
    let volume: Volume<RunPodNetworkVolume>;
    let writer: Server<RunPodPod>;
    let reader: Server<RunPodPod>;

    /**
     * A pod in the volume's data center: the cheapest GPU type in stock there
     * first, then the next when RunPod has no machine free for it (stock is per
     * host: one pod can take the last GPU of a type).
     */
    const podInDc = async (o: Omit<CreateServerOptions<RunPodTypes>, 'offer' | 'region'>): Promise<Server<RunPodPod>> => {
        const candidates = (await p.listOffers({ kind: 'gpu', maxPricePerHour, minCudaVersion: TEST_IMAGE_CUDA })).filter((x) => x.regions.includes(dc));
        for (const candidate of candidates) {
            try {
                return await p.createServer({ ...o, offer: candidate, region: dc });
            } catch (e) {
                if (!(e instanceof CapacityError)) throw e;
            }
        }
        throw new Error(`no GPU at or under $${maxPricePerHour}/h could be rented in ${dc}`);
    };

    /** The pod's container output, read until it shows `line` (a container prints once it has started). */
    const logShows = async (id: string, line: string): Promise<string> => {
        let text = '';
        for (let i = 0; i < 36 && !text.includes(line); i++) {
            if (i) await new Promise((r) => setTimeout(r, 5000));
            text = await p.getServerLogs(id).catch(() => '');
        }
        return text;
    };

    beforeAll(async () => {
        loadCredentials();
        const apiKey = process.env.RUNPOD_API_KEY?.trim();
        if (!apiKey) throw new Error('ASAP_VPS_LIVE asks for runpod, but RUNPOD_API_KEY is not set');
        p = new RunPod(apiKey);
        volumeIds = trackVolumes(p);
        try {
            await p.listVolumes();
        } catch (e) {
            if (!(e instanceof AuthError)) throw e;
            refused = true;
            throw new Error(`RUNPOD_API_KEY is refused by RunPod, so nothing was tried: ${e.message}`);
        }
        if (!freeOnly) {
            expect(await sweepLeftovers(p)).toEqual([]);
            watchdog = await startWatchdog('runpod', runName, Date.now() + 45 * 60_000);
        }
    }, 10 * 60_000);

    afterAll(async () => {
        if (!p || refused) return;
        // Pods first, so nothing holds the volume; then every volume the run made, by id and by name, each verified gone.
        const servers = await teardown(p, run);
        const volumes = await deleteRunVolumes(p, run, { ids: volumeIds, rounds: 6 });
        if (watchdog && !servers.length && !volumes.length) writeFileSync(watchdog.doneFile, 'done\n');
        expect({ servers, volumes }).toEqual({ servers: [], volumes: [] });
    }, 15 * 60_000);

    paid('createVolume makes a network volume in a data center with GPU stock; getVolume and listVolumes read it', async () => {
        // The data centers that have network volumes (the catalog says which tiers each has: none is none).
        const { dataCenters } = await p.api.call<{ dataCenters: Array<{ id: string, networkVolumeTypes: string[] }> }>('GET', '/v2/catalog/datacenters');
        const withVolumes = new Set(dataCenters.filter((d) => d.networkVolumeTypes?.length).map((d) => d.id));
        const offers = await p.listOffers({ kind: 'gpu', maxPricePerHour, minCudaVersion: TEST_IMAGE_CUDA });
        const pick = offers.map((o) => ({ o, dc: o.regions.find((r) => withVolumes.has(r)) })).find((x) => x.dc);
        if (!pick) throw new Error(`no GPU at or under $${maxPricePerHour}/h is in stock in a data center with network volumes right now`);
        offer = pick.o;
        dc = pick.dc!;
        volume = await p.createVolume({ name: `${runName}-models`, region: dc, sizeGb: 10 });
        expect(volume).toMatchObject({ provider: 'runpod', name: `${runName}-models`, region: dc, sizeGb: 10, status: 'available', mountPath: '/workspace' });
        expect((await p.getVolume(volume.id))?.id).toBe(volume.id);
        expect((await p.listVolumes()).map((v) => v.id)).toContain(volume.id);
        expect(await p.getVolume('zzzzzzzzzz')).toBeNull();
    }, 5 * 60_000);

    paid('a pod mounts it at the path asked, with the container disk asked for, and writes to it', async () => {
        const created = await podInDc({
            name: `${runName}-writer`, image: TEST_IMAGE, minCudaVersion: TEST_IMAGE_CUDA, diskGb: 15,
            mounts: [{ volume, path: '/models' }],
            command: ['bash', '-c', `echo "asap-vps-wrote=${runName}" > /models/marker && echo "asap-vps-read=$(cat /models/marker)"; sleep 3600`],
        });
        expect(created.mounts).toEqual([{ volumeId: volume.id, path: '/models' }]);
        writer = await p.waitUntilRunning(created.id, WAIT);
        expect(writer).toMatchObject({ region: dc, mounts: [{ volumeId: volume.id, path: '/models' }] });
        expect((writer.raw as RunPodPod & { disk?: number }).disk).toBe(15);
        expect(await logShows(writer.id, `asap-vps-read=asap-vps-wrote=${runName}`)).toContain(`asap-vps-read=asap-vps-wrote=${runName}`);
    }, 20 * 60_000);

    paid('a second pod mounts the same volume while the first runs, and reads what the first wrote', async () => {
        const created = await podInDc({
            name: `${runName}-reader`, image: TEST_IMAGE, minCudaVersion: TEST_IMAGE_CUDA,
            mounts: [{ volume: volume.id, path: '/data' }],
            command: ['bash', '-c', 'echo "asap-vps-shared=$(cat /data/marker)"; sleep 3600'],
        });
        reader = await p.waitUntilRunning(created.id, WAIT);
        expect(reader).toMatchObject({ region: dc, mounts: [{ volumeId: volume.id, path: '/data' }] });
        expect((await p.getServer(writer.id))?.status).toBe('running');
        expect(await logShows(reader.id, `asap-vps-shared=asap-vps-wrote=${runName}`)).toContain(`asap-vps-shared=asap-vps-wrote=${runName}`);
    }, 20 * 60_000);

    paid('the pods go; the volume stays until deleteVolume, which is idempotent', async () => {
        expect(await p.deleteServerAndWait(writer.id, WAIT)).toBe(true);
        expect(await p.deleteServerAndWait(reader.id, WAIT)).toBe(true);
        expect(await p.getVolume(volume.id)).toMatchObject({ id: volume.id, status: 'available' });
        await p.deleteVolume(volume.id);
        expect(await p.getVolume(volume.id)).toBeNull();
        expect((await p.listVolumes()).map((v) => v.id)).not.toContain(volume.id);
        await expect(p.deleteVolume(volume.id)).resolves.toBeUndefined();
    }, 15 * 60_000);
});
