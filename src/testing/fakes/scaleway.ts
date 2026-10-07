// A fetch() that answers like api.scaleway.com for the calls both Scaleway
// initializers make, from Scaleway's OpenAPI specs (Instance API v1, IAM
// v1alpha1, Block Storage v1, Marketplace v2, read 2026-10-01) and its real
// catalog answers (./scalewayCatalog.ts). What it holds the initializers to:
//   - the secret key rides in X-Auth-Token (401 denied_authentication otherwise);
//   - every Instance and Block call is zonal, and an id is read in its zone only;
//   - a server is created `stopped` and runs after the `poweron` action; a type in
//     `shortage` is refused with a typed 400 out_of_stock, at the power-on (or at
//     the create, with shortageAt: 'create'); a GPU quota is a typed 403
//     quotas_exceeded (and, the Instance API's own wording, a 400
//     invalid_request_error "Quota exceeded for this resource");
//   - `terminate` (a server that runs) deletes it and its local volumes but only
//     DETACHES its Block Storage volumes, which then stay (status `available`)
//     until deleted through the Block API; deleting an attached volume is refused;
//     a STOPPED server has no `terminate` (400 precondition_failed, checked live)
//     and is deleted with DELETE, which keeps all its volumes, local ones too
//     (those are deleted through the Instance API's volumes);
//   - `backup` makes an image of snapshots (of the volumes it names, else of
//     all), `creating` for a few requests; deleting an image leaves its snapshots;
//   - a server's tags are set with PATCH, and a Block Storage volume is attached
//     to a server (its next free key) and detached (never its boot volume);
//   - a Block Storage volume is made `creating`, then `available`; a server is
//     created with existing ones attached by `volumes: {'<n>': {id, volume_type:
//     'sbs_volume'}}` (only `available` ones of its zone, checked live
//     2026-10-06 with keys from '1' and no '0'), after the volumes an account
//     image adds ('1'..'n', its extra volumes);
//   - the types list pages (per_page, page) with the X-Total-Count header, the
//     other lists page with page_size; SSH keys belong to a Project;
//   - Instance 404s are `unknown_resource`, IAM and Block 404s are `not_found`.
//   - a server authorizes the keys its Project held when it last booted (read at
//     every boot, as checked live 2026-10-02): a key deleted from the Project is
//     refused after the next reboot or power-on (`authorized`);
//   - `modification_date` is stamped at every change of state, as the live API does
//     (checked 2026-10-02: when a server is started, when it runs, when it is stopped);
//   - `intercept` changes the account at a known moment, or answers a request
//     its own way (a 500, a dropped connection), for the tests of what a client
//     does when the account changes behind its back.
// Assumed, not documented by the spec: Scaleway's own SSH key fingerprint (MD5
// here, so a client that trusted it instead of computing the SHA256 one would show).

import { sshKeyFingerprint } from '../../Core/utils';
import { fakeBootId, FakeApi, FakeMachine, json, readDiskFiles, readRequest, userDataFiles, writeDiskFiles } from './util';
import { fakeS3, FakeS3 } from './s3';
import { MARKETPLACE_IMAGES, SERVER_TYPES } from './scalewayCatalog';

export const FAKE_SCALEWAY_PROJECT = '11111111-1111-4111-8111-111111111111';
const OTHER_PROJECT = '22222222-2222-4222-8222-222222222222';

export type FakeScalewayOptions = {
    token?: string,
    /** Requests the fake answers while a server starts, before it runs (default 2): time passes with every request. */
    bootReads?: number,
    /** Requests while a server stops before it is stopped or, terminated, gone (default 2). */
    stopReads?: number,
    /** Requests while an image is made before it is available (default 2). */
    imageReads?: number,
    /** Where a type in shortage is refused: its create, or its power-on (default). */
    shortageAt?: 'create' | 'poweron',
    /** GPU servers one zone may hold (default 4). */
    gpuQuota?: number,
    /** Instance API quotas are worded as an invalid_request_error: use that wording instead of the typed one. */
    legacyQuota?: boolean,
    /** CPU types added to fr-par-2, to make its type table span pages. */
    fillerTypes?: number,
    /** Types the catalog reports at end of service. */
    endOfService?: string[],
    /** The backup action answers without saying which image it makes (no `href_result`: every field of a task is optional). */
    noTaskHref?: boolean,
    /** An image ends in the `error` state instead of becoming available. */
    imageFails?: boolean,
    /** Requests while a File Storage filesystem is made before it is available (default 1). */
    fileReads?: number,
    /** The access key Object Storage knows (its secret is the token): the Project's buckets are `<access key>@<project>`'s. */
    accessKey?: string,
    /** Requests while an import from Object Storage is a `creating` snapshot (default 2). */
    importReads?: number,
    /** Requests while a serverless container deploys before it is ready (default 2); an image with "missing" in it ends in `error`. */
    deployReads?: number,
    /** Requests to a container's endpoint answered 503 after it is deployed, while its first instance starts (a cold start; default 1). */
    coldRequests?: number,
};

const ZONES = ['fr-par-1', 'fr-par-2', 'fr-par-3', 'nl-ams-1', 'nl-ams-2', 'nl-ams-3', 'pl-waw-1', 'pl-waw-2', 'pl-waw-3', 'it-mil-1'];

/** Which zone offers which types, as in the real listing of 2026-10-01 (the other zones offered no GPU type, and are left empty here). */
const OFFERED: Record<string, string[]> = {
    'fr-par-1': ['L4-1-24G', 'L4-2-24G', 'DEV1-S', 'PLAY2-NANO', 'STARDUST1-S', 'BASIC2-A2C-4G'],
    'fr-par-2': ['L4-1-24G', 'L4-2-24G', 'L40S-1-48G', 'H100-1-80G', 'H100-SXM-8-80G', 'B300-SXM-8-288G', 'RENDER-S', 'DEV1-S', 'PLAY2-NANO', 'BASIC2-A2C-4G'],
    'nl-ams-1': ['DEV1-S', 'PLAY2-NANO', 'STARDUST1-S', 'BASIC2-A2C-4G'],
    'pl-waw-2': ['L4-1-24G', 'L4-2-24G', 'L40S-1-48G', 'H100-1-80G', 'DEV1-S', 'PLAY2-NANO', 'STARDUST1-S'],
};

/** Live stock of the GPU types (a type not listed here is `available`): the real snapshot, with one `scarce` (L40S in Paris 2) added. */
const STOCK: Record<string, Record<string, string>> = {
    'fr-par-1': { 'L4-1-24G': 'shortage', 'L4-2-24G': 'shortage' },
    'fr-par-2': {
        'L4-1-24G': 'shortage', 'L4-2-24G': 'shortage', 'L40S-1-48G': 'scarce', 'H100-1-80G': 'shortage', 'H100-SXM-8-80G': 'shortage',
        'B300-SXM-8-288G': 'shortage', 'RENDER-S': 'available',
    },
    'pl-waw-2': { 'L4-1-24G': 'available', 'L4-2-24G': 'scarce', 'L40S-1-48G': 'shortage', 'H100-1-80G': 'shortage' },
};

const GPU_LABEL = /_gpu_os_/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A request as a hook sees it. */
export type FakeScalewayRequest = { method: string, path: string, body: any };

export type FakeScalewayHook = {
    /** Replaces the fake's answer (return a Response, or throw to drop the connection). */
    answer?: (r: FakeScalewayRequest) => Response,
    /** Runs once the fake has answered. */
    after?: (r: FakeScalewayRequest) => void,
    /** How many matching requests it applies to (default: all). */
    times?: number,
};

export function fakeScaleway(o: FakeScalewayOptions = {}) {
    const token = o.token ?? 'scw-test';
    const calls: FakeApi['calls'] = [];
    const state = {
        servers: new Map<string, any>(),
        /** Block Storage volumes (`sbs_volume`), by id. */
        volumes: new Map<string, any>(),
        /** Snapshots: `sbs_snapshot` (Block Storage) and `unified` (Instance API), by id. */
        snapshots: new Map<string, any>(),
        images: new Map<string, any>(),
        keys: new Map<string, any>(),
        /** Object Storage per region: buckets of the Project's. */
        s3: {} as Record<string, FakeS3>,
        /** File Storage filesystems, by id (Paris only, as the API has it). */
        filesystems: new Map<string, any>(),
        /** Serverless Containers: namespaces and containers, by id (each with its region). */
        namespaces: new Map<string, any>(),
        containers: new Map<string, any>(),
        /** Instance API volumes (`l_ssd`) a deleted stopped server left behind, by id. */
        localVolumes: new Map<string, any>(),
        nextId: 1,
        bootReads: o.bootReads ?? 2,
        stopReads: o.stopReads ?? 2,
        imageReads: o.imageReads ?? 2,
        gpuQuota: o.gpuQuota ?? 4,
        nextIp: 10,
        /** Stock set by a test, over the table below: `state.stock['pl-waw-2']['L4-1-24G'] = 'shortage'`. */
        stock: {} as Record<string, Record<string, string>>,
    };
    const uuid = () => `00000000-0000-4000-8000-${(state.nextId++).toString(16).padStart(12, '0')}`;
    for (const region of ['fr-par', 'nl-ams', 'pl-waw', 'it-mil']) {
        state.s3[region] = fakeS3({ region, credentials: { accessKey: `${o.accessKey ?? 'SCWFAKEACCESSKEY0000'}@${FAKE_SCALEWAY_PROJECT}`, secretKey: token } });
    }
    // Time never stands still: two things made in one millisecond are still made in order.
    let clock = Date.now();
    const now = () => new Date(clock = Math.max(Date.now(), clock + 1)).toISOString();

    const typesOf = (zone: string): Record<string, any> => {
        const out: Record<string, any> = {};
        for (const name of OFFERED[zone] ?? []) out[name] = SERVER_TYPES[name];
        if (zone === 'fr-par-2') {
            for (let i = 0; i < (o.fillerTypes ?? 0); i++) out[`FILLER-${String(i).padStart(3, '0')}`] = { ...SERVER_TYPES['DEV1-S'], hourly_price: 0.01 + i / 1000 };
        }
        for (const name of o.endOfService ?? []) if (out[name]) out[name] = { ...out[name], end_of_service: true };
        return out;
    };
    const stockOf = (zone: string, type: string) => state.stock[zone]?.[type] ?? STOCK[zone]?.[type] ?? 'available';

    const err = (status: number, type: string, message: string, extra: Record<string, unknown> = {}) => json(status, { type, message, ...extra });
    /** The Instance API's 404. */
    const unknownResource = (what: string, id: string) => err(404, 'unknown_resource', `${what} "${id}" not found`);
    /** The standard 404 of the IAM and Block APIs. */
    const notFound = (resource: string, id: string) => err(404, 'not_found', `resource ${resource} with ID ${id} is not found`, { resource, resource_id: id });
    const invalid = (argument: string, help: string) => err(400, 'invalid_arguments', 'Invalid argument(s)', { details: [{ argument_name: argument, reason: 'constraint', help_message: help }] });
    const transient = (s: any) => err(400, 'transient_state', `resource instance_server with ID ${s.id} is in a transient state: ${s.state}`,
        { resource: 'instance_server', resource_id: s.id, current_state: s.state });

    /** A page of a list, by the page-size parameter the API names; the whole count rides in X-Total-Count. */
    const paged = <T>(items: T[], u: URL, size: 'per_page' | 'page_size'): { items: T[], headers: Record<string, string> } => {
        const n = Number(u.searchParams.get(size) ?? 50);
        const page = Number(u.searchParams.get('page') ?? 1);
        return { items: items.slice((page - 1) * n, page * n), headers: { 'x-total-count': String(items.length) } };
    };

    const ALLOWED: Record<string, string[]> = {
        running: ['poweroff', 'stop_in_place', 'reboot', 'backup', 'terminate'],
        // Checked live: a stopped server has no `terminate` (it is deleted instead).
        stopped: ['poweron', 'backup'],
        'stopped in place': ['poweron', 'poweroff', 'backup', 'terminate'],
        starting: [],
        stopping: [],
    };
    const view = (s: any) => {
        const { bootLeft, stopLeft, terminating, userData, bootKeys, files, boots, ...rest } = s;
        return { ...rest, filesystems: (rest.filesystems ?? []).map((x: any) => ({ ...x })), allowed_actions: ALLOWED[s.state] ?? [] };
    };
    /** A server's filesystems let go of (it is deleted). */
    const releaseFileSystems = (s: any) => {
        for (const a of s.filesystems ?? []) {
            const fsys = state.filesystems.get(a.filesystem_id);
            if (fsys) fsys.number_of_attachments = Math.max(0, fsys.number_of_attachments - 1);
        }
        s.filesystems = [];
    };
    const imageView = (i: any) => {
        const { left, ...rest } = i;
        return rest;
    };
    const volumeView = (v: any) => {
        const { left, ...rest } = v;
        return rest;
    };
    /** An Instance snapshot (a local volume's), as the Instance API reads it. */
    const instanceSnapshotView = (x: any) => ({
        id: x.id, name: x.name, volume_type: x.volume_type, size: x.size, state: x.state ?? 'available', zone: x.zone, project: FAKE_SCALEWAY_PROJECT, tags: [],
    });
    const snapshotView = (x: any) => {
        const { left, corrupt, volume_type, image, exportTo, ...rest } = x;
        return { ...rest, status: rest.status ?? 'available', tags: rest.tags ?? [], project_id: rest.project_id ?? FAKE_SCALEWAY_PROJECT };
    };
    /** A Block Storage volume a server holds from now on. */
    const attach = (v: any, serverId: string) => Object.assign(v, {
        status: 'in_use', references: [{ id: uuid(), product_resource_type: 'instance_server', product_resource_id: serverId, type: 'exclusive', status: 'attached' }],
    });
    const find = (zone: string, id: string) => (UUID.test(id) ? state.servers.get(`${zone}/${id}`) : undefined);

    /** Removes a terminated server: its local volumes go, its Block Storage volumes are only detached, its filesystems let go of. */
    const reap = (s: any) => {
        state.servers.delete(`${s.zone}/${s.id}`);
        releaseFileSystems(s);
        for (const v of Object.values<any>(s.volumes)) {
            const block = state.volumes.get(v.id);
            if (block) Object.assign(block, { status: 'available', references: [] });
        }
    };

    /** Moves a server on by one tick: starting -> running (with its dynamic IP), stopping -> stopped or, terminating, gone. */
    const tick = (s: any) => {
        if (s.state === 'starting' && --s.bootLeft <= 0) {
            s.state = 'running';
            s.modification_date = now();
            s.state_detail = '';
            s.bootKeys = [...state.keys.values()].filter((k) => k.project_id === s.project && !k.disabled).map((k) => k.public_key);
            // cloud-init runs its user data at the first boot only.
            if (++s.boots === 1) Object.assign(s.files, userDataFiles(s.userData['cloud-init']));
            // A dynamic IP is released when the server is stopped: a power-on gets a new one, a reboot keeps it.
            if (!s.public_ips.length) {
                s.public_ips = [{ id: uuid(), address: `51.159.0.${state.nextIp++}`, gateway: '10.0.0.1', netmask: '32', family: 'inet', dynamic: true,
                    provisioning_mode: 'dhcp', tags: [], ipam_id: uuid(), state: 'attached' }];
            }
        } else if (s.state === 'stopping' && --s.stopLeft <= 0) {
            if (s.terminating) return reap(s);
            s.state = 'stopped';
            s.modification_date = now();
            s.public_ips = [];
        }
    };
    /** Time passes with every request the fake answers (a client that retries without reading must see things change too). */
    const advance = () => {
        for (const s of [...state.servers.values()]) tick(s);
        for (const i of state.images.values()) if (i.state === 'creating' && --i.left <= 0) i.state = o.imageFails ? 'error' : 'available';
        for (const v of state.volumes.values()) if (v.status === 'creating' && --v.left <= 0) v.status = 'available';
        for (const x of state.filesystems.values()) if (x.status === 'creating' && --x.left <= 0) x.status = 'available';
        for (const x of state.snapshots.values()) if (x.status === 'creating' && --x.left <= 0) x.status = x.corrupt ? 'error' : 'available';
        for (const x of state.snapshots.values()) {
            if (!x.exportTo || --x.exportTo.left > 0) continue;
            const qcow2 = Buffer.alloc(4096, 2);
            qcow2.write('QFI\xfb', 0, 'latin1');
            writeDiskFiles(qcow2, x.files);
            state.s3[x.exportTo.region]?.buckets.get(x.exportTo.bucket)?.set(x.exportTo.key, new Uint8Array(qcow2));
            delete x.exportTo;
            if (x.volume_type === 'sbs_snapshot') x.status = 'available';
            else x.state = 'available';
        }
        for (const sv of state.servers.values()) {
            for (const a of sv.filesystems ?? []) if (a.state === 'attaching') a.state = 'available';
            for (const a of (sv.filesystems ?? []).filter((x: any) => x.state === 'detaching')) {
                sv.filesystems = sv.filesystems.filter((x: any) => x !== a);
                const fsys = state.filesystems.get(a.filesystem_id);
                if (fsys) fsys.number_of_attachments = Math.max(0, fsys.number_of_attachments - 1);
            }
        }
    };

    const quotaFull = (zone: string, type: any) => (type.gpu ?? 0) > 0
        && [...state.servers.values()].filter((s) => s.zone === zone && (SERVER_TYPES[s.commercial_type]?.gpu ?? 0) > 0).length >= state.gpuQuota;
    // The typed quota is a 403, as the live API answers it (checked 2026-10-02: a GPU type of an account that is not verified yet).
    const quota = (type: string) => (o.legacyQuota
        ? err(400, 'invalid_request_error', 'Quota exceeded for this resource', { resource: 'instances_gpu', fields: null })
        : err(403, 'quotas_exceeded', 'quota(s) exceeded for this resource', {
            details: [{ resource: `cp_servers_type_${type.replace(/-/g, '_')}`, organization_id: OTHER_PROJECT }, { resource: `cp_servers_type_${type.replace(/-/g, '_')}`, project_id: FAKE_SCALEWAY_PROJECT }],
        }));
    const noStock = (zone: string, type: string) => err(400, 'out_of_stock', `resource ${type} is out of stock in ${zone}`, { resource: type });

    /** The images a type can boot: a GPU OS image only on a GPU type. */
    const bootable = (label: string, type: any) => !GPU_LABEL.test(label) || (type.gpu ?? 0) > 0;

    const createServer = (zone: string, b: any): Response => {
        const type = typesOf(zone)[b.commercial_type];
        if (!b.name) return invalid('name', 'is required');
        if (!type) return invalid('commercial_type', `${b.commercial_type} is not offered in ${zone}`);
        if (!b.project) return invalid('project', 'is required');
        let image: any;
        if (UUID.test(String(b.image))) {
            image = [...state.images.values()].find((i) => i.id === b.image && i.zone === zone);
            if (!image) return invalid('image', `image ${b.image} not found in ${zone}`);
        } else {
            image = MARKETPLACE_IMAGES.find((i) => i.label === b.image);
            if (!image) return invalid('image', `unknown image label ${b.image}`);
            if (!bootable(image.label, type)) return invalid('image', `${image.label} is not compatible with ${b.commercial_type}`);
        }
        const root = b.volumes?.['0'];
        // A GPU type allows no local volume: its root volume is Block Storage.
        if (root?.volume_type === 'l_ssd' && type.volumes_constraint.max_size === 0) return invalid('volumes.0.volume_type', `${b.commercial_type} has no local storage`);
        if (root?.size !== undefined && root.size % 512 !== 0) return invalid('volumes.0.size', 'must be a multiple of 512');
        if (quotaFull(zone, type)) return quota(b.commercial_type);
        if (o.shortageAt === 'create' && stockOf(zone, b.commercial_type) === 'shortage') return noStock(zone, b.commercial_type);
        // An account image's extra volumes take keys '1'..'n'; an existing volume is attached at a key of its own, after them.
        const extra = Object.entries<any>(image.extra_volumes ?? {});
        const existing = Object.entries<any>(b.volumes ?? {}).filter(([k]) => k !== '0');
        for (const [k, t] of existing) {
            if (!t?.id) return invalid(`volumes.${k}`, 'the fake makes no extra volume: name an existing one (id)');
            if (t.volume_type !== 'sbs_volume') return invalid(`volumes.${k}.volume_type`, 'an existing Block Storage volume is attached as sbs_volume');
            if (extra.some(([x]) => x === k)) return invalid(`volumes.${k}`, `key ${k} is the image's extra volume`);
            const v = state.volumes.get(t.id);
            if (!v || v.zone !== zone) return notFound('volume', t.id);
            if (v.status !== 'available') return err(400, 'precondition_failed', `volume ${t.id} is ${v.status}`, { precondition: 'resource_still_in_use' });
        }
        const id = uuid();
        const rootType = root?.volume_type ?? (type.capabilities?.block_storage ? 'sbs_volume' : 'l_ssd');
        const rootId = uuid();
        const rootSize = root?.size ?? 10_000_000_000;
        if (rootType === 'sbs_volume') {
            state.volumes.set(rootId, { id: rootId, name: `${b.name}-0`, type: 'sbs_5k', size: rootSize, project_id: b.project, status: 'in_use', tags: [], zone,
                references: [{ id: uuid(), product_resource_type: 'instance_server', product_resource_id: id, type: 'exclusive', status: 'attached' }] });
        }
        const volumes: Record<string, any> = { 0: { id: rootId, name: `${b.name}-0`, volume_type: rootType, size: rootSize, boot: true, state: 'available', zone, server: { id, name: b.name } } };
        for (const [k, x] of extra) {
            // Made from the image's snapshot: Block Storage for an sbs_snapshot, else a local volume.
            const vid = uuid();
            const block = x.volume_type === 'sbs_snapshot';
            if (block) attach(state.volumes.set(vid, { id: vid, name: `${b.name}-${k}`, type: 'sbs_5k', size: x.size, project_id: b.project, tags: [], zone }).get(vid), id);
            volumes[k] = { id: vid, name: `${b.name}-${k}`, volume_type: block ? 'sbs_volume' : 'l_ssd', size: x.size, boot: false, state: 'available', zone, server: { id, name: b.name } };
        }
        for (const [k, t] of existing) {
            const v = attach(state.volumes.get(t.id), id);
            volumes[k] = { id: v.id, name: v.name, volume_type: 'sbs_volume', size: v.size, boot: false, state: 'available', zone, server: { id, name: b.name } };
        }
        const s = {
            id, name: b.name, organization: b.project, project: b.project, tags: b.tags ?? [], commercial_type: b.commercial_type,
            creation_date: now(), modification_date: now(), dynamic_ip_required: b.dynamic_ip_required ?? true, hostname: b.name,
            image: { id: image.id, name: image.name, arch: type.arch, zone, state: 'available', public: true },
            protected: !!b.protected, private_ip: null, public_ip: null, public_ips: [], mac_address: '02:00:00:00:00:01', state: 'stopped',
            state_detail: '', boot_type: b.boot_type ?? 'local', arch: type.arch, zone, end_of_service: false, dns: null, ipv6: null,
            volumes,
            bootLeft: 0, stopLeft: 0, terminating: false, userData: {}, bootKeys: [],
            // Its disk: what the image it boots from carries; its user data adds to it at its first boot.
            files: { ...(image.files ?? {}) }, boots: 0,
        };
        state.servers.set(`${zone}/${id}`, s);
        return json(201, { server: view(s) });
    };

    const action = (s: any, b: any): Response => {
        const task = (what: string) => json(200, { task: { id: uuid(), description: `server_${what}`, progress: 0, status: 'pending', href_from: `/servers/${s.id}/action`, href_result: `/servers/${s.id}` } });
        const busy = s.state === 'starting' || s.state === 'stopping';
        switch (b.action) {
            case 'poweron': {
                if (busy) return transient(s);
                if (s.state === 'running') return err(400, 'precondition_failed', 'the server is running already', { precondition: 'unknown_precondition' });
                if (stockOf(s.zone, s.commercial_type) === 'shortage') return noStock(s.zone, s.commercial_type);
                Object.assign(s, { state: 'starting', state_detail: 'booting kernel', bootLeft: state.bootReads, modification_date: now() });
                return task('poweron');
            }
            case 'poweroff':
            case 'stop_in_place': {
                if (busy) return transient(s);
                if (s.state !== 'running' && s.state !== 'stopped in place') return err(400, 'precondition_failed', `cannot ${b.action} a ${s.state} server`, { precondition: 'unknown_precondition' });
                if (b.action === 'stop_in_place') Object.assign(s, { state: 'stopped in place', modification_date: now() });
                else Object.assign(s, { state: 'stopping', stopLeft: state.stopReads, modification_date: now() });
                return task(b.action);
            }
            case 'reboot': {
                if (s.state !== 'running') return transient(s);
                Object.assign(s, { state: 'starting', bootLeft: state.bootReads, modification_date: now() });
                return task('reboot');
            }
            case 'terminate': {
                if (s.state === 'stopped') return err(400, 'precondition_failed', 'precondition is not respected', { precondition: 'unknown_precondition' });
                if (s.protected) return err(400, 'precondition_failed', 'the server is protected', { precondition: 'unknown_precondition' });
                // A terminate under way is asked again harmlessly; a start or a stop in progress refuses it (a starting server, checked live: 400 precondition_failed).
                if (busy && !s.terminating) return err(400, 'precondition_failed', 'precondition is not respected', { precondition: 'unknown_precondition' });
                if (!s.terminating) Object.assign(s, { state: 'stopping', terminating: true, stopLeft: state.stopReads });
                return task('terminate');
            }
            case 'backup': {
                if (!b.name) return invalid('name', 'is required for a backup');
                if (busy) return transient(s);
                // The volumes it names (by id), else every one but a scratch volume.
                const named = b.volumes ? Object.keys(b.volumes) : undefined;
                const own = Object.values<any>(s.volumes);
                const stranger = named?.find((vid) => !own.some((v) => v.id === vid));
                if (stranger) return invalid('volumes', `volume ${stranger} is not one of the server's`);
                const imageId = uuid();
                const vols = own.filter((v) => v.volume_type !== 'scratch' && (!named || named.includes(v.id)));
                const made = vols.map((v) => {
                    const id = uuid();
                    const type = v.volume_type === 'sbs_volume' ? 'sbs_snapshot' : 'unified';
                    // The root disk's snapshot holds the server's files.
                    state.snapshots.set(id, { id, name: `${b.name}-${v.name}`, volume_type: type, size: v.size, zone: s.zone, image: imageId, ...(v === own[0] ? { files: { ...s.files } } : {}) });
                    return { id, name: `${b.name}-${v.name}`, size: v.size, volume_type: type };
                });
                state.images.set(imageId, { id: imageId, name: b.name, arch: s.arch, from_server: s.id, organization: s.project, project: s.project, public: false,
                    root_volume: made[0] ?? null, extra_volumes: Object.fromEntries(made.slice(1).map((m, i) => [String(i + 1), { ...m, organization: s.project, project: s.project, tags: [], server: null, state: 'available', zone: s.zone }])), state: 'creating',
                    tags: [], zone: s.zone, creation_date: now(), modification_date: now(), left: state.imageReads, files: { ...s.files } });
                return json(200, { task: { id: uuid(), description: 'server_backup', progress: 0, status: 'pending', href_from: `/servers/${s.id}/action`, ...(o.noTaskHref ? {} : { href_result: `/images/${imageId}` }) } });
            }
            default:
                return invalid('action', `unsupported action ${b.action}`);
        }
    };

    // The account's other things: a CPU server and an image of its own, which a GPU listing must not mix up with a test's.
    const seed = (zone: string, name: string, type: string, rootType: 'l_ssd' | 'sbs_volume') => {
        const id = uuid();
        const rootId = uuid();
        if (rootType === 'sbs_volume') {
            state.volumes.set(rootId, { id: rootId, name: `${name}-0`, type: 'sbs_5k', size: 20_000_000_000, project_id: FAKE_SCALEWAY_PROJECT, status: 'in_use', tags: [], zone,
                references: [{ id: uuid(), product_resource_type: 'instance_server', product_resource_id: id, type: 'exclusive', status: 'attached' }] });
        }
        state.servers.set(`${zone}/${id}`, { id, name, organization: FAKE_SCALEWAY_PROJECT, project: FAKE_SCALEWAY_PROJECT, tags: ['prod'], commercial_type: type,
            creation_date: '2026-01-01T00:00:00Z', dynamic_ip_required: true, hostname: name, image: null, protected: false, private_ip: null, public_ip: null,
            public_ips: [{ id: uuid(), address: '51.159.1.1', gateway: '10.0.0.1', netmask: '32', family: 'inet', dynamic: true, provisioning_mode: 'dhcp', tags: [], ipam_id: uuid(), state: 'attached' }],
            mac_address: '02:00:00:00:00:02', state: 'running', state_detail: '', boot_type: 'local', arch: 'x86_64', zone, end_of_service: false, dns: null, ipv6: null,
            volumes: { 0: { id: rootId, name: `${name}-0`, volume_type: rootType, size: 20_000_000_000, boot: true, state: 'available', zone } },
            bootLeft: 0, stopLeft: 0, terminating: false, userData: {}, bootKeys: [], files: {}, boots: 1 });
        return id;
    };
    const prodServer = seed('fr-par-1', 'api-1', 'DEV1-S', 'l_ssd');
    seed('nl-ams-1', 'mail', 'PLAY2-NANO', 'sbs_volume');
    const backupId = uuid();
    state.images.set(backupId, { id: backupId, name: 'api-1 backup 2026-09-01', arch: 'x86_64', from_server: prodServer, organization: FAKE_SCALEWAY_PROJECT, project: FAKE_SCALEWAY_PROJECT,
        public: false, root_volume: { id: uuid(), name: 'api-1-0', size: 20_000_000_000, volume_type: 'unified' }, extra_volumes: {}, state: 'available', tags: [], zone: 'fr-par-1',
        creation_date: '2026-09-01T00:00:00Z', modification_date: '2026-09-01T00:00:00Z', left: 0 });
    // The Project's SSH keys, and another Project's (which must never show).
    const addKey = (name: string, publicKey: string, project: string) => {
        const id = uuid();
        const key = { id, name, public_key: publicKey, fingerprint: sshKeyFingerprint(publicKey, 'md5'), organization_id: FAKE_SCALEWAY_PROJECT, project_id: project, disabled: false,
            created_at: now(), updated_at: now() };
        state.keys.set(id, key);
        return key;
    };
    addKey('laptop', 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKd0 laptop', FAKE_SCALEWAY_PROJECT);
    addKey('theirs', 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOth3r theirs', OTHER_PROJECT);

    const hooks: Array<FakeScalewayHook & { match: (r: FakeScalewayRequest) => boolean, left: number }> = [];

    async function fetchImpl(url: string | URL | Request, init?: RequestInit): Promise<Response> {
        const host = new URL(String(url)).host;
        // Object Storage: S3, signed by its own rules.
        const s3 = /^s3\.([a-z-]+)\.scw\.cloud$/.exec(host);
        if (s3) {
            calls.push({ method: (init?.method ?? 'GET').toUpperCase(), host, path: new URL(String(url)).pathname, body: undefined, auth: undefined, headers: {} });
            return state.s3[s3[1]]?.fetchImpl(url, init) ?? json(404, { message: `no Object Storage in ${s3[1]}` });
        }
        // A file anyone can download (an image's QCOW2): a small one whose first bytes say QCOW2 ("corrupt" in its name: they do not).
        if (!/scw\.cloud$|scaleway\.com$/.test(host)) {
            calls.push({ method: (init?.method ?? 'GET').toUpperCase(), host, path: new URL(String(url)).pathname, body: undefined, auth: undefined, headers: {} });
            if (/missing/.test(String(url))) return new Response('not found', { status: 404, statusText: 'Not Found' });
            const bytes = Buffer.alloc(4096, 1);
            if (!/corrupt/.test(String(url))) bytes.write('QFI\xfb', 0, 'latin1');
            return new Response(bytes, { status: 200, headers: { 'content-length': String(bytes.length) } });
        }
        const request = readRequest(calls, url, init);
        if (/\.functions\.fnc\.[a-z-]+\.scw\.cloud$/.test(request.u.host)) return containerRequest(request);
        if (request.headers['x-auth-token'] !== token) return err(401, 'denied_authentication', 'invalid authentication', { method: 'api_key', reason: 'invalid_argument' });
        advance();
        const seen = { method: request.method, path: request.path, body: request.body };
        const hook = hooks.find((h) => h.left > 0 && h.match(seen));
        if (hook) hook.left--;
        const answer = hook?.answer ? hook.answer(seen) : await route(request);
        hook?.after?.(seen);
        return answer;
    }

    /** A request to a container's public endpoint: 403 without the key where it is private; 503 while it is cold; else an echo of the request. */
    function containerRequest({ u, method, path, headers }: ReturnType<typeof readRequest>): Response {
        const c = [...state.containers.values()].find((x) => new URL(x.public_endpoint).host === u.host && x.status !== 'deleting');
        if (!c || c.status !== 'ready') return json(404, { message: 'container not found' });
        if (c.privacy === 'private' && headers['x-auth-token'] !== token) return json(403, { message: 'forbidden: a private container needs a token' });
        if (c.cold > 0) {
            c.cold--;
            return json(503, { message: 'no instance is up yet' });
        }
        return json(200, { container: c.name, method, path, query: u.search, port: c.port, image: c.image });
    }

    /** A namespace or container read: `creating` moves on with each read; `deleting` is gone at the next. */
    const settle = (x: any, map: Map<string, any>): any => {
        if (x.status === 'deleting') {
            if (x.deleteReads-- <= 0) {
                map.delete(x.id);
                return null;
            }
        } else if (x.status === 'creating' && ++x.reads >= x.deployReads) {
            x.status = x.fails ? 'error' : 'ready';
            if (x.fails) x.error_message = `image "${x.image}" could not be pulled: manifest unknown`;
        }
        const { reads, deployReads, deleteReads, fails, cold, ...view } = x;
        return view;
    };
    const NAME_NS = /^[a-zA-Z]([-a-zA-Z0-9]*[a-zA-Z0-9])?$/;
    const NAME_CONTAINER = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;

    /** Serverless Containers API v1 (regional): namespaces, and containers deployed in them. */
    function serverless(method: string, region: string, kind: string, id: string | undefined, body: any, u: URL): Response {
        const now = new Date().toISOString();
        if (kind === 'namespaces') {
            if (!id && method === 'POST') {
                if (body?.project_id !== FAKE_SCALEWAY_PROJECT) return invalid('project_id', 'unknown project');
                if (typeof body?.name !== 'string' || body.name.length > 50 || !NAME_NS.test(body.name)) return invalid('name', 'must be 1-50 characters, a letter first');
                const ns = { id: uuid(), name: body.name, organization_id: FAKE_SCALEWAY_PROJECT, project_id: body.project_id, description: body.description ?? '',
                    status: 'creating', error_message: null, environment_variables: body.environment_variables ?? {}, tags: body.tags ?? [], created_at: now, updated_at: now,
                    region, reads: 0, deployReads: 1, deleteReads: 1 };
                state.namespaces.set(ns.id, ns);
                return json(200, settle({ ...ns, reads: -1 }, new Map()));
            }
            const ns = id ? state.namespaces.get(id) : undefined;
            if (!ns || ns.region !== region) return notFound('namespace', String(id));
            if (method === 'GET') {
                const view = settle(ns, state.namespaces);
                return view ? json(200, view) : notFound('namespace', ns.id);
            }
            if (method === 'DELETE') {
                ns.status = 'deleting';
                for (const c of state.containers.values()) if (c.namespace_id === ns.id) c.status = 'deleting';
                const { reads, deployReads, deleteReads, ...view } = ns;
                return json(200, view);
            }
        }
        if (!id && method === 'GET') {
            const all = [...state.containers.values()].filter((c) => c.region === region && (!u.searchParams.get('project_id') || state.namespaces.get(c.namespace_id)?.project_id === u.searchParams.get('project_id')))
                .map((c) => settle(c, state.containers)).filter(Boolean);
            const p = paged(all, u, 'page_size');
            return json(200, { containers: p.items, total_count: all.length }, 'application/json', p.headers);
        }
        if (!id && method === 'POST') {
            const ns = state.namespaces.get(body?.namespace_id);
            if (!ns || ns.region !== region) return notFound('namespace', String(body?.namespace_id));
            if (ns.status !== 'ready') return err(412, 'precondition_failed', `namespace ${ns.id} is ${ns.status}`);
            const bad = (arg: string, help: string) => invalid(arg, help);
            if (typeof body.name !== 'string' || body.name.length < 2 || body.name.length > 34 || !NAME_CONTAINER.test(body.name)) return bad('name', 'must be 2-34 lowercase letters, digits and dashes');
            if (!body.image) return bad('image', 'is required');
            if (body.min_scale !== undefined && !(body.min_scale >= 0 && body.min_scale <= 10)) return bad('min_scale', 'must be 0-10');
            if (body.max_scale !== undefined && !(body.max_scale >= 1 && body.max_scale <= 200)) return bad('max_scale', 'must be 1-200');
            if (body.mvcpu_limit !== undefined && !(body.mvcpu_limit >= 70 && body.mvcpu_limit <= 6000)) return bad('mvcpu_limit', 'must be 70-6000');
            if (body.memory_limit_bytes !== undefined && !(body.memory_limit_bytes >= 128e6 && body.memory_limit_bytes <= 12288e6)) return bad('memory_limit_bytes', 'must be 128 MB to 12288 MB');
            if (body.port !== undefined && !(body.port >= 1 && body.port <= 65535)) return bad('port', 'must be 1-65535');
            if ([...state.containers.values()].some((c) => c.namespace_id === ns.id && c.name === body.name)) return err(409, 'conflict', `container ${body.name} exists`);
            const c = { id: uuid(), name: body.name, namespace_id: ns.id, description: body.description ?? '', status: 'creating', error_message: null, created_at: now, updated_at: now,
                environment_variables: body.environment_variables ?? {}, min_scale: body.min_scale ?? 0, max_scale: body.max_scale ?? 5, memory_limit_bytes: body.memory_limit_bytes ?? 2048e6,
                mvcpu_limit: body.mvcpu_limit ?? 1000, local_storage_limit_bytes: 1e9, timeout: body.timeout ?? '300s', privacy: body.privacy ?? 'public', image: body.image,
                protocol: body.protocol ?? 'http1', port: body.port ?? 8080, https_connections_only: false, sandbox: body.sandbox ?? 'v2', tags: body.tags ?? [],
                command: body.command ?? [], args: body.args ?? [], private_endpoint: null, region,
                public_endpoint: `https://${ns.name.replace(/-/g, '')}${ns.id.slice(0, 8)}-${body.name}.functions.fnc.${region}.scw.cloud`,
                reads: 0, deployReads: o.deployReads ?? 2, deleteReads: 1, fails: /missing/.test(body.image), cold: o.coldRequests ?? 1 };
            state.containers.set(c.id, c);
            return json(200, settle({ ...c, reads: -1 }, new Map()));
        }
        const c = id ? state.containers.get(id) : undefined;
        if (!c || c.region !== region) return notFound('container', String(id));
        if (method === 'GET') {
            const view = settle(c, state.containers);
            return view ? json(200, view) : notFound('container', c.id);
        }
        if (method === 'DELETE') {
            c.status = 'deleting';
            const { reads, deployReads, deleteReads, fails, cold, ...view } = c;
            return json(200, view);
        }
        return err(405, 'method_not_allowed', `${method} ${kind}`);
    }

    async function route({ u, method, body, path }: ReturnType<typeof readRequest>): Promise<Response> {
        let m: RegExpExecArray | null;

        // ── File Storage API v1alpha1 (Paris only) ──
        if ((m = /^\/file\/v1alpha1\/regions\/([a-z-]+)\/filesystems(?:\/([^/]+))?$/.exec(path))) {
            if (m[1] !== 'fr-par') return invalid('region', `File Storage is not in ${m[1]}`);
            if (!m[2] && method === 'POST') {
                if (body?.project_id !== FAKE_SCALEWAY_PROJECT) return invalid('project_id', 'unknown project');
                if (!body?.name) return invalid('name', 'is required');
                if (!(Number.isInteger(body.size) && body.size % 1e9 === 0 && body.size >= 25e9 && body.size <= 50e12)) return invalid('size', 'must be 25 GB to 50 TB, in GB steps');
                const x = { id: uuid(), name: body.name, size: body.size, status: 'creating', project_id: body.project_id, organization_id: FAKE_SCALEWAY_PROJECT, tags: body.tags ?? [],
                    number_of_attachments: 0, region: m[1], created_at: now(), updated_at: now(), filesystem_type_id: '00000000-0000-4000-8000-0000000f11e5', left: o.fileReads ?? 1 };
                state.filesystems.set(x.id, x);
                const { left, ...view } = x;
                return json(200, view);
            }
            if (!m[2] && method === 'GET') {
                const all = [...state.filesystems.values()].filter((x) => !u.searchParams.get('project_id') || x.project_id === u.searchParams.get('project_id')).map(({ left, ...x }) => x);
                const p = paged(all, u, 'page_size');
                return json(200, { filesystems: p.items, total_count: all.length }, 'application/json', p.headers);
            }
            const x = m[2] ? state.filesystems.get(m[2]) : undefined;
            if (!x) return notFound('filesystem', String(m[2]));
            if (method === 'GET') {
                const { left, ...view } = x;
                return json(200, view);
            }
            if (method === 'DELETE') {
                if (x.number_of_attachments > 0) return err(412, 'precondition_failed', `filesystem ${x.id} is attached to ${x.number_of_attachments} Instance(s)`);
                state.filesystems.delete(x.id);
                return new Response(null, { status: 204 });
            }
        }

        // ── Serverless Containers API v1 ──
        if ((m = /^\/containers\/v1\/regions\/([a-z-]+)\/(namespaces|containers)(?:\/([^/]+))?$/.exec(path))) {
            if (!['fr-par', 'nl-ams', 'pl-waw', 'it-mil'].includes(m[1])) return invalid('region', `unknown region ${m[1]}`);
            return serverless(method, m[1], m[2], m[3], body, u);
        }

        // ── Instance API v1 ──
        if ((m = /^\/instance\/v1\/zones\/([a-z0-9-]+)\/(.*)$/.exec(path))) {
            const zone = m[1];
            const rest = m[2];
            if (!ZONES.includes(zone)) return invalid('zone', `unknown zone ${zone}`);
            if (method === 'GET' && rest === 'products/servers') {
                const p = paged(Object.entries(typesOf(zone)), u, 'per_page');
                return json(200, { servers: Object.fromEntries(p.items) }, 'application/json', p.headers);
            }
            if (method === 'GET' && rest === 'products/servers/availability') {
                const p = paged(Object.keys(typesOf(zone)).map((t) => [t, { availability: stockOf(zone, t) }]), u, 'per_page');
                return json(200, { servers: Object.fromEntries(p.items) }, 'application/json', p.headers);
            }
            if (method === 'GET' && rest === 'snapshots') {
                const all = [...state.snapshots.values()].filter((x) => x.volume_type !== 'sbs_snapshot' && x.zone === zone);
                const p = paged(all, u, 'per_page');
                return json(200, { snapshots: p.items.map(instanceSnapshotView) }, 'application/json', p.headers);
            }
            if (rest === 'servers') {
                if (method === 'POST') return createServer(zone, body);
                if (method === 'GET') {
                    const all = [...state.servers.values()].filter((s) => s.zone === zone);
                    const p = paged(all, u, 'per_page');
                    return json(200, { servers: p.items.map(view), total_count: all.length }, 'application/json', p.headers);
                }
            }
            if ((m = /^servers\/([^/]+)$/.exec(rest))) {
                const s = find(zone, m[1]);
                if (!s) return UUID.test(m[1]) ? unknownResource('Instance', m[1]) : invalid('server_id', 'is not a UUID');
                if (method === 'GET') return json(200, { server: view(s) });
                if (method === 'PATCH') {
                    if (body?.tags !== undefined && body.tags !== null && !Array.isArray(body.tags)) return invalid('tags', 'must be a list');
                    if (body?.tags) s.tags = [...body.tags];
                    s.modification_date = now();
                    return json(200, { server: view(s) });
                }
                if (method === 'DELETE') {
                    // Only a stopped server is deleted, and every volume it had stays: Block Storage ones detached, local ones as they were.
                    if (s.state !== 'stopped') return err(400, 'precondition_failed', 'precondition is not respected', { precondition: 'unknown_precondition' });
                    state.servers.delete(`${s.zone}/${s.id}`);
                    releaseFileSystems(s);
                    for (const v of Object.values<any>(s.volumes)) {
                        const block = state.volumes.get(v.id);
                        if (block) Object.assign(block, { status: 'available', references: [] });
                        else state.localVolumes.set(v.id, { ...v, server: null });
                    }
                    return new Response(null, { status: 204 });
                }
            }
            if (method === 'POST' && (m = /^servers\/([^/]+)\/(attach|detach)-volume$/.exec(rest))) {
                const s = find(zone, m[1]);
                if (!s) return unknownResource('Instance', m[1]);
                const v = state.volumes.get(body?.volume_id);
                if (m[2] === 'attach') {
                    if (body?.volume_type !== 'sbs_volume') return invalid('volume_type', 'a Block Storage volume is attached as sbs_volume');
                    if (!v || v.zone !== zone) return notFound('volume', body?.volume_id);
                    if (v.status !== 'available') return err(400, 'precondition_failed', `volume ${v.id} is ${v.status}`, { precondition: 'resource_still_in_use' });
                    // The next free key: after the server's own volumes.
                    let key = 1;
                    while (s.volumes[key] !== undefined) key++;
                    attach(v, s.id);
                    s.volumes[key] = { id: v.id, name: v.name, volume_type: 'sbs_volume', size: v.size, boot: false, state: 'available', zone, server: { id: s.id, name: s.name } };
                    return json(200, { server: view(s) });
                }
                const key = Object.keys(s.volumes).find((k) => s.volumes[k].id === body?.volume_id);
                if (!key) return invalid('volume_id', 'the volume is not attached to this Instance');
                if (s.volumes[key].boot) return invalid('volume_id', 'the boot volume cannot be detached');
                delete s.volumes[key];
                if (v) Object.assign(v, { status: 'available', references: [] });
                return json(200, { server: view(s) });
            }
            if (method === 'DELETE' && (m = /^volumes\/([^/]+)$/.exec(rest))) {
                if (!state.localVolumes.get(m[1])?.zone || state.localVolumes.get(m[1]).zone !== zone) return unknownResource('Volume', m[1]);
                state.localVolumes.delete(m[1]);
                return new Response(null, { status: 204 });
            }
            if (method === 'POST' && (m = /^servers\/([^/]+)\/action$/.exec(rest))) {
                const s = find(zone, m[1]);
                return s ? action(s, body) : unknownResource('Instance', m[1]);
            }
            if (method === 'POST' && (m = /^servers\/([^/]+)\/(attach|detach)-filesystem$/.exec(rest))) {
                const s = find(zone, m[1]);
                if (!s) return unknownResource('Instance', m[1]);
                const fsys = state.filesystems.get(body?.filesystem_id);
                if (!fsys) return notFound('filesystem', String(body?.filesystem_id));
                s.filesystems ??= [];
                const held = s.filesystems.find((x: any) => x.filesystem_id === fsys.id);
                if (m[2] === 'attach') {
                    if (fsys.region !== zone.replace(/-\d+$/, '')) return invalid('filesystem_id', `filesystem ${fsys.id} is in ${fsys.region}, not in the region of ${zone}`);
                    if (fsys.status !== 'available') return err(412, 'precondition_failed', `filesystem ${fsys.id} is ${fsys.status}`);
                    if (held) return err(409, 'conflict', `filesystem ${fsys.id} is attached already`);
                    if (s.filesystems.length >= (SERVER_TYPES[s.commercial_type]?.capabilities?.max_file_systems ?? 0)) {
                        return invalid('filesystem_id', `${s.commercial_type} attaches at most ${SERVER_TYPES[s.commercial_type]?.capabilities?.max_file_systems ?? 0} filesystems`);
                    }
                    s.filesystems.push({ filesystem_id: fsys.id, state: 'attaching' });
                    fsys.number_of_attachments++;
                } else {
                    if (!held) return invalid('filesystem_id', `filesystem ${fsys.id} is not attached`);
                    held.state = 'detaching';
                }
                return json(200, { server: view(s) });
            }
            if (method === 'PATCH' && (m = /^servers\/([^/]+)\/user_data\/([^/]+)$/.exec(rest))) {
                const s = find(zone, m[1]);
                if (!s) return unknownResource('Instance', m[1]);
                if (typeof body !== 'string') return invalid('body', 'user data is the raw content');
                s.userData[m[2]] = body;
                return new Response(null, { status: 204 });
            }
            if (method === 'POST' && rest === 'images') {
                const snap = state.snapshots.get(body?.root_volume);
                if (!snap || snap.zone !== zone) return unknownResource('Snapshot', String(body?.root_volume));
                if (snap.status !== 'available') return err(400, 'precondition_failed', `snapshot ${snap.id} is ${snap.status}`, { precondition: 'resource_not_usable' });
                if (!['x86_64', 'arm64'].includes(body?.arch)) return invalid('arch', 'must be x86_64 or arm64');
                const id = uuid();
                const image = { id, name: body.name, arch: body.arch, from_server: null, organization: body.project, project: body.project, public: body.public ?? false,
                    root_volume: { id: snap.id, name: snap.name, size: snap.size, volume_type: 'sbs_snapshot' }, extra_volumes: {}, state: 'creating', tags: body.tags ?? [],
                    zone, creation_date: now(), modification_date: now(), left: state.imageReads, files: { ...(snap.files ?? {}) } };
                state.images.set(id, image);
                return json(201, { image: imageView(image) });
            }
            if (method === 'GET' && rest === 'images') {
                const own = [...state.images.values()].filter((i) => i.zone === zone && (u.searchParams.get('public') !== 'false' || !i.public));
                const p = paged(own, u, 'per_page');
                return json(200, { images: p.items.map(imageView) }, 'application/json', p.headers);
            }
            if ((m = /^images\/([^/]+)$/.exec(rest))) {
                const i = UUID.test(m[1]) ? state.images.get(m[1]) : undefined;
                if (!i || i.zone !== zone) return unknownResource('Image', m[1]);
                if (method === 'GET') return json(200, { image: imageView(i) });
                if (method === 'DELETE') {
                    // Only the image goes: its snapshots stay.
                    state.images.delete(i.id);
                    return new Response(null, { status: 204 });
                }
            }
            if ((m = /^snapshots\/([^/]+)(\/export)?$/.exec(rest)) && method !== 'DELETE') {
                const snap = state.snapshots.get(m[1]);
                if (!snap || snap.volume_type === 'sbs_snapshot' || snap.zone !== zone) return unknownResource('Snapshot', m[1]);
                if (method === 'POST' && m[2]) {
                    const region = zone.replace(/-\d+$/, '');
                    if (!state.s3[region]?.buckets.has(body?.bucket)) return invalid('bucket', `bucket ${body?.bucket} not found in ${region}`);
                    snap.state = 'exporting';
                    snap.exportTo = { region, bucket: body.bucket, key: body.key, left: 2 };
                    return json(200, { task: { id: uuid(), description: 'export_snapshot', status: 'pending' } });
                }
                if (method === 'GET' && !m[2]) return json(200, { snapshot: instanceSnapshotView(snap) });
            }
            if (method === 'DELETE' && (m = /^snapshots\/([^/]+)$/.exec(rest))) {
                const s = state.snapshots.get(m[1]);
                if (!s || s.volume_type === 'sbs_snapshot') return unknownResource('Snapshot', m[1]);
                if ([...state.images.values()].some((i) => i.root_volume?.id === s.id)) return err(400, 'precondition_failed', 'the snapshot is used by an image', { precondition: 'resource_still_in_use' });
                state.snapshots.delete(s.id);
                return new Response(null, { status: 204 });
            }
        }

        // ── Block Storage API v1 ──
        if ((m = /^\/block\/v1\/zones\/([a-z0-9-]+)\/volumes$/.exec(path))) {
            const zone = m[1];
            if (!ZONES.includes(zone)) return invalid('zone', `unknown zone ${zone}`);
            if (method === 'GET') {
                const project = u.searchParams.get('project_id');
                const all = [...state.volumes.values()].filter((v) => v.zone === zone && (!project || v.project_id === project));
                const p = paged(all, u, 'page_size');
                return json(200, { volumes: p.items.map(volumeView), total_count: all.length }, 'application/json', p.headers);
            }
            if (method === 'POST') {
                if (!body?.name) return invalid('name', 'is required');
                if (!UUID.test(String(body.project_id))) return invalid('project_id', 'is required (a UUID)');
                if (body.perf_iops !== undefined && body.perf_iops !== null && ![5000, 15000].includes(body.perf_iops)) return invalid('perf_iops', 'must be 5000 or 15000');
                const size = body.from_empty?.size;
                if (!(Number.isInteger(size) && size >= 1e9 && size % 1e9 === 0)) return invalid('from_empty.size', 'a size in bytes, by 1 GB (10^9), from 1 GB');
                const id = uuid();
                const v = { id, name: body.name, type: body.perf_iops === 15000 ? 'sbs_15k' : 'sbs_5k', size, project_id: body.project_id, created_at: now(), updated_at: now(),
                    references: [], parent_snapshot_id: null, status: 'creating', tags: body.tags ?? [], zone, left: 1 };
                state.volumes.set(id, v);
                return json(200, volumeView(v));
            }
        }
        if (method === 'POST' && (m = /^\/block\/v1\/zones\/([a-z0-9-]+)\/snapshots\/([^/]+)\/export-to-object-storage$/.exec(path))) {
            const snap = state.snapshots.get(m[2]);
            if (!snap || snap.zone !== m[1] || snap.volume_type !== 'sbs_snapshot') return notFound('snapshot', m[2]);
            const region = m[1].replace(/-\d+$/, '');
            if (!state.s3[region]?.buckets.has(body?.bucket)) return err(404, 'not_found', `bucket ${body?.bucket} not found in ${region}`);
            snap.status = 'exporting';
            snap.exportTo = { region, bucket: body.bucket, key: body.key, left: 2 };
            return json(200, snapshotView(snap));
        }
        if (method === 'POST' && (m = /^\/block\/v1\/zones\/([a-z0-9-]+)\/snapshots\/import-from-object-storage$/.exec(path))) {
            const zone = m[1];
            const region = zone.replace(/-\d+$/, '');
            const object = state.s3[region]?.buckets.get(body?.bucket)?.get(body?.key);
            if (!body?.name) return invalid('name', 'is required');
            if (!object) return err(404, 'not_found', `object ${body?.key} of bucket ${body?.bucket} not found in ${region}`);
            const id = uuid();
            const snap = { id, name: body.name, size: body.size ?? 10e9, project_id: body.project_id ?? FAKE_SCALEWAY_PROJECT, created_at: now(), updated_at: now(),
                status: 'creating', tags: body.tags ?? [], zone, volume_type: 'sbs_snapshot', left: o.importReads ?? 2,
                corrupt: Buffer.from(object.slice(0, 4)).toString('latin1') !== 'QFI\xfb', files: readDiskFiles(object) };
            state.snapshots.set(id, snap);
            return json(200, snapshotView(snap));
        }
        if (method === 'GET' && (m = /^\/block\/v1\/zones\/([a-z0-9-]+)\/snapshots$/.exec(path))) {
            const zone = m[1];
            if (!ZONES.includes(zone)) return invalid('zone', `unknown zone ${zone}`);
            const project = u.searchParams.get('project_id');
            const all = [...state.snapshots.values()].filter((x) => x.volume_type === 'sbs_snapshot' && x.zone === zone && (!project || (x.project_id ?? FAKE_SCALEWAY_PROJECT) === project));
            const p = paged(all, u, 'page_size');
            return json(200, { snapshots: p.items.map(snapshotView), total_count: all.length }, 'application/json', p.headers);
        }
        if ((m = /^\/block\/v1\/zones\/([a-z0-9-]+)\/(volumes|snapshots)\/([^/]+)$/.exec(path))) {
            const [, zone, kind, id] = m;
            const store = kind === 'volumes' ? state.volumes : state.snapshots;
            const item = store.get(id);
            if (!item || item.zone !== zone || (kind === 'snapshots' && item.volume_type !== 'sbs_snapshot')) return notFound(kind === 'volumes' ? 'volume' : 'snapshot', id);
            if (method === 'GET' && kind === 'volumes') return json(200, volumeView(item));
            if (method === 'GET') return json(200, snapshotView(item));
            if (method === 'DELETE') {
                if (kind === 'volumes' && item.status === 'in_use') return err(400, 'precondition_failed', 'the volume is attached to a server', { precondition: 'resource_still_in_use' });
                if (kind === 'snapshots' && [...state.images.values()].some((i) => i.root_volume?.id === id)) {
                    return err(400, 'precondition_failed', 'the snapshot is used by an image', { precondition: 'resource_still_in_use' });
                }
                store.delete(id);
                return new Response(null, { status: 204 });
            }
        }

        // ── IAM API ──
        if (path === '/iam/v1alpha1/ssh-keys') {
            if (method === 'GET') {
                const project = u.searchParams.get('project_id');
                const all = [...state.keys.values()].filter((k) => (!project || k.project_id === project) && (u.searchParams.get('disabled') === 'true' || !k.disabled));
                const p = paged(all, u, 'page_size');
                return json(200, { ssh_keys: p.items, total_count: all.length });
            }
            if (method === 'POST') {
                if (!body?.name || !body.public_key || !body.project_id) return invalid('project_id', 'name, public_key and project_id are required');
                let fingerprint: string;
                try {
                    fingerprint = sshKeyFingerprint(String(body.public_key), 'md5');
                } catch {
                    return invalid('public_key', 'is not a valid SSH public key');
                }
                // The same key twice in a Project is accepted, as two registrations (checked live).
                return json(200, addKey(body.name, body.public_key, body.project_id));
            }
        }
        if (method === 'DELETE' && (m = /^\/iam\/v1alpha1\/ssh-keys\/([^/]+)$/.exec(path))) {
            if (!state.keys.delete(m[1])) return notFound('ssh_key', m[1]);
            return new Response(null, { status: 204 });
        }

        // ── Marketplace API v2 ──
        if (method === 'GET' && path === '/marketplace/v2/images') {
            const p = paged(MARKETPLACE_IMAGES, u, 'page_size');
            return json(200, { images: p.items, total_count: MARKETPLACE_IMAGES.length });
        }
        return err(404, 'unknown_resource', `fake has no route ${method} ${path}`);
    }

    // A login attempt is a request like any other: time passes (a server that reboots is not reachable until it runs again).
    const machine = (host: string): FakeMachine | undefined => {
        advance();
        const s = [...state.servers.values()].find((x) => x.state === 'running' && x.public_ips.some((ip: any) => ip.address === host));
        // Its sshd takes the Project's keys as its last boot applied them.
        return s && { bootId: fakeBootId(s.id, s.boots), files: { ...s.files }, keys: [...s.bootKeys] };
    };

    const api: FakeApi & {
        state: typeof state, prodServerId: string, backupImageId: string, liveVolumes(): number, liveSnapshots(): number,
        intercept(match: (r: FakeScalewayRequest) => boolean, hook: FakeScalewayHook): void,
    } = {
        fetchImpl: fetchImpl as typeof fetch,
        calls,
        state,
        /** Changes the account, or an answer, at a known moment: `fake.intercept((r) => r.body?.action === 'poweroff', { after: () => lock(server) })`. */
        intercept: (match, hook) => void hooks.push({ ...hook, match, left: hook.times ?? Infinity }),
        prodServerId: prodServer,
        backupImageId: backupId,
        liveServers: () => state.servers.size,
        machine,
        authorized: (host, publicKey) => !!machine(host)?.keys.some((k) => sshKeyFingerprint(k) === sshKeyFingerprint(publicKey)),
        /** Block Storage volumes that still exist: each bills until deleted. */
        liveVolumes: () => state.volumes.size + state.localVolumes.size,
        liveSnapshots: () => state.snapshots.size,
    };
    return api;
}
