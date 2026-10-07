// What an image reference says about the registry it is pulled from, for the
// login a private image needs (CreateServerOptions.registryAuth).

import { createHash, createHmac } from 'crypto';
import type { RegistryAuth } from '../../types';
import type { FetchImpl } from './http';

/** Docker Hub: where an image reference that names no host is pulled from. */
export const DOCKER_HUB = 'docker.io';

/**
 * The registry host an image reference names, as Docker reads it: the first
 * part is a host when it has a dot or a port, or is `localhost`
 * ('ghcr.io/acme/app:1' -> 'ghcr.io', 'localhost:5000/app' -> 'localhost:5000');
 * anything else is Docker Hub's ('acme/app', 'ubuntu:24.04').
 */
export function registryHost(image: string): string {
    const slash = image.indexOf('/');
    if (slash < 0) return DOCKER_HUB;
    const first = image.slice(0, slash);
    return first.includes('.') || first.includes(':') || first === 'localhost' ? first : DOCKER_HUB;
}

/** The host a login is for: the one it names, else the image's. */
export function registryOf(auth: RegistryAuth, image: string): string {
    return auth.server?.trim() || registryHost(image);
}

/**
 * The name a stored login is kept under (RunPod keeps them by name, and never
 * shows a password again): the same host, user and password give the same name,
 * so one stored login serves every server that uses them, and a new password
 * gives a new one. The password enters only through an HMAC keyed by `secret`
 * (the account's API key), so the name gives nothing to guess it by.
 */
export function registryAuthName(auth: RegistryAuth, host: string, secret: string): string {
    const digest = createHmac('sha256', secret).update(`${host}\n${auth.username}\n${auth.password}`).digest('hex').slice(0, 16);
    return `asap-vps:${auth.username}@${host}:${digest}`;
}

// ── the registry HTTP API (Docker Registry v2 / OCI distribution) ───────────

/** An image reference, read: the registry's API host, the repository, and a tag or digest. */
export type ImageRef = { host: string, repository: string, reference: string };

/** Docker Hub's API host, which `docker.io` stands for. */
const DOCKER_HUB_API = 'registry-1.docker.io';

/** The media types a manifest read accepts: an index (several platforms) or one image's manifest, OCI or Docker. */
const MANIFEST_TYPES = [
    'application/vnd.oci.image.index.v1+json', 'application/vnd.docker.distribution.manifest.list.v2+json',
    'application/vnd.oci.image.manifest.v1+json', 'application/vnd.docker.distribution.manifest.v2+json',
];

/**
 * An image reference as the registry's API addresses it: Docker Hub's API host
 * for docker.io, `library/` for an official image, `latest` when it names no
 * tag ('busybox' -> registry-1.docker.io, library/busybox, latest;
 * 'ghcr.io/acme/app@sha256:..' -> ghcr.io, acme/app, sha256:..).
 */
export function parseImageRef(image: string): ImageRef {
    const host = registryHost(image);
    let rest = image.startsWith(`${host}/`) ? image.slice(host.length + 1) : image;
    let reference = 'latest';
    const at = rest.indexOf('@');
    if (at >= 0) {
        reference = rest.slice(at + 1);
        rest = rest.slice(0, at);
    } else {
        const colon = rest.lastIndexOf(':');
        if (colon > rest.lastIndexOf('/')) {
            reference = rest.slice(colon + 1);
            rest = rest.slice(0, colon);
        }
    }
    const hub = host === DOCKER_HUB;
    return { host: hub ? DOCKER_HUB_API : host, repository: hub && !rest.includes('/') ? `library/${rest}` : rest, reference };
}

/** A manifest as read: its media type, its digest, and its exact bytes (a manifest is written back byte for byte). */
export type Manifest = { mediaType: string, digest: string, bytes: Uint8Array, json: any };

/**
 * A client of one registry's HTTP API, logged in with `auth` (anonymous
 * without): the Bearer-token handshake its 401 asks for (a token per
 * repository and scope, basic credentials for the token), and the reads and
 * writes an image copy, a tag list and a delete take.
 */
export class RegistryClient {
    private readonly tokens = new Map<string, string>();
    private readonly fetchImpl: FetchImpl;

    constructor(readonly host: string, private readonly auth?: RegistryAuth, fetchImpl?: FetchImpl, private readonly sleep: (ms: number) => Promise<unknown> = (ms) => new Promise((r) => setTimeout(r, ms))) {
        const send = fetchImpl ?? fetch;
        // A request that fails on the way (a reset, a timeout) or that the registry fails (5xx, 429) is sent again, up to
        // 4 times in all, a second, two, four apart: each is whole (a blob goes in one PUT, by its digest), so sending it
        // again is safe. What the network said is kept: `fetch failed` alone names nothing.
        this.fetchImpl = async (url, init) => {
            for (let attempt = 1; ; attempt++) {
                try {
                    const r = await send(url, init);
                    if ((r.status < 500 && r.status !== 429) || attempt === 4) return r;
                    await r.body?.cancel().catch(() => undefined);
                } catch (e) {
                    const cause = (e as { cause?: { code?: string, message?: string } }).cause;
                    if (attempt === 4) throw new Error(`registry ${this.host}: ${(init?.method ?? 'GET')} ${String(url).replace(/[?#].*$/, '')}: ${(e as Error).message}${cause ? ` (${cause.code ?? cause.message})` : ''}`);
                }
                await this.sleep(1000 * 2 ** (attempt - 1));
            }
        };
    }

    /** One request to the API, with the token for `repository` and `scope`, fetched once a 401 asks for one. */
    private async request(repository: string, scope: 'pull' | 'pull,push' | '*', path: string, init: RequestInit = {}): Promise<Response> {
        const url = `https://${this.host}/v2/${repository}${path}`;
        const key = `${repository} ${scope}`;
        const send = () => this.fetchImpl(url, { ...init, headers: { ...(init.headers as Record<string, string>), ...(this.tokens.has(key) ? { authorization: `Bearer ${this.tokens.get(key)}` } : {}) } });
        let r = await send();
        if (r.status !== 401 || this.tokens.has(key)) return r;
        const challenge = r.headers.get('www-authenticate') ?? '';
        const basic = this.auth ? `Basic ${Buffer.from(`${this.auth.username}:${this.auth.password}`).toString('base64')}` : undefined;
        if (/^basic/i.test(challenge)) {
            if (!basic) return r;
            this.tokens.set(key, '');
            return this.fetchImpl(url, { ...init, headers: { ...(init.headers as Record<string, string>), authorization: basic } });
        }
        const params = Object.fromEntries([...challenge.matchAll(/(\w+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
        if (!params.realm) return r;
        const tokenUrl = new URL(params.realm);
        if (params.service) tokenUrl.searchParams.set('service', params.service);
        tokenUrl.searchParams.set('scope', `repository:${repository}:${scope}`);
        const t = await this.fetchImpl(tokenUrl.toString(), { headers: basic ? { authorization: basic } : {} });
        if (!t.ok) throw new Error(`registry ${this.host}: the token for ${repository} (${scope}) was refused: ${t.status} ${await t.text().catch(() => '')}`);
        const body = await t.json() as { token?: string, access_token?: string };
        this.tokens.set(key, body.token ?? body.access_token ?? '');
        r = await send();
        return r;
    }

    private static async fail(r: Response, what: string): Promise<never> {
        throw new Error(`${what}: ${r.status} ${(await r.text().catch(() => '')).slice(0, 300)}`);
    }

    /**
     * Whether a read found nothing: a 404, or, with a login the registry took
     * (a bad one fails at its token), a 401: a registry answers so for a
     * repository that is not there (Scaleway's, once its last tag is deleted,
     * observed 2026-10-07; Docker Hub's).
     */
    private nothing(r: Response): boolean {
        return r.status === 404 || (r.status === 401 && !!this.auth);
    }

    /** The manifest `reference` names (a tag or a digest), as it is stored; null when there is none. */
    async manifest(repository: string, reference: string): Promise<Manifest | null> {
        const r = await this.request(repository, 'pull', `/manifests/${reference}`, { headers: { accept: MANIFEST_TYPES.join(', ') } });
        if (this.nothing(r)) return null;
        if (!r.ok) return RegistryClient.fail(r, `manifest ${this.host}/${repository}:${reference}`);
        const bytes = new Uint8Array(await r.arrayBuffer());
        const json = JSON.parse(Buffer.from(bytes).toString('utf8'));
        const mediaType = json.mediaType ?? r.headers.get('content-type') ?? MANIFEST_TYPES[2];
        const digest = r.headers.get('docker-content-digest') ?? `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
        return { mediaType, digest, bytes, json };
    }

    /** One image's manifest: the reference's own, or, for an index, the entry for `platform` (default linux/amd64). */
    async imageManifest(repository: string, reference: string, platform = { os: 'linux', architecture: 'amd64' }): Promise<Manifest> {
        const m = await this.manifest(repository, reference);
        if (!m) throw new Error(`no image ${this.host}/${repository}:${reference}`);
        if (!Array.isArray(m.json.manifests)) return m;
        const entry = m.json.manifests.find((x: any) => x.platform?.os === platform.os && x.platform?.architecture === platform.architecture);
        if (!entry) throw new Error(`image ${this.host}/${repository}:${reference} has no ${platform.os}/${platform.architecture} manifest`);
        const one = await this.manifest(repository, entry.digest);
        if (!one) throw new Error(`image ${this.host}/${repository}@${entry.digest} is listed but not there`);
        return one;
    }

    async blob(repository: string, digest: string): Promise<Uint8Array> {
        const r = await this.request(repository, 'pull', `/blobs/${digest}`);
        if (!r.ok) return RegistryClient.fail(r, `blob ${this.host}/${repository}@${digest}`);
        return new Uint8Array(await r.arrayBuffer());
    }

    async hasBlob(repository: string, digest: string): Promise<boolean> {
        const r = await this.request(repository, 'pull,push', `/blobs/${digest}`, { method: 'HEAD' });
        return r.ok;
    }

    /** Uploads a blob in one request (POST for an upload, then PUT with its digest), unless the repository has it. */
    async putBlob(repository: string, digest: string, bytes: Uint8Array): Promise<void> {
        if (await this.hasBlob(repository, digest)) return;
        const start = await this.request(repository, 'pull,push', '/blobs/uploads/', { method: 'POST', headers: { 'content-length': '0' } });
        if (start.status !== 202) return RegistryClient.fail(start, `upload to ${this.host}/${repository}`);
        const location = new URL(start.headers.get('location') ?? '', `https://${this.host}`);
        location.searchParams.set('digest', digest);
        const put = await this.request(repository, 'pull,push', location.pathname.replace(`/v2/${repository}`, '') + location.search, {
            method: 'PUT', headers: { 'content-type': 'application/octet-stream', 'content-length': String(bytes.byteLength) }, body: Buffer.from(bytes),
        });
        if (put.status !== 201) return RegistryClient.fail(put, `blob ${digest} to ${this.host}/${repository}`);
    }

    async putManifest(repository: string, tag: string, m: Pick<Manifest, 'mediaType' | 'bytes'>): Promise<string> {
        const r = await this.request(repository, 'pull,push', `/manifests/${tag}`, { method: 'PUT', headers: { 'content-type': m.mediaType }, body: Buffer.from(m.bytes) });
        if (r.status !== 201) return RegistryClient.fail(r, `manifest ${this.host}/${repository}:${tag}`);
        return r.headers.get('docker-content-digest') ?? `sha256:${createHash('sha256').update(m.bytes).digest('hex')}`;
    }

    /** The repository's tags; [] when it has none (or does not exist). */
    async tags(repository: string): Promise<string[]> {
        const r = await this.request(repository, 'pull', '/tags/list');
        if (this.nothing(r)) return [];
        if (!r.ok) return RegistryClient.fail(r, `tags of ${this.host}/${repository}`);
        return (JSON.parse(await r.text()) as { tags?: string[] | null }).tags ?? [];
    }

    /** The digest of the manifest `reference` names (a HEAD: on Docker Hub, no pull is counted); null when there is none. */
    async digest(repository: string, reference: string): Promise<string | null> {
        const r = await this.request(repository, 'pull', `/manifests/${reference}`, { method: 'HEAD', headers: { accept: MANIFEST_TYPES.join(', ') } });
        if (this.nothing(r)) return null;
        if (!r.ok) return RegistryClient.fail(r, `manifest ${this.host}/${repository}:${reference}`);
        return r.headers.get('docker-content-digest') ?? (await this.manifest(repository, reference))?.digest ?? null;
    }

    /** Deletes the manifest a digest names (its tags go with it); false when it was not there. */
    async deleteManifest(repository: string, digest: string): Promise<boolean> {
        const r = await this.request(repository, '*', `/manifests/${digest}`, { method: 'DELETE' });
        if (r.status === 404) return false;
        if (r.status !== 202 && r.status !== 200) return RegistryClient.fail(r, `delete of ${this.host}/${repository}@${digest}`);
        return true;
    }
}

/**
 * Copies one image (its linux/amd64 manifest, config and layers) from one
 * registry to another, under `to`'s tag: the way to put a public image into a
 * private registry without Docker. The digest of the manifest written.
 */
export async function copyRegistryImage(from: string, to: string, o: { fromAuth?: RegistryAuth, toAuth?: RegistryAuth, fetchImpl?: FetchImpl } = {}): Promise<string> {
    const src = parseImageRef(from);
    const dst = parseImageRef(to);
    const reader = new RegistryClient(src.host, o.fromAuth, o.fetchImpl);
    const writer = new RegistryClient(dst.host, o.toAuth, o.fetchImpl);
    const m = await reader.imageManifest(src.repository, src.reference);
    for (const d of [m.json.config?.digest, ...(m.json.layers ?? []).map((l: { digest: string }) => l.digest)].filter(Boolean) as string[]) {
        if (await writer.hasBlob(dst.repository, d)) continue;
        await writer.putBlob(dst.repository, d, await reader.blob(src.repository, d));
    }
    return writer.putManifest(dst.repository, dst.reference, m);
}

/** A Scaleway registry's host: its region (rg.fr-par.scw.cloud -> fr-par). */
const SCALEWAY_REGISTRY = /^rg\.([a-z]+-[a-z]+)\.scw\.cloud$/;

/**
 * Deletes the image a reference names, every tag of it with it: false when
 * it was not there. Through the Registry API (a DELETE of its manifest), or,
 * for a Scaleway registry (rg.<region>.scw.cloud, whose login is an API key),
 * through Scaleway's registry API: its Registry API refuses a DELETE whatever
 * the key and the scope (checked 2026-10-07). A registry that deletes nothing
 * through its API (Docker Hub, ghcr.io) is an error saying where to delete it.
 */
export async function deleteRegistryImage(reference: string, auth: RegistryAuth, o: { fetchImpl?: FetchImpl, sleep?: (ms: number) => Promise<unknown> } = {}): Promise<boolean> {
    const ref = parseImageRef(reference);
    const scaleway = SCALEWAY_REGISTRY.exec(ref.host);
    if (scaleway) return deleteScalewayTags(scaleway[1], ref, auth.password, o.fetchImpl ?? fetch);
    const registry = new RegistryClient(ref.host, auth, o.fetchImpl, o.sleep);
    const digest = await registry.digest(ref.repository, ref.reference);
    if (!digest) return false;
    try {
        return await registry.deleteManifest(ref.repository, digest);
    } catch (e) {
        if (/: (401|403|405) /.test((e as Error).message)) throw new Error(`${ref.host} deletes no image through the Registry API (${(e as Error).message.split(': ').pop()}): delete ${reference} with its own tools`);
        throw e;
    }
}

/** The tags of `ref`'s image (every tag of the same digest) deleted through Scaleway's registry API, with the secret key the login holds. */
async function deleteScalewayTags(region: string, ref: ImageRef, secretKey: string, fetchImpl: FetchImpl): Promise<boolean> {
    const api = async (method: string, path: string): Promise<any> => {
        const r = await fetchImpl(`https://api.scaleway.com/registry/v1/regions/${region}${path}`, { method, headers: { 'x-auth-token': secretKey } });
        if (!r.ok) throw new Error(`Scaleway registry ${method} ${path.replace(/\?.*$/, '')}: ${r.status} ${(await r.text().catch(() => '')).slice(0, 200)}`);
        return r.status === 204 ? null : r.json();
    };
    const [namespace, ...rest] = ref.repository.split('/');
    const name = rest.join('/');
    const ns = ((await api('GET', `/namespaces?name=${encodeURIComponent(namespace)}&page_size=100`)).namespaces as Array<{ id: string, name: string }>).find((n) => n.name === namespace);
    const image = ns && ((await api('GET', `/images?namespace_id=${ns.id}&name=${encodeURIComponent(name)}&page_size=100`)).images as Array<{ id: string, name: string }>).find((i) => i.name === name);
    if (!image) return false;
    const tags = (await api('GET', `/images/${image.id}/tags?page_size=100`)).tags as Array<{ id: string, name: string, digest: string }>;
    const tag = tags.find((t) => t.name === ref.reference);
    if (!tag) return false;
    for (const t of tags.filter((x) => x.digest === tag.digest)) await api('DELETE', `/tags/${t.id}?force=true`);
    return true;
}
