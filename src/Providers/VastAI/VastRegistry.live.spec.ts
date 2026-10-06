// Vast pulling a private image with `registryAuth`, against the live APIs: a
// private registry made for the run in the Scaleway account
// (src/testing/privateRegistry.ts: a pull-only IAM key, never the account's
// own), and an instance created from its image with that login (sent with
// the rental as `image_login`), running its command, and deleted. One GPU
// machine for a few minutes, under ASAP_VPS_LIVE_MAX_PRICE (default $1/h). Runs
// only when asked, with the Vast key and the Scaleway key and Project in
// .env.test (or ~/.config/asap-vps/credentials.env):
//   ASAP_VPS_LIVE=vast npx jest --config jest.live.config.js VastRegistry.live
// The instance and the registry are named after the run and deleted at the
// end, verified; the watchdog (src/testing/live.ts) deletes the instance if the run dies.

import { writeFileSync } from 'fs';
import { AuthError, CapacityError, ProviderError } from '../../errors';
import { liveOptions, liveRequested, loadCredentials, newRunName, runMatcher, startWatchdog, sweepLeftovers, teardown } from '../../testing/live';
import { makePrivateRegistry, PrivateRegistry, sweepPrivateRegistries } from '../../testing/privateRegistry';
import type { Server } from '../../types';
import type { VastInstance } from './types';
import { VastAI } from './VastAI';

const requested = liveRequested('vast');
const { freeOnly, maxPricePerHour } = liveOptions();
const paid = freeOnly ? it.skip : it;
const WAIT = { intervalMs: 10_000, timeoutMs: 15 * 60_000 };

(requested ? describe : describe.skip)(`Vast registryAuth: an instance from a private image, against the live APIs${
    requested ? '' : ' (set ASAP_VPS_LIVE=vast to run it: it rents a real GPU machine and makes a registry)'}`, () => {
    const runName = newRunName();
    const run = runMatcher(runName);
    let p: VastAI;
    let registry: PrivateRegistry | undefined;
    let watchdog: { doneFile: string } | undefined;
    let refused = false;
    const scw = () => ({ secretKey: process.env.SCW_SECRET_KEY!.trim(), projectId: process.env.SCW_DEFAULT_PROJECT_ID!.trim() });

    beforeAll(async () => {
        loadCredentials();
        const apiKey = process.env.VAST_API_KEY?.trim();
        if (!apiKey) throw new Error('ASAP_VPS_LIVE asks for vast, but VAST_API_KEY is not set');
        if (!process.env.SCW_SECRET_KEY || !process.env.SCW_DEFAULT_PROJECT_ID) throw new Error('the private registry needs SCW_SECRET_KEY and SCW_DEFAULT_PROJECT_ID');
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
            expect(await sweepPrivateRegistries(scw())).toEqual([]);
            watchdog = await startWatchdog('vast', runName, Date.now() + 45 * 60_000);
            registry = await makePrivateRegistry({ ...scw(), runName });
        }
    }, 10 * 60_000);

    afterAll(async () => {
        if (!p || refused) return;
        const servers = await teardown(p, run);
        const registryLeft = registry ? await registry.cleanup() : [];
        if (watchdog && !servers.length && !registryLeft.length) writeFileSync(watchdog.doneFile, 'done\n');
        expect({ servers, registry: registryLeft }).toEqual({ servers: [], registry: [] });
    }, 15 * 60_000);

    paid('an instance pulls the private image with the pull-only login and runs its command', async () => {
        let s: Server<VastInstance> | undefined;
        for (const offer of (await p.listOffers({ maxPricePerHour })).slice(0, 8)) {
            let made: Server<VastInstance> | undefined;
            try {
                made = await p.createServer({ name: runName, offer, image: registry!.image, registryAuth: registry!.pullAuth,
                    command: ['sh', '-c', `echo "asap-vps-private=${runName}"; sleep 3600`] });
                s = await p.waitUntilRunning(made.id, WAIT);
                break;
            } catch (e) {
                if (!(e instanceof CapacityError) && !(made && e instanceof ProviderError)) throw e;
                // A dead host (its container never starts): delete it, verified, and try the next machine.
                if (made) expect(await p.deleteServerAndWait(made.id, WAIT)).toBe(true);
            }
        }
        if (!s) throw new Error('no offer could be rented and started');
        let logs = '';
        for (let i = 0; i < 30 && !logs.includes(`asap-vps-private=${runName}`); i++) {
            if (i) await new Promise((r) => setTimeout(r, 10_000));
            logs = await p.getServerLogs(s.id).catch(() => '');
        }
        expect(logs).toContain(`asap-vps-private=${runName}`);
        expect(await p.deleteServerAndWait(s.id, WAIT)).toBe(true);
    }, 45 * 60_000);
});
