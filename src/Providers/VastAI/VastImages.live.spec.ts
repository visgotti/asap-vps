// Vast's images against the live API: Vast keeps none, so an image is a
// snapshot an instance pushes to a registry of yours (VastAIParams.snapshots).
// Here the registry is a private namespace made for the run in the Scaleway
// account, with an IAM key that can push (src/testing/privateRegistry.ts). An
// instance of the cheapest offer that runs the test image writes a file and is
// snapshotted (createImage: Vast pushes it under a tag of its own, which names
// the instance; it is then named too); the image is read and listed; a second
// instance boots it on another machine, pulled with the snapshot login, and
// its log shows the file the first wrote; the image is deleted (through
// Scaleway's registry API: its Registry API deletes nothing), verified. Runs for
// some minutes on the cheapest GPUs (cents). Runs only when asked, with the
// Vast key and Scaleway's secret key and Project in .env.test (or
// ~/.config/asap-vps/credentials.env):
//   ASAP_VPS_LIVE=vast npx jest --config jest.live.config.js VastImages.live
// What the run creates is named after it and deleted at the end (the registry:
// key, policy, application, namespace, each verified gone); the watchdog
// (src/testing/live.ts) deletes its instances if the run dies.

import { writeFileSync } from 'fs';
import { AuthError, CapacityError, ProviderError } from '../../errors';
import { liveOptions, liveRequested, loadCredentials, newRunName, runMatcher, startWatchdog, sweepLeftovers, teardown, TEST_IMAGE, TEST_IMAGE_CUDA } from '../../testing/live';
import { makePrivateRegistry, PrivateRegistry, sweepPrivateRegistries } from '../../testing/privateRegistry';
import type { CreateServerOptions, Server, ServerImage } from '../../types';
import type { VastImage, VastInstance, VastTypes } from './types';
import { VastAI } from './VastAI';

const requested = liveRequested('vast');
const { freeOnly, maxPricePerHour } = liveOptions();
const paid = freeOnly ? it.skip : it;
const WAIT = { intervalMs: 10_000, timeoutMs: 15 * 60_000 };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

(requested && !freeOnly ? describe : describe.skip)(`Vast images: a snapshot of an instance in a registry of yours, booted on another machine, against the live API${
    requested ? '' : ' (set ASAP_VPS_LIVE=vast to run it: it rents real GPU machines and makes a registry in the Scaleway account)'}`, () => {
    const runName = newRunName();
    const run = runMatcher(runName);
    const MARK = `asap-vps-snapshot=${runName}`;
    let p: VastAI;
    let registry: PrivateRegistry | undefined;
    let watchdog: { doneFile: string } | undefined;
    let refused = false;
    let image: ServerImage<VastImage> | undefined;
    let first: Server<VastInstance> | undefined;
    const scw = () => ({ secretKey: process.env.SCW_SECRET_KEY!.trim(), projectId: process.env.SCW_DEFAULT_PROJECT_ID!.trim() });
    const need = <T>(x: T | undefined, what: string): T => {
        if (x === undefined) throw new Error(`no ${what} (an earlier step failed)`);
        return x;
    };
    /** The cheapest offers that run the test image, tried in turn (but `skip`'s machine): a taken offer or a dead host moves on to the next. */
    const rentRunning = async (o: Omit<CreateServerOptions<VastTypes>, 'offer'>, skipMachine?: number): Promise<Server<VastInstance>> => {
        const offers = (await p.listOffers({ maxPricePerHour, minCudaVersion: TEST_IMAGE_CUDA })).filter((x) => x.raw.machine_id !== skipMachine).slice(0, 8);
        if (!offers.length) throw new Error(`no GPU at or under $${maxPricePerHour}/h runs CUDA ${TEST_IMAGE_CUDA} right now`);
        for (const offer of offers) {
            let made: Server<VastInstance> | undefined;
            try {
                made = await p.createServer({ ...o, offer });
                return await p.waitUntilRunning(made.id, WAIT);
            } catch (e) {
                if (!(e instanceof CapacityError) && !(made && e instanceof ProviderError)) throw e;
                if (made) expect(await p.deleteServerAndWait(made.id, WAIT)).toBe(true);
            }
        }
        throw new Error('no offer could be rented and started');
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
        if (!process.env.SCW_SECRET_KEY?.trim() || !process.env.SCW_DEFAULT_PROJECT_ID?.trim()) throw new Error('the snapshot registry is made in the Scaleway account: SCW_SECRET_KEY and SCW_DEFAULT_PROJECT_ID must be set');
        try {
            await new VastAI(apiKey).listServers();
        } catch (e) {
            if (!(e instanceof AuthError)) throw e;
            refused = true;
            throw new Error(`VAST_API_KEY is refused by Vast, so nothing was tried: ${e.message}`);
        }
        expect(await sweepPrivateRegistries(scw())).toEqual([]);
        registry = await makePrivateRegistry({ runName, ...scw(), access: 'push' });
        // The IAM key that can push is the snapshot login: never the account's own key.
        p = new VastAI({ apiKey, snapshots: { server: registry.pullAuth.server!, repository: `${runName}/snapshots`, username: registry.pullAuth.username, password: registry.pullAuth.password } });
        expect(await sweepLeftovers(p)).toEqual([]);
        watchdog = await startWatchdog('vast', runName, Date.now() + 60 * 60_000);
    }, 10 * 60_000);

    afterAll(async () => {
        if (refused) return;
        const servers = p ? await teardown(p, run) : [];
        const left = registry ? await registry.cleanup() : [];
        if (watchdog && !servers.length && !left.length) writeFileSync(watchdog.doneFile, 'done\n');
        expect({ servers, registry: left }).toEqual({ servers: [], registry: [] });
    }, 15 * 60_000);

    paid('createImage: an instance\'s snapshot, pushed by Vast under a tag naming the instance, named; read and listed once', async () => {
        first = await rentRunning({ name: `${runName}-a`, image: TEST_IMAGE, minCudaVersion: TEST_IMAGE_CUDA, command: ['bash', '-c', `echo "${MARK}" > /root/mark && echo wrote; sleep 3600`] });
        console.log(`vast images: instance ${first.id} (${first.gpu}) on machine ${first.raw.machine_id}`);
        expect(await logShows(first.id, 'wrote')).toContain('wrote');
        image = await p.createImage(first.id, { name: 'snap-v1', intervalMs: 15_000, timeoutMs: 45 * 60_000 });
        expect(image).toMatchObject({ provider: 'vast', id: `${registry!.pullAuth.server}/${runName}/snapshots:snap-v1`, name: 'snap-v1', status: 'available', regions: [] });
        expect(image.raw.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
        expect(image.sizeGb).toBeGreaterThan(0);
        expect(await p.getImage(image.id)).toMatchObject({ id: image.id, raw: { digest: image.raw.digest } });
        // Listed once: under its name, not also under Vast's own tag for it.
        expect((await p.listImages()).map((i) => i.name)).toEqual(['snap-v1']);
    }, 60 * 60_000);

    paid('a second instance boots it on another machine, pulled with the snapshot login: the file the first wrote is there', async () => {
        const img = need(image, 'image');
        const source = need(first, 'first instance');
        expect(await p.deleteServerAndWait(source.id, WAIT)).toBe(true);
        const second = await rentRunning({ name: `${runName}-b`, image: img.id, command: ['bash', '-c', 'echo "read=$(cat /root/mark)"; sleep 3600'] }, source.raw.machine_id ?? undefined);
        expect(second.raw.machine_id).not.toBe(source.raw.machine_id);
        expect(await logShows(second.id, `read=${MARK}`)).toContain(`read=${MARK}`);
        expect(await p.deleteServerAndWait(second.id, WAIT)).toBe(true);
    }, 45 * 60_000);

    paid('deleteImage: every tag of it gone from the registry (through Scaleway\'s API); deleting it again is no error', async () => {
        const img = need(image, 'image');
        await p.deleteImage(img.id);
        expect(await p.getImage(img.id)).toBeNull();
        expect(await p.listImages()).toEqual([]);
        await expect(p.deleteImage(img.id)).resolves.toBeUndefined();
    }, 10 * 60_000);
});
