// The guarantees every live run keeps, proven against the fake provider APIs
// before anything real is rented: whatever happens, nothing of the run is left
// (servers, keys and images, each verified gone, keys even while the account's
// list lags), a failed list is never read as empty, and the watchdog deletes
// exactly the run's resources when the launcher dies.

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { DigitalOcean } from '../Providers/DigitalOcean/DigitalOcean';
import { LambdaCloud } from '../Providers/LambdaCloud/LambdaCloud';
import { PROVIDERS } from '../Providers/registry';
import { RunPod } from '../Providers/RunPod/RunPod';
import { fakeDigitalOcean } from './fakes/digitalocean';
import { fakeLambda } from './fakes/lambda';
import { fakeRunPod } from './fakes/runpod';
import { testPublicKey } from './fakes/util';
import {
    deleteRunImages, deleteRunKeys, deleteRunVolumes, endRun, liveOptions, liveRequested, loadCredentials, newRunName, RUN_PREFIX, runMatcher, startWatchdog, sweepLeftovers,
    teardown, trackSSHKeys, trackVolumes, watchdogFiles, watchdogLoop,
} from './live';

const noSleep = async () => {};
const quiet = () => {};
const fast = { log: quiet, sleep: noSleep, intervalMs: 0 };

describe('teardown and sweep', () => {
    it('a run is its name and <name>-...: not another run that shares a prefix', () => {
        const mine = runMatcher(`${RUN_PREFIX}a`);
        expect([`${RUN_PREFIX}a`, `${RUN_PREFIX}a-image`, `${RUN_PREFIX}ab`, `${RUN_PREFIX}b`].map(mine)).toEqual([true, true, false, false]);
        // Where a platform takes no hyphens (Vast's volume names), the run's names have underscores.
        expect([`${RUN_PREFIX}a_vol`.replace(/-/g, '_'), `${RUN_PREFIX}ab_vol`.replace(/-/g, '_'), 'someone_elses_vol'].map(mine)).toEqual([true, false, false]);
    });

    it('never reads a failed list as nothing left', async () => {
        const fake = fakeRunPod();
        const p = new RunPod({ apiKey: 'rp-test', fetchImpl: fake.fetchImpl, sleep: noSleep });
        p.listServers = async () => {
            throw new Error('502 Bad Gateway');
        };
        expect(await teardown(p, `${RUN_PREFIX}x`, { ...fast, rounds: 2 })).toEqual(['(could not list)']);
    });

    it('a sweep deletes test servers, keys and images only', async () => {
        const fake = fakeDigitalOcean();
        const p = new DigitalOcean({ apiKey: 'do-test', fetchImpl: fake.fetchImpl, sleep: noSleep });
        const [offer] = await p.listOffers();
        const old = await p.createServer({ name: `${RUN_PREFIX}old-run`, offer });
        await p.waitUntilRunning(old.id, { intervalMs: 0 });
        await p.createImage(old.id, { name: `${RUN_PREFIX}old-run-image`, intervalMs: 0 });
        await p.addSSHKey(testPublicKey(), `${RUN_PREFIX}old-run`);
        const keep = await p.createServer({ name: 'someones-training-box', offer });
        const theirKey = await p.addSSHKey(testPublicKey(), 'someones-laptop');
        const before = fake.liveServers();
        expect(await sweepLeftovers(p, fast)).toEqual([]);
        expect(fake.liveServers()).toBe(before - 1);
        expect(await p.getServer(keep.id)).not.toBeNull();
        expect((await p.listSSHKeys()).map((k) => k.id)).toEqual([theirKey.id]);
        const images = (await p.listImages()).map((i) => i.name);
        expect(images.filter((n) => n.startsWith(RUN_PREFIX))).toEqual([]);
        // The account's own backup is not a test image.
        expect(images).toContain('api-1 2026-09-01');
    });

    it('an image it cannot delete is reported, not dropped; one whose delete only said so is found still listed', async () => {
        const fake = fakeDigitalOcean();
        const p = new DigitalOcean({ apiKey: 'do-test', fetchImpl: fake.fetchImpl, sleep: noSleep });
        const remove = p.deleteImage.bind(p);
        p.deleteImage = async () => {
            throw new Error('503');
        };
        const [offer] = await p.listOffers();
        const s = await p.createServer({ name: `${RUN_PREFIX}r`, offer });
        await p.waitUntilRunning(s.id, { intervalMs: 0 });
        const image = await p.createImage(s.id, { name: `${RUN_PREFIX}r-image`, intervalMs: 0 });
        expect(await deleteRunImages(p, runMatcher(`${RUN_PREFIX}r`), fast)).toEqual([`image ${RUN_PREFIX}r-image (${image.id})`]);
        // A delete that answers and deletes nothing: the image is still listed, and that is what counts.
        p.deleteImage = async () => undefined;
        expect(await deleteRunImages(p, runMatcher(`${RUN_PREFIX}r`), fast)).toEqual([`image ${RUN_PREFIX}r-image (${image.id})`]);
        p.deleteImage = remove;
        expect(await deleteRunImages(p, runMatcher(`${RUN_PREFIX}r`), fast)).toEqual([]);
        expect((await p.listImages()).map((i) => i.id)).not.toContain(image.id);
    });

    it('a run that is over makes nothing more: a step that outlived it cannot rent after the teardown', async () => {
        const fake = fakeDigitalOcean();
        const p = new DigitalOcean({ apiKey: 'do-test', fetchImpl: fake.fetchImpl, sleep: noSleep });
        const before = fake.liveServers();
        const [offer] = await p.listOffers();
        await p.createServer({ name: `${RUN_PREFIX}loop`, offer });
        endRun(p, `${RUN_PREFIX}loop`);
        expect(await teardown(p, `${RUN_PREFIX}loop`, fast)).toEqual([]);
        // What a step still running would do next: rent again, register a key.
        await expect(p.createServer({ name: `${RUN_PREFIX}loop-2`, offer })).rejects.toThrow(`${RUN_PREFIX}loop is over: createServer is refused`);
        await expect(p.addSSHKey(testPublicKey(), `${RUN_PREFIX}loop`)).rejects.toThrow(/is over: addSSHKey is refused/);
        expect(fake.liveServers()).toBe(before);
        expect(await p.listSSHKeys()).toEqual([]);
    });

    it('one empty list is not proof that nothing is left: a server the list does not show yet is found by the next read, and deleted', async () => {
        const fake = fakeDigitalOcean();
        const p = new DigitalOcean({ apiKey: 'do-test', fetchImpl: fake.fetchImpl, sleep: noSleep });
        const before = fake.liveServers();
        const [offer] = await p.listOffers();
        await p.createServer({ name: `${RUN_PREFIX}late`, offer });
        const list = p.listServers.bind(p);
        let reads = 0;
        // The account's list lags the create: the first read after it shows none of the run's.
        p.listServers = async (o) => (reads++ === 0 ? [] : list(o));
        expect(await teardown(p, `${RUN_PREFIX}late`, fast)).toEqual([]);
        expect(reads).toBeGreaterThan(1);
        expect(fake.liveServers()).toBe(before);
    });
});

describe('a run\'s SSH keys', () => {
    const runName = `${RUN_PREFIX}keys`;
    const run = runMatcher(runName);
    const rounds = { log: quiet, sleep: noSleep, intervalMs: 0 };

    async function account() {
        const fake = fakeDigitalOcean();
        const p = new DigitalOcean({ apiKey: 'do-test', fetchImpl: fake.fetchImpl, sleep: noSleep });
        // Someone else's key on the same account, registered through another client: never the run's to delete.
        const theirs = await new DigitalOcean({ apiKey: 'do-test', fetchImpl: fake.fetchImpl, sleep: noSleep }).addSSHKey(testPublicKey(), 'someones-laptop');
        return { p, theirs, list: p.listSSHKeys.bind(p) };
    }

    it('what the run registers is deleted by id, though the account\'s list does not show it yet', async () => {
        const { p, theirs, list } = await account();
        const ids = trackSSHKeys(p);
        const key = await p.addSSHKey(testPublicKey(), runName);
        expect([...ids]).toEqual([String(key.id)]);
        p.listSSHKeys = async () => (await list()).filter((k) => k.id !== key.id);
        expect(await deleteRunKeys(p, run, { ...rounds, ids })).toEqual([]);
        expect((await list()).map((k) => k.id)).toEqual(expect.arrayContaining([theirs.id]));
        expect((await list()).map((k) => k.id)).not.toContain(key.id);
    });

    it('a list that still shows a deleted key is read again until two reads agree it is gone; one read is not proof', async () => {
        const { p, list } = await account();
        await p.addSSHKey(testPublicKey(), runName);
        const stale = await list();
        let staleReads = 2;
        p.listSSHKeys = async () => (staleReads-- > 0 ? stale : list());
        expect(await deleteRunKeys(p, run, { ...rounds, rounds: 6 })).toEqual([]);
        p.listSSHKeys = list;
        const again = await p.addSSHKey(testPublicKey(), runName);
        const stale2 = await list();
        staleReads = 2;
        p.listSSHKeys = async () => (staleReads-- > 0 ? stale2 : list());
        expect(await deleteRunKeys(p, run, rounds)).toEqual([`SSH key ${runName} (${again.id})`]);
    });

    it('a key whose delete keeps failing is reported, and a list that cannot be read is never "none left"', async () => {
        const { p, list } = await account();
        const key = await p.addSSHKey(testPublicKey(), runName);
        p.deleteSSHKey = async () => {
            throw new Error('503 Service Unavailable');
        };
        expect(await deleteRunKeys(p, run, { ...rounds, rounds: 3 })).toEqual([`SSH key ${runName} (${key.id})`]);
        p.listSSHKeys = async () => {
            throw new Error('502 Bad Gateway');
        };
        expect(await deleteRunKeys(p, run, { ...rounds, rounds: 2 })).toEqual(['(could not list SSH keys)']);
        expect((await list()).map((k) => k.id)).toContain(key.id);
    });
});

describe('a run\'s volumes', () => {
    const runName = `${RUN_PREFIX}vols`;
    const run = runMatcher(runName);
    const rounds = { log: quiet, sleep: noSleep, intervalMs: 0 };

    async function account() {
        const fake = fakeDigitalOcean();
        const p = new DigitalOcean({ apiKey: 'do-test', fetchImpl: fake.fetchImpl, sleep: noSleep });
        // Someone else's volume on the same account, made through another client: never the run's to delete.
        const theirs = await new DigitalOcean({ apiKey: 'do-test', fetchImpl: fake.fetchImpl, sleep: noSleep }).createVolume({ name: 'someones-dataset', region: 'nyc1', sizeGb: 10 });
        return { p, theirs, list: p.listVolumes.bind(p) };
    }

    it('what the run creates is deleted by id, though the account\'s list does not show it yet; another\'s volume is kept', async () => {
        const { p, theirs, list } = await account();
        const ids = trackVolumes(p);
        const vol = await p.createVolume({ name: runName, region: 'nyc1', sizeGb: 10 });
        expect([...ids]).toEqual([String(vol.id)]);
        p.listVolumes = async () => (await list()).filter((v) => v.id !== vol.id);
        expect(await deleteRunVolumes(p, run, { ...rounds, ids })).toEqual([]);
        expect((await list()).map((v) => v.id)).toEqual([theirs.id]);
    });

    it('a volume a server still holds is refused, reported, and deleted on a later read once it is free', async () => {
        const { p, list } = await account();
        const vol = await p.createVolume({ name: runName, region: 'nyc1', sizeGb: 10 });
        const remove = p.deleteVolume.bind(p);
        let held = 2;
        p.deleteVolume = async (id: string) => {
            if (held-- > 0) throw new Error('422 volume is attached to a droplet');
            return remove(id);
        };
        expect(await deleteRunVolumes(p, run, rounds)).toEqual([`volume ${runName} (${vol.id})`]);
        expect(await deleteRunVolumes(p, run, { ...rounds, rounds: 4 })).toEqual([]);
        expect((await list()).map((v) => v.id)).not.toContain(vol.id);
        p.listVolumes = async () => {
            throw new Error('502 Bad Gateway');
        };
        expect(await deleteRunVolumes(p, run, { ...rounds, rounds: 2 })).toEqual(['(could not list volumes)']);
    });

    it('a sweep deletes test volumes, after the servers that could hold them, and keeps everyone else\'s', async () => {
        const { p, theirs, list } = await account();
        await p.createVolume({ name: `${RUN_PREFIX}old-run-data`, region: 'nyc1', sizeGb: 10 });
        expect(await sweepLeftovers(p, fast)).toEqual([]);
        expect((await list()).map((v) => v.id)).toEqual([theirs.id]);
    });
});

describe('watchdog', () => {
    const dir = mkdtempSync(join(tmpdir(), 'asap-vps-wd-'));
    afterAll(() => rmSync(dir, { recursive: true, force: true }));

    async function setup(runName: string) {
        const fake = fakeLambda();
        const p = new LambdaCloud({ apiKey: 'lambda-test', fetchImpl: fake.fetchImpl, sleep: noSleep });
        const [key] = await p.listSSHKeys();
        const mine = await p.createServer({ name: runName, offer: 'gpu_1x_a10', region: 'us-east-1', sshKeyIds: [key.id] });
        const mine2 = await p.createServer({ name: `${runName}-2`, offer: 'gpu_1x_a10', region: 'us-east-1', sshKeyIds: [key.id] });
        const other = await p.createServer({ name: `${RUN_PREFIX}another-run`, offer: 'gpu_1x_a10', region: 'us-east-1', sshKeyIds: [key.id] });
        await p.addSSHKey(testPublicKey(), runName);
        return { p, fake, mine, mine2, other };
    }

    it('launcher gone: deletes exactly its run\'s servers and keys, then keeps checking', async () => {
        const runName = `${RUN_PREFIX}wd-1`;
        const { p, mine, mine2, other } = await setup(runName);
        const res = await watchdogLoop({ provider: p, runName, parentPid: 1, deadline: Date.now() + 3_600_000, doneFile: join(dir, 'none.done'),
            log: quiet, alive: () => false, sleep: noSleep, pollMs: 0, roundMs: 0 });
        expect(res).toBe('swept');
        expect(await p.getServer(mine.id)).toBeNull();
        expect(await p.getServer(mine2.id)).toBeNull();
        expect(['pending', 'running']).toContain((await p.getServer(other.id))?.status);
        expect((await p.listSSHKeys()).some((k) => k.name === runName)).toBe(false);
    });

    it('deadline passed: deletes the run even while the launcher lives', async () => {
        const runName = `${RUN_PREFIX}wd-2`;
        const { p, mine } = await setup(runName);
        let t = 0;
        const res = await watchdogLoop({ provider: p, runName, parentPid: process.pid, deadline: 5, doneFile: join(dir, 'none.done'),
            log: quiet, alive: () => true, now: () => t++, sleep: noSleep, pollMs: 0, roundMs: 0 });
        expect(res).toBe('swept');
        expect(await p.getServer(mine.id)).toBeNull();
    });

    it('deletes the run\'s volumes too; one it cannot delete is "unverified", never "swept"', async () => {
        const runName = `${RUN_PREFIX}wd-5`;
        const { p } = await setup(runName);
        const vol = await p.createVolume({ name: `${runName}-data`, region: 'us-east-1' });
        const args = { provider: p, runName, parentPid: 1, deadline: Date.now() + 3_600_000, doneFile: join(dir, 'none.done'),
            log: quiet, alive: () => false, sleep: noSleep, pollMs: 0, roundMs: 0 };
        const remove = p.deleteVolume.bind(p);
        p.deleteVolume = async () => {
            throw new Error('503 Service Unavailable');
        };
        expect(await watchdogLoop(args)).toBe('unverified');
        p.deleteVolume = remove;
        expect(await watchdogLoop(args)).toBe('swept');
        expect((await p.listVolumes()).map((v) => v.id)).not.toContain(vol.id);
    });

    it('a key it cannot delete is "unverified", never "swept"', async () => {
        const runName = `${RUN_PREFIX}wd-4`;
        const { p } = await setup(runName);
        p.deleteSSHKey = async () => {
            throw new Error('503 Service Unavailable');
        };
        const res = await watchdogLoop({ provider: p, runName, parentPid: 1, deadline: Date.now() + 3_600_000, doneFile: join(dir, 'none.done'),
            log: quiet, alive: () => false, sleep: noSleep, pollMs: 0, roundMs: 0 });
        expect(res).toBe('unverified');
    });

    it('a run that verified its own teardown leaves the watchdog nothing to do', async () => {
        const runName = `${RUN_PREFIX}wd-3`;
        const { p, mine } = await setup(runName);
        writeFileSync(join(dir, 'wd-3.done'), 'done\n');
        const res = await watchdogLoop({ provider: p, runName, parentPid: 1, deadline: 0, doneFile: join(dir, 'wd-3.done'), log: quiet, sleep: noSleep });
        expect(res).toBe('done');
        expect(await p.getServer(mine.id)).not.toBeNull();
    });

    it('starts as a detached process and says when it is armed; one that cannot start refuses the run', async () => {
        // A run already marked done: the real watchdog arms, sees it, and exits without calling any API.
        const runName = newRunName();
        const files = watchdogFiles(runName);
        const broken = watchdogFiles(`${runName}-broken`);
        const key = process.env.RUNPOD_API_KEY;
        process.env.RUNPOD_API_KEY = 'asap-vps-dummy-key';
        try {
            // Where the watchdog keeps its files: startWatchdog makes it, but this run is marked done before it starts.
            mkdirSync(dirname(files.doneFile), { recursive: true });
            writeFileSync(files.doneFile, 'done\n');
            await expect(startWatchdog('runpod', runName, Date.now() + 60_000)).resolves.toEqual(files);
            for (let i = 0; i < 80 && !readFileSync(files.logFile, 'utf8').includes('finished'); i++) await new Promise((r) => setTimeout(r, 250));
            expect(readFileSync(files.logFile, 'utf8')).toMatch(/armed for .* on runpod[\s\S]*the run finished/);
            await expect(startWatchdog('nosuchprovider', `${runName}-broken`, Date.now() + 60_000)).rejects.toThrow(/did not start: .*unknown provider "nosuchprovider"/);
        } finally {
            if (key === undefined) delete process.env.RUNPOD_API_KEY;
            else process.env.RUNPOD_API_KEY = key;
            for (const f of [...Object.values(files), ...Object.values(broken)]) rmSync(f, { force: true });
        }
    }, 60_000);
});

describe('live selection and credentials', () => {
    const saved = { ...process.env };
    afterEach(() => {
        for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
        Object.assign(process.env, saved);
    });

    it('a live suite runs only when ASAP_VPS_LIVE names it (or all); a misspelled name is an error, not a skip', () => {
        delete process.env.ASAP_VPS_LIVE;
        expect(liveRequested('runpod')).toBe(false);
        process.env.ASAP_VPS_LIVE = 'vast, RunPod';
        expect([liveRequested('runpod'), liveRequested('vast'), liveRequested('lambda')]).toEqual([true, true, false]);
        process.env.ASAP_VPS_LIVE = 'all';
        expect(liveRequested('digitalocean-vps')).toBe(true);
        process.env.ASAP_VPS_LIVE = 'runpd';
        expect(() => liveRequested('runpod')).toThrow(/names "runpd"/);
    });

    it('options: free only, a price cap, and DigitalOcean images on unless turned off', () => {
        for (const k of ['ASAP_VPS_LIVE_FREE', 'ASAP_VPS_LIVE_MAX_PRICE', 'ASAP_VPS_LIVE_IMAGES']) delete process.env[k];
        expect(liveOptions()).toEqual({ freeOnly: false, maxPricePerHour: 1, images: true });
        Object.assign(process.env, { ASAP_VPS_LIVE_FREE: '1', ASAP_VPS_LIVE_MAX_PRICE: '2.5', ASAP_VPS_LIVE_IMAGES: '0' });
        expect(liveOptions()).toEqual({ freeOnly: true, maxPricePerHour: 2.5, images: false });
        process.env.ASAP_VPS_LIVE_MAX_PRICE = 'cheap';
        expect(() => liveOptions()).toThrow(/MAX_PRICE/);
    });

    it('reads keys without overriding the environment: .env.test before the credentials file; an empty value is no key', () => {
        const dir = mkdtempSync(join(tmpdir(), 'asap-vps-cred-'));
        try {
            const envTest = join(dir, '.env.test');
            const credentials = join(dir, 'credentials.env');
            writeFileSync(envTest, 'ASAP_VPS_TEST_A=from-env-test\nASAP_VPS_TEST_E=\n', { mode: 0o600 });
            writeFileSync(credentials, 'ASAP_VPS_TEST_A=from-credentials\nexport ASAP_VPS_TEST_B="quoted"\nASAP_VPS_TEST_C=\nASAP_VPS_TEST_D=from-credentials\nASAP_VPS_TEST_E=filled\n', { mode: 0o600 });
            process.env.ASAP_VPS_TEST_D = 'from-env';
            loadCredentials([envTest, credentials]);
            expect(['A', 'B', 'C', 'D', 'E'].map((x) => process.env[`ASAP_VPS_TEST_${x}`]))
                .toEqual(['from-env-test', 'quoted', undefined, 'from-env', 'filled']);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
        expect(existsSync(dir)).toBe(false);
    });

    it('.env.template copied as it is sets no key: every provider is skipped, and the credentials file\'s keys are the ones used', () => {
        const names = Object.values(PROVIDERS).flatMap((i) => [i.keyEnv, ...Object.values(('paramsEnv' in i ? i.paramsEnv : undefined) ?? {})]);
        const saved = Object.fromEntries(names.map((n) => [n, process.env[n]]));
        const dir = mkdtempSync(join(tmpdir(), 'asap-vps-template-'));
        try {
            const envTest = join(dir, '.env.test');
            copyFileSync(join(__dirname, '..', '..', '.env.template'), envTest);
            // The template names every setting a provider reads.
            const template = readFileSync(envTest, 'utf8');
            for (const n of names) expect([n, new RegExp(`^${n}=$`, 'm').test(template)]).toEqual([n, true]);
            for (const n of names) delete process.env[n];
            loadCredentials([envTest]);
            expect(names.filter((n) => process.env[n] !== undefined)).toEqual([]);
            const credentials = join(dir, 'credentials.env');
            writeFileSync(credentials, names.map((n) => `${n}=real-${n}\n`).join(''), { mode: 0o600 });
            loadCredentials([envTest, credentials]);
            expect(names.map((n) => process.env[n])).toEqual(names.map((n) => `real-${n}`));
        } finally {
            rmSync(dir, { recursive: true, force: true });
            for (const [n, v] of Object.entries(saved)) {
                if (v === undefined) delete process.env[n];
                else process.env[n] = v;
            }
        }
    });
});
