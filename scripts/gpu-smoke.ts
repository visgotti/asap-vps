#!/usr/bin/env node
// Live smoke test for one GPU provider: rent the cheapest single NVIDIA GPU
// under a price cap, wait until it runs, then delete it and verify it is gone.
//
//   npm run gpu:smoke -- <runpod|vast|lambda|digitalocean|scaleway> [--max-price 1] [--minutes 20]
//   npm run gpu:smoke -- <provider> --sweep      delete every leftover asap-vps-smoke-* server
//
// Keys come from the environment, the repo's .env.test, then
// ~/.config/asap-vps/credentials.env for what those leave unset
// (RUNPOD_API_KEY, VAST_API_KEY, LAMBDA_API_KEY, DIGITAL_OCEAN_API_KEY, SCW_SECRET_KEY with
// SCW_DEFAULT_PROJECT_ID). None is printed.
//
// Teardown, in layers (src/testing/live.ts, shared with the *.live.spec.ts suites):
//   1. every server a run creates is named asap-vps-smoke-<run>, and the run
//      deletes it in a `finally` and on SIGINT / SIGTERM;
//   2. it is found by NAME as well as by id (a create whose answer was lost
//      still made a machine), and a fresh list must show nothing of that name
//      left; a list that failed is never read as empty;
//   3. a detached watchdog, started (and confirmed running) before anything is
//      created, deletes the run's servers if this process dies or overruns its
//      deadline, and keeps looking a few more times for a late create;
//   4. every run first sweeps leftovers of earlier runs, and `--sweep` does it by hand.

import { generateKeyPairSync } from 'crypto';
import { writeFileSync } from 'fs';

import { CapacityError, Offer, PROVIDERS, Server, supports, toOpenSSHPublicKey } from '../src';
import {
    ComputeSubject, deleteRunKeys, loadCredentials, newRunName, providerFromEnv, RUN_PREFIX, runMatcher, startWatchdog, sweepLeftovers, teardown, TEST_IMAGE,
    TEST_IMAGE_CUDA,
} from '../src/testing/live';

/** What the smoke names its servers with: the prefix every test run shares (--sweep finds them all). */
export const SMOKE_PREFIX = RUN_PREFIX;
export const SMOKE_IMAGE = TEST_IMAGE;
const SMOKE_CUDA = TEST_IMAGE_CUDA;

type Log = (m: string) => void;
const realSleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type SmokeOptions = {
    runName?: string,
    /** Default 1 USD per hour. */
    maxPricePerHour?: number,
    /** Default 15 min. */
    readyTimeoutMs?: number,
    /** How long to look for the nvidia-smi line in a container's log (default 2 min). */
    logTimeoutMs?: number,
    /** Default 10 s. */
    intervalMs?: number,
    log?: Log,
    sleep?: (ms: number) => Promise<unknown>,
};

export type SmokeResult = {
    ok: boolean,
    runName: string,
    offer?: Offer,
    server?: Server,
    runningAfterSec?: number,
    gpuLine?: string,
    error?: string,
    /** Servers of this run still listed after teardown (empty = verified gone). */
    leftovers: string[],
};

/** An OpenSSH public key nobody holds the private half of: a VM provider that insists on a key gets one. */
function throwawayPublicKey(comment: string): string {
    return toOpenSSHPublicKey(generateKeyPairSync('ed25519').publicKey, comment);
}

/** Rent, wait for running, delete, verify. Never returns with this run's server still listed unless it says so. */
export async function runSmoke(p: ComputeSubject, o: SmokeOptions = {}): Promise<SmokeResult> {
    const log = o.log ?? console.log;
    const sleep = o.sleep ?? realSleep;
    const intervalMs = o.intervalMs ?? 10_000;
    const runName = o.runName ?? newRunName();
    const result: SmokeResult = { ok: false, runName, leftovers: [] };
    const t0 = Date.now();
    let keyId: string | number | undefined;
    try {
        const max = o.maxPricePerHour ?? 1;
        // A container host brings its own driver: only those that run the image. (A VM boots its image's.)
        const offers = await p.listOffers({ vendor: 'nvidia', gpuCount: 1, maxPricePerHour: max, minCudaVersion: SMOKE_CUDA });
        if (!offers.length) throw new Error(`no single NVIDIA GPU in stock under $${max}/h`);
        const extra: Record<string, unknown> = {};
        if (p.capabilities.compute?.kind === 'container') {
            Object.assign(extra, { image: SMOKE_IMAGE, command: ['bash', '-c', 'nvidia-smi -L; sleep 3600'], minCudaVersion: SMOKE_CUDA });
        } else if (supports(p, 'sshKeys')) {
            // A VM provider may insist on a key (Lambda does); this run's own is deleted with it.
            keyId = (await p.addSSHKey(throwawayPublicKey(runName), runName)).id;
            extra.sshKeyIds = [keyId];
        }
        for (const offer of offers.slice(0, 5)) {
            try {
                log(`creating ${runName}: ${offer.gpu} (${offer.id}) in ${offer.regions[0]} at $${offer.pricePerHour.toFixed(2)}/h`);
                result.server = await p.createServer({ name: runName, offer, ...extra });
                result.offer = offer;
                break;
            } catch (e) {
                if (!(e instanceof CapacityError)) throw e;
                log(`  no stock: ${(e as Error).message}`);
            }
        }
        if (!result.server) throw new Error('every offer tried had no stock');
        const running = await p.waitUntilRunning(result.server.id, { intervalMs, timeoutMs: o.readyTimeoutMs ?? 15 * 60_000 });
        result.server = running;
        result.runningAfterSec = Math.round((Date.now() - t0) / 1000);
        log(`running after ${result.runningAfterSec} s${running.ip ? ` at ${running.ip}` : ''}`);
        if (supports(p, 'logs')) {
            const end = Date.now() + (o.logTimeoutMs ?? 2 * 60_000);
            while (!result.gpuLine && Date.now() < end) {
                const logs = await p.getServerLogs(running.id).catch(() => '');
                result.gpuLine = /^GPU \d+: .*$/m.exec(logs)?.[0];
                if (!result.gpuLine) await sleep(intervalMs);
            }
            log(result.gpuLine ? `the container sees: ${result.gpuLine}` : 'no nvidia-smi line in the log (not fatal)');
        }
        result.ok = true;
    } catch (e) {
        result.error = (e as Error).message;
        log(`FAILED: ${result.error}`);
    } finally {
        result.leftovers = await teardown(p, runName, { knownId: result.server?.id, log, sleep, intervalMs });
        // Its key by id as well as by name, read until two lists agree: the account's list may lag its writes.
        result.leftovers.push(...await deleteRunKeys(p, runMatcher(runName), { ids: keyId ? [keyId] : [], log, sleep, intervalMs, rounds: 10 }));
        if (result.leftovers.length) result.ok = false;
    }
    return result;
}

async function main(): Promise<number> {
    const [id, ...args] = process.argv.slice(2);
    const flag = (name: string) => {
        const i = args.indexOf(`--${name}`);
        return i >= 0 ? args[i + 1] : undefined;
    };
    if (!id || id.startsWith('-')) {
        console.error(`usage: gpu-smoke <${Object.keys(PROVIDERS).join('|')}> [--max-price 1] [--minutes 20] | <provider> --sweep`);
        return 2;
    }
    loadCredentials();
    const provider = providerFromEnv(id);

    if (args.includes('--sweep')) {
        const left = await sweepLeftovers(provider);
        console.log(left.length ? `STILL LISTED: ${left.join(', ')}` : `${id}: no smoke servers left`);
        return left.length ? 1 : 0;
    }

    const minutes = Math.min(Number(flag('minutes') ?? 20), 60);
    const maxPricePerHour = Number(flag('max-price') ?? 1);
    const runName = newRunName();
    const deadline = Date.now() + minutes * 60_000;
    console.log(`${id}: sweeping leftovers of earlier smoke runs`);
    const earlier = await sweepLeftovers(provider);
    if (earlier.length) {
        console.error(`earlier smoke servers are still listed (${earlier.join(', ')}): not creating another`);
        return 1;
    }
    const { doneFile, logFile } = await startWatchdog(id, runName, deadline);
    console.log(`watchdog armed until ${new Date(deadline).toISOString()} (${logFile})`);

    let stopping = false;
    const stop = async (why: string) => {
        if (stopping) return;
        stopping = true;
        console.log(`[${why}] deleting this run's servers before exiting`);
        const left = await teardown(provider, runName);
        // A create may still land after this: the watchdog keeps looking, so it is not told done.
        console.log(left.length ? `NOT verified gone: ${left.join(', ')} (the watchdog keeps trying)` : 'verified gone; the watchdog double-checks');
        process.exit(130);
    };
    process.on('SIGINT', () => void stop('SIGINT'));
    process.on('SIGTERM', () => void stop('SIGTERM'));
    setTimeout(() => void stop('deadline'), deadline - Date.now()).unref();

    const r = await runSmoke(provider, { runName, maxPricePerHour, readyTimeoutMs: Math.max(60_000, deadline - Date.now() - 5 * 60_000) });
    if (!r.leftovers.length) writeFileSync(doneFile, 'done\n');
    console.log(r.leftovers.length
        ? `\nNOT VERIFIED GONE: ${r.leftovers.join(', ')}. The watchdog keeps deleting until ${new Date(deadline).toISOString()}; also run --sweep.`
        : `\n${r.ok ? 'PASS' : 'FAIL'}: ${r.offer ? `${r.offer.gpu} at $${r.offer.pricePerHour.toFixed(2)}/h, ` : ''}${r.runningAfterSec !== undefined ? `running after ${r.runningAfterSec} s, ` : ''}deleted and verified gone${r.error ? ` (${r.error})` : ''}`);
    return r.ok ? 0 : 1;
}

if (require.main === module) {
    main().then((code) => process.exit(code), (e) => {
        console.error(`error: ${(e as Error).message}`);
        process.exit(1);
    });
}
