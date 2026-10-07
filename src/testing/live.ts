// Runs against real provider accounts (the smoke script and the *.live.spec.ts
// suites) and the guarantees they keep. Whatever a run creates is named after
// the run (RUN_PREFIX...). The run deletes it when it ends, finds it by name as
// well as by id (a create whose answer was lost still made a machine; a key the
// account's list does not show yet), and proves with a fresh list that it is
// gone, servers, SSH keys, volumes and images alike; a list that failed is
// never read as empty. A detached watchdog deletes it if the run dies or overruns, and every
// run first sweeps what earlier runs left.

import { spawn } from 'child_process';
import { existsSync, mkdirSync, readFileSync, statSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { extname, join } from 'path';
import { Capable, ICompute, supports } from '../capabilities';
import { asRoot } from '../Core/ServerProvisioner';
import { SSHService } from '../Core/SSHService';
import { AuthError } from '../errors';
import { AnyProvider, providerInfo, providerParams } from '../Providers/registry';

/** Any provider that rents servers: what the live helpers take. */
export type ComputeSubject = ICompute & Capable;
import type { Endpoint, Server, ServerImage, SSHRetryOptions } from '../types';

/** What every test run names its servers, keys and images with. */
export const RUN_PREFIX = 'asap-vps-smoke-';
/** A small public CUDA image any recent host driver runs: what a container provider is tested with. */
export const TEST_IMAGE = 'nvidia/cuda:12.2.0-base-ubuntu22.04';
/** What TEST_IMAGE needs of a container host's driver. */
export const TEST_IMAGE_CUDA = '12.2';

export type Log = (m: string) => void;

/**
 * Run `command` on a server over SSH, as root (through sudo where the login is
 * not root: Lambda's ubuntu), with the run's private key: its stdout, trimmed.
 * An exit other than 0 throws, with stderr.
 */
export async function sshRun(server: Server, privateKey: string, command: string, retry: SSHRetryOptions = { maxRetries: 30, retryTimeout: 10_000 }): Promise<string> {
    if (!server.ssh) throw new Error(`server ${server.id} reports no ssh endpoint`);
    const ssh = await SSHService.connect({ ...server.ssh, privateKey, retry });
    try {
        const r = await asRoot(ssh, server.ssh.username).execCommand(command);
        if (r.code !== 0) throw new Error(`${command}: exit ${r.code}: ${r.stderr}`);
        return r.stdout.trim();
    } finally {
        ssh.dispose();
    }
}
type Sleep = (ms: number) => Promise<unknown>;
const realSleep: Sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function newRunName(now = Date.now()): string {
    const stamp = new Date(now).toISOString().replace(/[-:]/g, '').replace('T', 't').slice(0, 13);
    return `${RUN_PREFIX}${stamp}-${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * A name as a run's name reads it: where a platform takes no hyphens (Vast's
 * volumes: letters, digits and underscores), the run names with underscores, read back as hyphens.
 */
export function asRunName(name: string): string {
    return name.replace(/_/g, '-');
}

/** The run's own resources: named `runName`, or `runName-<anything>` (with underscores for hyphens where a platform takes no hyphens). */
export function runMatcher(runName: string): (name: string) => boolean {
    return (name) => {
        const n = asRunName(name);
        return n === runName || n.startsWith(`${runName}-`);
    };
}

/**
 * Delete every server `name` matches (a run name: it and `<name>-...`), and
 * `knownId`, then prove with a fresh list that none is left. Returns what is
 * still there ([] = verified gone).
 */
export async function teardown(
    p: ComputeSubject,
    name: string | ((serverName: string) => boolean),
    o: { knownId?: string, log?: Log, sleep?: Sleep, intervalMs?: number, rounds?: number } = {},
): Promise<string[]> {
    const log = o.log ?? console.log;
    const sleep = o.sleep ?? realSleep;
    const matches = typeof name === 'string' ? runMatcher(name) : name;
    /** What is still there, by a fresh read; null when it could not be read (never "nothing left"). */
    const look = async (): Promise<Map<string, string> | null> => {
        let listed: Server[];
        try {
            listed = await p.listServers();
        } catch (e) {
            if (e instanceof AuthError) throw e;
            log(`could not list servers (${(e as Error).message}); retrying`);
            return null;
        }
        const targets = new Map(listed.filter((s) => matches(s.name) && s.status !== 'terminated').map((s) => [s.id, s.name]));
        if (o.knownId && !targets.has(o.knownId)) {
            const s = await p.getServer(o.knownId).catch(() => undefined);
            if (s === undefined || (s && s.status !== 'terminated')) targets.set(o.knownId, s?.name ?? o.knownId);
        }
        return targets;
    };
    for (let round = 0; round < (o.rounds ?? 5); round++) {
        const targets = await look();
        if (!targets) {
            await sleep(o.intervalMs ?? 10_000);
            continue;
        }
        if (!targets.size) return [];
        for (const [id, n] of targets) {
            log(`deleting ${n} (${id})`);
            const gone = await p.deleteServerAndWait(id, { intervalMs: o.intervalMs ?? 10_000, timeoutMs: 5 * 60_000 }).catch((e) => {
                log(`  delete failed: ${(e as Error).message}`);
                return false;
            });
            log(gone ? `  ${n} is gone` : `  ${n} NOT verified gone yet`);
        }
    }
    // What the last round's deletes left, read again: not the list from before them.
    const left = await look();
    return left ? [...left.values()] : ['(could not list)'];
}

/**
 * Records the id of every SSH key registered through `p` from now on (addSSHKey,
 * and what calls it: ServerProvisioner). deleteRunKeys deletes those by id, so
 * neither a key the account's list does not show yet (DigitalOcean's lags its
 * writes by seconds) nor a second registration of the same key (Scaleway takes
 * one; DigitalOcean did during that lag) is left behind.
 */
export function trackSSHKeys(p: ComputeSubject): Set<string> {
    const ids = new Set<string>();
    if (!supports(p, 'sshKeys')) return ids;
    const add = p.addSSHKey.bind(p);
    p.addSSHKey = async (publicKey: string, keyName: string) => {
        const key = await add(publicKey, keyName);
        ids.add(String(key.id));
        return key;
    };
    return ids;
}

/** How deleteRunKeys and deleteRunVolumes read and wait: `ids` the run recorded, and how many reads it takes. */
export type DeleteRunOptions = { ids?: Iterable<string | number>, log?: Log, sleep?: Sleep, intervalMs?: number, rounds?: number };

/**
 * Delete a run's resources of one kind: every id in `o.ids` first (what the run
 * recorded: deleted though the list does not show it yet), then every one
 * `matches` names, and prove it with fresh lists. A list may still show a
 * deleted one, or not yet show a new one, for seconds: with `rounds` above 1 it
 * is read again every `intervalMs` (deleting what it shows) until two reads in a
 * row show none. Returns what is still listed ([] = verified gone); a list that
 * failed is never read as empty.
 */
async function deleteVerified<R extends { id: string | number, name: string }>(
    kind: string, list: () => Promise<R[]>, remove: (id: string) => Promise<unknown>, matches: (name: string) => boolean, o: DeleteRunOptions,
): Promise<string[]> {
    const log = o.log ?? console.log;
    const sleep = o.sleep ?? realSleep;
    const ids = new Set([...(o.ids ?? [])].map(String));
    const del = async (id: string, name: string) => {
        await remove(id).catch((e) => log(`  ${kind} ${name} (${id}) not deleted: ${(e as Error).message}`));
    };
    /** The run's ones the account lists now; null when the list could not be read. */
    const look = async (): Promise<R[] | null> => {
        try {
            return (await list()).filter((r) => matches(r.name) || ids.has(String(r.id)));
        } catch (e) {
            if (e instanceof AuthError) throw e;
            log(`could not list ${kind}s (${(e as Error).message}); retrying`);
            return null;
        }
    };
    for (const id of ids) await del(id, id);
    const rounds = Math.max(1, o.rounds ?? 1);
    let clean = 0;
    for (let round = 0; round < rounds; round++) {
        if (round) await sleep(o.intervalMs ?? 10_000);
        const left = await look();
        if (!left) {
            clean = 0;
            continue;
        }
        for (const r of left) {
            log(`deleting ${kind} ${r.name} (${r.id})`);
            await del(String(r.id), r.name);
        }
        clean = left.length ? 0 : clean + 1;
        if (clean >= (rounds > 1 ? 2 : 1)) return [];
    }
    // What the last round's deletes left, read again.
    const left = await look();
    return left ? left.map((r) => `${kind} ${r.name} (${r.id})`) : [`(could not list ${kind}s)`];
}

/**
 * Delete the run's SSH keys (where the provider has keys), by the ids trackSSHKeys
 * recorded and by name, verified by fresh lists (deleteVerified). Returns what is
 * still listed ([] = verified gone).
 */
export async function deleteRunKeys(p: ComputeSubject, matches: (name: string) => boolean, o: DeleteRunOptions = {}): Promise<string[]> {
    if (!supports(p, 'sshKeys')) return [];
    return deleteVerified('SSH key', () => p.listSSHKeys(), (id) => p.deleteSSHKey(id), matches, o);
}

/**
 * Records the id of every volume created through `p` from now on (createVolume):
 * deleteRunVolumes deletes those by id, so a volume, which outlives the servers
 * that mount it and bills until deleted, is never left behind.
 */
export function trackVolumes(p: ComputeSubject): Set<string> {
    const ids = new Set<string>();
    if (!supports(p, 'volumes')) return ids;
    const create = p.createVolume.bind(p);
    p.createVolume = async (options: Parameters<typeof create>[0]) => {
        const volume = await create(options);
        ids.add(String(volume.id));
        return volume;
    };
    return ids;
}

/**
 * Delete the run's volumes (where the provider has volumes), by the ids
 * trackVolumes recorded and by name, verified by fresh lists (deleteVerified).
 * A volume a server still holds is refused: call this once the servers are
 * gone (the reads in between let a detach catch up). Returns what is still
 * listed ([] = verified gone).
 */
export async function deleteRunVolumes(p: ComputeSubject, matches: (name: string) => boolean, o: DeleteRunOptions = {}): Promise<string[]> {
    if (!supports(p, 'volumes')) return [];
    return deleteVerified('volume', () => p.listVolumes(), (id) => p.deleteVolume(id), matches, o);
}

/** The images `matches` names, deleted (where the provider has images); what could not be deleted. */
export async function deleteRunImages(p: ComputeSubject, matches: (name: string) => boolean, log: Log = console.log): Promise<string[]> {
    if (!supports(p, 'images')) return [];
    let images: ServerImage[];
    try {
        images = (await p.listImages()).filter((i) => matches(i.name));
    } catch (e) {
        log(`could not list images (${(e as Error).message})`);
        return ['(could not list images)'];
    }
    const left: string[] = [];
    for (const i of images) {
        log(`deleting image ${i.name} (${i.id})`);
        await p.deleteImage(i.id).catch((e) => {
            log(`  image delete failed: ${(e as Error).message}`);
            left.push(i.name);
        });
    }
    return left;
}

/** The run's serverless endpoints (named after it), each deleted and waited for: what is still listed ([] = all gone). */
export async function deleteRunEndpoints(p: ComputeSubject, matches: (name: string) => boolean, log: Log = console.log): Promise<string[]> {
    if (!supports(p, 'serverless')) return [];
    const list = async () => (await p.listEndpoints()).filter((e) => matches(e.name));
    let endpoints: Endpoint[];
    try {
        endpoints = await list();
    } catch (e) {
        log(`could not list endpoints (${(e as Error).message})`);
        return ['(could not list endpoints)'];
    }
    for (const e of endpoints) {
        log(`deleting endpoint ${e.name} (${e.id})`);
        await p.deleteEndpoint(e.id).catch((x) => log(`  endpoint delete failed: ${(x as Error).message}`));
    }
    // What the deletes left, read again.
    const left = await list().catch(() => null);
    return left === null ? ['(could not list endpoints)'] : left.map((e) => `endpoint ${e.name} (${e.id})`);
}

/**
 * Every leftover of earlier runs on this provider: servers, then SSH keys and
 * volumes (once no server holds them), then images, each verified gone. What is
 * still listed. `keyRounds`: how often the key and volume lists are read (they
 * may lag their writes).
 */
export async function sweepLeftovers(p: ComputeSubject, o: { log?: Log, sleep?: Sleep, intervalMs?: number, keyRounds?: number } = {}): Promise<string[]> {
    const ours = (n: string) => asRunName(n).startsWith(RUN_PREFIX);
    const left = await teardown(p, ours, o);
    const reads = { log: o.log, sleep: o.sleep, intervalMs: o.intervalMs, rounds: o.keyRounds };
    const keys = await deleteRunKeys(p, ours, reads);
    const volumes = await deleteRunVolumes(p, ours, reads);
    return [...left, ...keys, ...volumes, ...await deleteRunImages(p, ours, o.log), ...await deleteRunEndpoints(p, ours, o.log)];
}

/**
 * The dead-man switch: until the run marks itself done, wait; once the
 * launcher is gone or the deadline passes, delete the run's servers, and
 * keep checking a few more times (a create in flight can land late); then
 * its keys, volumes and images.
 */
export async function watchdogLoop(o: {
    provider: ComputeSubject,
    runName: string,
    parentPid: number,
    deadline: number,
    doneFile: string,
    log: Log,
    alive?: (pid: number) => boolean,
    now?: () => number,
    sleep?: Sleep,
    pollMs?: number,
    roundMs?: number,
}): Promise<'done' | 'swept' | 'unverified'> {
    const alive = o.alive ?? isAlive;
    const now = o.now ?? Date.now;
    const sleep = o.sleep ?? realSleep;
    for (;;) {
        if (existsSync(o.doneFile)) {
            o.log('the run finished and verified its own teardown');
            return 'done';
        }
        if (!alive(o.parentPid)) {
            o.log(`launcher ${o.parentPid} is gone: deleting ${o.runName}`);
            break;
        }
        if (now() >= o.deadline) {
            o.log(`deadline passed: deleting ${o.runName}`);
            break;
        }
        await sleep(o.pollMs ?? 10_000);
    }
    const run = runMatcher(o.runName);
    let clean = 0;
    for (let round = 0; round < 20; round++) {
        const left = await teardown(o.provider, run, { log: o.log, sleep, intervalMs: o.roundMs ?? 30_000, rounds: 3 });
        clean = left.length ? 0 : clean + 1;
        if (clean >= 3) {
            // A key or volume the run made just before it died may not be listed yet: read the lists a few times.
            const reads = { log: o.log, sleep, intervalMs: o.roundMs ?? 10_000, rounds: 6 };
            const keys = await deleteRunKeys(o.provider, run, reads);
            const volumes = await deleteRunVolumes(o.provider, run, reads);
            const images = await deleteRunImages(o.provider, run, o.log);
            const endpoints = await deleteRunEndpoints(o.provider, run, o.log);
            const left = [...keys, ...volumes, ...images, ...endpoints];
            o.log(left.length ? `servers verified gone; NOT deleted: ${left.join(', ')}` : `verified: nothing named ${o.runName} is left`);
            return left.length ? 'unverified' : 'swept';
        }
        await sleep(o.roundMs ?? 30_000);
    }
    o.log(`could NOT verify ${o.runName} gone: check the provider's console by hand`);
    return 'unverified';
}

export function isAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (e) {
        return (e as NodeJS.ErrnoException).code === 'EPERM';
    }
}

const STATE_DIR = join(tmpdir(), 'asap-vps-smoke');

/** Where a run's watchdog logs, and the file the run writes once its own teardown is verified. */
export function watchdogFiles(runName: string): { doneFile: string, logFile: string } {
    return { doneFile: join(STATE_DIR, `${runName}.done`), logFile: join(STATE_DIR, `${runName}.log`) };
}

/**
 * Start the run's watchdog (./watchdog.ts), double-forked so its parent is
 * init at once and killing this process tree misses it. Resolves once it says
 * it is armed: nothing may be created before.
 */
export async function startWatchdog(id: string, runName: string, deadline: number): Promise<{ doneFile: string, logFile: string }> {
    mkdirSync(STATE_DIR, { recursive: true });
    const files = watchdogFiles(runName);
    const entry = join(__dirname, `watchdog${extname(__filename)}`);
    spawn('/bin/sh', ['-c', 'nohup "$0" "$@" </dev/null >/dev/null 2>&1 &', process.execPath, '-r', require.resolve('ts-node/register/transpile-only'),
        entry, id, runName, String(process.pid), String(deadline)], { detached: true, stdio: 'ignore', env: process.env }).unref();
    for (let i = 0; i < 120; i++) {
        const text = existsSync(files.logFile) ? readFileSync(files.logFile, 'utf8') : '';
        if (text.includes('armed')) return files;
        if (text.includes('watchdog failed')) throw new Error(`the watchdog did not start: ${text.trim().split('\n').pop()}`);
        await realSleep(250);
    }
    throw new Error(`the watchdog did not start (${files.logFile}): refusing to create anything`);
}

/**
 * KEY=value lines from the repo's .env.test, then ~/.config/asap-vps/credentials.env
 * (or $ASAP_VPS_CREDENTIALS), both outside git: what is already set wins, so
 * the environment first, then .env.test (jest loads it too), then the
 * credentials file for what those leave unset. An empty value is no key.
 * Nothing is printed.
 */
export function loadCredentials(files = [join(__dirname, '..', '..', '.env.test'), process.env.ASAP_VPS_CREDENTIALS ?? join(homedir(), '.config', 'asap-vps', 'credentials.env')]): void {
    for (const file of files) {
        if (!existsSync(file)) continue;
        if (statSync(file).mode & 0o077) console.error(`warning: ${file} is readable by others; chmod 600 it`);
        for (const line of readFileSync(file, 'utf8').split('\n')) {
            const m = /^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
            const value = m?.[2].replace(/^(['"])(.*)\1$/, '$2');
            if (!m || !value || process.env[m[1]]) continue;
            process.env[m[1]] = value;
        }
    }
}

/** The provider, with its key from the environment (PROVIDERS[id].keyEnv) and the other settings it reads from it (paramsEnv: Scaleway's Project). */
export function providerFromEnv(id: string): AnyProvider {
    const info = providerInfo(id);
    const params = providerParams(info, process.env);
    if (!params) throw new Error(`no ${info.keyEnv} in the environment, the credentials file or .env.test`);
    return info.create(params);
}

// ── which live suites run ──────────────────────────────────────────────────

/**
 * The live suites run only when asked:
 *   ASAP_VPS_LIVE=runpod,vast,lambda,digitalocean,scaleway,digitalocean-cpu,scaleway-cpu,digitalocean-vps,scaleway-vps (or all)
 *                                 (<provider>-cpu: the provider's lifecycle on its cheapest CPU server, for cents)
 *   ASAP_VPS_LIVE_FREE=1          only what costs nothing: no server, no image
 *   ASAP_VPS_LIVE_MAX_PRICE=1     the most a rented GPU may cost, USD per hour
 *   ASAP_VPS_LIVE_IMAGES=0        skip the image phase of DigitalOcean and Scaleway (tens of minutes)
 */
export const LIVE_TARGETS = ['digitalocean', 'runpod', 'vast', 'lambda', 'scaleway', 'digitalocean-cpu', 'scaleway-cpu', 'digitalocean-vps', 'scaleway-vps'];

export function liveRequested(target: string): boolean {
    const asked = (process.env.ASAP_VPS_LIVE ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    for (const a of asked) {
        if (a !== 'all' && !LIVE_TARGETS.includes(a)) throw new Error(`ASAP_VPS_LIVE names "${a}": use ${LIVE_TARGETS.join(', ')} or all`);
    }
    return asked.includes('all') || asked.includes(target);
}

export function liveOptions(): { freeOnly: boolean, maxPricePerHour: number, images: boolean } {
    const maxPricePerHour = Number(process.env.ASAP_VPS_LIVE_MAX_PRICE ?? 1);
    if (!(maxPricePerHour > 0)) throw new Error('ASAP_VPS_LIVE_MAX_PRICE must be a price in USD per hour, e.g. 1');
    return {
        freeOnly: /^(1|true|yes)$/i.test(process.env.ASAP_VPS_LIVE_FREE ?? ''),
        maxPricePerHour,
        images: !/^(0|false|no)$/i.test(process.env.ASAP_VPS_LIVE_IMAGES ?? ''),
    };
}
