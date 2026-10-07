// The Scaleway API client (api.ts) against the fake of Scaleway's API
// (src/testing/fakes/scaleway.ts): zonal ids, the zones a client covers, how
// every kind of error answer Scaleway sends becomes a typed error (the types
// are the ones of Scaleway's SDKs), pagination by X-Total-Count, the Instance
// type table's cache, and a raw (text/plain) body for user data.

import { isRetriable, AuthError, CapacityError, NotFoundError, ProviderError, QuotaError } from '../../errors';
import { FAKE_SCALEWAY_PROJECT, fakeScaleway } from '../../testing/fakes/scaleway';
import { json } from '../../testing/fakes/util';
import { ScalewayApi } from './api';
import { epochMs, imageVolumes, parseZonedId, parseZones, scalewayErrorText, serverAddresses, zonedId } from './mappers';
import { SCALEWAY_ENDPOINTS } from './endpoints';
import type { ScalewayCreateServerBody, ScalewayImage, ScalewayServer, ScalewayVolume, ScalewayZone } from './types';
import { SCALEWAY_ZONES } from './types';

const noSleep = async () => {};
const ID = '9d1a2f3c-0b6e-4a52-9c36-7f3f6e2b8a10';

/** A fetch that answers every request with one status and body. */
const answering = (status: number, body: unknown, type = 'application/json') => (async () => new Response(
    typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': type } })) as unknown as typeof fetch;

const apiWith = (fetchImpl: typeof fetch) => new ScalewayApi({ apiKey: 'k', projectId: FAKE_SCALEWAY_PROJECT, fetchImpl, sleep: noSleep });

describe('zonal ids', () => {
    it('a server or image is named by its zone and its id, the way Scaleway\'s own tools write it', () => {
        expect(zonedId('fr-par-2', ID)).toBe(`fr-par-2/${ID}`);
        expect(parseZonedId(`fr-par-2/${ID}`)).toEqual({ zone: 'fr-par-2', id: ID });
        // A bare id has no zone: whoever reads it asks each zone.
        expect(parseZonedId(ID.toUpperCase())).toEqual({ id: ID });
        expect(parseZonedId(` pl-waw-3/${ID} `)).toEqual({ zone: 'pl-waw-3', id: ID });
    });

    it('anything that cannot name a Scaleway resource is nothing\'s id', () => {
        for (const bad of ['', 'nope', '1', 12345, `fr-par-9/${ID}`, `fr-par-2/${ID}/x`, `/${ID}`, `fr-par-2/`, `fr-par/${ID}`]) expect([bad, parseZonedId(bad)]).toEqual([bad, null]);
    });
});

describe('zones', () => {
    it('are all of them by default, and the ones named otherwise, in Scaleway\'s order', () => {
        expect(parseZones()).toEqual([...SCALEWAY_ZONES]);
        expect(parseZones('')).toEqual([...SCALEWAY_ZONES]);
        expect(parseZones(' , ')).toEqual([...SCALEWAY_ZONES]);
        expect(parseZones('pl-waw-2, fr-par-1')).toEqual(['fr-par-1', 'pl-waw-2']);
        expect(parseZones(['it-mil-1'])).toEqual(['it-mil-1']);
    });

    it('a region stands for its zones, without repeats', () => {
        expect(parseZones(['nl-ams'])).toEqual(['nl-ams-1', 'nl-ams-2', 'nl-ams-3']);
        expect(parseZones('fr-par-3,fr-par')).toEqual(['fr-par-1', 'fr-par-2', 'fr-par-3']);
    });

    it('a zone that does not exist is refused, naming the ones that do', () => {
        expect(() => parseZones('fr-par-7')).toThrow(/unknown Scaleway zone "fr-par-7" \(zones: fr-par-1, fr-par-2/);
        expect(() => new ScalewayApi({ apiKey: 'k', zones: 'moon-1' })).toThrow(/unknown Scaleway zone/);
    });
});

describe('ScalewayApi configuration', () => {
    it('takes a bare key; defaults every zone, no Project, and the euro rate', () => {
        const api = new ScalewayApi('secret');
        expect([api.apiKey, api.baseUrl, api.zones.length, api.projectId, api.eurToUsd]).toEqual(['secret', 'https://api.scaleway.com', SCALEWAY_ZONES.length, undefined, 1.15]);
        expect(() => new ScalewayApi('')).toThrow(/API key is required/);
    });

    it('refuses a Project that is not a Scaleway id, and a rate that is not a price', () => {
        expect(() => new ScalewayApi({ apiKey: 'k', projectId: 'my-project' })).toThrow(/not a Scaleway Project id/);
        expect(() => new ScalewayApi({ apiKey: 'k', eurToUsd: 0 })).toThrow(/eurToUsd/);
        expect(new ScalewayApi({ apiKey: 'k', projectId: ` ${FAKE_SCALEWAY_PROJECT} `, eurToUsd: 1.1 })).toMatchObject({ projectId: FAKE_SCALEWAY_PROJECT, eurToUsd: 1.1 });
    });

    it('a create that needs the Project says how to give it, before anything is sent', async () => {
        const fake = fakeScaleway();
        const api = new ScalewayApi({ apiKey: 'scw-test', fetchImpl: fake.fetchImpl, sleep: noSleep });
        expect(() => api.requireProject('add an SSH key')).toThrow(/Project is needed to add an SSH key: pass projectId \(SCW_DEFAULT_PROJECT_ID/);
        await expect(api.listSSHKeys()).rejects.toMatchObject({ code: 'project_required' });
        await expect(api.registerSSHKey(`ssh-ed25519 AAAA x`, 'k')).rejects.toBeInstanceOf(ProviderError);
        expect(fake.calls).toHaveLength(0);
    });

    it('sends the secret key in X-Auth-Token, not as a bearer token', async () => {
        const seen: Array<Record<string, string>> = [];
        const fetchImpl = (async (_url: string, init: RequestInit) => {
            seen.push(init.headers as Record<string, string>);
            return new Response(JSON.stringify({ servers: {} }), { status: 200, headers: { 'content-type': 'application/json' } });
        }) as unknown as typeof fetch;
        await new ScalewayApi({ apiKey: 'the-secret', fetchImpl, sleep: noSleep }).availability('fr-par-1');
        expect(seen[0]).toMatchObject({ 'x-auth-token': 'the-secret', accept: 'application/json' });
        expect(seen[0].authorization).toBeUndefined();
    });

    it('signs Object Storage with the access key and the secret key: the access key names the Project where one is given', async () => {
        const seen: string[] = [];
        const fetchImpl = (async (url: string, init: RequestInit) => {
            seen.push(`${new URL(url).host} ${(init.headers as Record<string, string>).authorization}`);
            return new Response(null, { status: 200 });
        }) as unknown as typeof fetch;
        await new ScalewayApi({ apiKey: 'the-secret', accessKey: 'SCWACCESS', projectId: FAKE_SCALEWAY_PROJECT, fetchImpl, sleep: noSleep }).objectStorage('nl-ams', 'a test').headBucket('b');
        await new ScalewayApi({ apiKey: 'the-secret', accessKey: 'SCWACCESS', fetchImpl, sleep: noSleep }).objectStorage('fr-par', 'a test').headBucket('b');
        expect(seen[0]).toMatch(new RegExp(`^s3\\.nl-ams\\.scw\\.cloud AWS4-HMAC-SHA256 Credential=SCWACCESS@${FAKE_SCALEWAY_PROJECT}/\\d{8}/nl-ams/s3/aws4_request`));
        expect(seen[1]).toMatch(/^s3\.fr-par\.scw\.cloud AWS4-HMAC-SHA256 Credential=SCWACCESS\/\d{8}\/fr-par\/s3\/aws4_request/);
        expect(() => new ScalewayApi({ apiKey: 'the-secret', fetchImpl, sleep: noSleep }).objectStorage('fr-par', 'copyImage')).toThrow(/copyImage goes through Object Storage, which needs the API key's access key/);
    });
});

describe('errors: every kind of answer Scaleway sends is a typed error', () => {
    // A create is a POST: never retried after a server error, so the answer below is the error.
    const create = (api: ScalewayApi) => api.createServer('fr-par-2', { name: 'x', commercial_type: 'L4-1-24G', protected: false });
    const fails = async (status: number, body: unknown, type?: string) => create(apiWith(answering(status, body, type))).then(() => { throw new Error('did not fail'); }, (e) => e);

    it('401 and 403 are the key, denied or without permission', async () => {
        const denied = await fails(401, { type: 'denied_authentication', message: 'invalid authentication', method: 'api_key', reason: 'invalid_argument' });
        expect(denied).toBeInstanceOf(AuthError);
        expect(denied).toMatchObject({ status: 401, code: 'denied_authentication', provider: 'scaleway' });
        const permissions = await fails(403, { type: 'permissions_denied', message: 'insufficient permissions', details: [{ action: 'read', resource: 'instance' }] });
        expect(permissions).toBeInstanceOf(AuthError);
        expect(permissions.message).toMatch(/permissions_denied: insufficient permissions; read instance/);
    });

    it('404 is not found: the Instance API\'s unknown_resource, and the standard not_found', async () => {
        for (const body of [{ type: 'unknown_resource', message: `Instance "${ID}" not found` }, { type: 'not_found', resource: 'volume', resource_id: ID, message: 'resource not found' }]) {
            const e = await fails(404, body);
            expect(e).toBeInstanceOf(NotFoundError);
            expect(e.code).toBe(body.type);
        }
    });

    it('a quota is a QuotaError, in the typed form and in the Instance API\'s own wording', async () => {
        const typed = await fails(400, { type: 'quotas_exceeded', message: 'quota exceeded', details: [{ resource: 'instances_gpu', quota: 0, current: 0 }] });
        expect(typed).toBeInstanceOf(QuotaError);
        expect(typed.message).toMatch(/quotas_exceeded: quota exceeded; instances_gpu 0\/0/);
        // As the live API answers it (a GPU type of an account that is not verified): a 403, which is also the status of a refusal for want of rights.
        const live = await fails(403, { type: 'quotas_exceeded', message: 'quota(s) exceeded for this resource', details: [{ resource: 'cp_servers_type_L4_1_24G', organization_id: ID }, { resource: 'cp_servers_type_L4_1_24G', project_id: ID }] });
        expect(live).toBeInstanceOf(QuotaError);
        expect(live).toMatchObject({ status: 403, code: 'quotas_exceeded' });
        expect(live.message).toBe('scaleway: POST /instance/v1/zones/fr-par-2/servers -> 403 quotas_exceeded: quota(s) exceeded for this resource; cp_servers_type_L4_1_24G');
        const legacy = await fails(400, { type: 'invalid_request_error', message: 'Quota exceeded for this resource', resource: 'instances_gpu', fields: null });
        expect(legacy).toBeInstanceOf(QuotaError);
        // The wording is what says it is a quota: an invalid request that says nothing is not one.
        expect(await fails(400, { type: 'invalid_request_error' })).not.toBeInstanceOf(QuotaError);
    });

    it('no stock is a CapacityError: typed out_of_stock, or worded as a lack of capacity', async () => {
        expect(await fails(400, { type: 'out_of_stock', message: 'resource L4-1-24G is out of stock', resource: 'L4-1-24G' })).toBeInstanceOf(CapacityError);
        expect(await fails(400, { message: 'Not enough capacity available in this zone' })).toBeInstanceOf(CapacityError);
        // An unrelated refusal is not one.
        expect(await fails(400, { type: 'invalid_arguments', message: 'bad' })).not.toBeInstanceOf(CapacityError);
    });

    it('a transient state is worth asking again; an invalid argument says which and why; the rest are plain', async () => {
        const busy = await fails(400, { type: 'transient_state', message: 'busy', resource: 'instance_server', resource_id: ID, current_state: 'starting' });
        expect(busy).toMatchObject({ code: 'transient_state', retriable: true });
        expect(busy.message).toMatch(/state starting/);
        expect(isRetriable(busy)).toBe(true);
        const invalid = await fails(400, { type: 'invalid_arguments', message: 'Invalid argument(s)', details: [{ argument_name: 'commercial_type', reason: 'constraint', help_message: 'unknown commercial type' }] });
        expect(invalid).toMatchObject({ code: 'invalid_arguments', retriable: false });
        expect(invalid.message).toMatch(/commercial_type: unknown commercial type/);
        const fields = await fails(400, { type: 'invalid_request_error', message: 'Invalid request', fields: { name: ['too long'], 'volumes.0.size': ['must be a multiple of 512'] } });
        expect(fields.message).toMatch(/name: too long; volumes\.0\.size: must be a multiple of 512/);
        expect(fields).not.toBeInstanceOf(QuotaError);
        const locked = await fails(400, { type: 'precondition_failed', precondition: 'resource_still_in_use', message: 'the volume is in use' });
        expect(locked).toMatchObject({ code: 'precondition_failed', retriable: false });
    });

    it('a server error and a rate limit are retriable; an answer that is not JSON is read as text', async () => {
        const down = await fails(503, 'upstream connect error', 'text/html');
        expect(down).toMatchObject({ status: 503, retriable: true });
        expect(down.message).toMatch(/503 .*upstream connect error/);
        expect(await fails(429, { type: 'too_many_requests', message: 'slow down' })).toMatchObject({ status: 429, retriable: true });
        expect(await fails(400, 'not json at all', 'text/plain')).toMatchObject({ status: 400, retriable: false });
    });

    it('describes an answer by its message and what its type adds', () => {
        expect(scalewayErrorText({ message: 'm', details: [{ argument_name: 'a', reason: 'required' }, { resource: 'r', quota: 2, current: 1 }, { action: 'delete', resource: 'volume' }], fields: { f: ['x'] }, current_state: 's' }))
            .toBe('m; a: required; r 1/2; delete volume; f: x; state s');
        // What an answer leaves out is named as unknown: no reason for an argument, no current count for a quota.
        expect(scalewayErrorText({ message: 'm', details: [{ argument_name: 'a' }, { resource: 'r', quota: 2 }] })).toBe('m; a: invalid; r ?/2');
        expect(scalewayErrorText({}, 'plain text')).toBe('plain text');
        expect(scalewayErrorText({ message: 'x'.repeat(900) })).toHaveLength(400);
    });
});

describe('lists', () => {
    it('reads every page of a list and stops at the count X-Total-Count gives', async () => {
        const fake = fakeScaleway({ fillerTypes: 120 });
        const api = new ScalewayApi({ apiKey: 'scw-test', fetchImpl: fake.fetchImpl, sleep: noSleep });
        expect(Object.keys(await api.serverTypes('fr-par-2'))).toHaveLength(130);
        expect(Object.keys(await api.availability('fr-par-2'))).toHaveLength(130);
        const asked = (re: RegExp) => fake.calls.map((c) => c.path).filter((p) => re.test(p));
        expect(asked(/products\/servers\?/)).toEqual(['/instance/v1/zones/fr-par-2/products/servers?per_page=100&page=1', '/instance/v1/zones/fr-par-2/products/servers?per_page=100&page=2']);
        expect(asked(/availability\?/)).toHaveLength(2);
    });

    it('a list that fills one page exactly is not asked for a second', async () => {
        const fake = fakeScaleway({ fillerTypes: 90 });
        const api = new ScalewayApi({ apiKey: 'scw-test', fetchImpl: fake.fetchImpl, sleep: noSleep });
        expect(Object.keys(await api.serverTypes('fr-par-2'))).toHaveLength(100);
        expect(fake.calls.filter((c) => /products\/servers\?/.test(c.path))).toHaveLength(1);
    });

    it('reuses an Instance type table for ten minutes, but never the stock; a failed read is not kept', async () => {
        const fake = fakeScaleway();
        let outage = 4;
        const flaky = (async (url: string, init?: RequestInit) => (outage-- > 0
            ? new Response('unavailable', { status: 503 }) : fake.fetchImpl(url, init))) as unknown as typeof fetch;
        const api = new ScalewayApi({ apiKey: 'scw-test', fetchImpl: flaky, sleep: noSleep });
        const tableReads = () => fake.calls.filter((c) => /fr-par-1\/products\/servers\?/.test(c.path)).length;
        await expect(api.serverTypes('fr-par-1')).rejects.toMatchObject({ status: 503 });
        expect(await api.serverTypes('fr-par-1')).toHaveProperty('L4-1-24G');
        await api.serverTypes('fr-par-1');
        expect(tableReads()).toBe(1);
        await api.availability('fr-par-1');
        await api.availability('fr-par-1');
        expect(fake.calls.filter((c) => /fr-par-1\/products\/servers\/availability/.test(c.path))).toHaveLength(2);
        const now = Date.now();
        const clock = jest.spyOn(Date, 'now').mockReturnValue(now + 11 * 60_000);
        try {
            await api.serverTypes('fr-par-1');
        } finally {
            clock.mockRestore();
        }
        expect(tableReads()).toBe(2);
    });
});

describe('what an answer must hold', () => {
    it('a query parameter the endpoint table does not list is refused before anything is sent', async () => {
        const fake = fakeScaleway();
        const api = new ScalewayApi({ apiKey: 'scw-test', fetchImpl: fake.fetchImpl, sleep: noSleep });
        await expect(api.callResult(SCALEWAY_ENDPOINTS.getServer, { path: { zone: 'fr-par-1', server_id: ID }, query: { verbose: true } })).rejects.toThrow(/GetServer is not sent a "verbose" query parameter/);
        await expect(api.callResult(SCALEWAY_ENDPOINTS.listServers, { path: { zone: 'fr-par-1' }, query: { per_page: 10, page: 1 } })).resolves.toMatchObject({ status: 200 });
        expect(fake.calls).toHaveLength(1);
    });

    it('an endpoint with nothing to fill is called without options', async () => {
        const fake = fakeScaleway();
        const api = new ScalewayApi({ apiKey: 'scw-test', fetchImpl: fake.fetchImpl, sleep: noSleep });
        expect((await api.call(SCALEWAY_ENDPOINTS.listSSHKeys)).ssh_keys.map((k: { name: string }) => k.name).sort()).toEqual(['laptop', 'theirs']);
    });

    it('a list that is not where Scaleway puts it is an error that says so, not an empty list', async () => {
        for (const body of [{}, { servers: {} }, { servers: null }, 'oops']) {
            await expect(apiWith(answering(200, body)).listServers('fr-par-1')).rejects.toMatchObject({ code: 'bad_answer', message: expect.stringContaining('the answer has no "servers" list') });
        }
        for (const body of [{}, { servers: [] }, { servers: null }, { servers: 'x' }]) {
            await expect(apiWith(answering(200, body)).serverTypes('fr-par-1')).rejects.toMatchObject({ code: 'bad_answer', message: expect.stringContaining('the answer has no "servers" map') });
        }
    });

    it('a list that never ends is not read forever', async () => {
        const page = { images: Array.from({ length: 100 }, (_, i) => ({ id: `i${i}`, label: `l${i}` })) };
        let asked = 0;
        const endless = (async () => (asked++, json(200, page))) as unknown as typeof fetch;
        await expect(apiWith(endless).listMarketplaceImages()).rejects.toThrow(/has more than 100 pages/);
        expect(asked).toBe(100);
    });
});

describe('addresses, dates and image volumes', () => {
    const server = (o: Partial<ScalewayServer>) => ({ public_ips: [], public_ip: null, ipv6: null, private_ip: null, ...o }) as ScalewayServer;

    it('a server\'s addresses are its routed IPs\', or the deprecated fields\' when it has none; one it does not have is left out', () => {
        const ip = (family: 'inet' | 'inet6', address: string) => ({ id: 'x', address, family, dynamic: true });
        expect(serverAddresses(server({ public_ips: [ip('inet6', '2001:db8::1'), ip('inet', '51.159.0.1')] as any, private_ip: '10.0.0.4' })))
            .toEqual({ ip: '51.159.0.1', ipv6: '2001:db8::1', privateIp: '10.0.0.4' });
        expect(serverAddresses(server({ public_ip: { id: 'x', address: '51.15.0.2', dynamic: true } as any, ipv6: { address: '2001:db8::2' } as any })))
            .toEqual({ ip: '51.15.0.2', ipv6: '2001:db8::2', privateIp: undefined });
        // An address that is not given yet (an empty one) is none.
        expect(serverAddresses(server({ public_ips: [ip('inet', '')] as any, public_ip: { address: '' } as any }))).toEqual({ ip: undefined, ipv6: undefined, privateIp: undefined });
    });

    it('a date is epoch milliseconds; a missing or unreadable one is none, the epoch itself is a date', () => {
        expect(epochMs('2026-09-01T00:00:00Z')).toBe(Date.UTC(2026, 8, 1));
        expect(epochMs('1970-01-01T00:00:00Z')).toBe(0);
        for (const none of [undefined, null, '', 'yesterday']) expect([none, epochMs(none)]).toEqual([none, undefined]);
    });

    it('an image holds its root volume, when it has one, and its extra ones', () => {
        const volume = (id: string) => ({ id, name: id, size: 1, volume_type: 'unified' as const });
        // The other volumes of an image come in full.
        const full = (id: string): ScalewayVolume => ({ ...volume(id), organization: 'o', project: 'p', tags: [], state: 'available', zone: 'fr-par-1' });
        const image = (o: Partial<ScalewayImage>) => ({ root_volume: null, extra_volumes: {}, ...o }) as ScalewayImage;
        expect(imageVolumes(image({ root_volume: volume('r'), extra_volumes: { 1: full('a'), 2: full('b') } })).map((v) => v.id)).toEqual(['r', 'a', 'b']);
        expect(imageVolumes(image({ extra_volumes: { 1: full('a') } })).map((v) => v.id)).toEqual(['a']);
        expect(imageVolumes(image({}))).toEqual([]);
    });
});

describe('servers', () => {
    const made = async (o: Parameters<typeof fakeScaleway>[0] = {}) => {
        const fake = fakeScaleway(o);
        const api = new ScalewayApi({ apiKey: 'scw-test', projectId: FAKE_SCALEWAY_PROJECT, fetchImpl: fake.fetchImpl, sleep: noSleep });
        return { fake, api };
    };

    /** A GPU server (Block Storage root volume) to create, or a small one on a local disk, which `terminate` removes with the server. */
    const launching = (name: string, local = false): ScalewayCreateServerBody => ({
        name, project: FAKE_SCALEWAY_PROJECT, protected: false,
        ...(local
            ? { commercial_type: 'DEV1-S', image: 'ubuntu_noble', volumes: { 0: { volume_type: 'l_ssd' as const, size: 10_000_000_000 } } }
            : { commercial_type: 'L4-1-24G', image: 'ubuntu_noble_gpu_os_13_nvidia' }),
    });

    it('user data is sent raw, as text/plain, to the cloud-init key of a server that is not started yet', async () => {
        const { fake, api } = await made();
        const server = await api.createServer('fr-par-2', { name: 'ud', commercial_type: 'RENDER-S', image: 'ubuntu_noble_gpu_os_13_nvidia', project: FAKE_SCALEWAY_PROJECT, protected: false });
        expect(server.state).toBe('stopped');
        const content = '#cloud-config\nruncmd:\n  - ["touch", "/tmp/ok"]\n';
        await api.setServerUserData('fr-par-2', server.id, content);
        const sent = fake.calls[fake.calls.length - 1];
        expect(sent).toMatchObject({ method: 'PATCH', path: `/instance/v1/zones/fr-par-2/servers/${server.id}/user_data/cloud-init`, body: content });
        expect(sent.headers?.['content-type']).toBe('text/plain');
        expect(fake.state.servers.get(`fr-par-2/${server.id}`).userData['cloud-init']).toBe(content);
    });

    it('finds a server by `zone/id` in one read, by a bare id in every zone it covers, and by nothing else in none', async () => {
        const { fake, api } = await made();
        const server = await api.createServer('pl-waw-2', { name: 'find', commercial_type: 'L4-1-24G', image: 'ubuntu_noble_gpu_os_13_nvidia', project: FAKE_SCALEWAY_PROJECT, protected: false });
        const reads = () => fake.calls.filter((c) => c.method === 'GET' && c.path.includes(`/servers/${server.id}`)).length;
        expect((await api.findServer(`pl-waw-2/${server.id}`))?.id).toBe(server.id);
        expect(reads()).toBe(1);
        expect((await api.findServer(server.id))?.zone).toBe('pl-waw-2');
        expect(reads()).toBe(1 + SCALEWAY_ZONES.length);
        const before = fake.calls.length;
        expect(await api.findServer('not-an-id')).toBeNull();
        expect(await api.findServer(`fr-par-2/${server.id}`)).toBeNull();
        expect(fake.calls.length).toBe(before + 1);
        // Only the zones it covers are asked.
        const paris = new ScalewayApi({ apiKey: 'scw-test', zones: 'fr-par', fetchImpl: fake.fetchImpl, sleep: noSleep });
        const count = fake.calls.length;
        expect(await paris.findServer(server.id)).toBeNull();
        expect(fake.calls.length).toBe(count + 3);
    });

    it('deleting terminates, deletes the Block Storage volume terminate only detached as soon as it is free, and waits until the server is gone', async () => {
        const { fake, api } = await made();
        const before = { servers: fake.liveServers(), volumes: fake.liveVolumes() };
        const server = await api.launchServer('pl-waw-2', { name: 'del', commercial_type: 'L4-1-24G', image: 'ubuntu_noble_gpu_os_13_nvidia', project: FAKE_SCALEWAY_PROJECT, protected: false });
        expect(fake.liveVolumes()).toBe(before.volumes + 1);
        expect(await api.deleteServer('pl-waw-2', server.id)).toBe(true);
        expect({ servers: fake.liveServers(), volumes: fake.liveVolumes() }).toEqual(before);
        // The order that matters: the volume goes once terminate has detached it (not when the server's record is gone), by the Block Storage API.
        const lastIndex = <T>(xs: T[], match: (x: T) => boolean) => {
            for (let i = xs.length - 1; i >= 0; i--) if (match(xs[i])) return i;
            return -1;
        };
        const terminate = lastIndex(fake.calls, (c) => c.method === 'POST' && c.body?.action === 'terminate');
        const lastRead = lastIndex(fake.calls, (c) => c.method === 'GET' && c.path === `/instance/v1/zones/pl-waw-2/servers/${server.id}`);
        const volumeDelete = lastIndex(fake.calls, (c) => c.method === 'DELETE' && /^\/block\/v1\/zones\/pl-waw-2\/volumes\//.test(c.path));
        expect(terminate).toBeGreaterThan(-1);
        expect(volumeDelete).toBeGreaterThan(terminate);
        expect(lastRead).toBeGreaterThan(volumeDelete);
        // Already gone: nothing to do, and nothing sent but the read.
        const sent = fake.calls.length;
        expect(await api.deleteServer('pl-waw-2', server.id)).toBe(false);
        expect(fake.calls.length).toBe(sent + 1);
    });

    it('a block volume is deleted only once nothing uses it, and a volume that is gone is not an error', async () => {
        const { fake, api } = await made();
        const server = await api.launchServer('pl-waw-2', { name: 'vol', commercial_type: 'L4-1-24G', image: 'ubuntu_noble_gpu_os_13_nvidia', project: FAKE_SCALEWAY_PROJECT, protected: false });
        const volume = Object.values(server.volumes)[0].id;
        // Attached to a running server: Scaleway refuses, so the call waits, and gives up naming the volume.
        await expect(api.deleteBlockVolume('pl-waw-2', volume, { timeoutMs: 20, intervalMs: 1 })).rejects.toMatchObject({ code: 'timeout', message: expect.stringMatching(/still in_use/) });
        expect(await api.deleteServer('pl-waw-2', server.id)).toBe(true);
        expect(await api.getBlockVolume('pl-waw-2', volume)).toBeNull();
        expect(await api.deleteBlockVolume('pl-waw-2', volume)).toBe(false);
    });

    it('a server that outlasts the wait is reported with the volume it still holds, and how to delete it', async () => {
        // Running by the time it is deleted; terminating it then never finishes.
        const { fake, api } = await made({ stopReads: 1_000_000, bootReads: 1 });
        const before = fake.liveVolumes();
        const server = await api.launchServer('pl-waw-2', { name: 'slow', commercial_type: 'L4-1-24G', image: 'ubuntu_noble_gpu_os_13_nvidia', project: FAKE_SCALEWAY_PROJECT, protected: false });
        const volume = Object.values(server.volumes)[0].id;
        const e = await api.deleteServer('pl-waw-2', server.id, { timeoutMs: 20, intervalMs: 1 }).catch((x) => x);
        expect(e).toMatchObject({ code: 'timeout' });
        expect(e.message).toContain(volume);
        expect(e.message).toContain(`deleteBlockVolume('pl-waw-2', '${volume}')`);
        expect(fake.liveVolumes()).toBe(before + 1);
        // The server finishes: it is gone, so deleting it again finds nothing, and the volume is what is left, free to delete as the error said.
        fake.state.servers.get(`pl-waw-2/${server.id}`).stopLeft = 1;
        expect(await api.deleteServer('pl-waw-2', server.id)).toBe(false);
        expect((await api.getBlockVolume('pl-waw-2', volume))?.status).toBe('available');
        expect(await api.deleteBlockVolume('pl-waw-2', volume)).toBe(true);
        expect(fake.liveVolumes()).toBe(before);
    });

    it('a server that cannot be started is deleted again, and the error is the start\'s, whatever becomes of the delete', async () => {
        const { fake, api } = await made();
        const before = { servers: fake.liveServers(), volumes: fake.liveVolumes() };
        fake.intercept((r) => r.body?.action === 'poweron', { answer: () => json(500, { message: 'no power' }) });
        await expect(api.launchServer('pl-waw-2', launching('stillborn'))).rejects.toThrow(/no power/);
        expect({ servers: fake.liveServers(), volumes: fake.liveVolumes() }).toEqual(before);
        // The delete fails too: the start's failure is the one reported, and the server it could not delete is there to be deleted by hand.
        // The server was never started: it is deleted as a stopped one is (a plain DELETE).
        fake.intercept((r) => r.method === 'DELETE' && /\/servers\/[0-9a-f-]{36}$/.test(r.path), { answer: () => json(500, { message: 'no delete' }) });
        await expect(api.launchServer('pl-waw-2', launching('stuck'))).rejects.toThrow(/no power/);
        expect(fake.liveServers()).toBe(before.servers + 1);
    });

    it('a server that is started but cannot be read is reported as starting', async () => {
        const { fake, api } = await made();
        fake.intercept((r) => r.method === 'GET' && /\/servers\/[0-9a-f-]{36}$/.test(r.path), { answer: () => json(500, { message: 'read failed' }) });
        const server = await api.launchServer('pl-waw-2', launching('unread'));
        expect(server).toMatchObject({ name: 'unread', state: 'starting' });
        // The start was accepted: the server is there, and powered on (what the failed reads could not say).
        expect(['starting', 'running']).toContain(fake.state.servers.get(`pl-waw-2/${server.id}`)?.state);
    });

    it('a server that is gone when it is terminated is deleted all the same; any other failure to delete a volume is not hidden', async () => {
        const { fake, api } = await made();
        const local = await api.launchServer('nl-ams-1', launching('local', true));
        fake.intercept((r) => r.body?.action === 'terminate', { times: 1, answer: () => (fake.state.servers.delete(`nl-ams-1/${local.id}`), json(404, { type: 'unknown_resource', message: 'gone' })) });
        expect(await api.deleteServer('nl-ams-1', local.id)).toBe(true);
        expect(fake.liveServers()).toBe(2);
        const denied = await made();
        const gpu = await denied.api.launchServer('pl-waw-2', launching('gpu'));
        denied.fake.intercept((r) => r.method === 'DELETE' && r.path.startsWith('/block/'), { answer: () => json(403, { type: 'permissions_denied', message: 'no volume rights' }) });
        await expect(denied.api.deleteServer('pl-waw-2', gpu.id)).rejects.toMatchObject({ name: 'AuthError', code: 'permissions_denied' });
    });

    /** Stops a running server and waits until it is stopped. */
    const stop = async (api: ScalewayApi, zone: ScalewayZone, id: string) => {
        await api.serverAction(zone, id, { action: 'poweroff' });
        while ((await api.getServer(zone, id))?.state !== 'stopped') { /* the fake moves on with every read */ }
    };
    const key = (zone: string, id: string) => `${zone}/${id}`;

    it('a stopped server\'s local volumes that will not delete are named, as nothing finds them once the server is gone', async () => {
        const { fake, api } = await made();
        // Its local root disk, and a Block Storage volume it was made with (named by id, and untagged: its own).
        const block = await api.createBlockVolume('nl-ams-1', { name: 'extra', perf_iops: 5000, project_id: FAKE_SCALEWAY_PROJECT, from_empty: { size: 20_000_000_000 } });
        const body = { ...launching('two-disks', true), volumes: { 0: { volume_type: 'l_ssd' as const, size: 10_000_000_000 }, 1: { id: block.id, volume_type: 'sbs_volume' as const } } };
        const s = await api.launchServer('nl-ams-1', body);
        await stop(api, 'nl-ams-1', s.id);
        const local = Object.values((await api.getServer('nl-ams-1', s.id))!.volumes).find((v) => v.volume_type === 'l_ssd')!.id;
        fake.intercept((r) => r.method === 'DELETE' && /^\/(instance|block)\/v1\/zones\/nl-ams-1\/volumes\//.test(r.path), { answer: () => json(500, { message: 'internal error' }) });
        const e = await api.deleteServer('nl-ams-1', s.id).catch((x) => x);
        // Both are tried and named; a failure that reads as transient is not one anything will retry.
        expect(e).toMatchObject({ name: 'ProviderError', code: 'left_behind', retriable: false });
        expect(e.message).toContain(`its local volume ${local}, block volume ${block.id} are not`);
        expect(await api.getServer('nl-ams-1', s.id)).toBeNull();
    });

    it('a stopped server has no terminate: it is deleted as it is, and the volumes it keeps are deleted too (local ones through the Instance API, Block Storage ones through their own)', async () => {
        const { fake, api } = await made();
        const before = fake.liveVolumes();
        const local = await api.launchServer('nl-ams-1', launching('local', true));
        const gpu = await api.launchServer('pl-waw-2', launching('gpu'));
        // The Block Storage volume of the GPU server; a local volume is the server's own while it exists.
        expect(fake.liveVolumes()).toBe(before + 1);
        await stop(api, 'nl-ams-1', local.id);
        await stop(api, 'pl-waw-2', gpu.id);
        expect(await api.deleteServer('nl-ams-1', local.id)).toBe(true);
        expect(await api.deleteServer('pl-waw-2', gpu.id)).toBe(true);
        expect(fake.liveVolumes()).toBe(before);
        expect(fake.calls.filter((c) => c.body?.action === 'terminate')).toEqual([]);
        expect(fake.calls.filter((c) => c.method === 'DELETE').map((c) => c.path.split('/').slice(1, 5).join('/') + '/' + c.path.split('/')[5]).sort()).toEqual([
            'block/v1/zones/pl-waw-2/volumes', 'instance/v1/zones/nl-ams-1/servers', 'instance/v1/zones/nl-ams-1/volumes', 'instance/v1/zones/pl-waw-2/servers',
        ]);
    });

    it('a server that stopped while it was being terminated is deleted as a stopped one; one that is protected stays, and says so at once', async () => {
        const { fake, api } = await made();
        const before = fake.liveServers();
        const local = await api.launchServer('nl-ams-1', launching('raced', true));
        // Scaleway refuses the terminate because the server is stopped by now.
        fake.intercept((r) => r.body?.action === 'terminate', {
            times: 1, answer: () => {
                Object.assign(fake.state.servers.get(key('nl-ams-1', local.id)), { state: 'stopped', public_ips: [] });
                return json(400, { type: 'precondition_failed', message: 'precondition is not respected' });
            },
        });
        expect(await api.deleteServer('nl-ams-1', local.id)).toBe(true);
        expect([fake.liveServers(), fake.liveVolumes()]).toEqual([before, 1]);
        const protectedServer = await api.launchServer('nl-ams-1', { ...launching('protected', true), protected: true });
        const asked = fake.calls.length;
        await expect(api.deleteServer('nl-ams-1', protectedServer.id)).rejects.toMatchObject({ code: 'precondition_failed', message: expect.stringContaining('the server is protected') });
        // The refusal stood at the first answer: terminate, and the read that says nothing changed.
        expect(fake.calls.slice(asked).filter((c) => c.body?.action === 'terminate')).toHaveLength(1);
    });

    it('a server that disappears while it is being terminated is gone, and whatever else deleted it is not asked again', async () => {
        const { fake, api } = await made();
        const local = await api.launchServer('nl-ams-1', launching('vanishing', true));
        fake.intercept((r) => r.body?.action === 'terminate', {
            times: 1, answer: () => {
                fake.state.servers.delete(key('nl-ams-1', local.id));
                return json(400, { type: 'transient_state', message: 'busy', current_state: 'starting' });
            },
        });
        expect(await api.deleteServer('nl-ams-1', local.id)).toBe(true);
        expect(fake.calls.filter((c) => c.body?.action === 'terminate')).toHaveLength(1);
    });

    it('a stopped server that is gone before it is deleted is deleted all the same, and the volumes it left are not forgotten', async () => {
        const { fake, api } = await made();
        const gpu = await api.launchServer('pl-waw-2', launching('late'));
        await stop(api, 'pl-waw-2', gpu.id);
        const volume = Object.values(gpu.volumes)[0].id;
        // Someone else deletes it between the read and the delete: Scaleway says it is not found, and its volume is detached.
        fake.intercept((r) => r.method === 'DELETE' && /\/servers\/[0-9a-f-]{36}$/.test(r.path), {
            times: 1, answer: () => (Object.assign(fake.state.volumes.get(volume), { status: 'available', references: [] }), fake.state.servers.delete(key('pl-waw-2', gpu.id)), json(404, { type: 'unknown_resource', message: 'gone' })),
        });
        expect(await api.deleteServer('pl-waw-2', gpu.id)).toBe(true);
        expect(await api.getBlockVolume('pl-waw-2', volume)).toBeNull();
    });

    it('a server that never goes is reported as what it still is', async () => {
        const { api } = await made({ stopReads: 1_000_000, bootReads: 1 });
        const local = await api.launchServer('nl-ams-1', launching('lingering', true));
        await expect(api.deleteServer('nl-ams-1', local.id, { timeoutMs: 20, intervalMs: 1 })).rejects.toMatchObject({
            code: 'timeout', message: expect.stringMatching(/is still stopping after 0 s \(its volumes are deleted\)/),
        });
    });

    it('a server that is changing state is not asked to terminate (Scaleway refuses it: precondition_failed): it is waited for, until the deadline', async () => {
        const { fake, api } = await made({ bootReads: 4 });
        const server = await api.launchServer('pl-waw-2', launching('busy'));
        expect(server.state).toBe('starting');
        expect(await api.deleteServer('pl-waw-2', server.id)).toBe(true);
        // One terminate, once it runs.
        expect(fake.calls.filter((c) => c.method === 'POST' && c.body?.action === 'terminate')).toHaveLength(1);
        // A server that stays busy ends the wait at the deadline, saying what it still is.
        const stuck = await made({ bootReads: 1_000_000 });
        const s = await stuck.api.launchServer('pl-waw-2', launching('stuck'));
        await expect(stuck.api.deleteServer('pl-waw-2', s.id, { timeoutMs: 20, intervalMs: 1 })).rejects.toMatchObject({
            code: 'timeout', message: expect.stringMatching(/is still starting: it cannot be deleted while it changes state/),
        });
        expect(stuck.fake.calls.filter((c) => c.body?.action === 'terminate')).toEqual([]);
    });

    it('a server that goes while it is waited for is gone', async () => {
        const { fake, api } = await made({ bootReads: 1_000_000 });
        const local = await api.launchServer('nl-ams-1', launching('gone-meanwhile', true));
        fake.intercept((r) => r.method === 'GET' && /\/servers\/[0-9a-f-]{36}$/.test(r.path), { times: 1, after: () => fake.state.servers.delete(key('nl-ams-1', local.id)) });
        expect(await api.deleteServer('nl-ams-1', local.id)).toBe(true);
    });

    it('a terminate that gets no answer at all is not guessed at: the error is the transport\'s', async () => {
        const { fake, api } = await made();
        const local = await api.launchServer('nl-ams-1', launching('unreachable', true));
        fake.intercept((r) => r.body?.action === 'terminate', { answer: () => { throw new TypeError('connection reset'); } });
        await expect(api.deleteServer('nl-ams-1', local.id)).rejects.toMatchObject({ name: 'TransportError', message: expect.stringContaining('connection reset') });
        expect(fake.liveServers()).toBeGreaterThan(0);
    });

    it('a transient_state is asked again, until the deadline, with Scaleway\'s own error', async () => {
        const { fake, api } = await made();
        const local = await api.launchServer('nl-ams-1', launching('transient', true));
        // Busy once, with its state unchanged: asked again, and it takes.
        fake.intercept((r) => r.body?.action === 'terminate', { times: 1, answer: () => json(400, { type: 'transient_state', message: 'busy', current_state: 'running' }) });
        expect(await api.deleteServer('nl-ams-1', local.id)).toBe(true);
        expect(fake.calls.filter((c) => c.body?.action === 'terminate')).toHaveLength(2);
        const other = await api.launchServer('nl-ams-1', launching('transient-forever', true));
        fake.intercept((r) => r.body?.action === 'terminate', { answer: () => json(400, { type: 'transient_state', message: 'busy', current_state: 'running' }) });
        await expect(api.deleteServer('nl-ams-1', other.id, { timeoutMs: 20, intervalMs: 1 })).rejects.toMatchObject({ code: 'transient_state', retriable: true });
    });
});

describe('images and SSH keys', () => {
    const made = (o: Parameters<typeof fakeScaleway>[0] = {}) => {
        const fake = fakeScaleway(o);
        return { fake, api: new ScalewayApi({ apiKey: 'scw-test', projectId: FAKE_SCALEWAY_PROJECT, fetchImpl: fake.fetchImpl, sleep: noSleep }) };
    };

    it('an image that is not there is not deleted, whether it is gone before the read or between the read and the delete', async () => {
        const { fake, api } = made();
        expect(await api.deleteImage('fr-par-1', '00000000-0000-4000-8000-0000000000aa')).toBe(false);
        fake.intercept((r) => r.method === 'DELETE' && /\/images\//.test(r.path), { answer: () => json(404, { type: 'unknown_resource', message: 'gone' }) });
        expect(await api.deleteImage('fr-par-1', fake.backupImageId)).toBe(false);
        expect(fake.state.images.has(fake.backupImageId)).toBe(true);
    });
});

describe('endpoints used by the client are the table\'s', () => {
    it('every request goes to a path of SCALEWAY_ENDPOINTS', async () => {
        const fake = fakeScaleway();
        const api = new ScalewayApi({ apiKey: 'scw-test', projectId: FAKE_SCALEWAY_PROJECT, fetchImpl: fake.fetchImpl, sleep: noSleep });
        await api.serverTypes('fr-par-1');
        await api.availability('fr-par-1');
        await api.listServers('fr-par-1');
        await api.listImages('fr-par-1');
        await api.listSSHKeys();
        await api.listMarketplaceImages();
        const templates = Object.values(SCALEWAY_ENDPOINTS).map((e) => new RegExp(`^${e.path.replace(/\{[a-z_]+\}/g, '[^/?]+')}(\\?|$)`));
        for (const c of fake.calls) expect([c.path, templates.some((t) => t.test(c.path))]).toEqual([c.path, true]);
        expect(fake.calls.map((c) => c.host)).toEqual(Array(fake.calls.length).fill('api.scaleway.com'));
    });
});
