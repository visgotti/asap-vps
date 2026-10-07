// A fetch() that answers like api.digitalocean.com for the calls the
// DigitalOcean provider makes, from documented (and, for the error wording,
// observed) behaviour: 422 "Size is not available in this region." when a size
// has no stock there, 422 on the droplet limit, `new` -> `active` after a few
// reads, power actions, one at a time (an action asked for while another is in
// progress, the droplet's create included until it is active, is a 422
// "Droplet already has a pending event."), account keys (with
// DigitalOcean's MD5 fingerprints), and images: the public distribution images,
// a snapshot action that completes after a few reads of /v2/actions/{id}, the
// account's private images (a production backup is seeded: callers pick theirs
// by name), transfers that add a region, and a droplet booted from a snapshot
// only where the snapshot is; and Block Storage volumes (one region each,
// attached at a droplet's create to that droplet only, detached when it is
// deleted, refused deletion while attached). Non-GPU droplets are seeded: a GPU
// listServers must never return them.

import { randomUUID } from 'crypto';
import { sshKeyFingerprint } from '../../Core/utils';
import { fakeBootId, FakeApi, json, readRequest, userDataFiles } from './util';

/**
 * The regions Network File Storage is in, from docs.digitalocean.com/products/nfs/details/availability/
 * (generated 6 Oct 2026): a share anywhere else is refused. The live shares suite rents in these too.
 */
export const DO_NFS_REGIONS: readonly string[] = ['nyc2', 'ams3', 'atl1', 'ric1', 'mkc1', 'mem1'];

/** DigitalOcean's datacenters (its regional availability matrix, 6 Oct 2026), the two legacy ones last: a slug outside them names no region. */
const REGIONS = ['nyc1', 'nyc2', 'nyc3', 'ams3', 'sfo2', 'sfo3', 'sgp1', 'lon1', 'fra1', 'tor1', 'blr1', 'syd1', 'atl1', 'ric1', 'mkc1', 'mem1', 'ams2', 'sfo1'];

/** Public images: GET /v2/images lists them with the account's own; ?private=true leaves them out. */
const PUBLIC_IMAGES = [
    { id: 101, name: '24.04 (LTS) x64', distribution: 'Ubuntu', slug: 'ubuntu-24-04-x64', public: true, regions: ['nyc1', 'nyc2', 'tor1', 'sfo3'],
        created_at: '2024-04-25T00:00:00Z', min_disk_size: 7, type: 'base', size_gigabytes: 2.5, description: 'Ubuntu 24.04 x64', tags: [], status: 'available' },
    { id: 102, name: '22.04 (LTS) x64', distribution: 'Ubuntu', slug: 'ubuntu-22-04-x64', public: true, regions: ['nyc1', 'nyc2', 'tor1', 'sfo3'],
        created_at: '2022-04-21T00:00:00Z', min_disk_size: 7, type: 'base', size_gigabytes: 2.3, description: 'Ubuntu 22.04 x64', tags: [], status: 'available' },
    { id: 103, name: '20.04 (LTS) x64', distribution: 'Ubuntu', slug: 'ubuntu-20-04-x64', public: true, regions: ['nyc1'],
        created_at: '2020-04-23T00:00:00Z', min_disk_size: 7, type: 'base', size_gigabytes: 2.1, description: 'Ubuntu 20.04 x64', tags: [], status: 'retired' },
];

const SIZES = [
    { slug: 'gpu-4000adax1-20gb', price_hourly: 0.76, available: true, regions: ['tor1'], vcpus: 8, memory: 32768, disk: 500,
        gpu_info: { count: 1, vram: { amount: 20, unit: 'gib' }, model: 'nvidia_rtx4000_ada' } },
    { slug: 'gpu-l40sx1-48gb', price_hourly: 1.57, available: true, regions: [], vcpus: 8, memory: 65536, disk: 500,
        gpu_info: { count: 1, vram: { amount: 48, unit: 'gib' }, model: 'nvidia_l40s' } },
    { slug: 'gpu-6000adax1-48gb', price_hourly: 1.57, available: true, regions: ['nyc2', 'tor1'], vcpus: 8, memory: 65536, disk: 500,
        gpu_info: { count: 1, vram: { amount: 48, unit: 'gib' }, model: 'nvidia_rtx6000_ada' } },
    { slug: 'gpu-h100x8-640gb', price_hourly: 23.92, available: true, regions: ['nyc2'], vcpus: 160, memory: 1966080, disk: 2046,
        gpu_info: { count: 8, vram: { amount: 640, unit: 'gib' }, model: 'nvidia_h100' } },
    { slug: 'gpu-mi300x1-192gb', price_hourly: 1.99, available: true, regions: ['atl1'], vcpus: 20, memory: 245760, disk: 720,
        gpu_info: { count: 1, vram: { amount: 192, unit: 'gib' }, model: 'amd_mi300x' } },
    { slug: 's-8vcpu-16gb', price_hourly: 0.14286, available: true, regions: ['nyc1', 'tor1'], vcpus: 8, memory: 16384, disk: 320, gpu_info: null },
];

/**
 * `keyLag`: how many requests a newly added SSH key stays unknown to the account's
 * list, its duplicate check and the droplet create, as DigitalOcean's do for
 * seconds (seen live 2026-10-05: a create with a key added moments before was
 * refused, 422 "... are invalid key identifiers for Droplet creation.").
 * `releaseReads`: how many reads a deleted droplet's volumes still read as
 * attached to it (seen live 2026-10-06: still attached once its delete was
 * verified), and cannot be attached to another droplet or deleted.
 */
export function fakeDigitalOcean(o: {
    token?: string, bootReads?: number, dropletLimit?: number, actionReads?: number, failShutdown?: boolean, keyLag?: number, releaseReads?: number,
    /** The guest ignores a shutdown: its action completes (the command was issued), and the droplet stays on. */
    ignoreShutdown?: boolean,
    /** Reads before an imported custom image is available (or, for a URL with "corrupt" in it, deleted with an error). */
    importReads?: number,
    /** Reads before a new NFS share is ACTIVE (with its host and mount path). */
    shareReads?: number,
} = {}) {
    const token = o.token ?? 'do-test';
    const calls: FakeApi['calls'] = [];
    const state = {
        sizes: SIZES.map((s) => ({ ...s, regions: [...s.regions] })),
        droplets: new Map<string, any>(),
        keys: new Map<string, any>(),
        images: new Map<string, any>(),
        deletedImages: new Set<string>(),
        actions: new Map<string, any>(),
        volumes: new Map<string, any>(),
        /** Network File Storage shares, by id; each region of the sizes has a default VPC. */
        shares: new Map<string, any>(),
        vpcs: [...new Set(SIZES.flatMap((x) => x.regions))].map((region, i) => ({ id: `00000000-0000-4000-9000-00000000000${i}`, name: `default-${region}`, region, default: true })),
        nextId: 5000,
        bootReads: o.bootReads ?? 2,
        dropletLimit: o.dropletLimit ?? 25,
        keyLag: o.keyLag ?? 0,
        /** Requests answered so far: a lagging key is known from keyKnownAt on. */
        requests: 0,
        keyKnownAt: new Map<string, number>(),
        actionReads: o.actionReads ?? 2,
    };
    // Not GPU servers: the account runs other things too.
    for (const name of ['api-1', 'mail.example.com']) {
        const id = state.nextId++;
        const size = state.sizes.find((s) => s.slug === 's-8vcpu-16gb');
        state.droplets.set(String(id), { id, name, status: 'active', tags: ['prod'], region: { slug: 'nyc1' }, size_slug: 's-8vcpu-16gb', size,
            created_at: '2026-01-01T00:00:00Z', networks: { v4: [{ ip_address: `10.0.0.${id % 250}`, type: 'public' }], v6: [] }, reads: 99 });
    }
    // And its images: a production backup nobody may boot or delete by accident.
    const backupId = state.nextId++;
    state.images.set(String(backupId), { id: backupId, name: 'api-1 2026-09-01', type: 'backup', regions: ['nyc1'], status: 'available',
        size_gigabytes: 25, created_at: '2026-09-01T00:00:00Z', droplet_id: 5000 });
    const err = (status: number, id: string, message: string) => json(status, { id, message });
    const view = (d: any) => {
        const { reads, user_data, files, boots, authKeys, ...rest } = d;
        return rest;
    };
    /** An image as read: an import moves on with each read (NEW, then available, or deleted with an error for a corrupt file). */
    const imageView = (i: any) => {
        if (i.importing && --i.importing.reads <= 0) {
            if (/corrupt/.test(i.importing.url)) Object.assign(i, { status: 'deleted', error_message: 'We had a problem decompressing your file. This typically happens if the archive is corrupt or incomplete.' });
            else Object.assign(i, { status: 'available', regions: [i.importing.region], size_gigabytes: 2.36, min_disk_size: 3 });
            delete i.importing;
        }
        const { droplet_id, importing, ...rest } = i;
        return rest;
    };
    /** A volume as read: a deleted droplet lets go of it once its reads run out. */
    const volumeView = (v: any) => {
        if (v.releasing && --v.releasing.reads <= 0) {
            v.droplet_ids = v.droplet_ids.filter((x: number) => x !== v.releasing.droplet);
            delete v.releasing;
        }
        // DigitalOcean says a volume's filesystem only in its create's answer (seen live 2026-10-06).
        const { releasing: _r, ...rest } = v;
        return { ...rest, ...(rest.filesystem_type !== undefined ? { filesystem_type: '' } : {}) };
    };

    /** A share as read: CREATING turns ACTIVE (its host and mount path set) once its reads run out; DELETED is gone at the next read. */
    const shareView = (x: any) => {
        if (x.status === 'CREATING' && --x.reads <= 0) Object.assign(x, { status: 'ACTIVE', host: '10.10.0.5', mount_path: `/2559851/${x.id}` });
        const { reads, ...rest } = x;
        return rest;
    };

    /** Network File Storage: shares made in a region's VPCs, listed (in every region, or one), read, deleted. */
    function nfs(method: string, path: string, u: URL, body: any): Response {
        if (path === '/v2/nfs' && method === 'POST') {
            if (typeof body?.name !== 'string' || !/^[a-z][a-z0-9-]*$/.test(body.name)) return err(400, 'bad_request', 'name must be lowercase letters, digits and dashes');
            if (!DO_NFS_REGIONS.includes(body.region)) return err(400, 'bad_request', `NFS is not available in region ${body.region}`);
            const tier = body.performance_tier ?? 'high';
            const least = tier === 'high' ? 500 : 50;
            if (!Number.isInteger(body.size_gib) || body.size_gib < least) return err(400, 'bad_request', `The value for 'size_gib' must be greater than or equal to ${least}Gib.`);
            if (!Array.isArray(body.vpc_ids) || !body.vpc_ids.length || body.vpc_ids.some((v: string) => !state.vpcs.some((x) => x.id === v && x.region === body.region))) {
                return err(400, 'bad_request', 'vpc_ids must name at least one VPC of the region');
            }
            const id = randomUUID();
            const share = { id, name: body.name, size_gib: body.size_gib, region: body.region, status: 'CREATING', created_at: new Date().toISOString(), vpc_ids: body.vpc_ids,
                performance_tier: `PERFORMANCE_TIER_${tier.toUpperCase()}`, reads: o.shareReads ?? 2 };
            state.shares.set(id, share);
            const { reads, ...view } = share;
            return json(201, { share: view });
        }
        if (path === '/v2/nfs' && method === 'GET') {
            const region = u.searchParams.get('region');
            const list = [...state.shares.values()].filter((x) => !region || x.region === region).map(shareView);
            for (const x of [...state.shares.values()]) if (x.status === 'DELETED') state.shares.delete(x.id);
            return json(200, { shares: list });
        }
        const m = /^\/v2\/nfs\/([0-9a-f-]+)$/.exec(path);
        const share = m ? state.shares.get(m[1]) : undefined;
        if (!share) return err(404, 'not_found', 'The resource you were accessing could not be found.');
        if (method === 'GET') return json(200, { share: shareView(share) });
        if (method === 'DELETE') {
            share.status = 'DELETED';
            return new Response(null, { status: 204 });
        }
        return err(405, 'method_not_allowed', method);
    }

    /**
     * An action that completes after `actionReads` reads, then runs `done`; a
     * droplet's create completes when the droplet is active instead. One on a
     * droplet is its pending event until then: the droplet takes no other.
     */
    const startAction = (type: string, done: () => void, dropletId?: number) => {
        const a = { id: state.nextId++, type, status: 'in-progress', reads: 0, done, dropletId };
        state.actions.set(String(a.id), a);
        return { id: a.id, type, status: a.status };
    };
    /** A droplet that is new becomes active after `bootReads` reads: its first boot, and the end of its create. */
    const advance = (d: any) => {
        if (d.status !== 'new' || ++d.reads < state.bootReads) return;
        d.status = 'active';
        // Its first boot: cloud-init runs its user data.
        d.boots = 1;
        Object.assign(d.files, userDataFiles(d.user_data));
        d.networks = { v4: [{ ip_address: `203.0.113.${d.id % 250}`, type: 'public' }, { ip_address: '10.10.0.2', type: 'private' }], v6: [] };
        for (const a of state.actions.values()) if (a.dropletId === d.id && a.type === 'create') a.status = 'completed';
    };
    /** Time passes for an action: a read of it, or a request it held up. */
    const progress = (a: any) => {
        if (a.status !== 'in-progress') return;
        if (a.type === 'create') {
            const d = state.droplets.get(String(a.dropletId));
            if (d) advance(d);
            else a.status = 'completed';
            return;
        }
        if (++a.reads < state.actionReads) return;
        // A shutdown the guest ignores errors out (the case power_off exists for).
        if (a.type === 'shutdown' && o.failShutdown) a.status = 'errored';
        else {
            a.status = 'completed';
            a.done();
        }
    };
    /** The droplet's pending event, if it has one: an action on it then is refused (and time passes for that event). */
    const pendingEvent = (d: any): Response | undefined => {
        const pending = [...state.actions.values()].filter((a) => a.dropletId === d.id && a.status === 'in-progress');
        if (!pending.length) return undefined;
        for (const a of pending) progress(a);
        return err(422, 'unprocessable_entity', 'Droplet already has a pending event.');
    };

    /** The account's keys DigitalOcean knows by now (keyLag). */
    const knownKeys = () => [...state.keys.values()].filter((k) => (state.keyKnownAt.get(String(k.id)) ?? 0) <= state.requests);

    async function fetchImpl(url: string | URL | Request, init?: RequestInit): Promise<Response> {
        const { u, method, body, auth, path } = readRequest(calls, url, init);
        state.requests++;
        if (auth !== `Bearer ${token}`) return err(401, 'unauthorized', 'Unable to authenticate you');
        const page = Number(u.searchParams.get('page') ?? 1);
        let m: RegExpExecArray | null;
        if (method === 'GET' && path === '/v2/sizes') {
            // Two pages, to hold the provider to following links.pages.next.
            const half = Math.ceil(state.sizes.length / 2);
            const items = page === 1 ? state.sizes.slice(0, half) : state.sizes.slice(half);
            return json(200, { sizes: items, links: page === 1 ? { pages: { next: 'https://api.digitalocean.com/v2/sizes?page=2' } } : {}, meta: { total: state.sizes.length } });
        }
        if (method === 'POST' && path === '/v2/droplets') {
            const size = state.sizes.find((s) => s.slug === body.size);
            if (!size) return err(422, 'unprocessable_entity', 'You specified an invalid size for Droplet creation.');
            if (!size.available || !size.regions.includes(body.region)) return err(422, 'unprocessable_entity', 'Size is not available in this region.');
            if (state.droplets.size >= state.dropletLimit) return err(422, 'unprocessable_entity', 'creating this/these droplet(s) will exceed your droplet limit');
            if (typeof body.image === 'number') {
                const img = state.images.get(String(body.image));
                if (!img || img.status !== 'available' || !img.regions.includes(body.region)) {
                    return err(422, 'unprocessable_entity', 'The image is not available in the requested region.');
                }
            }
            // Every key by id or MD5 fingerprint, among the keys DigitalOcean knows by now.
            const unknownKeys = (Array.isArray(body.ssh_keys) ? body.ssh_keys : []).filter((r: unknown) => !knownKeys().some((k) => String(k.id) === String(r) || k.fingerprint === r));
            if (unknownKeys.length) return err(422, 'unprocessable_entity', `${unknownKeys.join(', ')} are invalid key identifiers for Droplet creation.`);
            // "The volumes must not already be attached to an existing Droplet", and a volume is attached only in its own region.
            const volumes = (Array.isArray(body.volumes) ? body.volumes : []).map((v: string) => state.volumes.get(String(v)));
            if (volumes.some((v: any) => !v)) return err(422, 'unprocessable_entity', 'A specified volume could not be found.');
            if (volumes.some((v: any) => v.region.slug !== body.region)) return err(422, 'unprocessable_entity', 'Volumes must be in the same region as the Droplet.');
            if (volumes.some((v: any) => v.droplet_ids.length)) return err(422, 'unprocessable_entity', 'A specified volume is already attached to a Droplet.');
            // A droplet joins the VPC it names (of its region), else its region's default one.
            if (body.vpc_uuid !== undefined && !state.vpcs.some((v) => v.id === body.vpc_uuid && v.region === body.region)) return err(422, 'unprocessable_entity', 'vpc_uuid is not a VPC of the region.');
            const id = state.nextId++;
            // What its sshd takes: the keys it was created with (applied at creation only), and its disk: what the image carried.
            const authKeys = (Array.isArray(body.ssh_keys) ? body.ssh_keys : []).map((r: unknown) => knownKeys().find((k) => String(k.id) === String(r) || k.fingerprint === r)!.public_key);
            const carried = typeof body.image === 'number' ? state.images.get(String(body.image))?.files ?? {} : {};
            const d = { id, name: body.name, status: 'new', tags: body.tags ?? [], region: { slug: body.region }, size_slug: size.slug, size,
                image: body.image, ssh_keys: body.ssh_keys, user_data: body.user_data, created_at: new Date().toISOString(), networks: { v4: [], v6: [] },
                volume_ids: volumes.map((v: any) => v.id), vpc_uuid: body.vpc_uuid ?? state.vpcs.find((v) => v.region === body.region)?.id, reads: 0,
                authKeys, files: { ...carried }, boots: 0 };
            for (const v of volumes) v.droplet_ids = [id];
            state.droplets.set(String(id), d);
            // Its create is its pending event until it is active.
            const create = startAction('create', () => undefined, id);
            return json(202, { droplet: view(d), links: { actions: [{ id: create.id, rel: 'create', href: `https://api.digitalocean.com/v2/actions/${create.id}` }] } });
        }
        if (method === 'GET' && path === '/v2/droplets') {
            // "By default, only non-GPU Droplets are returned. To list only GPU Droplets, set the type query parameter to gpus."
            const gpus = u.searchParams.get('type') === 'gpus';
            const list = [...state.droplets.values()].filter((d) => !!d.size?.gpu_info === gpus);
            return json(200, { droplets: list.map(view), links: {}, meta: { total: list.length } });
        }
        if ((m = /^\/v2\/droplets\/(\d+)$/.exec(path))) {
            const d = state.droplets.get(m[1]);
            if (!d) return err(404, 'not_found', 'The resource you were accessing could not be found.');
            if (method === 'GET') {
                advance(d);
                return json(200, { droplet: view(d) });
            }
            if (method === 'DELETE') {
                // Its volumes are detached, not deleted: a few reads later.
                for (const v of state.volumes.values()) if (v.droplet_ids.includes(d.id)) v.releasing = { droplet: d.id, reads: o.releaseReads ?? 2 };
                state.droplets.delete(m[1]);
                return new Response(null, { status: 204 });
            }
        }
        if (path === '/v2/volumes') {
            if (method === 'GET') {
                const list = [...state.volumes.values()].map(volumeView);
                return json(200, { volumes: list, links: {}, meta: { total: list.length } });
            }
            if (method === 'POST') {
                if (typeof body?.name !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(body.name)) return err(422, 'unprocessable_entity', 'Name must be lowercase letters, numbers and dashes, starting with a letter.');
                if (!Number.isInteger(body.size_gigabytes) || body.size_gigabytes < 1 || body.size_gigabytes > 16384) return err(422, 'unprocessable_entity', 'Size must be between 1 and 16384 GiB.');
                if (!state.sizes.some((x) => x.regions.includes(body.region))) return err(422, 'unprocessable_entity', 'Region is not available for Block Storage.');
                if (body.filesystem_type !== undefined && !['ext4', 'xfs'].includes(body.filesystem_type)) return err(422, 'unprocessable_entity', 'Filesystem type must be ext4 or xfs.');
                if ([...state.volumes.values()].some((v) => v.name === body.name && v.region.slug === body.region)) return err(409, 'conflict', 'A volume with that name already exists in this region.');
                const v = { id: randomUUID(), name: body.name, description: body.description ?? '', size_gigabytes: body.size_gigabytes,
                    region: { slug: body.region, name: body.region, features: [], available: true, sizes: [] }, droplet_ids: [] as number[],
                    ...(body.filesystem_type ? { filesystem_type: body.filesystem_type, filesystem_label: body.filesystem_label ?? '' } : {}),
                    created_at: new Date().toISOString(), tags: body.tags ?? [] };
                state.volumes.set(v.id, v);
                return json(201, { volume: v });
            }
        }
        if ((m = /^\/v2\/volumes\/([0-9a-f-]+)$/.exec(path))) {
            const v = state.volumes.get(m[1]);
            if (!v) return err(404, 'not_found', 'The resource you were accessing could not be found.');
            if (method === 'GET') return json(200, { volume: volumeView(v) });
            if (method === 'DELETE') {
                volumeView(v);
                // A volume must be detached before it is deleted.
                if (v.droplet_ids.length) return err(409, 'conflict', 'Attached volumes cannot be deleted: detach it from its Droplet first.');
                state.volumes.delete(v.id);
                return new Response(null, { status: 204 });
            }
        }
        if (method === 'POST' && (m = /^\/v2\/volumes\/([0-9a-f-]+)\/actions$/.exec(path))) {
            // Attach to / detach from a droplet that runs: an action (`attach_volume`, `detach_volume`) that completes after a few reads.
            const v = state.volumes.get(m[1]);
            if (!v) return err(404, 'not_found', 'The resource you were accessing could not be found.');
            const d = state.droplets.get(String(body?.droplet_id));
            if (!d) return err(422, 'unprocessable_entity', 'droplet_id is not a droplet of the account.');
            if (body.region !== undefined && body.region !== v.region.slug) return err(422, 'unprocessable_entity', 'region is not the volume\'s region.');
            // An attach or a detach is an event of the droplet's: it waits for none, and holds up any other.
            const busy = pendingEvent(d);
            if (busy) return busy;
            if (body.type === 'attach') {
                if (d.region.slug !== v.region.slug) return err(422, 'unprocessable_entity', 'Volumes must be in the same region as the Droplet.');
                if (v.droplet_ids.length) return err(422, 'unprocessable_entity', 'The volume is already attached to a Droplet.');
                v.droplet_ids = [d.id];
                const action = startAction('attach_volume', () => { d.volume_ids = [...(d.volume_ids ?? []), v.id]; }, d.id);
                return json(202, { action });
            }
            if (body.type === 'detach') {
                if (!v.droplet_ids.includes(d.id)) return err(422, 'unprocessable_entity', 'The volume is not attached to this Droplet.');
                const action = startAction('detach_volume', () => {
                    v.droplet_ids = [];
                    d.volume_ids = (d.volume_ids ?? []).filter((x: string) => x !== v.id);
                }, d.id);
                return json(202, { action });
            }
            return err(422, 'unprocessable_entity', `unsupported volume action ${body?.type}`);
        }
        if (method === 'POST' && (m = /^\/v2\/droplets\/(\d+)\/actions$/.exec(path))) {
            const d = state.droplets.get(m[1]);
            if (!d) return err(404, 'not_found', 'The resource you were accessing could not be found.');
            const busy = pendingEvent(d);
            if (busy) return busy;
            if (body.type === 'snapshot') {
                if (!body.name) return err(422, 'unprocessable_entity', 'name is required');
                const dropletId = d.id;
                const region = d.region.slug;
                const action = startAction('snapshot', () => {
                    const id = state.nextId++;
                    state.images.set(String(id), { id, name: body.name, type: 'snapshot', regions: [region], status: 'available',
                        size_gigabytes: 23.25, created_at: new Date().toISOString(), droplet_id: dropletId, files: { ...(state.droplets.get(String(dropletId))?.files ?? {}) } });
                }, d.id);
                return json(201, { action });
            }
            const done = { power_off: 'off', shutdown: 'off', power_on: 'active', reboot: 'active' }[body.type as string];
            if (!done) return err(422, 'unprocessable_entity', `unsupported action ${body.type}`);
            const action = startAction(body.type, () => {
                if (body.type === 'shutdown' && o.ignoreShutdown) return;
                d.status = done;
                // A reboot or a power-on is a boot of this droplet, and of no other.
                if (body.type === 'reboot' || body.type === 'power_on') d.boots++;
            }, d.id);
            return json(201, { action });
        }
        if (method === 'GET' && (m = /^\/v2\/actions\/(\d+)$/.exec(path))) {
            const a = state.actions.get(m[1]);
            if (!a) return err(404, 'not_found', 'The resource you were accessing could not be found.');
            progress(a);
            return json(200, { action: { id: a.id, type: a.type, status: a.status } });
        }
        if (method === 'GET' && (m = /^\/v2\/droplets\/(\d+)\/snapshots$/.exec(path))) {
            if (!state.droplets.has(m[1])) return err(404, 'not_found', 'The resource you were accessing could not be found.');
            // The snapshot list carries no status field (a listed snapshot is ready).
            const list = [...state.images.values()].filter((i) => String(i.droplet_id) === m![1] && i.type === 'snapshot')
                .map((i) => { const { status, ...rest } = imageView(i); return rest; });
            return json(200, { snapshots: list, links: {}, meta: { total: list.length } });
        }
        if (method === 'GET' && path === '/v2/vpcs') return json(200, { vpcs: state.vpcs, links: {}, meta: { total: state.vpcs.length } });
        if (path === '/v2/nfs' || path.startsWith('/v2/nfs/')) return nfs(method, path, u, body);
        if (method === 'POST' && path === '/v2/images') {
            // A custom image from a URL: NEW, with no region yet, until it is imported.
            if (typeof body?.name !== 'string' || !body.name) return err(422, 'unprocessable_entity', 'name is required');
            if (typeof body.url !== 'string' || !/^(https?|ftp):\/\//.test(body.url)) return err(422, 'unprocessable_entity', 'url must be an http, https or ftp URL');
            if (!state.sizes.some((x) => x.regions.includes(body.region))) return err(422, 'unprocessable_entity', 'region is not available');
            const id = state.nextId++;
            const img = { id, name: body.name, type: 'custom', distribution: body.distribution ?? 'Unknown', slug: null, public: false, regions: [] as string[],
                created_at: new Date().toISOString(), min_disk_size: null, size_gigabytes: null, description: body.description ?? '', tags: body.tags ?? [],
                status: 'NEW', error_message: '', importing: { reads: o.importReads ?? 3, url: body.url, region: body.region } };
            state.images.set(String(id), img);
            const { importing: _i, ...view } = img;
            return json(202, { image: view });
        }
        if (method === 'GET' && path === '/v2/images') {
            const own = [...state.images.values()].map(imageView);
            const list = u.searchParams.get('private') === 'true' ? own : [...PUBLIC_IMAGES, ...own];
            return json(200, { images: list, links: {}, meta: { total: list.length } });
        }
        if ((m = /^\/v2\/images\/(\d+)$/.exec(path))) {
            const img = state.images.get(m[1]);
            // A deleted image is not found, but deleting it again is refused as such (seen live).
            if (!img && method === 'DELETE' && state.deletedImages.has(m[1])) return err(422, 'unprocessable_entity', 'Can not delete an already deleted image.');
            if (!img) return err(404, 'not_found', 'The resource you were accessing could not be found.');
            if (method === 'GET') return json(200, { image: imageView(img) });
            if (method === 'DELETE') {
                // A failed import is 'deleted' already: answered as one deleted twice.
                if (img.status === 'deleted') return err(422, 'unprocessable_entity', 'Can not delete an already deleted image.');
                state.images.delete(m[1]);
                state.deletedImages.add(m[1]);
                return new Response(null, { status: 204 });
            }
        }
        if (method === 'POST' && (m = /^\/v2\/images\/(\d+)\/actions$/.exec(path))) {
            const img = state.images.get(m[1]);
            if (!img) return err(404, 'not_found', 'The resource you were accessing could not be found.');
            if (body.type !== 'transfer' || !body.region) return err(422, 'unprocessable_entity', `unsupported image action ${body.type}`);
            if (!REGIONS.includes(body.region)) return err(422, 'unprocessable_entity', `${body.region} is not a valid region.`);
            const action = startAction('transfer', () => {
                if (!img.regions.includes(body.region)) img.regions.push(body.region);
            });
            return json(201, { action });
        }
        if (method === 'GET' && path === '/v2/account') {
            return json(200, { account: { droplet_limit: state.dropletLimit, email_verified: true, status: 'active' } });
        }
        if (method === 'GET' && path === '/v2/account/keys') {
            const known = knownKeys();
            return json(200, { ssh_keys: known, links: {}, meta: { total: known.length } });
        }
        if (method === 'POST' && path === '/v2/account/keys') {
            let fingerprint: string;
            try {
                fingerprint = sshKeyFingerprint(String(body.public_key), 'md5');
            } catch {
                return err(422, 'unprocessable_entity', 'Key invalid, key should be of the format `type key [comment]`');
            }
            if (knownKeys().some((k) => k.fingerprint === fingerprint)) return err(422, 'unprocessable_entity', 'SSH Key is already in use on your account');
            const id = state.nextId++;
            const key = { id, name: body.name, public_key: body.public_key, fingerprint };
            state.keys.set(String(id), key);
            state.keyKnownAt.set(String(id), state.requests + state.keyLag);
            return json(201, { ssh_key: key });
        }
        if (method === 'DELETE' && (m = /^\/v2\/account\/keys\/(\d+)$/.exec(path))) {
            if (!state.keys.delete(m[1])) return err(404, 'not_found', 'The resource you were accessing could not be found.');
            return new Response(null, { status: 204 });
        }
        return err(404, 'not_found', `fake has no route ${method} ${path}`);
    }

    const api: FakeApi & { state: typeof state, backupImageId: string } = {
        fetchImpl: fetchImpl as typeof fetch,
        calls,
        state,
        liveServers: () => state.droplets.size,
        machine: (host: string) => {
            const d = [...state.droplets.values()].find((x) => x.status === 'active' && x.networks.v4.some((n: any) => n.type === 'public' && n.ip_address === host));
            // The account's own droplets (seeded) were made before the test: one boot, nothing on file.
            return d && { bootId: fakeBootId(d.id, d.boots ?? 1), files: { ...(d.files ?? {}) }, keys: [...(d.authKeys ?? [])] };
        },
        backupImageId: String(backupId),
    };
    return api;
}
