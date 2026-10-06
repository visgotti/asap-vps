// Shared plumbing for the fake provider APIs: each fake is a fetch() that
// answers like its provider's REST API, written from that provider's spec.

import { generateKeyPairSync, randomUUID } from 'crypto';
import { toOpenSSHPublicKey } from '../../Core/utils';

export type FakeCall = { method: string, host: string, path: string, body?: any, auth?: string, headers?: Record<string, string> };

export type FakeApi = {
    fetchImpl: typeof fetch,
    calls: FakeCall[],
    /** Servers that exist at the provider right now (not deleted). */
    liveServers(): number,
    /**
     * Whether the server reachable at `host` is up and accepts this public key (an
     * OpenSSH line) right now, for a fake that models which keys a server
     * authorizes (Scaleway applies its Project's keys at every boot); absent: any
     * key does. Asking is a request like any other: time passes.
     */
    authorized?(host: string, publicKey: string): boolean,
};

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
