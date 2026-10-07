import { fakeRegistry } from '../../testing/fakes/registry';
import { copyRegistryImage, deleteRegistryImage, DOCKER_HUB, parseImageRef, RegistryClient, registryAuthName, registryHost, registryOf } from './registry';

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

describe('deleteRegistryImage: an image, every tag of it, through the Registry API or Scaleway\'s own', () => {
    const auth = { username: 'pusher', password: 'secret' };

    it('reads a digest with a HEAD, deletes the manifest (its tags go with it), and finds nothing the second time', async () => {
        const r = fakeRegistry('reg.example', { users: { pusher: 'secret' } });
        const digest = r.push('acme/snaps', 'v1');
        r.tags.get('acme/snaps')!.set('alias', digest);
        expect(await new RegistryClient('reg.example', auth, r.fetchImpl).digest('acme/snaps', 'v1')).toBe(digest);
        expect(await new RegistryClient('reg.example', auth, r.fetchImpl).digest('acme/snaps', 'none')).toBeNull();
        expect(r.calls.filter((c) => c.path.includes('/manifests/')).map((c) => c.method)).toEqual(['HEAD', 'HEAD', 'HEAD', 'HEAD']);
        expect(await deleteRegistryImage('reg.example/acme/snaps:v1', auth, { fetchImpl: r.fetchImpl })).toBe(true);
        expect([...r.tags.get('acme/snaps')!.keys()]).toEqual([]);
        expect(await deleteRegistryImage('reg.example/acme/snaps:v1', auth, { fetchImpl: r.fetchImpl })).toBe(false);
    });

    it('a registry that deletes nothing through the Registry API is an error that says where to delete it', async () => {
        const r = fakeRegistry('hub.example', { users: { pusher: 'secret' } });
        r.push('acme/snaps', 'v1');
        const refusing = (async (input: string | URL | Request, init?: RequestInit) => (init?.method === 'DELETE'
            ? new Response('{"errors":[{"code":"UNSUPPORTED"}]}', { status: 405 }) : r.fetchImpl(input, init))) as typeof fetch;
        await expect(deleteRegistryImage('hub.example/acme/snaps:v1', auth, { fetchImpl: refusing, sleep: async () => {} }))
            .rejects.toThrow(/^hub\.example deletes no image through the Registry API \(405 .*UNSUPPORTED.*\): delete hub\.example\/acme\/snaps:v1 with its own tools$/);
        const broken = (async (input: string | URL | Request, init?: RequestInit) => (init?.method === 'DELETE' ? new Response('nope', { status: 400 }) : r.fetchImpl(input, init))) as typeof fetch;
        await expect(deleteRegistryImage('hub.example/acme/snaps:v1', auth, { fetchImpl: broken, sleep: async () => {} })).rejects.toThrow(/: 400 nope/);
    });

    it('a Scaleway registry\'s image goes through Scaleway\'s API, with the key the login holds: every tag of its digest', async () => {
        const calls: Array<{ method: string, path: string, token: string | null }> = [];
        const tags = [{ id: 't1', name: 'v1', digest: 'sha256:a' }, { id: 't2', name: 'instance_9_at_x', digest: 'sha256:a' }, { id: 't3', name: 'v2', digest: 'sha256:b' }];
        const scw = (async (input: string | URL | Request, init?: RequestInit) => {
            const u = new URL(String(input));
            calls.push({ method: init?.method ?? 'GET', path: `${u.pathname}${u.search}`, token: new Headers(init?.headers).get('x-auth-token') });
            const p = u.pathname.replace('/registry/v1/regions/nl-ams', '');
            if (p === '/namespaces') return Response.json({ namespaces: [{ id: 'ns-other', name: 'teamx' }, { id: 'ns-1', name: 'team' }] });
            if (p === '/images') return Response.json({ images: u.searchParams.get('namespace_id') === 'ns-1' ? [{ id: 'img-1', name: 'snaps' }] : [] });
            if (p === '/images/img-1/tags') return Response.json({ tags });
            if (init?.method === 'DELETE' && /^\/tags\/t\d$/.test(p)) return new Response(null, { status: 204 });
            return new Response('{"message":"no route"}', { status: 404 });
        }) as typeof fetch;
        expect(await deleteRegistryImage('rg.nl-ams.scw.cloud/team/snaps:v1', { username: 'nologin', password: 'scw-secret' }, { fetchImpl: scw })).toBe(true);
        expect(calls.filter((c) => c.method === 'DELETE').map((c) => c.path)).toEqual(['/registry/v1/regions/nl-ams/tags/t1?force=true', '/registry/v1/regions/nl-ams/tags/t2?force=true']);
        expect(calls.every((c) => c.token === 'scw-secret')).toBe(true);
        // Not there: a tag, an image or a namespace it does not have.
        expect(await deleteRegistryImage('rg.nl-ams.scw.cloud/team/snaps:none', { username: 'nologin', password: 'scw-secret' }, { fetchImpl: scw })).toBe(false);
        expect(await deleteRegistryImage('rg.nl-ams.scw.cloud/team/other:v1', { username: 'nologin', password: 'scw-secret' }, { fetchImpl: scw })).toBe(false);
        expect(await deleteRegistryImage('rg.nl-ams.scw.cloud/nobody/snaps:v1', { username: 'nologin', password: 'scw-secret' }, { fetchImpl: scw })).toBe(false);
        // Scaleway refusing says what it said.
        const denied = (async () => new Response('{"message":"permission denied"}', { status: 403 })) as typeof fetch;
        await expect(deleteRegistryImage('rg.nl-ams.scw.cloud/team/snaps:v1', { username: 'nologin', password: 'bad' }, { fetchImpl: denied }))
            .rejects.toThrow('Scaleway registry GET /namespaces: 403 {"message":"permission denied"}');
    });
});

describe('a read that finds nothing', () => {
    it('is a 404, or a 401 to a login the registry took (Scaleway\'s answer for a repository that is not there); without a login a 401 is an error', async () => {
        const r = fakeRegistry('rg.example', { users: { pusher: 'secret' }, missingIsUnauthorized: true });
        const c = new RegistryClient('rg.example', { username: 'pusher', password: 'secret' }, r.fetchImpl);
        expect(await c.tags('team/gone')).toEqual([]);
        expect(await c.manifest('team/gone', 'v1')).toBeNull();
        expect(await c.digest('team/gone', 'v1')).toBeNull();
        r.push('team/here', 'v1');
        expect(await c.tags('team/here')).toEqual(['v1']);
        await expect(new RegistryClient('rg.example', undefined, r.fetchImpl).manifest('team/here', 'v1')).rejects.toThrow(/manifest rg\.example\/team\/here:v1: 401/);
        // A login the registry refuses fails at its token, not as nothing.
        await expect(new RegistryClient('rg.example', { username: 'pusher', password: 'wrong' }, r.fetchImpl).tags('team/here')).rejects.toThrow(/the token for team\/here \(pull\) was refused/);
    });
});
