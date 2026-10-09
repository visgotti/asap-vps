// RunPod's CPU pods against the live API: the cheapest CPU flavor in stock (a
// machine without GPUs, priced per vCPU: a few cents an hour), rented,
// running a small public image, listed as a CPU server and not as a GPU one,
// priced, and deleted, verified. Runs only when asked, with the key in
// .env.test (or ~/.config/asap-vps/credentials.env):
//   ASAP_VPS_LIVE=runpod npx jest --config jest.live.config.js RunPodCpu.live
// What the run creates is named after it and deleted at the end; the watchdog
// (src/testing/live.ts) deletes it if the run dies.

import { writeFileSync } from 'fs';
import { AuthError, CapacityError } from '../../errors';
import { liveOptions, liveRequested, loadCredentials, newRunName, runMatcher, startWatchdog, sweepLeftovers, teardown } from '../../testing/live';
import type { Server } from '../../types';
import { RunPod } from './RunPod';
import type { RunPodPod } from './types';

const requested = liveRequested('runpod');
const { freeOnly } = liveOptions();
const paid = freeOnly ? it.skip : it;
const WAIT = { intervalMs: 5000, timeoutMs: 15 * 60_000 };

(requested ? describe : describe.skip)(`RunPod CPU pods: the cheapest CPU flavor, rented and deleted, against the live API${
    requested ? '' : ' (set ASAP_VPS_LIVE=runpod to run it: it rents a real CPU pod)'}`, () => {
    const runName = newRunName();
    const run = runMatcher(runName);
    let p: RunPod;
    let watchdog: { doneFile: string } | undefined;
    let refused = false;
    let pod: Server<RunPodPod>;

    beforeAll(async () => {
        loadCredentials();
        const apiKey = process.env.RUNPOD_API_KEY?.trim();
        if (!apiKey) throw new Error('ASAP_VPS_LIVE asks for runpod, but RUNPOD_API_KEY is not set');
        p = new RunPod(apiKey);
        try {
            await p.listServers();
        } catch (e) {
            if (!(e instanceof AuthError)) throw e;
            refused = true;
            throw new Error(`RUNPOD_API_KEY is refused by RunPod, so nothing was tried: ${e.message}`);
        }
        if (!freeOnly) {
            expect(await sweepLeftovers(p)).toEqual([]);
            watchdog = await startWatchdog('runpod', runName, Date.now() + 30 * 60_000);
        }
    }, 10 * 60_000);

    afterAll(async () => {
        if (!p || refused) return;
        const servers = await teardown(p, run);
        if (watchdog && !servers.length) writeFileSync(watchdog.doneFile, 'done\n');
        expect(servers).toEqual([]);
    }, 15 * 60_000);

    it('offers CPU flavors as machines without GPUs, priced per vCPU, each at a power-of-two count, and a GPU question reads none', async () => {
        const cpu = await p.listOffers({ kind: 'cpu', includeUnavailable: true });
        expect(cpu.length).toBeGreaterThan(0);
        for (const o of cpu) {
            expect(o).toMatchObject({ provider: 'runpod', gpu: '', vendor: null, gpuCount: 0, vramGb: 0 });
            expect(o.id).toMatch(/^[^:]+:\d+$/);
            expect(o.vcpus! & (o.vcpus! - 1)).toBe(0);
            expect(o.pricePerHour).toBeGreaterThan(0);
            expect(o.memoryGb).toBeGreaterThan(0);
        }
        expect((await p.listOffers({ kind: 'gpu' })).every((o) => o.gpuCount > 0)).toBe(true);
    }, 5 * 60_000);

    paid('rents the cheapest CPU pod in stock: it runs its image, lists as a CPU server, is priced, and is deleted verified', async () => {
        const offers = await p.listOffers({ kind: 'cpu' });
        if (!offers.length) throw new Error('no CPU flavor is in stock right now');
        for (const offer of offers.slice(0, 5)) {
            try {
                pod = await p.createServer({ name: runName, offer, image: 'busybox:1.36', command: ['sh', '-c', `echo asap-vps-cpu=${runName}; sleep 3600`] });
                break;
            } catch (e) {
                if (!(e instanceof CapacityError)) throw e;
            }
        }
        if (!pod) throw new Error('no CPU flavor in stock could be rented right now');
        const running = await p.waitUntilRunning(pod.id, WAIT);
        expect(running.gpu).toBeUndefined();
        expect(running.offerId).toMatch(/^[^:]+:\d+$/);
        expect(running.pricePerHour).toBeGreaterThan(0);
        let logs = '';
        for (let i = 0; i < 36 && !logs.includes(`asap-vps-cpu=${runName}`); i++) {
            if (i) await new Promise((r) => setTimeout(r, 5000));
            logs = await p.getServerLogs(pod.id).catch(() => '');
        }
        expect(logs).toContain(`asap-vps-cpu=${runName}`);
        expect((await p.listServers({ kind: 'cpu' })).map((s) => s.id)).toContain(pod.id);
        expect((await p.listServers({ kind: 'gpu' })).map((s) => s.id)).not.toContain(pod.id);
        expect(await p.deleteServerAndWait(pod.id, WAIT)).toBe(true);
        expect(await p.getServer(pod.id)).toBeNull();
    }, 20 * 60_000);
});
