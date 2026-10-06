import { createHash } from 'crypto';
import { copyRegistryImage, DOCKER_HUB, parseImageRef, RegistryClient, registryAuthName, registryHost, registryOf } from './registry';

describe('registryHost: the registry an image reference names', () => {
    it.each([
        ['ubuntu', DOCKER_HUB],
        ['ubuntu:24.04', DOCKER_HUB],
        ['acme/app', DOCKER_HUB],
        ['acme/app:1.2', DOCKER_HUB],
        ['nvidia/cuda:12.8.1-base-ubuntu24.04', DOCKER_HUB],
        ['docker.io/acme/app', 'docker.io'],
        ['ghcr.io/acme/app:1', 'ghcr.io'],
        ['123456789012.dkr.ecr.us-east-1.amazonaws.com/app@sha256:abc', '123456789012.dkr.ecr.us-east-1.amazonaws.com'],
        ['localhost/app', 'localhost'],
        ['localhost:5000/app', 'localhost:5000'],
        ['registry:5000/team/app', 'registry:5000'],
    ])('%s -> %s', (image, host) => {
        expect(registryHost(image)).toBe(host);
    });
});

describe('registryOf: the host a login is for', () => {
    it('is the one the login names, else the image\'s', () => {
        expect(registryOf({ username: 'u', password: 'p', server: ' ghcr.io ' }, 'acme/app')).toBe('ghcr.io');
        expect(registryOf({ username: 'u', password: 'p', server: ' ' }, 'ghcr.io/acme/app')).toBe('ghcr.io');
        expect(registryOf({ username: 'u', password: 'p' }, 'acme/app')).toBe(DOCKER_HUB);
    });
});

describe('registryAuthName: the name a stored login is kept under', () => {
    const auth = { username: 'bot', password: 'ghp_secret' };

    it('is the same for the same host, user, password and key, and names the user and host', () => {
        const name = registryAuthName(auth, 'ghcr.io', 'key-1');
        expect(name).toBe(registryAuthName({ ...auth }, 'ghcr.io', 'key-1'));
        expect(name).toMatch(/^asap-vps:bot@ghcr\.io:[0-9a-f]{16}$/);
    });

    it('changes with the password, the host, the user and the key', () => {
        const name = registryAuthName(auth, 'ghcr.io', 'key-1');
        expect(registryAuthName({ ...auth, password: 'ghp_rotated' }, 'ghcr.io', 'key-1')).not.toBe(name);
        expect(registryAuthName(auth, 'docker.io', 'key-1')).not.toBe(name);
        expect(registryAuthName({ ...auth, username: 'other' }, 'ghcr.io', 'key-1')).not.toBe(name);
        expect(registryAuthName(auth, 'ghcr.io', 'key-2')).not.toBe(name);
    });

    it('holds nothing of the password', () => {
        expect(registryAuthName(auth, 'ghcr.io', 'key-1')).not.toContain('secret');
    });
});

// ── the registry HTTP API, against a fake registry ──────────────────────────

/**
 * A registry as Docker Hub, ghcr.io and Scaleway's answer: a 401 with a Bearer
 * challenge, a token for a repository and scope (anonymous pulls where
 * `publicRepos` says so, basic credentials for the rest), blobs uploaded in a
 * POST then a PUT with their digest (checked), manifests by tag or digest.
 */
function fakeRegistry(host: string, o: { users?: Record<string, string>, publicRepos?: string[] } = {}) {
    const sha = (b: Uint8Array | string) => `sha256:${createHash('sha256').update(b).digest('hex')}`;
    const blobs = new Map<string, Map<string, Uint8Array>>();
    const manifests = new Map<string, Map<string, { type: string, bytes: Uint8Array }>>();
    const tags = new Map<string, Map<string, string>>();
    const tokens = new Map<string, { repo: string, actions: string[] }>();
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
            const actions = known ? scope.split(',') : (o.publicRepos ?? []).includes(repo) ? ['pull'] : [];
            const token = `t${tokens.size}`;
            tokens.set(token, { repo, actions });
            return Response.json({ token });
        }
        const m = /^\/v2\/(.+?)\/(manifests|blobs|tags)\/(.*)$/.exec(u.pathname);
        if (!m) return new Response(null, { status: 404 });
        const [, repo, kind, rest] = m;
        const need = method === 'GET' || method === 'HEAD' ? 'pull' : method === 'DELETE' ? '*' : 'push';
        const t = tokens.get(/^Bearer (.+)$/.exec(headers.authorization ?? '')?.[1] ?? '');
        if (!t || t.repo !== repo || !(t.actions.includes(need) || t.actions.includes('*'))) {
            return new Response(null, { status: 401, headers: { 'www-authenticate': `Bearer realm="https://auth.${host}/token",service="${host}",scope="repository:${repo}:${need}"` } });
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
    return { fetchImpl, seed, calls, blobs, tags };
}

/** One fetch for two registries: each request to the registry its host names. */
const both = (...registries: Array<{ host: string, r: ReturnType<typeof fakeRegistry> }>) =>
    ((input: string | URL | Request, init?: RequestInit) => {
        const host = new URL(String(input)).host;
        return registries.find((x) => host === x.host || host === `auth.${x.host}`)!.r.fetchImpl(input, init);
    }) as typeof fetch;

describe('parseImageRef: an image reference as the registry API addresses it', () => {
    it.each([
        ['busybox', { host: 'registry-1.docker.io', repository: 'library/busybox', reference: 'latest' }],
        ['busybox:1.36', { host: 'registry-1.docker.io', repository: 'library/busybox', reference: '1.36' }],
        ['acme/app:2', { host: 'registry-1.docker.io', repository: 'acme/app', reference: '2' }],
        ['docker.io/library/ubuntu:24.04', { host: 'registry-1.docker.io', repository: 'library/ubuntu', reference: '24.04' }],
        ['ghcr.io/acme/app@sha256:abc', { host: 'ghcr.io', repository: 'acme/app', reference: 'sha256:abc' }],
        ['localhost:5000/team/app', { host: 'localhost:5000', repository: 'team/app', reference: 'latest' }],
        ['rg.fr-par.scw.cloud/ns/app:1', { host: 'rg.fr-par.scw.cloud', repository: 'ns/app', reference: '1' }],
    ])('%s', (image, ref) => {
        expect(parseImageRef(image)).toEqual(ref);
    });
});

describe('RegistryClient and copyRegistryImage', () => {
    const SRC = 'src.example';
    const DST = 'dst.example';
    const push = { username: 'pusher', password: 'secret' };

    it('copies the linux/amd64 image of an index: config and layers, then the manifest byte for byte, under the new tag', async () => {
        const src = fakeRegistry(SRC, { publicRepos: ['library/busybox'] });
        const dst = fakeRegistry(DST, { users: { pusher: 'secret' } });
        const { manifestDigest, blobDigests } = src.seed('library/busybox', '1.36');
        const fetchImpl = both({ host: SRC, r: src }, { host: DST, r: dst });
        const digest = await copyRegistryImage(`${SRC}/library/busybox:1.36`, `${DST}/ns/busybox:1.36`, { toAuth: push, fetchImpl });
        expect(digest).toBe(manifestDigest);
        expect([...dst.blobs.get('ns/busybox')!.keys()].sort()).toEqual([...blobDigests].sort());
        expect(dst.tags.get('ns/busybox')?.get('1.36')).toBe(manifestDigest);
        // Read back through the API: the same manifest, listed under its tag.
        const reader = new RegistryClient(DST, push, fetchImpl);
        expect((await reader.manifest('ns/busybox', '1.36'))?.digest).toBe(manifestDigest);
        expect(await reader.tags('ns/busybox')).toEqual(['1.36']);
        // A second copy uploads no blob the repository has.
        const uploads = () => dst.calls.filter((c) => c.method === 'POST').length;
        const before = uploads();
        await copyRegistryImage(`${SRC}/library/busybox:1.36`, `${DST}/ns/busybox:again`, { toAuth: push, fetchImpl });
        expect(uploads()).toBe(before);
        expect((await reader.tags('ns/busybox')).sort()).toEqual(['1.36', 'again']);
    });

    it('a login the registry refuses is an error that names the registry, the repository and the scope; a pull it denies is a 401 back', async () => {
        const dst = fakeRegistry(DST, { users: { pusher: 'secret' } });
        const wrong = new RegistryClient(DST, { username: 'pusher', password: 'nope' }, dst.fetchImpl);
        await expect(wrong.tags('ns/app')).rejects.toThrow(`registry ${DST}: the token for ns/app (pull) was refused: 401`);
        // Anonymous, on a private repository: the token has no rights, and the read says so.
        await expect(new RegistryClient(DST, undefined, dst.fetchImpl).tags('ns/app')).rejects.toThrow(/tags of dst\.example\/ns\/app: 401/);
    });

    it('an index without linux/amd64 is refused by name; a missing image is an error, a missing manifest null', async () => {
        const src = fakeRegistry(SRC, { publicRepos: ['acme/app'] });
        src.seed('acme/app', '1');
        const c = new RegistryClient(SRC, undefined, src.fetchImpl);
        await expect(c.imageManifest('acme/app', '1', { os: 'windows', architecture: 'amd64' })).rejects.toThrow(/has no windows\/amd64 manifest/);
        await expect(c.imageManifest('acme/app', 'nope')).rejects.toThrow(`no image ${SRC}/acme/app:nope`);
        expect(await c.manifest('acme/app', 'nope')).toBeNull();
    });

    it('deletes a manifest by digest, its tags with it; deleting it again is false', async () => {
        const dst = fakeRegistry(DST, { users: { pusher: 'secret' } });
        const { manifestDigest } = dst.seed('ns/app', '1');
        const c = new RegistryClient(DST, push, dst.fetchImpl);
        const index = (await c.manifest('ns/app', '1'))!;
        expect(index.json.manifests.map((m: { digest: string }) => m.digest)).toContain(manifestDigest);
        expect(await c.deleteManifest('ns/app', index.digest)).toBe(true);
        expect(await c.tags('ns/app')).toEqual([]);
        expect(await c.deleteManifest('ns/app', index.digest)).toBe(false);
    });

    it('sends a request again when it fails on the way or the registry fails it (5xx, 429), and names what the network said when it never gets through', async () => {
        const dst = fakeRegistry(DST, { users: { pusher: 'secret' } });
        dst.seed('ns/app', '1');
        const naps: number[] = [];
        const sleep = async (ms: number) => void naps.push(ms);
        const networkError = (code: string) => Object.assign(new TypeError('fetch failed'), { cause: { code } });
        // The first request is reset on the way, the second the registry fails, the rest go through.
        let sent = 0;
        const flaky = (async (input: string | URL | Request, init?: RequestInit) => {
            sent++;
            if (sent === 1) throw networkError('ECONNRESET');
            if (sent === 2) return new Response(null, { status: 503 });
            return dst.fetchImpl(input, init);
        }) as typeof fetch;
        expect(await new RegistryClient(DST, push, flaky, sleep).tags('ns/app')).toEqual(['1']);
        expect(naps).toEqual([1000, 2000]);

        const down = (async () => {
            throw networkError('ETIMEDOUT');
        }) as typeof fetch;
        naps.length = 0;
        await expect(new RegistryClient(DST, push, down, sleep).tags('ns/app'))
            .rejects.toThrow(`registry ${DST}: GET https://${DST}/v2/ns/app/tags/list: fetch failed (ETIMEDOUT)`);
        expect(naps).toEqual([1000, 2000, 4000]);
        // A registry that keeps failing: its last answer is what the caller sees.
        const failing = (async () => new Response('busy', { status: 502 })) as typeof fetch;
        await expect(new RegistryClient(DST, push, failing, sleep).tags('ns/app')).rejects.toThrow(/tags of dst\.example\/ns\/app: 502 busy/);
    });
});
