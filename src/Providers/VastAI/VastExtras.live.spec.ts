// Vast's create options that its lifecycle suite does not exercise, against
// the live API: `userData` (a script the container runs before its command,
// at each start) and `diskGb` (the instance's disk). One instance, the
// cheapest that runs the test image under ASAP_VPS_LIVE_MAX_PRICE (default
// $1/h), for a few minutes. Vast is a marketplace: a host can be dead (it
// cannot start the container) and an offer can be taken in seconds, so the next
// offer is tried, and a dead host's instance deleted first. Runs only when
// asked, with the key in .env.test (or ~/.config/asap-vps/credentials.env):
//   ASAP_VPS_LIVE=vast npx jest --config jest.live.config.js VastExtras.live
// What the run creates is named after it and deleted at the end; the watchdog
// (src/testing/live.ts) deletes it if the run dies.

import { writeFileSync } from 'fs';
import { AuthError, CapacityError, ProviderError } from '../../errors';
import { liveOptions, liveRequested, loadCredentials, newRunName, runMatcher, startWatchdog, sweepLeftovers, teardown, TEST_IMAGE, TEST_IMAGE_CUDA } from '../../testing/live';
import type { CreateServerOptions, Server } from '../../types';
import type { VastInstance, VastTypes } from './types';
import { VastAI } from './VastAI';

const requested = liveRequested('vast');
const { freeOnly, maxPricePerHour } = liveOptions();
const paid = freeOnly ? it.skip : it;
const WAIT = { intervalMs: 10_000, timeoutMs: 15 * 60_000 };

(requested ? describe : describe.skip)(`Vast create options: userData and diskGb, against the live API${
    requested ? '' : ' (set ASAP_VPS_LIVE=vast to run it: it rents a real GPU machine)'}`, () => {
    const runName = newRunName();
    const run = runMatcher(runName);
    let p: VastAI;
    let watchdog: { doneFile: string } | undefined;
    let refused = false;

    /** The cheapest offers that run the test image, tried in turn: a taken offer or a dead host moves on to the next. */
    const rentRunning = async (o: Omit<CreateServerOptions<VastTypes>, 'offer'>): Promise<Server<VastInstance>> => {
        const offers = (await p.listOffers({ maxPricePerHour, minCudaVersion: TEST_IMAGE_CUDA })).slice(0, 8);
        if (!offers.length) throw new Error(`no GPU at or under $${maxPricePerHour}/h runs CUDA ${TEST_IMAGE_CUDA} right now`);
        for (const offer of offers) {
            let made: Server<VastInstance> | undefined;
            try {
                made = await p.createServer({ ...o, offer });
                return await p.waitUntilRunning(made.id, WAIT);
            } catch (e) {
                if (!(e instanceof CapacityError) && !(made && e instanceof ProviderError)) throw e;
                // A dead host (its container never starts): delete what was rented, verified, and try the next machine.
                if (made) expect(await p.deleteServerAndWait(made.id, WAIT)).toBe(true);
            }
        }
        throw new Error('no offer could be rented and started');
    };
    const logShows = async (id: string, lines: string[]): Promise<string> => {
        let text = '';
        for (let i = 0; i < 30 && !lines.every((l) => text.includes(l)); i++) {
            if (i) await new Promise((r) => setTimeout(r, 10_000));
            text = await p.getServerLogs(id).catch(() => '');
        }
        return text;
    };

    beforeAll(async () => {
        loadCredentials();
        const apiKey = process.env.VAST_API_KEY?.trim();
        if (!apiKey) throw new Error('ASAP_VPS_LIVE asks for vast, but VAST_API_KEY is not set');
        p = new VastAI(apiKey);
        try {
            await p.listServers();
        } catch (e) {
            if (!(e instanceof AuthError)) throw e;
            refused = true;
            throw new Error(`VAST_API_KEY is refused by Vast, so nothing was tried: ${e.message}`);
        }
        if (!freeOnly) {
            expect(await sweepLeftovers(p)).toEqual([]);
            watchdog = await startWatchdog('vast', runName, Date.now() + 45 * 60_000);
        }
    }, 10 * 60_000);

    afterAll(async () => {
        if (!p || refused) return;
        const servers = await teardown(p, run);
        if (watchdog && !servers.length) writeFileSync(watchdog.doneFile, 'done\n');
        expect(servers).toEqual([]);
    }, 15 * 60_000);

    paid('userData runs before the command in the same container (its file is there for the command), and the disk is the size asked for', async () => {
        const s = await rentRunning({
            name: runName, image: TEST_IMAGE, minCudaVersion: TEST_IMAGE_CUDA, diskGb: 24,
            userData: `#!/bin/bash\necho "asap-vps-booted=${runName}" > /tmp/asap-vps-boot\necho "asap-vps-script=ran"`,
            command: ['bash', '-c', 'echo "asap-vps-cmd=$(cat /tmp/asap-vps-boot)"; sleep 3600'],
        });
        const logs = await logShows(s.id, ['asap-vps-script=ran', `asap-vps-cmd=asap-vps-booted=${runName}`]);
        expect(logs).toContain('asap-vps-script=ran');
        expect(logs).toContain(`asap-vps-cmd=asap-vps-booted=${runName}`);
        expect(Math.round(Number((s.raw as VastInstance & { disk_space?: number }).disk_space))).toBe(24);
        expect(await p.deleteServerAndWait(s.id, WAIT)).toBe(true);
    }, 45 * 60_000);
});
