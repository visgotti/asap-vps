// The live smoke (runSmoke) against the fake provider APIs before any real GPU
// is rented: it rents, sees the GPU, deletes and verifies, and whatever
// happens on the way leaves nothing of the run. The teardown and watchdog it
// relies on: src/testing/live.spec.ts.

import { DigitalOcean, LambdaCloud, RunPod, Scaleway, supports, VastAI } from '../src';
import type { ComputeSubject } from '../src/testing/live';
import { fakeDigitalOcean } from '../src/testing/fakes/digitalocean';
import { fakeLambda } from '../src/testing/fakes/lambda';
import { fakeRunPod } from '../src/testing/fakes/runpod';
import { FAKE_SCALEWAY_PROJECT, fakeScaleway } from '../src/testing/fakes/scaleway';
import { FakeApi } from '../src/testing/fakes/util';
import { fakeVast } from '../src/testing/fakes/vast';
import { runSmoke, SMOKE_PREFIX } from './gpu-smoke';

const noSleep = async () => {};
const quiet = () => {};
const fastSmoke = { intervalMs: 0, sleep: noSleep, log: quiet, readyTimeoutMs: 2000, logTimeoutMs: 200 };

/** A provider over a fake; `wrap` can change what the API answers. */
function makers(wrap: (f: typeof fetch) => typeof fetch = (f) => f) {
    return {
        runpod: (o: { bootReads?: number } = {}) => {
            const fake = fakeRunPod(o);
            return { fake: fake as FakeApi, p: new RunPod({ apiKey: 'rp-test', fetchImpl: wrap(fake.fetchImpl), sleep: noSleep }) as ComputeSubject };
        },
        vast: (o: { bootReads?: number } = {}) => {
            const fake = fakeVast(o);
            return { fake: fake as FakeApi, p: new VastAI({ apiKey: 'vast-test', fetchImpl: wrap(fake.fetchImpl), sleep: noSleep }) as ComputeSubject };
        },
        lambda: (o: { bootReads?: number } = {}) => {
            const fake = fakeLambda(o);
            return { fake: fake as FakeApi, p: new LambdaCloud({ apiKey: 'lambda-test', fetchImpl: wrap(fake.fetchImpl), sleep: noSleep }) as ComputeSubject };
        },
        digitalocean: (o: { bootReads?: number } = {}) => {
            const fake = fakeDigitalOcean(o);
            return { fake: fake as FakeApi, p: new DigitalOcean({ apiKey: 'do-test', fetchImpl: wrap(fake.fetchImpl), sleep: noSleep }) as ComputeSubject };
        },
        scaleway: (o: { bootReads?: number } = {}) => {
            // Scaleway refuses to delete a server that is starting (checked live: precondition_failed): the delete waits until it settles. A server that
            // is not running within the smoke's wait settles a few thousand requests later, which the delete's own reads get through at once.
            const fake = fakeScaleway({ ...o, bootReads: Math.min(o.bootReads ?? 2, 5000) });
            return { fake: fake as FakeApi, p: new Scaleway({ apiKey: 'scw-test', projectId: FAKE_SCALEWAY_PROJECT, fetchImpl: wrap(fake.fetchImpl), sleep: noSleep }) as ComputeSubject };
        },
    };
}

describe.each(Object.keys(makers()))('smoke on %s', (id) => {
    const make = (o?: { bootReads?: number }) => makers()[id as keyof ReturnType<typeof makers>](o);

    it('rents one GPU, sees it run, deletes it, and verifies it gone', async () => {
        const { p, fake } = make();
        const before = fake.liveServers();
        const r = await runSmoke(p, fastSmoke);
        expect(r.error).toBeUndefined();
        expect(r.ok).toBe(true);
        expect(r.leftovers).toEqual([]);
        expect(r.server?.status).toBe('running');
        if (supports(p, 'logs')) expect(r.gpuLine).toMatch(/^GPU 0: /);
        expect(fake.liveServers()).toBe(before);
        if (supports(p, 'sshKeys')) expect((await p.listSSHKeys()).some((k) => k.name.startsWith(SMOKE_PREFIX))).toBe(false);
    });

    it('a server that never comes up is still deleted', async () => {
        const { p, fake } = make({ bootReads: 1e9 });
        const before = fake.liveServers();
        const r = await runSmoke(p, { ...fastSmoke, readyTimeoutMs: 30 });
        expect(r.ok).toBe(false);
        expect(r.error).toMatch(/timed out/);
        expect(r.leftovers).toEqual([]);
        expect(fake.liveServers()).toBe(before);
    });
});

describe('smoke teardown', () => {
    it('a create whose answer was lost still made a machine: found by name and deleted', async () => {
        let lost = false;
        const loseTheAnswer = (f: typeof fetch) => (async (url: any, init?: RequestInit) => {
            const res = await f(url, init);
            if (!lost && init?.method === 'POST' && String(url).endsWith('/v2/pods')) {
                lost = true;
                return new Response('upstream timed out', { status: 504 });
            }
            return res;
        }) as typeof fetch;
        const { p, fake } = makers(loseTheAnswer).runpod();
        const before = fake.liveServers();
        const r = await runSmoke(p, fastSmoke);
        expect(r.ok).toBe(false);
        expect(r.server).toBeUndefined();
        expect(r.leftovers).toEqual([]);
        expect(fake.liveServers()).toBe(before);
    });

    it('moves past an offer that ran out of stock since it was listed', async () => {
        let refused = false;
        const sellOutFirst = (f: typeof fetch) => (async (url: any, init?: RequestInit) => {
            if (!refused && init?.method === 'POST' && String(url).endsWith('/v2/pods')) {
                refused = true;
                return new Response(JSON.stringify({ title: 'Bad Request', status: 400, detail: 'There are no longer any instances available with the requested specifications.' }),
                    { status: 400, headers: { 'content-type': 'application/problem+json' } });
            }
            return f(url, init);
        }) as typeof fetch;
        const { p, fake } = makers(sellOutFirst).runpod();
        const r = await runSmoke(p, fastSmoke);
        expect(r.ok).toBe(true);
        expect(r.offer?.gpu).toBe('RTX 4090');
        expect(fake.liveServers()).toBe(2);
    });
});
