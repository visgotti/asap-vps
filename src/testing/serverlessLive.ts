// A serverless endpoint against the live APIs, the same run on RunPod and
// Scaleway: an endpoint of a tiny public HTTP image (traefik/whoami answers
// every path, /ping included, with an echo of the request) on the cheapest
// CPU worker in stock, scaled from zero; a request through requestEndpoint (its
// cold start waited out) answered by a worker of it; the same request without
// the account's key refused (the endpoint is private); read and listed; where
// the platform scales down within minutes (RunPod), back at no worker once
// idle; then deleted, verified gone. What the run makes is named after it and
// deleted at the end; the watchdog (live.ts) deletes it if the run dies.

import { writeFileSync } from 'fs';
import type { IServerless } from '../capabilities';
import { AuthError } from '../errors';
import type { CreateEndpointOptions, Endpoint, PlatformTypes } from '../types';
import { deleteRunEndpoints, liveOptions, liveRequested, loadCredentials, newRunName, runMatcher, startWatchdog, sweepLeftovers } from './live';
import type { ComputeSubject } from './live';

export type ServerlessLive<P extends IServerless<PlatformTypes> & ComputeSubject> = {
    /** What ASAP_VPS_LIVE names to run it. */
    target: string,
    /** The provider's id, for the watchdog. */
    provider: string,
    make(): P,
    /** The endpoint's own options on this platform (RunPod: a short idle timeout). */
    extra?: Partial<CreateEndpointOptions>,
    /** Its workers now, where the platform says: to see it back at none once idle. */
    workers?(p: P, id: string): Promise<number>,
    /** What a request without the account's key is answered. */
    deniedStatus: number,
};

const IMAGE = 'traefik/whoami:v1.12.0';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function describeServerlessLive<P extends IServerless<PlatformTypes> & ComputeSubject>(t: ServerlessLive<P>): void {
    const requested = liveRequested(t.target);
    const { freeOnly } = liveOptions();
    const paid = freeOnly ? it.skip : it;

    (requested ? describe : describe.skip)(`${t.provider} serverless: an endpoint of a plain HTTP image, from zero workers, against the live API${
        requested ? '' : ` (set ASAP_VPS_LIVE=${t.target} to run it: it makes a real endpoint, billed while a worker runs)`}`, () => {
        const runName = newRunName();
        const run = runMatcher(runName);
        let p: P;
        let watchdog: { doneFile: string } | undefined;
        let refused = false;
        let endpoint: Endpoint | undefined;
        const need = () => {
            if (!endpoint) throw new Error('no endpoint (an earlier step failed)');
            return endpoint;
        };

        beforeAll(async () => {
            loadCredentials();
            p = t.make();
            try {
                await p.listEndpoints();
            } catch (e) {
                if (!(e instanceof AuthError)) throw e;
                refused = true;
                throw new Error(`the ${t.provider} key is refused, so nothing was tried: ${e.message}`);
            }
            if (!freeOnly) {
                expect(await sweepLeftovers(p)).toEqual([]);
                watchdog = await startWatchdog(t.provider, runName, Date.now() + 45 * 60_000);
            }
        }, 10 * 60_000);

        afterAll(async () => {
            if (!p || refused) return;
            const endpoints = await deleteRunEndpoints(p, run);
            if (watchdog && !endpoints.length) writeFileSync(watchdog.doneFile, 'done\n');
            expect({ endpoints }).toEqual({ endpoints: [] });
        }, 15 * 60_000);

        paid('createEndpoint deploys the image on the cheapest CPU worker in stock, from zero workers', async () => {
            const [offer] = await p.listEndpointOffers({ kind: 'cpu' });
            if (!offer) throw new Error('no CPU worker is in stock right now');
            endpoint = await p.createEndpoint({
                name: runName, container: { image: IMAGE, env: { MARK: runName } }, offer, port: 80, minWorkers: 0, maxWorkers: 1, ...t.extra,
                intervalMs: 5000, timeoutMs: 15 * 60_000,
            });
            expect(endpoint).toMatchObject({ provider: p.id, name: runName, status: 'ready', image: IMAGE, port: 80, minWorkers: 0, maxWorkers: 1, private: true });
            expect(endpoint.url).toMatch(/^https:\/\/[^/]+$/);
        }, 20 * 60_000);

        paid('a request reaches a worker (its cold start waited out); without the account\'s key it is refused', async () => {
            const e = need();
            const r = await p.requestEndpoint(e, '/api', { timeoutMs: 10 * 60_000, intervalMs: 5000 });
            expect(r.status).toBe(200);
            const echo = await r.json() as { url?: string, method?: string, hostname?: string };
            expect(echo).toMatchObject({ url: '/api', method: 'GET' });
            expect(echo.hostname).toBeTruthy();
            // Straight to its URL, with no key: refused.
            const anon = await fetch(`${e.url}/api`);
            expect(anon.status).toBe(t.deniedStatus);
        }, 15 * 60_000);

        paid('read and listed as it is', async () => {
            const e = need();
            expect(await p.getEndpoint(e.id)).toMatchObject({ id: e.id, name: runName, status: 'ready' });
            expect((await p.listEndpoints()).map((x) => x.id)).toContain(e.id);
        }, 5 * 60_000);

        if (t.workers) {
            paid('idle again, it scales back to no worker', async () => {
                const e = need();
                let n = await t.workers!(p, e.id);
                for (let i = 0; i < 40 && n > 0; i++) {
                    await sleep(10_000);
                    n = await t.workers!(p, e.id);
                }
                expect(n).toBe(0);
            }, 10 * 60_000);
        }

        paid('deleted, verified gone; deleting it again is no error', async () => {
            const e = need();
            await p.deleteEndpoint(e.id, { intervalMs: 3000, timeoutMs: 5 * 60_000 });
            expect(await p.getEndpoint(e.id)).toBeNull();
            expect((await p.listEndpoints()).map((x) => x.id)).not.toContain(e.id);
            await p.deleteEndpoint(e.id);
        }, 10 * 60_000);
    });
}
