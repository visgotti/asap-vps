// Shared plumbing for the fake provider APIs: each fake is a fetch() that
// answers like its provider's REST API, written from that provider's spec.

import { generateKeyPairSync, randomUUID } from 'crypto';
import { toOpenSSHPublicKey } from '../../Core/utils';

export type FakeCall = { method: string, host: string, path: string, body?: any, auth?: string, headers?: Record<string, string> };

/** What the server at a host shows to a login: what a VM fake knows of that one server. */
export type FakeMachine = {
    /** Changes with each of this server's own boots (its first, its reboots, its power-ons), never with another's. */
    bootId: string,
    /** The files on its disk: what its user data wrote at its first boot, and what the image it booted from carried. */
    files: Record<string, string>,
    /** The public keys (OpenSSH lines) its sshd takes. */
    keys: string[],
};

export type FakeApi = {
    fetchImpl: typeof fetch,
    calls: FakeCall[],
    /** Servers that exist at the provider right now (not deleted). */
    liveServers(): number,
    /**
     * Whether the server reachable at `host` is up and takes this public key (an
     * OpenSSH line) right now: one of `machine(host)`'s keys. Asking is a
     * request like any other: time passes.
     */
    authorized?(host: string, publicKey: string): boolean,
    /**
     * The server whose sshd is reachable at `host` (and `port`, where servers
     * share an address) right now, as it would show it; undefined when nothing
     * answers there: no server, or one that runs no SSH server. Asking is a
     * request like any other: time passes.
     */
    machine?(host: string, port?: number): FakeMachine | undefined,
};

/**
 * The keys a script makes log in as `user`: what sshdBootScript (a
 * container's start) or authorizeKeysScript (a VM's first boot) was given. A
 * fake runs no script: it reads the one line these write, word by word as a
 * shell would. undefined for a script that names no keys for that user.
 */
export function scriptKeys(script: unknown, user: string): string[] | undefined {
    for (const line of String(script ?? '').split('\n')) {
        const m = /^\s*asap_vps_keys\s+(.*)$/.exec(line);
        if (!m) continue;
        const all = [...m[1].matchAll(/'((?:[^']|'\\'')*)'|(\S+)/g)];
        // The call's own words: what follows a bare `||`, `&&` or `;` is another command (what the script does when this one fails).
        const end = all.findIndex((w) => w[1] === undefined && /^(\|\||&&|;)$/.test(w[2]));
        const words = (end < 0 ? all : all.slice(0, end)).map((w) => (w[1] !== undefined ? w[1].replace(/'\\''/g, "'") : w[2]));
        if (words[0] === user) return words.slice(1);
    }
    return undefined;
}

/** Whether a container's start script starts an SSH server (sshdBootScript), and so answers at its port 22. */
export function startsSshd(script: unknown): boolean {
    return /^asap_vps_sshd\(\) \($/m.test(String(script ?? '')) && /^ASAP_VPS_PATH=\$PATH asap_vps_sshd \|\| /m.test(String(script ?? ''));
}

/**
 * The files a user-data script's `echo <text> > <path>` lines write: what a
 * fake VM's first boot leaves on its disk (a fake runs no script; this is the
 * one form the tests write).
 */
export function userDataFiles(userData: unknown): Record<string, string> {
    const out: Record<string, string> = {};
    for (const m of String(userData ?? '').matchAll(/\becho\s+(\S+)\s*>\s*(\S+)/g)) out[m[2]] = m[1];
    return out;
}

/** A boot id (as /proc/sys/kernel/random/boot_id reads) for a server's `n`th boot: `server` sets its first 8 hex digits. */
export function fakeBootId(server: string | number, n: number): string {
    const head = (typeof server === 'number' ? server.toString(16) : server.replace(/[^0-9a-f]/gi, '')).toLowerCase().padStart(8, '0').slice(-8);
    return `${head}-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

/**
 * A clock the waits advance, for a spec of how long something waits: while
 * it is installed Date.now() is the real time plus every pause `sleep` was
 * asked for (each on record in `slept`), so a wait of minutes ends at once
 * and reports the time it was told. `restore()` puts the real clock back.
 */
export function waitingClock() {
    const real = Date.now.bind(Date);
    const now = Date.now;
    const slept: number[] = [];
    let offset = 0;
    Date.now = () => real() + offset;
    return {
        slept,
        sleep: async (ms: number) => {
            slept.push(ms);
            offset += ms;
        },
        restore: () => {
            Date.now = now;
        },
    };
}

/** Files carried in a fake disk export (a QCOW2): written after its magic, so a byte-for-byte copy keeps them. */
export function writeDiskFiles(disk: Buffer, files: Record<string, string> = {}): void {
    const json = Buffer.from(JSON.stringify(files), 'utf8');
    disk.writeUInt32BE(json.length, 2048);
    json.copy(disk, 2052);
}

/** The files a fake disk export carries; {} for a disk with none. */
export function readDiskFiles(disk: Uint8Array): Record<string, string> {
    const b = Buffer.from(disk.buffer, disk.byteOffset, disk.byteLength);
    if (b.length < 2052) return {};
    const n = b.readUInt32BE(2048);
    if (!n || 2052 + n > b.length) return {};
    try {
        return JSON.parse(b.subarray(2052, 2052 + n).toString('utf8'));
    } catch {
        return {};
    }
}

export function json(status: number, body?: unknown, type = 'application/json', headers: Record<string, string> = {}): Response {
    return new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'content-type': type, ...headers } });
}

/** The request as the fake sees it, recorded. */
export function readRequest(calls: FakeCall[], url: string | URL | Request, init: RequestInit = {}) {
    const u = new URL(String(url));
    const method = (init.method ?? 'GET').toUpperCase();
    const headers = (init.headers ?? {}) as Record<string, string>;
    // A body is JSON unless its content type says text (cloud-init user data is sent as text/plain): that stays as it was sent.
    const raw = typeof init.body === 'string' && init.body ? init.body : undefined;
    const body = raw !== undefined && !/^(text\/|application\/octet-stream)/i.test(headers['content-type'] ?? '') ? JSON.parse(raw) : raw;
    const call: FakeCall = { method, host: u.host, path: u.pathname + u.search, body, auth: headers.authorization, headers };
    calls.push(call);
    return { u, method, body, auth: headers.authorization, headers, path: u.pathname };
}

/**
 * What one run of a container's command prints with `echo "..."`, its `$VARS`
 * read from the environment the container was given, or set by the command to
 * a fresh UUID (`BOOT=$(cat /proc/sys/kernel/random/uuid)`: a new one each run,
 * as a real container's would be): a fake container's log shows them all.
 */
export function echoed(command: unknown, env: Record<string, unknown> = {}): string[] {
    const text = Array.isArray(command) ? command.join(' ') : String(command ?? '');
    const vars: Record<string, unknown> = { ...env };
    for (const m of text.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)=\$\(cat \/proc\/sys\/kernel\/random\/uuid\)/g)) vars[m[1]] = randomUUID();
    return [...text.matchAll(/\becho\s+"([^"]*)"/g)].map((m) => m[1].replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (_, name) => String(vars[name] ?? '')));
}

/** A fresh OpenSSH ed25519 public key line. */
export function testPublicKey(comment = 'test@asap-vps'): string {
    return toOpenSSHPublicKey(generateKeyPairSync('ed25519').publicKey, comment);
}

/**
 * A fetch that follows redirects as the real one does unless asked not to
 * (`redirect: 'manual'`): the same request to the Location, its headers with
 * it (only Authorization and cookies are left behind across origins). What a
 * test that a key never leaves its host runs against.
 */
export function followingRedirects(inner: typeof fetch): typeof fetch {
    return (async (url: string | URL | Request, init?: RequestInit) => {
        let target = String(url);
        let r = await inner(target, init);
        for (let hops = 0; init?.redirect !== 'manual' && r.status >= 300 && r.status < 400 && r.headers.get('location') && hops < 5; hops++) {
            const next = new URL(r.headers.get('location')!, target);
            const headers = Object.fromEntries(new Headers(init?.headers).entries());
            if (next.origin !== new URL(target).origin) for (const h of ['authorization', 'cookie', 'proxy-authorization']) delete headers[h];
            target = next.toString();
            r = await inner(target, { ...init, headers });
        }
        return r;
    }) as typeof fetch;
}
