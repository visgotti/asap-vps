// Every method of every capability a provider declares, end to end, in the
// order a user calls them. First what costs nothing: the key, the offers, SSH
// keys, ids nothing has, and what `capabilities` promises. Then one rented
// server taken through create, read and list, its logs (a container) or its
// shell (a VM: the GPU, cloud-init user data, sudo), restart, stop and start,
// images, and a verified delete. The same suite runs against each provider's
// fake (src/Providers/lifecycle.spec.ts) and, when asked, against the
// real API with the keys in .env.test (src/Providers/<Platform>/*.live.spec.ts).

import { writeFileSync } from 'fs';
import { CAPABILITY_METHODS, CapabilityName, requireCapability, supports } from '../capabilities';
import { asRoot, ProvisionTarget, ServerProvisioner } from '../Core/ServerProvisioner';
import { SSHService } from '../Core/SSHService';
import { RunCommandStep } from '../Core/steps';
import { canonicalGpu, compareCudaVersions, sshKeyFingerprint } from '../Core/utils';
import { AuthError, CapacityError, NotSupportedError, ProviderError, QuotaError } from '../errors';
import { DigitalOceanApi } from '../Providers/DigitalOcean/api';
import { providerInfo } from '../Providers/registry';
import type {
    CostEstimate, CreateServerOptions, ImageStatus, InitializedSSHKeyData, Offer, OfferQuery, Server, ServerStatus, SetupStepResult, SSHKeyData, SSHRetryOptions,
    WaitOptions,
} from '../types';
import { testPublicKey } from './fakes/util';
import {
    ComputeSubject, deleteRunImages, deleteRunKeys, liveOptions, liveRequested, loadCredentials, newRunName, providerFromEnv, runMatcher, startWatchdog, sweepLeftovers,
    teardown, TEST_IMAGE, TEST_IMAGE_CUDA, trackSSHKeys, trackVolumes, deleteRunVolumes,
} from './live';

export type LifecycleTarget = {
    /** The provider id (PROVIDERS). */
    id: string,
    /** 'fake' runs in milliseconds against the fake API; 'live' rents real hardware. */
    mode: 'fake' | 'live',
    /** Why the suite is skipped (not asked for); undefined when it runs. */
    skip?: string,
    /** The environment variable the live key is read from (named when the provider refuses it). */
    keyEnv?: string,
    /** A fresh provider; `apiKey` replaces the key (the wrong-key check). */
    make(apiKey?: string): ComputeSubject,
    /** Ids nothing has, for getServer and getImage. */
    unknownServerId: string,
    unknownImageId: string,
    /** What to rent: the cheapest offers matching it are tried in turn. */
    query: OfferQuery,
    /**
     * `query` asks for CPU offers (`kind: 'cpu'`): the lifecycle rents the cheapest
     * x86 Instance and takes it through every step but the GPU's own checks. For a
     * provider whose API is the same for both (Scaleway), it runs the whole
     * lifecycle live for cents instead of a GPU's price.
     */
    cpu?: boolean,
    /** Only what costs nothing: no server, no image. */
    freeOnly: boolean,
    /** Run the image phase where the provider has images. */
    images: boolean,
    /** RunPod resumes a stopped pod on its old host, whose GPU may be rented out meanwhile: startServer then throws CapacityError. */
    startMayLackGpu: boolean,
    /** Vast reports only the rental's start: after a stop and start, billing is not checked to start again. */
    billingFromRentalStart: boolean,
    /**
     * A marketplace (Vast): a rented host can be broken (it cannot start the
     * container). The create test then deletes it and tries the next offer, a
     * different host; elsewhere a server that does not come up fails the test.
     */
    hostsMayFail: boolean,
    /** Where to copy a region-bound image to, other than `from` (where the provider has imageCopy). */
    copyRegion(from: string): string,
    wait: WaitOptions,
    imageWait: WaitOptions,
    sshRetry: SSHRetryOptions,
    sleep(ms: number): Promise<unknown>,
    timeouts: { free: number, server: number, images: number },
    /** Live: what is checked before anything is created, and how long the watchdog lets the run take. */
    live?: { deadlineMs: number, preflight?(p: ComputeSubject): Promise<void> },
    log(m: string): void,
};

/** What a VM's cloud-init writes, and where: the shell reads it back, and an image of the disk carries it. */
export const USER_DATA_FILE = '/var/tmp/asap-vps-user-data';
const USER_DATA_MARK = 'asap-vps-user-data-ok';
const USER_DATA = `#!/bin/bash\necho ${USER_DATA_MARK} > ${USER_DATA_FILE}\n`;
const BOOT_ID = 'cat /proc/sys/kernel/random/boot_id';
/** How far a provider's clock may be from ours, when its billing dates are checked against our own. */
const SKEW_MS = 60_000;
/** How long an account's list may lag its writes (DigitalOcean's SSH keys: seconds), before a key is expected listed, or gone. */
const LIST_LAG_MS = 60_000;
/** Starts tried, and the wait between them, when a stopped server's host has no GPU free (CapacityError): a start is never assumed. */
const START_TRIES = 6;
const START_RETRY_MS = 30_000;

const STATUSES: ServerStatus[] = ['pending', 'running', 'stopping', 'stopped', 'terminating', 'terminated', 'error', 'unknown'];
const IMAGE_STATUSES: ImageStatus[] = ['pending', 'available', 'error', 'unknown'];

/**
 * What a container is started with: it prints its GPU (on a host with one), an
 * environment variable, and a boot mark (a fresh UUID each time it runs, so a
 * restart shows a new one), then idles.
 */
function containerOptions(runName: string, cpu: boolean): Partial<CreateServerOptions> {
    return {
        image: TEST_IMAGE,
        command: ['bash', '-c', `${cpu ? '' : 'nvidia-smi -L; '}echo "asap-vps-env=$ASAP_VPS_CHECK"; BOOT=$(cat /proc/sys/kernel/random/uuid); echo "asap-vps-boot=$BOOT"; sleep 3600`],
        env: { ASAP_VPS_CHECK: runName },
        // A host without GPUs has no GPU driver, so no CUDA version to ask of it.
        ...(cpu ? {} : { minCudaVersion: TEST_IMAGE_CUDA }),
    };
}

/** What that container's log shows: the GPU it got (if it rented one), the environment it was given, and the boot mark of a run. */
function containerLog(runName: string, cpu: boolean): RegExp[] {
    return [...(cpu ? [] : [/^GPU \d+: /m]), new RegExp(`^asap-vps-env=${runName}$`, 'm'), /^asap-vps-boot=[0-9a-f-]{36}$/m];
}

/** The boot marks a container's log shows: one per run of its command. */
function bootsIn(logs: string): Set<string> {
    return new Set([...logs.matchAll(/^asap-vps-boot=([0-9a-f-]{36})$/gm)].map((m) => m[1]));
}

/** Per provider: ids nothing has, and what is particular to its lifecycle. */
const PROFILES: Record<string, {
    unknownServerId: string, unknownImageId: string, startMayLackGpu?: boolean, deadlineMs: number,
    /** Where a provider that copies images (imageCopy) is asked to copy one when no other region has an offer in stock: its own regions. */
    copyRegions?: string[],
    /** billingStartedAt is the rental's start, which a stop and start does not move (Vast). */
    billingFromRentalStart?: boolean,
    /** A marketplace whose rented hosts can be broken (Vast): see LifecycleTarget.hostsMayFail. */
    hostsMayFail?: boolean,
}> = {
    digitalocean: { unknownServerId: '1', unknownImageId: '1', deadlineMs: 3 * 3_600_000, copyRegions: ['nyc3', 'sfo3', 'ams3'] },
    runpod: { unknownServerId: 'zzzzzzzzzzzzzz', unknownImageId: 'none', startMayLackGpu: true, deadlineMs: 90 * 60_000 },
    vast: { unknownServerId: '1', unknownImageId: 'none', startMayLackGpu: true, billingFromRentalStart: true, hostsMayFail: true, deadlineMs: 90 * 60_000 },
    lambda: { unknownServerId: 'f'.repeat(32), unknownImageId: 'none', deadlineMs: 90 * 60_000 },
    // poweroff releases the GPU, so powering on again needs stock; an image is copied to another zone through Object Storage.
    scaleway: {
        unknownServerId: '00000000-0000-4000-8000-ffffffffffff', unknownImageId: '00000000-0000-4000-8000-fffffffffffe', startMayLackGpu: true, deadlineMs: 90 * 60_000,
        copyRegions: ['fr-par-1', 'nl-ams-1', 'pl-waw-2'],
    },
};

function profile(id: string) {
    const p = PROFILES[id];
    if (!p) throw new Error(`no lifecycle profile for "${id}" (add one in src/testing/lifecycle.ts)`);
    return p;
}

/** A region of the provider's own to copy an image to, other than where it is: never another provider's. */
const copyRegionOf = (id: string, prof: { copyRegions?: string[] }) => (from: string): string => {
    const to = prof.copyRegions?.find((r) => r !== from);
    if (!to) throw new Error(`no region to copy an image of ${id} to from ${from} (set copyRegions in its lifecycle profile)`);
    return to;
};

/** A provider's fake: every step in milliseconds, nothing rented. The shell (VMs) is the caller's mock of SSHService.connect. */
export function fakeLifecycle(id: string, make: (apiKey?: string) => ComputeSubject, o: { cpu?: boolean } = {}): LifecycleTarget {
    const fast = { intervalMs: 0, timeoutMs: 5000 };
    const prof = profile(id);
    return {
        id,
        mode: 'fake',
        make,
        unknownServerId: prof.unknownServerId,
        unknownImageId: prof.unknownImageId,
        startMayLackGpu: !!prof.startMayLackGpu,
        billingFromRentalStart: !!prof.billingFromRentalStart,
        hostsMayFail: !!prof.hostsMayFail,
        query: o.cpu ? { kind: 'cpu', maxPricePerHour: 100 } : { vendor: 'nvidia', gpuCount: 1, maxPricePerHour: 100 },
        ...(o.cpu ? { cpu: true } : {}),
        freeOnly: false,
        images: true,
        copyRegion: copyRegionOf(id, prof),
        wait: fast,
        imageWait: fast,
        sshRetry: { maxRetries: 1, retryTimeout: 0 },
        sleep: async () => {},
        timeouts: { free: 30_000, server: 30_000, images: 30_000 },
        log: () => {},
    };
}

/**
 * A provider's real API, with its key from the environment (.env.test or
 * ~/.config/asap-vps/credentials.env). Skipped unless ASAP_VPS_LIVE names it.
 */
export function liveLifecycle(id: string, opts: { cpu?: boolean } = {}): LifecycleTarget {
    const info = providerInfo(id);
    const prof = profile(id);
    const requested = liveRequested(opts.cpu ? `${id}-cpu` : id);
    const o = liveOptions();
    if (requested) {
        loadCredentials();
        if (!process.env[info.keyEnv]?.trim()) throw new Error(`ASAP_VPS_LIVE asks for ${id}, but ${info.keyEnv} is not set (.env.test or ~/.config/asap-vps/credentials.env)`);
    }
    const container = info.capabilities.compute?.kind === 'container';
    return {
        id,
        mode: 'live',
        keyEnv: info.keyEnv,
        ...(requested ? {} : { skip: `set ASAP_VPS_LIVE=${opts.cpu ? `${id}-cpu` : id} to run it: it rents a real ${opts.cpu ? 'CPU server' : 'GPU'}` }),
        make: (apiKey) => (apiKey ? info.create(apiKey) : providerFromEnv(id)),
        unknownServerId: prof.unknownServerId,
        unknownImageId: prof.unknownImageId,
        startMayLackGpu: !!prof.startMayLackGpu,
        billingFromRentalStart: !!prof.billingFromRentalStart,
        hostsMayFail: !!prof.hostsMayFail,
        query: opts.cpu
            ? { kind: 'cpu', maxPricePerHour: o.maxPricePerHour }
            : { vendor: 'nvidia', gpuCount: 1, maxPricePerHour: o.maxPricePerHour, ...(container ? { minCudaVersion: TEST_IMAGE_CUDA } : {}) },
        ...(opts.cpu ? { cpu: true } : {}),
        freeOnly: o.freeOnly,
        images: o.images,
        copyRegion: copyRegionOf(id, prof),
        wait: { intervalMs: 10_000, timeoutMs: 20 * 60_000 },
        imageWait: { intervalMs: 15_000, timeoutMs: 60 * 60_000 },
        sshRetry: { maxRetries: 30, retryTimeout: 10_000 },
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
        timeouts: { free: 5 * 60_000, server: 45 * 60_000, images: 150 * 60_000 },
        live: { deadlineMs: prof.deadlineMs, ...(id === 'digitalocean' ? { preflight: roomForADroplet } : {}) },
        log: (m) => console.log(m),
    };
}

/** DigitalOcean counts GPU droplets against the account's droplet limit: refuse the run before creating anything when there is no room. */
async function roomForADroplet(p: ComputeSubject): Promise<void> {
    const api = (p as { api?: unknown }).api;
    if (!(api instanceof DigitalOceanApi)) return;
    const { limit, used } = await api.dropletUsage();
    if (used >= limit) throw new QuotaError(p.id, `the account has ${used} of ${limit} droplets: no room for the test droplet`);
}

type State = {
    offer?: Offer,
    server?: Server,
    /** VM: the key pair its shell takes. */
    keys?: SSHKeyData,
    setup?: SetupStepResult[],
    bootId?: string,
    /** Epoch ms before the server was asked for: no run it bills starts earlier. */
    rentedAt?: number,
    /** Container: the boot marks its log has shown, one per run of its command. */
    boots?: Set<string>,
};

function need<T>(v: T | undefined, what: string): T {
    if (v === undefined) throw new Error(`${what} (an earlier step failed)`);
    return v;
}

export function describeGpuLifecycle(t: LifecycleTarget): void {
    const title = `${t.id}${t.cpu ? ' (a CPU server)' : ''}: every method, against the ${t.mode} API`;
    if (t.skip) {
        describe.skip(`${title} (${t.skip})`, () => {
            it('is not asked for', () => undefined);
        });
        return;
    }
    // Capabilities are fixed per class: they decide which tests exist.
    const caps = t.make().capabilities;
    const vm = caps.compute?.kind === 'vm';
    const paid = t.freeOnly ? it.skip : it;

    describe(title, () => {
        const runName = newRunName();
        const run = runMatcher(runName);
        const s: State = {};
        let p: ComputeSubject;
        /** The run's provider, once beforeAll made it. */
        const provider = () => p;
        let watchdog: { doneFile: string } | undefined;

        /** One command on the server, as root, through the key it was created with. */
        const shell = async (server: Server, command: string, retry = t.sshRetry): Promise<string> => {
            const endpoint = need(server.ssh, `server ${server.id} reports no ssh endpoint`);
            const keys = need(s.keys, 'no key pair');
            const ssh = await SSHService.connect({ ...endpoint, privateKey: keys.privateKey, retry });
            try {
                const r = await asRoot(ssh, endpoint.username).execCommand(command);
                if (r.code !== 0) throw new Error(`${command}: exit ${r.code}: ${r.stderr}`);
                return r.stdout.trim();
            } finally {
                ssh.dispose();
            }
        };

        /** A VM booted again: its boot id changes (its status alone may read running before the reboot begins). */
        const newBoot = async (server: Server): Promise<string> => {
            const before = need(s.bootId, 'no boot id');
            const end = Date.now() + (t.wait.timeoutMs ?? 0);
            for (;;) {
                const now = await shell(server, BOOT_ID, { maxRetries: 1, retryTimeout: 0 }).catch(() => '');
                if (now && now !== before) return now;
                if (Date.now() >= end) throw new Error(`server ${server.id} did not boot again within ${t.wait.timeoutMs} ms`);
                await t.sleep(t.wait.intervalMs ?? 10_000);
            }
        };

        /** The run getServerCost says the server bills now: begun no earlier than `after`, not in the future, at a rate. */
        const billedRun = async (id: string, after: number): Promise<CostEstimate> => {
            const cost = await p.getServerCost(id);
            if (!cost) throw new Error(`getServerCost(${id}) is null while it runs: ${t.id} reports no rate or no start for it`);
            // A fake stamps by our clock, after the request it answers; a provider by its own, which may differ (or count whole seconds).
            expect(cost.from).toBeGreaterThanOrEqual(after - (t.mode === 'live' ? SKEW_MS : 0));
            expect(cost.from).toBeLessThanOrEqual(Date.now() + SKEW_MS);
            expect(cost.pricePerHour).toBeGreaterThan(0);
            return cost;
        };

        /** Stopped, a server bills only its disk: no run bills at its rate. Where a stopped server bills in full, its run goes on. */
        const expectStoppedBilling = async (id: string, run: CostEstimate) => {
            const cost = await p.getServerCost(id);
            if (caps.power?.stoppedBilling === 'full') expect(cost?.from).toBe(run.from);
            else expect(cost).toBeNull();
        };

        /** A container started anew: its log shows a boot mark it did not show before (its status alone may read running before the restart begins). */
        const newContainerBoot = async (server: Server): Promise<void> => {
            const lp = requireCapability(provider(), 'logs');
            const before = need(s.boots, 'no boot mark seen in its log yet');
            const end = Date.now() + (t.wait.timeoutMs ?? 0);
            for (;;) {
                const now = bootsIn(await lp.getServerLogs(server.id).catch(() => ''));
                if ([...now].some((b) => !before.has(b))) {
                    s.boots = new Set([...before, ...now]);
                    return;
                }
                if (Date.now() >= end) throw new Error(`container ${server.id} did not start anew within ${t.wait.timeoutMs} ms: no new boot mark in its log`);
                await t.sleep(t.wait.intervalMs ?? 10_000);
            }
        };

        /** The account's SSH keys, read until `ok` accepts them: a list may lag its writes by seconds (DigitalOcean), a fake's never does. */
        const keysUntil = async (kp: { listSSHKeys(): Promise<InitializedSSHKeyData[]> }, ok: (keys: InitializedSSHKeyData[]) => boolean, what: string) => {
            const end = Date.now() + (t.mode === 'live' ? LIST_LAG_MS : 0);
            for (;;) {
                const keys = await kp.listSSHKeys();
                if (ok(keys)) return keys;
                if (Date.now() >= end) throw new Error(`the account's SSH keys never showed ${what} (read for ${t.mode === 'live' ? LIST_LAG_MS / 1000 : 0} s)`);
                await t.sleep(2000);
            }
        };

        /**
         * Start a stopped server, and return when it was asked. Where its host may have no GPU free (startMayLackGpu),
         * startServer throws CapacityError and leaves it stopped, as documented: that is checked (stopped, and billing
         * only its disk), and the start tried again, START_TRIES times in all. A start is never assumed.
         */
        const startChecked = async (pp: ComputeSubject & { startServer(id: string): Promise<void> }, id: string, run?: CostEstimate): Promise<number> => {
            for (let attempt = 1; ; attempt++) {
                const at = Date.now();
                try {
                    await pp.startServer(id);
                    return at;
                } catch (e) {
                    if (!(t.startMayLackGpu && e instanceof CapacityError)) throw e;
                    t.log(`${t.id}: start ${attempt} of ${START_TRIES}: its host has no GPU free (${(e as Error).message}): stopped, as documented`);
                    expect((await pp.waitForServer(id, (x) => !x || x.status === 'stopped', t.wait))?.status).toBe('stopped');
                    if (run) await expectStoppedBilling(id, run);
                    if (attempt >= START_TRIES) {
                        throw new Error(`startServer was refused ${START_TRIES} times for want of a GPU on its host (CapacityError, the server left stopped, as documented), so a start was NOT verified`);
                    }
                    await t.sleep(t.mode === 'live' ? START_RETRY_MS : 0);
                }
            }
        };

        /** Every SSH key the run registers (its own test's, the provisioner's, the image boot's): deleted by id at the end, verified. */
        let keyIds = new Set<string>();
        /** Every volume the run creates: it outlives the servers that mount it and bills until deleted, so it is deleted by id at the end, verified. */
        let volumeIds = new Set<string>();

        /** The key was refused before anything ran: every test says so, and there is nothing to tear down. */
        let refused = false;

        beforeAll(async () => {
            p = t.make();
            keyIds = trackSSHKeys(p);
            volumeIds = trackVolumes(p);
            try {
                await p.listServers();
            } catch (e) {
                if (!(e instanceof AuthError)) throw e;
                refused = true;
                throw new Error(`${t.keyEnv ?? 'the key'} is refused by ${t.id}, so nothing was tried: ${e.message}`);
            }
            if (t.live && !t.freeOnly) {
                t.log(`${t.id}: sweeping what earlier runs left`);
                expect(await sweepLeftovers(p, { log: t.log, keyRounds: 3 })).toEqual([]);
                await t.live.preflight?.(p);
                watchdog = await startWatchdog(t.id, runName, Date.now() + t.live.deadlineMs);
                t.log(`${t.id}: watchdog armed for ${runName}`);
            }
        }, t.timeouts.server);

        afterAll(async () => {
            if (!p || refused) return;
            const servers = await teardown(p, run, { log: t.log, sleep: t.sleep, intervalMs: t.wait.intervalMs });
            // By id as well as by name, read until two lists agree: a list may lag its writes by seconds, and a volume
            // detaches from its deleted server a little after it is gone.
            const reads = { log: t.log, sleep: t.sleep, intervalMs: t.wait.intervalMs, rounds: t.mode === 'live' ? 10 : 1 };
            const keys = await deleteRunKeys(p, run, { ...reads, ids: keyIds });
            const volumes = await deleteRunVolumes(p, run, { ...reads, ids: volumeIds });
            const images = await deleteRunImages(p, run, t.log);
            if (watchdog && !servers.length && !keys.length && !volumes.length && !images.length) writeFileSync(watchdog.doneFile, 'done\n');
            expect({ servers, keys, volumes, images }).toEqual({ servers: [], keys: [], volumes: [], images: [] });
        }, t.timeouts.server);

        // ── free: nothing is created but a key, deleted again ──

        it('a wrong API key is an AuthError', async () => {
            await expect(t.make('asap-vps-wrong-key').listServers()).rejects.toBeInstanceOf(AuthError);
        }, t.timeouts.free);

        it('listOffers: what is in stock now, cheapest first, well-formed; every filter means what it says', async () => {
            const offers = await p.listOffers({ kind: 'gpu' });
            expect(offers.length).toBeGreaterThan(0);
            for (const o of offers) {
                expect(o.provider).toBe(p.id);
                expect(o.id).toBeTruthy();
                expect(o.gpu).toBeTruthy();
                expect(['nvidia', 'amd']).toContain(o.vendor);
                // A model asap-vps knows goes by its one name (a MIG slice's: the name and its profile) and its maker.
                const known = canonicalGpu(o.gpu);
                if (known) expect([o.id, o.gpu.replace(/ MIG \S+$/, ''), o.vendor]).toEqual([o.id, known.name, known.vendor]);
                expect(o.gpuCount).toBeGreaterThanOrEqual(1);
                expect(o.vramGb).toBeGreaterThan(0);
                expect(o.pricePerHour).toBeGreaterThan(0);
                expect(o.regions.length).toBeGreaterThan(0);
                expect(o.interruptible).toBeFalsy();
            }
            for (let i = 1; i < offers.length; i++) expect(offers[i - 1].pricePerHour).toBeLessThanOrEqual(offers[i].pricePerHour);
            // Each filter must keep something (every() of nothing proves nothing), on a model with the most listings:
            // a marketplace's offers are single machines, rented in seconds.
            const listings = new Map<string, number>();
            for (const o of offers) listings.set(o.gpu, (listings.get(o.gpu) ?? 0) + 1);
            const gpu = [...listings].sort((a, b) => b[1] - a[1])[0][0];
            const same = await p.listOffers({ gpus: [gpu], includeUnavailable: true });
            expect(same.length).toBeGreaterThan(0);
            expect(same.every((o) => o.gpu === gpu)).toBe(true);
            const big = await p.listOffers({ minVramGb: 40, includeUnavailable: true });
            expect(big.length).toBeGreaterThan(0);
            expect(big.every((o) => o.vramGb >= 40)).toBe(true);
            const cap = offers[Math.min(4, offers.length - 1)].pricePerHour;
            const capped = await p.listOffers({ maxPricePerHour: cap });
            expect(capped.length).toBeGreaterThan(0);
            expect(capped.every((o) => o.pricePerHour <= cap)).toBe(true);
            // Without GPUs where the provider rents such machines, and none where it does not.
            const cpu = await p.listOffers({ kind: 'cpu', includeUnavailable: true });
            expect(cpu.every((o) => o.gpuCount === 0 && o.vendor === null && o.gpu === '')).toBe(true);
            if (caps.compute?.cpu) expect(cpu.length).toBeGreaterThan(0);
            else expect(cpu).toEqual([]);
            // What this run rents: one NVIDIA GPU under the price cap (on a container host whose driver runs the image).
            const q = t.query;
            for (const o of await p.listOffers(q)) {
                if (!t.cpu) expect([o.vendor, o.gpuCount]).toEqual([q.vendor, q.gpuCount]);
                expect(o.pricePerHour).toBeLessThanOrEqual(q.maxPricePerHour as number);
                if (q.minCudaVersion && o.cudaVersion) expect(compareCudaVersions(o.cudaVersion, q.minCudaVersion)).toBeGreaterThanOrEqual(0);
            }
        }, t.timeouts.free);

        it('getServer and getImage of an id nothing has are null', async () => {
            expect(await p.getServer(t.unknownServerId)).toBeNull();
            if (supports(p, 'images')) expect(await p.getImage(t.unknownImageId)).toBeNull();
        }, t.timeouts.free);

        it('lists the account\'s servers and images, every one of them', async () => {
            const servers = await p.listServers();
            for (const x of servers) {
                expect(x.provider).toBe(p.id);
                expect(x.id).toBeTruthy();
                expect(STATUSES).toContain(x.status);
            }
            // Each server is listed under exactly one kind, the one its GPUs say (live, one made or deleted meanwhile is left out).
            const hasGpu = (x: Server) => (x.gpuCount ?? 0) > 0;
            const [gpus, cpus] = [await p.listServers({ kind: 'gpu' }), await p.listServers({ kind: 'cpu' })];
            expect(gpus.filter((x) => !hasGpu(x)).map((x) => x.id)).toEqual([]);
            expect(cpus.filter(hasGpu).map((x) => x.id)).toEqual([]);
            const ids = (xs: Server[]) => new Set(xs.map((x) => String(x.id)));
            const [g, c, still] = [ids(gpus), ids(cpus), ids(await p.listServers())];
            for (const x of servers.filter((y) => still.has(String(y.id)))) {
                expect([x.id, g.has(String(x.id)), c.has(String(x.id))]).toEqual([x.id, hasGpu(x), !hasGpu(x)]);
            }
            if (supports(p, 'images')) {
                for (const i of await p.listImages()) {
                    expect(i.provider).toBe(p.id);
                    expect(IMAGE_STATUSES).toContain(i.status);
                }
            }
        }, t.timeouts.free);

        if (caps.sshKeys) {
            it('SSH keys: add (the same key again is the same registration), list, delete; the account\'s other keys untouched', async () => {
                const p = requireCapability(provider(), 'sshKeys');
                const has = (id: string | number) => (keys: InitializedSSHKeyData[]) => keys.some((k) => String(k.id) === String(id));
                // A second key of the run's, so the account has another key to leave untouched even when it had none.
                const other = await p.addSSHKey(testPublicKey(`${runName}-other`), `${runName}-other`);
                const before = (await keysUntil(p, has(other.id), `${other.id} listed`)).map((k) => String(k.id));
                const pub = testPublicKey(runName);
                const key = await p.addSSHKey(pub, runName);
                expect(key).toMatchObject({ name: runName, fingerprint: sshKeyFingerprint(pub) });
                expect(key.publicKey.split(' ').slice(0, 2)).toEqual(pub.split(' ').slice(0, 2));
                expect((await p.addSSHKey(pub, `${runName}-again`)).id).toBe(key.id);
                const listed = has(key.id);
                const during = await keysUntil(p, listed, `${key.id} listed`);
                expect(during.filter((k) => k.fingerprint === key.fingerprint).map((k) => k.id)).toEqual([key.id]);
                expect(during.map((k) => String(k.id))).toEqual(expect.arrayContaining(before));
                expect(await p.deleteSSHKey(key.id)).toBe(true);
                // Gone from the list, and none of the account's other keys with it (others may add theirs meanwhile).
                const after = await keysUntil(p, (keys) => !listed(keys), `${key.id} gone`);
                expect(after.map((k) => String(k.id))).toEqual(expect.arrayContaining(before));
                expect(await p.deleteSSHKey(key.id)).toBe(false);
                expect(await p.deleteSSHKey(other.id)).toBe(true);
            }, t.timeouts.free);
        }

        it('capabilities say up front what exists: a declared one has every method, any other none; an option it cannot honor is refused before anything is rented', async () => {
            const unsupported = async (call: () => Promise<unknown>) => expect(call()).rejects.toBeInstanceOf(NotSupportedError);
            const methods = p as unknown as Record<string, unknown>;
            for (const c of Object.keys(CAPABILITY_METHODS) as CapabilityName[]) {
                for (const m of CAPABILITY_METHODS[c]) expect([c, m, typeof methods[m]]).toEqual([c, m, supports(p, c) ? 'function' : 'undefined']);
            }
            // Refused by the provider itself, before any request: nothing can be rented by these.
            if (!caps.compute?.userData) await unsupported(() => p.createServer({ name: runName, offer: 'none', userData: USER_DATA }));
            if (vm) await unsupported(() => p.createServer({ name: runName, offer: 'none', env: { A: 'b' } }));
            else if (supports(p, 'sshKeys')) {
                await unsupported(() => new ServerProvisioner(p as ProvisionTarget).provision({ serverOptions: { name: runName, offer: 'none' } }, () => undefined));
            }
        }, t.timeouts.free);

        // ── paid: one server, then the delete ──

        paid(`createServer rents the cheapest offer in stock, which runs ${t.cpu ? 'as a CPU server' : 'with the GPU it was rented for'}${vm
            ? ` (over SSH: ${t.cpu ? '' : 'the GPU, '}the cloud-init user data, root)` : ''}`, async () => {
            const offers = (await p.listOffers(t.query)).slice(0, 5);
            if (!offers.length) throw new Error(`no offer in stock right now for ${JSON.stringify(t.query)} (ASAP_VPS_LIVE_MAX_PRICE raises the cap)`);
            s.rentedAt = Date.now();
            for (const offer of offers) {
                /** The container server this attempt made, and whether it was past our own checks and booting when it failed. */
                let made: Server | undefined;
                let booting = false;
                try {
                    t.log(`${t.id}: renting ${offer.gpu} (${offer.id}) in ${offer.regions[0]} at $${offer.pricePerHour.toFixed(2)}/h as ${runName}`);
                    if (vm) {
                        const r = await new ServerProvisioner(p as ProvisionTarget).provision({
                            serverOptions: { name: runName, offer, userData: USER_DATA },
                            sshKeyName: runName,
                            wait: t.wait,
                            sshRetry: t.sshRetry,
                        }, (pipeline) => void pipeline
                            .addStep(new RunCommandStep([t.cpu ? 'true' : 'nvidia-smi -L'], 'gpu'))
                            .addStep(new RunCommandStep([`(cloud-init status --wait || true) > /dev/null 2>&1; cat ${USER_DATA_FILE}`], 'user-data'))
                            .addStep(new RunCommandStep(['id -u', BOOT_ID], 'root')));
                        s.server = r.server;
                        s.keys = r.sshKeyData;
                        s.setup = r.setupResults;
                    } else {
                        made = await p.createServer({ name: runName, offer, ...containerOptions(runName, !!t.cpu) });
                        expect(made).toMatchObject({ provider: p.id, name: runName });
                        // A marketplace host can fail before the create has even answered.
                        expect(['pending', 'running', ...(t.hostsMayFail ? ['error'] : [])]).toContain(made.status);
                        booting = true;
                        s.server = await p.waitUntilRunning(made.id, t.wait);
                    }
                    s.offer = offer;
                    break;
                } catch (e) {
                    s.server = undefined;
                    // Nothing runs against a server that did not come up: it goes now, verified, and every later test says an earlier step failed.
                    if (made) {
                        const gone = await p.deleteServerAndWait(made.id, t.wait).catch((x) => {
                            t.log(`  delete of ${made?.id} failed: ${(x as Error).message}`);
                            return false;
                        });
                        t.log(`${t.id}: ${made.id} did not come up (${(e as Error).message}): ${gone ? 'deleted, verified' : 'NOT verified deleted (the teardown tries again)'}`);
                    }
                    if (e instanceof CapacityError) {
                        t.log(`${t.id}: no stock for ${offer.id} after all (${(e as Error).message}): trying the next offer`);
                        continue;
                    }
                    // A broken marketplace host: the host failed, not the provider. Only the provider's own answer while the server
                    // boots lands here: never a check of ours (they run before `booting`), never a refused key.
                    if (booting && t.hostsMayFail && e instanceof ProviderError && !(e instanceof AuthError)) {
                        t.log(`${t.id}: the host of ${offer.id} could not run the container: trying the next offer, another host`);
                        continue;
                    }
                    throw e;
                }
            }
            const server = need(s.server, 'every offer tried had no stock, or a host that could not run the container');
            const offer = need(s.offer, 'no offer');
            t.log(`${t.id}: ${server.id} is running`);
            expect(server).toMatchObject({ provider: p.id, name: runName, status: 'running', region: offer.regions[0], ...(t.cpu ? {} : { gpu: offer.gpu, gpuCount: offer.gpuCount }) });
            if (vm) {
                expect(server.ip).toBeTruthy();
                expect(server.ssh).toEqual({ host: server.ip, port: 22, username: expect.any(String) });
                const out = Object.fromEntries((s.setup ?? []).map((r) => [r.step, r.output ?? '']));
                if (!t.cpu) expect(out.gpu).toMatch(/^GPU \d+: /m);
                expect(out['user-data']).toContain(USER_DATA_MARK);
                const [uid, bootId] = out.root.split('\n').map((l) => l.trim());
                expect(uid).toBe('0');
                expect(bootId).toMatch(/^[0-9a-f-]{36}$/);
                s.bootId = bootId;
            }
        }, t.timeouts.server);

        paid('getServer, listServers and waitForServer report it as it is', async () => {
            const server = need(s.server, 'no server');
            const got = await p.getServer(server.id);
            expect(got).toMatchObject({ id: server.id, name: runName, status: 'running', gpu: server.gpu, region: server.region });
            expect(got?.pricePerHour).toBeGreaterThan(0);
            // What it has cost: its rate, from the start of the run it bills, in its provider's steps; an hour of that run is an
            // hour's price, or the least a run costs where that is more (DigitalOcean: $0.01, above an hour of its smallest droplet).
            const cost = await billedRun(server.id, need(s.rentedAt, 'no create'));
            expect(cost.pricePerHour).toBe(got?.pricePerHour);
            expect(got?.billing?.incrementSeconds).toBeGreaterThanOrEqual(1);
            const hour = await p.getServerCost(server.id, cost.from + 3_600_000);
            expect(hour).toMatchObject({ from: cost.from, billedSeconds: 3600 });
            expect(hour?.usd).toBeCloseTo(Math.max(cost.pricePerHour, got?.billing?.minimumUsd ?? 0), 6);
            expect((await p.listServers({ kind: t.cpu ? 'cpu' : 'gpu' })).find((x) => x.id === server.id)).toMatchObject({ name: runName, status: 'running' });
            expect((await p.listServers({ kind: t.cpu ? 'gpu' : 'cpu' })).map((x) => x.id)).not.toContain(server.id);
            expect((await p.waitForServer(server.id, (x) => x?.status === 'running', t.wait))?.id).toBe(server.id);
        }, t.timeouts.server);

        if (caps.logs) {
            paid('getServerLogs: the container\'s own output, with the environment it was given', async () => {
                const p = requireCapability(provider(), 'logs');
                const server = need(s.server, 'no server');
                const want = containerLog(runName, !!t.cpu);
                const end = Date.now() + (t.wait.timeoutMs ?? 0);
                let logs = await p.getServerLogs(server.id);
                while (!want.every((re) => re.test(logs)) && Date.now() < end) {
                    // A container that is not running will not print what is missing: say so now, not at the timeout.
                    const now = await p.getServer(server.id);
                    if (now?.status !== 'running') throw new Error(`server ${server.id} is ${now?.status ?? 'gone'} (${now?.providerStatus ?? ''}): its log will not show its output`);
                    await t.sleep(t.wait.intervalMs ?? 10_000);
                    logs = await p.getServerLogs(server.id);
                }
                for (const re of want) expect(logs).toMatch(re);
                s.boots = bootsIn(logs);
            }, t.timeouts.server);
        }

        if (caps.restart) {
            paid(`restartServer: running again, ${vm ? 'after a real reboot' : 'its container started anew'}`, async () => {
                const p = requireCapability(provider(), 'restart');
                const server = need(s.server, 'no server');
                for (let attempt = 1; ; attempt++) {
                    try {
                        await p.restartServer(server.id);
                        break;
                    } catch (e) {
                        // RunPod restarts a pod by stopping and starting it: on a host with no GPU free, the start is refused
                        // (CapacityError) and the pod left stopped. It is started again, then the restart tried again.
                        if (!(t.startMayLackGpu && e instanceof CapacityError && supports(p, 'power'))) throw e;
                        t.log(`${t.id}: restart ${attempt} of ${START_TRIES}: its host has no GPU free (${(e as Error).message})`);
                        if (attempt >= START_TRIES) throw new Error(`restartServer was refused ${START_TRIES} times for want of a GPU on its host, so a restart was NOT verified`);
                        await t.sleep(t.mode === 'live' ? START_RETRY_MS : 0);
                        if ((await p.getServer(server.id))?.status !== 'running') {
                            await startChecked(p, server.id);
                            s.server = await p.waitUntilRunning(server.id, t.wait);
                            // That start booted it anew: the restart's own boot comes after this one.
                            if (vm) s.bootId = await newBoot(s.server);
                            else await newContainerBoot(s.server);
                        }
                    }
                }
                if (vm) s.bootId = await newBoot(server);
                s.server = await p.waitUntilRunning(server.id, t.wait);
                if (!vm) await newContainerBoot(s.server);
            }, t.timeouts.server);
        }

        if (caps.power) {
            paid(`stopServer and startServer: stopped (no run billed where only the disk bills), then running again: a new run, ${vm ? 'booted' : 'its container started'} anew`, async () => {
                const p = requireCapability(provider(), 'power');
                const server = need(s.server, 'no server');
                const run = await billedRun(server.id, need(s.rentedAt, 'no create'));
                await p.stopServer(server.id);
                expect((await p.waitForServer(server.id, (x) => !x || ['stopped', 'error'].includes(x.status), t.wait))?.status).toBe('stopped');
                await expectStoppedBilling(server.id, run);
                const startedAt = await startChecked(p, server.id, run);
                s.server = await p.waitUntilRunning(server.id, t.wait);
                // Running again, it bills again: a new run, begun after the start, where the stop ended the last one.
                const newRun = caps.power?.stoppedBilling === 'storage' && !t.billingFromRentalStart;
                await billedRun(server.id, newRun ? startedAt : run.from);
                if (vm) s.bootId = await newBoot(s.server);
                else await newContainerBoot(s.server);
            }, t.timeouts.server);
        }

        // A VM's disk, booted again with a key: a container platform's images (Vast's snapshots, pushed to a registry) have their own suite.
        if (caps.images && caps.compute?.kind === 'vm') {
            (t.images ? paid : it.skip)(`images: capture the stopped server, read and list it, ${caps.imageCopy ? 'copy it to another region, ' : ''}boot a new server from it, delete it`, async () => {
                // The image phase stops the server, and boots the image with a key of the account.
                const p = requireCapability(requireCapability(requireCapability(provider(), 'images'), 'power'), 'sshKeys');
                const server = need(s.server, 'no server');
                const keys = need(s.keys, 'no key pair');
                const region = need(server.region, 'no region');
                await p.stopServer(server.id);
                const name = `${runName}-image`;
                t.log(`${t.id}: capturing ${server.id} as ${name}`);
                const image = await p.createImage(server.id, { name, ...t.imageWait });
                expect(image).toMatchObject({ provider: p.id, name, status: 'available' });
                if (caps.images?.scope === 'region') expect(image.regions).toEqual([region]);
                expect(await p.getImage(image.id)).toMatchObject({ id: image.id, name, status: 'available' });
                expect((await p.listImages()).map((i) => i.id)).toContain(image.id);
                let regions = image.regions;
                if (caps.images?.scope === 'region' && supports(p, 'imageCopy')) {
                    // Where a GPU is in stock now, if anywhere else: a second place the image can boot.
                    const to = (await p.listOffers(t.query)).flatMap((o) => o.regions).find((r) => r !== region) ?? t.copyRegion(region);
                    t.log(`${t.id}: copying ${name} to ${to}`);
                    regions = (await p.copyImage(image.id, [to], t.imageWait)).regions;
                    expect(regions).toEqual(expect.arrayContaining([region, to]));
                }
                // One GPU server at a time (an account may have room for only one): the first goes before the image boots.
                expect(await p.deleteServerAndWait(server.id, t.wait)).toBe(true);
                s.server = undefined;
                const key = await p.addSSHKey(keys.publicKey, runName);
                // Stock comes and goes while an image is made: boot it on whatever is in stock now where the image is.
                const candidates = (await p.listOffers(t.query))
                    .flatMap((o) => o.regions.filter((r) => !regions.length || regions.includes(r)).map((r) => ({ offer: o, region: r })));
                for (const c of candidates.slice(0, 6)) {
                    try {
                        t.log(`${t.id}: booting ${name} on ${c.offer.id} in ${c.region}`);
                        s.server = await p.createServer({ name: `${runName}-from-image`, offer: c.offer, region: c.region, image: image.id, sshKeyIds: [key.id] });
                        break;
                    } catch (e) {
                        if (!(e instanceof CapacityError)) throw e;
                        t.log(`${t.id}: no stock for ${c.offer.id} in ${c.region} after all: trying the next`);
                    }
                }
                const booted = need(s.server, `no GPU in stock in the image's regions (${regions.join(', ')})`);
                s.server = await p.waitUntilRunning(booted.id, t.wait);
                // The image is the first server's disk: the file its user data wrote came with it.
                expect(await shell(s.server, `cat ${USER_DATA_FILE}`)).toContain(USER_DATA_MARK);
                await p.deleteImage(image.id);
                expect(await p.getImage(image.id)).toBeNull();
                await expect(p.deleteImage(image.id)).resolves.toBeUndefined();
            }, t.timeouts.images);
        }

        paid('deleteServerAndWait: verified gone; a second delete succeeds; it is no longer listed', async () => {
            const server = need(s.server, 'no server');
            expect(await p.deleteServerAndWait(server.id, t.wait)).toBe(true);
            const gone = await p.getServer(server.id);
            expect(gone === null || gone.status === 'terminated').toBe(true);
            expect(await p.getServerCost(server.id)).toBeNull();
            await expect(p.deleteServer(server.id)).resolves.toBeUndefined();
            expect((await p.listServers()).filter((x) => x.id === server.id && x.status !== 'terminated')).toEqual([]);
            s.server = undefined;
        }, t.timeouts.server);
    });
}
