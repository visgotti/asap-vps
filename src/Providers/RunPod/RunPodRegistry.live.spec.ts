// RunPod pulling a private image with `registryAuth`, against the live APIs: a
// private registry made for the run in the Scaleway account
// (src/testing/privateRegistry.ts: a pull-only IAM key, never the account's
// own), a CPU pod created from its image with that login (stored on the
// RunPod account once, named asap-vps:<user>@<host>:<hash>, and reused by a
// second pod), running, and deleted. Costs a few cents (CPU pods). Runs only
// when asked, with the RunPod key and the Scaleway key and Project in .env.test
// (or ~/.config/asap-vps/credentials.env):
//   ASAP_VPS_LIVE=runpod npx jest --config jest.live.config.js RunPodRegistry.live
// The pods, RunPod's stored login and the registry (key, policy, application,
// namespace) are named after the run and deleted at the end, verified; the
// watchdog (src/testing/live.ts) deletes the pods if the run dies.

import { writeFileSync } from 'fs';
import { AuthError, CapacityError } from '../../errors';
import { liveOptions, liveRequested, loadCredentials, newRunName, runMatcher, startWatchdog, sweepLeftovers, teardown } from '../../testing/live';
import { makePrivateRegistry, PrivateRegistry, sweepPrivateRegistries } from '../../testing/privateRegistry';
import type { Server } from '../../types';
import { RunPod } from './RunPod';
import type { RunPodPod, RunPodRegistry } from './types';

const requested = liveRequested('runpod');
const { freeOnly } = liveOptions();
const paid = freeOnly ? it.skip : it;
const WAIT = { intervalMs: 5000, timeoutMs: 15 * 60_000 };

(requested ? describe : describe.skip)(`RunPod registryAuth: a pod from a private image, against the live APIs${
    requested ? '' : ' (set ASAP_VPS_LIVE=runpod to run it: it rents real CPU pods and makes a registry)'}`, () => {
    const runName = newRunName();
    const run = runMatcher(runName);
    let p: RunPod;
    let registry: PrivateRegistry | undefined;
    let watchdog: { doneFile: string } | undefined;
    let refused = false;
    const scw = () => ({ secretKey: process.env.SCW_SECRET_KEY!.trim(), projectId: process.env.SCW_DEFAULT_PROJECT_ID!.trim() });
    /** RunPod's stored logins that this run's registry made (named after its host and pull user). */
    const storedLogins = async () => ((await p.api.call<{ registries?: RunPodRegistry[] }>('GET', '/v2/registries')).registries ?? [])
        .filter((r) => registry && r.name.startsWith(`asap-vps:${registry.pullAuth.username}@${registry.pullAuth.server}:`));

    /** A CPU pod of the cheapest flavor in stock that RunPod has a machine for. */
    const cpuPod = async (name: string, command: string[]): Promise<Server<RunPodPod>> => {
        for (const offer of (await p.listOffers({ kind: 'cpu' })).slice(0, 6)) {
            try {
                return await p.createServer({ name, offer, image: registry!.image, registryAuth: registry!.pullAuth, command });
            } catch (e) {
                if (!(e instanceof CapacityError)) throw e;
            }
        }
        throw new Error('no CPU flavor in stock could be rented right now');
    };
    const logShows = async (id: string, line: string) => {
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
        if (!process.env.SCW_SECRET_KEY || !process.env.SCW_DEFAULT_PROJECT_ID) throw new Error('the private registry needs SCW_SECRET_KEY and SCW_DEFAULT_PROJECT_ID');
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
            expect(await sweepPrivateRegistries(scw())).toEqual([]);
            watchdog = await startWatchdog('runpod', runName, Date.now() + 40 * 60_000);
            registry = await makePrivateRegistry({ ...scw(), runName });
        }
    }, 10 * 60_000);

    afterAll(async () => {
        if (!p || refused) return;
        const servers = await teardown(p, run);
        // The stored login: refused while a pod uses it, so after the pods.
        const logins: string[] = [];
        for (const r of await storedLogins().catch(() => [])) {
            await p.api.call('DELETE', `/v2/registries/${encodeURIComponent(r.id)}`).catch((e) => logins.push(`${r.name} (${(e as Error).message})`));
        }
        const left = await storedLogins().catch(() => [{ name: '(could not list)' } as RunPodRegistry]);
        const registryLeft = registry ? await registry.cleanup() : [];
        if (watchdog && !servers.length && !left.length && !registryLeft.length) writeFileSync(watchdog.doneFile, 'done\n');
        expect({ servers, logins, storedLogins: left.map((r) => r.name), registry: registryLeft }).toEqual({ servers: [], logins: [], storedLogins: [], registry: [] });
    }, 15 * 60_000);

    paid('a pod pulls the private image with the pull-only login, which RunPod stores once and reuses for a second pod', async () => {
        const first = await cpuPod(`${runName}-a`, ['sh', '-c', `echo asap-vps-private=${runName}; sleep 3600`]);
        const running = await p.waitUntilRunning(first.id, WAIT);
        expect(await logShows(running.id, `asap-vps-private=${runName}`)).toContain(`asap-vps-private=${runName}`);
        const [stored, ...more] = await storedLogins();
        expect(more).toEqual([]);
        expect(running.raw.registry).toBe(stored.id);
        const second = await cpuPod(`${runName}-b`, ['sh', '-c', 'sleep 3600']);
        expect(second.raw.registry).toBe(stored.id);
        expect(await storedLogins()).toHaveLength(1);
        expect(await p.deleteServerAndWait(first.id, WAIT)).toBe(true);
        expect(await p.deleteServerAndWait(second.id, WAIT)).toBe(true);
    }, 30 * 60_000);
});
