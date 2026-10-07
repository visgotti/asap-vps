// A fake container registry (the Docker Registry HTTP API v2, as Docker Hub,
// ghcr.io and Scaleway's answer it): token auth, blobs, manifests by tag or
// digest, tags, deletes. What RegistryClient's tests and a provider's fake that
// pushes images (Vast's snapshots) run against.

import { createHash } from 'crypto';

/**
 * A registry as Docker Hub, ghcr.io and Scaleway's answer: a 401 with a Bearer
 * challenge, a token for a repository and scope (anonymous pulls where
 * `publicRepos` says so, basic credentials for the rest; good for `tokenUses`
 * requests where that is set), blobs uploaded in a POST then a PUT with their
 * digest (checked), manifests by tag or digest. With `basic`, one that asks
 * for the login itself instead.
 */
export function fakeRegistry(host: string, o: {
    users?: Record<string, string>, publicRepos?: string[],
    /** A repository with no tags is given a token for nothing: a 401, not a 404 (Scaleway's, observed 2026-10-07). */
    missingIsUnauthorized?: boolean,
    /** The registry asks for the login itself with every request (`WWW-Authenticate: Basic`), and has no token endpoint: a `registry:2` behind htpasswd. */
    basic?: boolean,
    /** The requests a token is good for before it has expired (default: it never does; Docker Hub's lasts 5 minutes). */
    tokenUses?: number,
} = {}) {
    const sha = (b: Uint8Array | string) => `sha256:${createHash('sha256').update(b).digest('hex')}`;
    const blobs = new Map<string, Map<string, Uint8Array>>();
    const manifests = new Map<string, Map<string, { type: string, bytes: Uint8Array }>>();
    const tags = new Map<string, Map<string, string>>();
    const tokens = new Map<string, { repo: string, actions: string[], left: number }>();
    const calls: Array<{ method: string, path: string }> = [];
    const repoOf = <T>(m: Map<string, Map<string, T>>, r: string) => m.get(r) ?? m.set(r, new Map()).get(r)!;
    const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
        const u = new URL(String(input));
        const method = init.method ?? 'GET';
        const headers = (init.headers ?? {}) as Record<string, string>;
        calls.push({ method, path: u.pathname });
        if (u.host === `auth.${host}`) {
            const [, repo, scope] = /^repository:(.+):([^:]+)$/.exec(u.searchParams.get('scope') ?? '') ?? [];
            const basic = /^Basic (.+)$/.exec(headers.authorization ?? '')?.[1];
            const [user, pass] = basic ? Buffer.from(basic, 'base64').toString().split(':') : [];
            const known = user !== undefined && o.users?.[user] === pass;
            if (basic && !known) return new Response('{"errors":[{"code":"UNAUTHORIZED"}]}', { status: 401 });
            const missing = o.missingIsUnauthorized && !(tags.get(repo)?.size);
            const actions = known ? (missing ? [] : scope.split(',')) : (o.publicRepos ?? []).includes(repo) ? ['pull'] : [];
            const token = `t${tokens.size}`;
            tokens.set(token, { repo, actions, left: o.tokenUses ?? Infinity });
            return Response.json({ token });
        }
        const m = /^\/v2\/(.+?)\/(manifests|blobs|tags)\/(.*)$/.exec(u.pathname);
        if (!m) return new Response(null, { status: 404 });
        const [, repo, kind, rest] = m;
        const need = method === 'GET' || method === 'HEAD' ? 'pull' : method === 'DELETE' ? '*' : 'push';
        if (o.basic) {
            const login = /^Basic (.+)$/.exec(headers.authorization ?? '')?.[1];
            const [user, pass] = login ? Buffer.from(login, 'base64').toString().split(':') : [];
            if (user === undefined || o.users?.[user] !== pass) return new Response(null, { status: 401, headers: { 'www-authenticate': `Basic realm="${host}"` } });
        } else {
            const t = tokens.get(/^Bearer (.+)$/.exec(headers.authorization ?? '')?.[1] ?? '');
            // A token that has expired is no token: the challenge again.
            if (!t || t.left-- <= 0 || t.repo !== repo || !(t.actions.includes(need) || t.actions.includes('*'))) {
                return new Response(null, { status: 401, headers: { 'www-authenticate': `Bearer realm="https://auth.${host}/token",service="${host}",scope="repository:${repo}:${need}"` } });
            }
        }
        if (kind === 'tags') return Response.json({ name: repo, tags: [...repoOf(tags, repo).keys()] });
        if (kind === 'blobs' && rest === 'uploads/' && method === 'POST') return new Response(null, { status: 202, headers: { location: `/v2/${repo}/blobs/uploads/u1?_state=s` } });
        if (kind === 'blobs' && rest.startsWith('uploads/') && method === 'PUT') {
            const body = new Uint8Array(init.body as Buffer);
            if (sha(body) !== u.searchParams.get('digest')) return new Response('{"errors":[{"code":"DIGEST_INVALID"}]}', { status: 400 });
            repoOf(blobs, repo).set(sha(body), body);
            return new Response(null, { status: 201 });
        }
        if (kind === 'blobs') {
            const b = repoOf(blobs, repo).get(rest);
            if (!b) return new Response(null, { status: 404 });
            return new Response(method === 'HEAD' ? null : Buffer.from(b), { status: 200 });
        }
        // manifests
        if (method === 'PUT') {
            const bytes = new Uint8Array(init.body as Buffer);
            repoOf(manifests, repo).set(sha(bytes), { type: headers['content-type'], bytes });
            repoOf(tags, repo).set(rest, sha(bytes));
            return new Response(null, { status: 201, headers: { 'docker-content-digest': sha(bytes) } });
        }
        const digest = rest.startsWith('sha256:') ? rest : repoOf(tags, repo).get(rest);
        const found = digest ? repoOf(manifests, repo).get(digest) : undefined;
        if (method === 'DELETE') {
            if (!found) return new Response(null, { status: 404 });
            repoOf(manifests, repo).delete(digest!);
            for (const [tag, d] of repoOf(tags, repo)) if (d === digest) repoOf(tags, repo).delete(tag);
            return new Response(null, { status: 202 });
        }
        if (!found) return new Response(null, { status: 404 });
        return new Response(Buffer.from(found.bytes), { status: 200, headers: { 'content-type': found.type, 'docker-content-digest': digest! } });
    }) as typeof fetch;
    /** Seeds an image: its config, one layer, its manifest, and an index that lists it for linux/amd64 (and arm64). */
    const seed = (repo: string, tag: string) => {
        const config = Buffer.from('{"architecture":"amd64","os":"linux"}');
        const layer = Buffer.from('layer bytes');
        for (const b of [config, layer]) repoOf(blobs, repo).set(sha(b), new Uint8Array(b));
        const manifest = Buffer.from(JSON.stringify({ schemaVersion: 2, mediaType: 'application/vnd.oci.image.manifest.v1+json',
            config: { mediaType: 'application/vnd.oci.image.config.v1+json', digest: sha(config), size: config.length },
            layers: [{ mediaType: 'application/vnd.oci.image.layer.v1.tar+gzip', digest: sha(layer), size: layer.length }] }));
        repoOf(manifests, repo).set(sha(manifest), { type: 'application/vnd.oci.image.manifest.v1+json', bytes: new Uint8Array(manifest) });
        const index = Buffer.from(JSON.stringify({ schemaVersion: 2, mediaType: 'application/vnd.oci.image.index.v1+json', manifests: [
            { mediaType: 'application/vnd.oci.image.manifest.v1+json', digest: 'sha256:' + 'a'.repeat(64), size: 1, platform: { os: 'linux', architecture: 'arm64' } },
            { mediaType: 'application/vnd.oci.image.manifest.v1+json', digest: sha(manifest), size: manifest.length, platform: { os: 'linux', architecture: 'amd64' } },
        ] }));
        repoOf(manifests, repo).set(sha(index), { type: 'application/vnd.oci.image.index.v1+json', bytes: new Uint8Array(index) });
        repoOf(tags, repo).set(tag, sha(index));
        return { manifestDigest: sha(manifest), blobDigests: [sha(config), sha(layer)] };
    };
    /** Pushes an image of its own under `tag` (one layer of `content`): what a registry holds after a push, a snapshot's. */
    const push = (repo: string, tag: string, content = tag) => {
        const config = Buffer.from(JSON.stringify({ architecture: 'amd64', os: 'linux', config: { Labels: { content } } }));
        const layer = Buffer.from(`layer of ${content}`);
        for (const b of [config, layer]) repoOf(blobs, repo).set(sha(b), new Uint8Array(b));
        const manifest = Buffer.from(JSON.stringify({ schemaVersion: 2, mediaType: 'application/vnd.docker.distribution.manifest.v2+json',
            config: { mediaType: 'application/vnd.docker.container.image.v1+json', digest: sha(config), size: config.length },
            layers: [{ mediaType: 'application/vnd.docker.image.rootfs.diff.tar.gzip', digest: sha(layer), size: layer.length }] }));
        repoOf(manifests, repo).set(sha(manifest), { type: 'application/vnd.docker.distribution.manifest.v2+json', bytes: new Uint8Array(manifest) });
        repoOf(tags, repo).set(tag, sha(manifest));
        return sha(manifest);
    };
    return { fetchImpl, seed, push, calls, blobs, tags };
}

export type FakeRegistry = ReturnType<typeof fakeRegistry>;
