// The Scaleway API client: one transport (the retry rules of Core/utils/http,
// the secret key in `X-Auth-Token`), one pager, one reading of Scaleway's
// errors onto src/errors.ts (toError), and the calls that take more than one
// request: SSH keys (the IAM API), and starting, reading and deleting a server
// (Instance API v1). Every endpoint it calls is in SCALEWAY_ENDPOINTS with its
// reference page.
//
// What shapes it:
//   - Every Instance call is zonal, so a server is named `fr-par-2/<uuid>`
//     (zonedId): the id alone does not say where to ask.
//   - A server created through the API is `stopped`: start it with the
//     `poweron` action, after its user data is set.
//   - `terminate` deletes a server and its local volumes but only DETACHES
//     Block Storage volumes (`sbs_volume`, what every GPU type boots from), and
//     a detached volume still bills: deleteServer deletes them too, all but the
//     volumes the server was created with from CreateServerOptions.mounts (its
//     MOUNT_TAG tags name them), which are the caller's.
//   - SSH keys belong to a Project (IAM), and Scaleway applies every key of a
//     Project at boot to every server created in it.

import { ApiClient, HttpResult, pollUntil, RequestInfo, S3Client } from '../../Core/utils';
import { AuthError, CapacityError, falseIfNotFound, isRetriable, NotFoundError, nullIfNotFound, ProviderError, QuotaError } from '../../errors';
import type { InitializedSSHKeyData, WaitOptions } from '../../types';
import { fillPath, queryString, SCALEWAY_ENDPOINTS, ScalewayEndpoint } from './endpoints';
import { imageVolumes, isUuid, mountedVolumeIds, parseZonedId, parseZones, SCALEWAY_ID, scalewayErrorText, toSSHKey, zonedId } from './mappers';
import { SCALEWAY_EUR_USD } from './types';
import type {
    ScalewayAttachServerVolumeBody, ScalewayBlockSnapshot, ScalewayBlockVolume, ScalewayContainer, ScalewayContainerNamespace, ScalewayCreateBlockVolumeBody,
    ScalewayCreateContainerBody, ScalewayCreateContainerNamespaceBody, ScalewayCreateFileSystemBody, ScalewayCreateImageBody, ScalewayCreateServerBody,
    ScalewayCreateSSHKeyBody, ScalewayDetachServerVolumeBody, ScalewayErrorBody, ScalewayExportBlockSnapshotBody, ScalewayFileSystem, ScalewayImage,
    ScalewayImportBlockSnapshotBody, ScalewayInstanceSnapshot, ScalewayMarketplaceImage, ScalewayParams, ScalewayRegion, ScalewayServer,
    ScalewayServerActionBody, ScalewayServerType, ScalewayServerTypesAvailability, ScalewaySSHKey, ScalewayTask, ScalewayUpdateServerBody,
    ScalewayVolumeSummary, ScalewayZone,
} from './types';

/** Scaleway's pages hold at most 100 items. */
const PAGE = 100;
/** How long an Instance type table is reused: types and prices change rarely, stock (availability) is always read fresh. */
const TYPES_TTL_MS = 10 * 60_000;
/** The wording of a refusal for want of capacity, where the answer is not typed `out_of_stock`. */
const NO_STOCK = /out of stock|insufficient capacity|not enough capacity|no capacity|capacity is not available|temporarily unavailable|shortage/i;
/** A snapshot Scaleway refuses to delete (`precondition_failed`) is tried this many times, `SNAPSHOT_RETRY_MS` apart (25 s of waiting), before it is taken for one another image uses. */
const SNAPSHOT_TRIES = 6;
const SNAPSHOT_RETRY_MS = 5000;

export type ScalewayCallOptions = {
    /** Values for the endpoint path's `{placeholders}`. */
    path?: Record<string, string>,
    query?: Record<string, string | number | boolean | string[] | undefined>,
    json?: unknown,
    /** A raw body (user data), with its `content-type` in `headers`. */
    body?: string,
    headers?: Record<string, string>,
    /** Overrides the method's default retry rule (a repeat is harmless). */
    idempotent?: boolean,
};

export class ScalewayApi extends ApiClient {
    static readonly BASE_URL = 'https://api.scaleway.com';
    /** Every request is one of these: request() refuses any other, so a path built by hand cannot bypass the table. */
    protected readonly endpoints = SCALEWAY_ENDPOINTS;
    /** The zones it reads and creates in. */
    readonly zones: ScalewayZone[];
    /** The Project servers and SSH keys are created in, when one was given. */
    readonly projectId?: string;
    /** USD per EUR: Scaleway's prices are euros. */
    readonly eurToUsd: number;
    /** The API key's access key, for Object Storage, when one was given. */
    readonly accessKey?: string;
    private readonly typeTables = new Map<ScalewayZone, { at: number, types: Promise<Record<string, ScalewayServerType>> }>();

    constructor(params: ScalewayParams | string) {
        super(params, ScalewayApi.BASE_URL, SCALEWAY_ID);
        const p = typeof params === 'string' ? undefined : params;
        this.zones = parseZones(p?.zones);
        this.projectId = p?.projectId?.trim() || undefined;
        if (this.projectId && !isUuid(this.projectId)) {
            throw new Error(`projectId "${this.projectId}" is not a Scaleway Project id (a UUID: the console shows it under Project settings)`);
        }
        this.eurToUsd = p?.eurToUsd ?? SCALEWAY_EUR_USD;
        this.accessKey = p?.accessKey?.trim() || undefined;
        if (!(this.eurToUsd > 0)) throw new Error('eurToUsd must be a positive number (USD per EUR)');
    }

    authHeaders(): Record<string, string> {
        return { 'x-auth-token': this.apiKey };
    }

    /** The Project a create needs: the one given, else an error saying how to give it. */
    requireProject(what: string): string {
        if (!this.projectId) {
            throw new ProviderError(this.id, `a Scaleway Project is needed to ${what}: pass projectId (SCW_DEFAULT_PROJECT_ID; the console shows it under Project settings)`, { code: 'project_required' });
        }
        return this.projectId;
    }

    /** `fn` for each of the zones, a few at a time (every Instance call is zonal); the results in zone order. */
    async forZones<T>(fn: (zone: ScalewayZone) => Promise<T>, concurrency = 4): Promise<T[]> {
        const out: T[] = new Array(this.zones.length);
        let next = 0;
        const worker = async () => {
            while (next < this.zones.length) {
                const i = next++;
                out[i] = await fn(this.zones[i]);
            }
        };
        await Promise.all(Array.from({ length: Math.min(concurrency, this.zones.length) }, worker));
        return out;
    }

    // ── transport ────────────────────────────────────────────────────────

    /** A call to `e` whose non-2xx answer throws its typed error; the answer's body. */
    async call<T = any>(e: ScalewayEndpoint, o: ScalewayCallOptions = {}): Promise<T> {
        return (await this.callResult(e, o)).body as T;
    }

    /** As `call`, with the whole answer (headers too). */
    async callResult(e: ScalewayEndpoint, o: ScalewayCallOptions): Promise<HttpResult> {
        const query = o.query ?? {};
        for (const name of Object.keys(query)) {
            if (!e.query?.includes(name)) throw new Error(`Scaleway ${e.operationId} is not sent a "${name}" query parameter: it is not in SCALEWAY_ENDPOINTS`);
        }
        const path = fillPath(e.path, o.path) + queryString(query);
        const r = await this.request(e.method, path, { json: o.json, body: o.body, headers: o.headers, idempotent: o.idempotent });
        if (this.succeeded(r)) return r;
        throw this.failure(r, { method: e.method, path, idempotent: o.idempotent });
    }

    /**
     * Every item of a list: pages of 100 until a short page, or until the
     * `X-Total-Count` header's count is reached. `size` is the page-size query
     * parameter's name: `per_page` (Instance API), `page_size` (IAM, Block, Marketplace).
     */
    async pages<T>(e: ScalewayEndpoint, o: Pick<ScalewayCallOptions, 'path' | 'query'> & { size: 'per_page' | 'page_size' }, pick: (body: any) => T[]): Promise<T[]> {
        const out: T[] = [];
        for (let page = 1; page <= 100; page++) {
            const r = await this.callResult(e, { path: o.path, query: { ...o.query, [o.size]: PAGE, page } });
            const items = pick(r.body);
            out.push(...items);
            const total = Number(r.headers.get('x-total-count'));
            if (items.length < PAGE || (total > 0 && out.length >= total)) return out;
        }
        throw new ProviderError(this.id, `${e.path} has more than 100 pages`);
    }

    /** The answer of `e`, or null when Scaleway has no such resource (a 404); any other failure is thrown. */
    private orNull<T>(e: ScalewayEndpoint, o: ScalewayCallOptions): Promise<T | null> {
        return nullIfNotFound(this.call<T>(e, o));
    }

    /** true when `e` deleted the resource, false when it was not there (a 404); any other failure is thrown. */
    private deleted(e: ScalewayEndpoint, o: ScalewayCallOptions): Promise<boolean> {
        return falseIfNotFound(this.call(e, o));
    }

    /** Scaleway's error answer as a typed error (src/errors.ts): its `type` says what it is before its status does. */
    protected toError(r: HttpResult, req: RequestInfo): ProviderError {
        const body: ScalewayErrorBody = r.body && typeof r.body === 'object' ? r.body : {};
        const type = body.type;
        const message = `${req.method} ${req.path} -> ${r.status} ${type ? `${type}: ` : ''}${scalewayErrorText(body, r.body)}`;
        const o = { status: r.status, code: type };
        // The type says what it is before the status does: a quota is a 403 (checked live), as a refusal for want of rights is.
        // The Instance API also words a quota in an `invalid_request_error` (a 400).
        if (type === 'quotas_exceeded' || (type === 'invalid_request_error' && /quota exceeded for this resource/i.test(body.message ?? ''))) {
            return new QuotaError(this.id, message, o);
        }
        if (r.status === 401 || r.status === 403 || type === 'denied_authentication' || type === 'permissions_denied') return new AuthError(this.id, message, o);
        if (r.status === 404 || type === 'not_found' || type === 'unknown_resource') return new NotFoundError(this.id, message, o);
        if (type === 'out_of_stock' || NO_STOCK.test(body.message ?? '')) return new CapacityError(this.id, message, o);
        return new ProviderError(this.id, message, { ...o, retriable: r.status === 429 || r.status >= 500 || type === 'transient_state' });
    }

    // ── Instance types and stock ─────────────────────────────────────────

    /**
     * Every Instance type of a zone by commercial type ('L4-1-24G'). Reused for
     * ten minutes (they change rarely); a failed read is not kept.
     */
    serverTypes(zone: ScalewayZone): Promise<Record<string, ScalewayServerType>> {
        const hit = this.typeTables.get(zone);
        if (hit && Date.now() - hit.at < TYPES_TTL_MS) return hit.types;
        const types = this.pages<[string, ScalewayServerType]>(SCALEWAY_ENDPOINTS.listServerTypes, { path: { zone }, size: 'per_page' },
            (b) => entriesOf(b, 'servers')).then((entries) => Object.fromEntries(entries));
        this.typeTables.set(zone, { at: Date.now(), types });
        types.catch(() => this.typeTables.delete(zone));
        return types;
    }

    /** Stock per commercial type right now: `available`, `scarce` or `shortage`. */
    async availability(zone: ScalewayZone): Promise<Record<string, ScalewayServerTypesAvailability>> {
        const entries = await this.pages<[string, { availability: ScalewayServerTypesAvailability }]>(SCALEWAY_ENDPOINTS.getServerTypesAvailability,
            { path: { zone }, size: 'per_page' }, (b) => entriesOf(b, 'servers'));
        return Object.fromEntries(entries.map(([type, a]) => [type, a.availability]));
    }

    // ── servers ──────────────────────────────────────────────────────────

    /** Every server of the zone (of every Project the key can read). */
    listServers(zone: ScalewayZone): Promise<ScalewayServer[]> {
        return this.pages(SCALEWAY_ENDPOINTS.listServers, { path: { zone }, size: 'per_page' }, (b) => listOf(b, 'servers'));
    }

    /** null when the zone has no such server. */
    async getServer(zone: ScalewayZone, id: string): Promise<ScalewayServer | null> {
        return (await this.orNull<{ server: ScalewayServer }>(SCALEWAY_ENDPOINTS.getServer, { path: { zone, server_id: id } }))?.server ?? null;
    }

    /**
     * The server a reference names: `fr-par-2/<uuid>` is one read; a bare
     * `<uuid>` is asked of every zone. null when there is none (or the
     * reference cannot name one).
     */
    async findServer(ref: string | number): Promise<ScalewayServer | null> {
        const r = parseZonedId(ref);
        if (!r) return null;
        if (r.zone) return this.getServer(r.zone, r.id);
        return (await this.forZones((z) => this.getServer(z, r.id))).find((s) => s !== null) ?? null;
    }

    /** Creates the server, powered off. Never retried after a server error: it may exist, and a second one would bill. */
    async createServer(zone: ScalewayZone, body: ScalewayCreateServerBody): Promise<ScalewayServer> {
        return (await this.call<{ server: ScalewayServer }>(SCALEWAY_ENDPOINTS.createServer, { path: { zone }, json: body })).server;
    }

    /** `idempotent`: a repeat of this action does no harm, so a transient failure may be retried. */
    async serverAction(zone: ScalewayZone, id: string, body: ScalewayServerActionBody, idempotent = false): Promise<ScalewayTask | undefined> {
        return (await this.call<{ task?: ScalewayTask }>(SCALEWAY_ENDPOINTS.serverAction, { path: { zone, server_id: id }, json: body, idempotent }))?.task;
    }

    /** Sets the server's tags (all of them: the list replaces the old one). */
    async setServerTags(zone: ScalewayZone, id: string, tags: string[]): Promise<ScalewayServer> {
        return (await this.call<{ server: ScalewayServer }>(SCALEWAY_ENDPOINTS.updateServer, {
            path: { zone, server_id: id }, json: { tags } satisfies ScalewayUpdateServerBody, idempotent: true,
        })).server;
    }

    /** Attaches a Block Storage volume to a server as its next disk. */
    async attachServerVolume(zone: ScalewayZone, id: string, volumeId: string): Promise<ScalewayServer> {
        return (await this.call<{ server: ScalewayServer }>(SCALEWAY_ENDPOINTS.attachServerVolume, {
            path: { zone, server_id: id }, json: { volume_id: volumeId, volume_type: 'sbs_volume' } satisfies ScalewayAttachServerVolumeBody,
        })).server;
    }

    async detachServerVolume(zone: ScalewayZone, id: string, volumeId: string): Promise<ScalewayServer> {
        return (await this.call<{ server: ScalewayServer }>(SCALEWAY_ENDPOINTS.detachServerVolume, {
            path: { zone, server_id: id }, json: { volume_id: volumeId } satisfies ScalewayDetachServerVolumeBody,
        })).server;
    }

    /** cloud-init user data, plain text: read at the server's first boot, so set it before `poweron`. */
    async setServerUserData(zone: ScalewayZone, id: string, content: string, key = 'cloud-init'): Promise<void> {
        await this.call(SCALEWAY_ENDPOINTS.setServerUserData, {
            path: { zone, server_id: id, key }, body: content, headers: { 'content-type': 'text/plain' }, idempotent: true,
        });
    }

    /**
     * Creates a server and starts it: create, user data, `poweron`. A server
     * that cannot be started is of no use and bills for its volume, so when
     * anything after the create fails it is deleted again (volumes too) before the
     * error goes on: a CapacityError (no stock at power-on) leaves nothing behind.
     */
    async launchServer(zone: ScalewayZone, body: ScalewayCreateServerBody, o: { userData?: string, filesystems?: string[], wait?: WaitOptions } = {}): Promise<ScalewayServer> {
        const created = await this.createServer(zone, body);
        try {
            if (o.userData) await this.setServerUserData(zone, created.id, o.userData);
            // Its filesystems, attached before it boots (so its first boot mounts them).
            for (const fs of o.filesystems ?? []) {
                await this.attachServerFileSystem(zone, created.id, fs);
                await this.fileSystemState(zone, created.id, fs, 'available', o.wait ?? {});
            }
            await this.serverAction(zone, created.id, { action: 'poweron' }, true);
        } catch (e) {
            // Deleted again, the start's failure is the error (a CapacityError: the next zone or offer). Not deleted, the
            // server is left billing its volume, and the error says so: nothing else would find it.
            try {
                await this.deleteServer(zone, created.id);
            } catch (cleanup) {
                throw new ProviderError(this.id, `${(e as Error).message}; and server ${zonedId(zone, created.id)}, made but not started, is not deleted (${(cleanup as Error).message}): it bills until deleted`,
                    { code: 'left_behind', cause: e });
            }
            throw e;
        }
        return (await this.getServer(zone, created.id).catch(() => null)) ?? { ...created, state: 'starting' };
    }

    /** Waits until the server holds the filesystem in `state` ('gone': holds it no more). */
    async fileSystemState(zone: ScalewayZone, serverId: string, filesystemId: string, state: 'available' | 'gone', o: WaitOptions): Promise<void> {
        const read = async () => (await this.getServer(zone, serverId))?.filesystems?.find((f) => f.filesystem_id === filesystemId)?.state ?? 'gone';
        const last = await pollUntil(read, (s) => s === state || (state === 'available' && s === 'gone'), {
            timeoutMs: o.timeoutMs ?? 5 * 60_000, intervalMs: o.intervalMs ?? 2000, sleep: this.sleep, retryOn: isRetriable,
            timeoutError: (l) => new ProviderError(this.id, `filesystem ${filesystemId} on server ${serverId}: still ${l.seen ? l.value : 'unread'}, not ${state}`, { code: 'timeout' }),
        });
        if (last !== state) throw new ProviderError(this.id, `filesystem ${filesystemId} is no longer attached to server ${serverId}`);
    }

    /**
     * Removes the server, deletes the volumes that outlive it, and waits until it
     * is gone. true when it deleted the server, false when it was gone already;
     * idempotent. A server that runs is terminated (its local volumes go with it,
     * its Block Storage ones are only detached); a stopped one has no `terminate`
     * (precondition_failed, checked live) and is deleted as it is, keeping every
     * volume: so the Block Storage volumes (`sbs_volume`) and, of a stopped
     * server, the local ones (`l_ssd`, `b_ssd`) are deleted here too, as they bill
     * until they are. The volumes it was created with from `mounts` (its
     * MOUNT_TAG tags) are the caller's: they are detached, and kept, by both
     * paths (checked live 2026-10-06: after a running server's `terminate` and
     * after a stopped server's plain DELETE, a mounted volume was `available`
     * with no references, and the root volume was deleted). Each volume is
     * deleted as soon as it is detached, not when the server's record
     * disappears, so a server that is slow to vanish costs nothing more. A
     * volume that is not detached in time is named in the error: it bills until
     * it is deleted, by another deleteServer while the server exists, or by
     * deleteBlockVolume once it is gone (a server that has vanished has no
     * volumes left to find).
     */
    async deleteServer(zone: ScalewayZone, id: string, o: WaitOptions = {}): Promise<boolean> {
        const server = await this.getServer(zone, id);
        if (!server) return false;
        const timeoutMs = o.timeoutMs ?? 5 * 60_000;
        const intervalMs = o.intervalMs ?? 3000;
        const end = Date.now() + timeoutMs;
        const secs = Math.round(timeoutMs / 1000);
        const volumes = Object.values(server.volumes);
        const mounted = new Set(mountedVolumeIds(server));
        const blocks = volumes.filter((v) => v.volume_type === 'sbs_volume' && !mounted.has(v.id)).map((v) => v.id);
        const local = (await this.remove(zone, server, end, intervalMs)) ? volumes.filter((x) => x.volume_type === 'l_ssd' || x.volume_type === 'b_ssd') : [];
        // The server is on its way out: a volume not deleted now is found by nothing once it is gone. Each is tried, and every one left is named.
        const left: string[] = [];
        let cause: unknown;
        for (const v of local) {
            try {
                await this.deleted(SCALEWAY_ENDPOINTS.deleteVolume, { path: { zone, volume_id: v.id } });
            } catch (e) {
                left.push(`local volume ${v.id}`);
                cause ??= e;
            }
        }
        for (const v of blocks) {
            try {
                await this.deleteBlockVolume(zone, v, { intervalMs, timeoutMs: Math.max(0, end - Date.now()) });
            } catch (e) {
                if (e instanceof ProviderError && e.code === 'timeout') {
                    throw new ProviderError(this.id, `server ${zonedId(zone, id)} still holds block volume ${v} after ${secs} s: it bills until deleted: call deleteServer again while the server exists, or deleteBlockVolume('${zone}', '${v}') once it is gone`, { code: 'timeout' });
                }
                left.push(`block volume ${v}`);
                cause ??= e;
            }
        }
        if (left.length) {
            // A failure that lasts (no rights for Block Storage: an AuthError) goes as it is; one that may look
            // transient is not, as the server it belonged to is gone: nothing retries it.
            if (!isRetriable(cause)) throw cause;
            throw new ProviderError(this.id, `server ${zonedId(zone, id)} is deleted, but its ${left.join(', ')} ${left.length > 1 ? 'are' : 'is'} not: it bills until deleted (${(cause as Error).message})`,
                { code: 'left_behind', cause });
        }
        let state = 'unread';
        await pollUntil(async () => {
            const s = await this.getServer(zone, id);
            state = s?.state ?? 'gone';
            return s;
        }, (s) => !s, {
            timeoutMs: Math.max(0, end - Date.now()),
            intervalMs,
            sleep: this.sleep,
            retryOn: isRetriable,
            timeoutError: () => new ProviderError(this.id, `server ${zonedId(zone, id)} is still ${state} after ${secs} s (its volumes are deleted)`, { code: 'timeout' }),
        });
        return true;
    }

    /**
     * Removes the server the way its state allows: the `terminate` action while it
     * runs, a plain delete once it is stopped. While it changes state (`starting`,
     * `stopping`) neither is accepted (precondition_failed, checked live), so it
     * waits for the state to settle, until the deadline. A refusal after the state
     * moved on (a start that finished meanwhile) goes by the new state; one with
     * the state unchanged (a protected server) stands; a `transient_state` is asked
     * again. true when it was deleted as a stopped server, whose local volumes are
     * then still there.
     */
    private async remove(zone: ScalewayZone, server: ScalewayServer, end: number, intervalMs: number): Promise<boolean> {
        let seen = server;
        for (;;) {
            if (seen.state !== 'starting' && seen.state !== 'stopping') {
                try {
                    if (seen.state === 'stopped') await this.deleted(SCALEWAY_ENDPOINTS.deleteServer, { path: { zone, server_id: seen.id } });
                    else await this.serverAction(zone, seen.id, { action: 'terminate' }, true);
                    return seen.state === 'stopped';
                } catch (e) {
                    if (e instanceof NotFoundError) return seen.state === 'stopped';
                    const code = e instanceof ProviderError ? e.code : undefined;
                    if (code !== 'precondition_failed' && code !== 'transient_state') throw e;
                    const now = await this.getServer(zone, seen.id);
                    if (!now) return seen.state === 'stopped';
                    if (code === 'precondition_failed' && now.state === seen.state) throw e;
                    if (Date.now() >= end) throw e;
                    seen = now;
                }
            } else if (Date.now() >= end) {
                throw new ProviderError(this.id, `server ${zonedId(zone, seen.id)} is still ${seen.state}: it cannot be deleted while it changes state`, { code: 'timeout' });
            } else {
                const now = await this.getServer(zone, seen.id);
                if (!now) return false;
                seen = now;
            }
            await this.sleep(intervalMs);
        }
    }

    // ── Object Storage, Block snapshots and images: images in and out ────

    /**
     * Object Storage of a region (S3, https://s3.<region>.scw.cloud), signed with
     * the access key and the secret key; its buckets are the Project's (the
     * access key names it: `<access key>@<project>`). `why` says what needs it.
     */
    objectStorage(region: ScalewayRegion, why: string): S3Client {
        if (!this.accessKey) throw new ProviderError(this.id, `${why} goes through Object Storage, which needs the API key's access key: pass accessKey (SCW_ACCESS_KEY)`);
        return new S3Client({
            endpoint: `https://s3.${region}.scw.cloud`, region, fetchImpl: this.fetchImpl, sleep: this.sleep,
            credentials: { accessKey: this.projectId ? `${this.accessKey}@${this.projectId}` : this.accessKey, secretKey: this.apiKey },
        });
    }

    importBlockSnapshot(zone: ScalewayZone, body: ScalewayImportBlockSnapshotBody): Promise<ScalewayBlockSnapshot> {
        return this.call<ScalewayBlockSnapshot>(SCALEWAY_ENDPOINTS.importBlockSnapshot, { path: { zone }, json: body });
    }

    exportBlockSnapshot(zone: ScalewayZone, id: string, body: ScalewayExportBlockSnapshotBody): Promise<ScalewayBlockSnapshot> {
        return this.call<ScalewayBlockSnapshot>(SCALEWAY_ENDPOINTS.exportBlockSnapshot, { path: { zone, snapshot_id: id }, json: body });
    }

    /** The Project's Block snapshots in the zone (every one the key can read without a Project). */
    listBlockSnapshots(zone: ScalewayZone): Promise<ScalewayBlockSnapshot[]> {
        // include_deleted is required by the spec: a deleted snapshot is no snapshot of the account's.
        return this.pages(SCALEWAY_ENDPOINTS.listBlockSnapshots, { path: { zone }, query: { project_id: this.projectId, include_deleted: false }, size: 'page_size' }, (b) => listOf(b, 'snapshots'));
    }

    getBlockSnapshot(zone: ScalewayZone, id: string): Promise<ScalewayBlockSnapshot | null> {
        return this.orNull<ScalewayBlockSnapshot>(SCALEWAY_ENDPOINTS.getBlockSnapshot, { path: { zone, snapshot_id: id } });
    }

    /** true when it deleted it, false when it was gone already. */
    deleteBlockSnapshot(zone: ScalewayZone, id: string): Promise<boolean> {
        return this.deleted(SCALEWAY_ENDPOINTS.deleteBlockSnapshot, { path: { zone, snapshot_id: id } });
    }

    exportInstanceSnapshot(zone: ScalewayZone, id: string, body: ScalewayExportBlockSnapshotBody): Promise<unknown> {
        return this.call(SCALEWAY_ENDPOINTS.exportInstanceSnapshot, { path: { zone, snapshot_id: id }, json: body });
    }

    /** The Project's Instance snapshots (of local volumes) in the zone (every one the key can read without a Project). */
    listInstanceSnapshots(zone: ScalewayZone): Promise<ScalewayInstanceSnapshot[]> {
        return this.pages(SCALEWAY_ENDPOINTS.listInstanceSnapshots, { path: { zone }, query: { project: this.projectId }, size: 'per_page' }, (b) => listOf(b, 'snapshots'));
    }

    async getInstanceSnapshot(zone: ScalewayZone, id: string): Promise<ScalewayInstanceSnapshot | null> {
        return (await this.orNull<{ snapshot: ScalewayInstanceSnapshot }>(SCALEWAY_ENDPOINTS.getInstanceSnapshot, { path: { zone, snapshot_id: id } }))?.snapshot ?? null;
    }

    async createImage(zone: ScalewayZone, body: ScalewayCreateImageBody): Promise<ScalewayImage> {
        return (await this.call<{ image: ScalewayImage }>(SCALEWAY_ENDPOINTS.createImage, { path: { zone }, json: body })).image;
    }

    // ── File Storage (regional) ──────────────────────────────────────────

    /** The Project's filesystems in a region (every one the key can read without a Project). */
    listFileSystems(region: ScalewayRegion): Promise<ScalewayFileSystem[]> {
        return this.pages(SCALEWAY_ENDPOINTS.listFileSystems, { path: { region }, query: { project_id: this.projectId }, size: 'page_size' }, (b) => listOf(b, 'filesystems'));
    }

    createFileSystem(region: ScalewayRegion, body: ScalewayCreateFileSystemBody): Promise<ScalewayFileSystem> {
        return this.call<ScalewayFileSystem>(SCALEWAY_ENDPOINTS.createFileSystem, { path: { region }, json: body });
    }

    getFileSystem(region: ScalewayRegion, id: string): Promise<ScalewayFileSystem | null> {
        return this.orNull<ScalewayFileSystem>(SCALEWAY_ENDPOINTS.getFileSystem, { path: { region, filesystem_id: id } });
    }

    /** true when it deleted it, false when it was gone already; one attached is refused. */
    deleteFileSystem(region: ScalewayRegion, id: string): Promise<boolean> {
        return falseIfNotFound(this.call(SCALEWAY_ENDPOINTS.deleteFileSystem, { path: { region, filesystem_id: id } }));
    }

    async attachServerFileSystem(zone: ScalewayZone, serverId: string, filesystemId: string): Promise<ScalewayServer> {
        return (await this.call<{ server: ScalewayServer }>(SCALEWAY_ENDPOINTS.attachServerFileSystem, { path: { zone, server_id: serverId }, json: { filesystem_id: filesystemId } })).server;
    }

    async detachServerFileSystem(zone: ScalewayZone, serverId: string, filesystemId: string): Promise<ScalewayServer> {
        return (await this.call<{ server: ScalewayServer }>(SCALEWAY_ENDPOINTS.detachServerFileSystem, { path: { zone, server_id: serverId }, json: { filesystem_id: filesystemId } })).server;
    }

    // ── Serverless Containers (regional) ─────────────────────────────────

    createContainerNamespace(region: ScalewayRegion, body: ScalewayCreateContainerNamespaceBody): Promise<ScalewayContainerNamespace> {
        return this.call<ScalewayContainerNamespace>(SCALEWAY_ENDPOINTS.createContainerNamespace, { path: { region }, json: body });
    }

    getContainerNamespace(region: ScalewayRegion, id: string): Promise<ScalewayContainerNamespace | null> {
        return this.orNull<ScalewayContainerNamespace>(SCALEWAY_ENDPOINTS.getContainerNamespace, { path: { region, namespace_id: id } });
    }

    /** Deletes it and its containers: true when it did, false when it was gone already. */
    deleteContainerNamespace(region: ScalewayRegion, id: string): Promise<boolean> {
        return falseIfNotFound(this.call(SCALEWAY_ENDPOINTS.deleteContainerNamespace, { path: { region, namespace_id: id } }));
    }

    /** The Project's containers in a region (every one the key can read without a Project). */
    listContainers(region: ScalewayRegion): Promise<ScalewayContainer[]> {
        return this.pages(SCALEWAY_ENDPOINTS.listContainers, { path: { region }, query: { project_id: this.projectId }, size: 'page_size' }, (b) => listOf(b, 'containers'));
    }

    createContainer(region: ScalewayRegion, body: ScalewayCreateContainerBody): Promise<ScalewayContainer> {
        return this.call<ScalewayContainer>(SCALEWAY_ENDPOINTS.createContainer, { path: { region }, json: body });
    }

    getContainer(region: ScalewayRegion, id: string): Promise<ScalewayContainer | null> {
        return this.orNull<ScalewayContainer>(SCALEWAY_ENDPOINTS.getContainer, { path: { region, container_id: id } });
    }

    /** true when it deleted it, false when it was gone already. */
    deleteContainer(region: ScalewayRegion, id: string): Promise<boolean> {
        return falseIfNotFound(this.call(SCALEWAY_ENDPOINTS.deleteContainer, { path: { region, container_id: id } }));
    }

    // ── Block Storage ────────────────────────────────────────────────────

    /** The zone's volumes: the Project's when there is one, else every one the key can read. */
    listBlockVolumes(zone: ScalewayZone): Promise<ScalewayBlockVolume[]> {
        // include_deleted is required by the spec: a deleted volume is no volume of the account's.
        return this.pages(SCALEWAY_ENDPOINTS.listBlockVolumes, { path: { zone }, query: { project_id: this.projectId, include_deleted: false }, size: 'page_size' }, (b) => listOf(b, 'volumes'));
    }

    /** Never retried after a server error: it may exist, and a second one would bill. */
    createBlockVolume(zone: ScalewayZone, body: ScalewayCreateBlockVolumeBody): Promise<ScalewayBlockVolume> {
        return this.call<ScalewayBlockVolume>(SCALEWAY_ENDPOINTS.createBlockVolume, { path: { zone }, json: body });
    }

    /** null when there is no such volume. */
    async getBlockVolume(zone: ScalewayZone, id: string): Promise<ScalewayBlockVolume | null> {
        return this.orNull<ScalewayBlockVolume>(SCALEWAY_ENDPOINTS.getBlockVolume, { path: { zone, volume_id: id } });
    }

    /** Deletes a volume now: one a server holds is refused (precondition_failed). true when it deleted it, false when it was gone already. */
    deleteBlockVolumeNow(zone: ScalewayZone, id: string): Promise<boolean> {
        return this.deleted(SCALEWAY_ENDPOINTS.deleteBlockVolume, { path: { zone, volume_id: id } });
    }

    /** Deletes a volume once nothing uses it; true when it deleted it, false when it was gone already. */
    async deleteBlockVolume(zone: ScalewayZone, id: string, o: WaitOptions = {}): Promise<boolean> {
        const busy = ['in_use', 'creating', 'updating', 'resizing', 'snapshotting', 'locked'];
        let status = 'unread';
        const volume = await pollUntil(async () => {
            const v = await this.getBlockVolume(zone, id);
            status = v?.status ?? 'gone';
            return v;
        }, (v) => !v || !busy.includes(v.status), {
            timeoutMs: o.timeoutMs ?? 2 * 60_000,
            intervalMs: o.intervalMs ?? 3000,
            sleep: this.sleep,
            retryOn: isRetriable,
            timeoutError: () => new ProviderError(this.id, `block volume ${zonedId(zone, id)} is still ${status}: it cannot be deleted yet`, { code: 'timeout' }),
        });
        if (!volume || volume.status === 'deleting' || volume.status === 'deleted') return false;
        return this.deleted(SCALEWAY_ENDPOINTS.deleteBlockVolume, { path: { zone, volume_id: id } });
    }

    // ── images ───────────────────────────────────────────────────────────

    /** The Project's own images in the zone: the public ones are left out. */
    listImages(zone: ScalewayZone): Promise<ScalewayImage[]> {
        return this.pages(SCALEWAY_ENDPOINTS.listImages, { path: { zone }, query: { public: false }, size: 'per_page' }, (b) => listOf(b, 'images'));
    }

    /** null when the zone has no such image. */
    async getImage(zone: ScalewayZone, id: string): Promise<ScalewayImage | null> {
        return (await this.orNull<{ image: ScalewayImage }>(SCALEWAY_ENDPOINTS.getImage, { path: { zone, image_id: id } }))?.image ?? null;
    }

    /**
     * Deletes the image and the snapshots it holds: deleting the image alone
     * leaves them behind, billed. A snapshot another image still uses is kept
     * (Scaleway refuses to delete it). true when the image was deleted, false
     * when it was gone already. Every snapshot is tried: one that cannot be
     * deleted is named in the error, as nothing finds it once the image is gone.
     * A snapshot Scaleway refuses to delete (`precondition_failed`: it is `in_use`
     * while its image's reference is cleared, or while something else holds it) is
     * asked again for 25 s; one that is still refused is kept only if another
     * image of the zone has it, and otherwise named in the error: refused and
     * left billing, as an earlier version did silently.
     */
    async deleteImage(zone: ScalewayZone, id: string): Promise<boolean> {
        const image = await this.getImage(zone, id);
        if (!image || !await this.deleted(SCALEWAY_ENDPOINTS.deleteImage, { path: { zone, image_id: id } })) return false;
        const left: string[] = [];
        let cause: unknown;
        for (const s of imageVolumes(image)) {
            try {
                await this.deleteSnapshot(zone, s, id);
            } catch (e) {
                left.push(s.id);
                cause ??= e;
            }
        }
        if (left.length) {
            throw new ProviderError(this.id, `image ${zonedId(zone, id)} is deleted, but its snapshot(s) ${left.join(', ')} are not: they bill until deleted (${(cause as Error).message})`, { code: 'snapshot_left', cause });
        }
        return true;
    }

    /**
     * A snapshot of image `imageId`, by the API that owns it: Block Storage for
     * `sbs_snapshot`, the Instance API otherwise. Gone already: nothing to do. Refused
     * (`precondition_failed`): asked again, then kept if another image of the zone
     * has it, else an error (see deleteImage).
     */
    private async deleteSnapshot(zone: ScalewayZone, s: ScalewayVolumeSummary, imageId: string): Promise<void> {
        const endpoint = s.volume_type === 'sbs_snapshot' ? SCALEWAY_ENDPOINTS.deleteBlockSnapshot : SCALEWAY_ENDPOINTS.deleteSnapshot;
        for (let attempt = 1; ; attempt++) {
            try {
                await this.deleted(endpoint, { path: { zone, snapshot_id: s.id } });
                return;
            } catch (e) {
                if (!(e instanceof ProviderError) || e.code !== 'precondition_failed') throw e;
                if (attempt < SNAPSHOT_TRIES) {
                    await this.sleep(SNAPSHOT_RETRY_MS);
                    continue;
                }
                if ((await this.listImages(zone)).some((i) => i.id !== imageId && imageVolumes(i).some((v) => v.id === s.id))) return;
                throw e;
            }
        }
    }

    // ── SSH keys (IAM) ───────────────────────────────────────────────────

    /** The Project's SSH keys (disabled ones are not applied to servers, so they are not listed). */
    async listSSHKeys(): Promise<InitializedSSHKeyData[]> {
        const project = this.requireProject('list its SSH keys');
        const keys = await this.pages<ScalewaySSHKey>(SCALEWAY_ENDPOINTS.listSSHKeys, { query: { project_id: project }, size: 'page_size' }, (b) => listOf(b, 'ssh_keys'));
        return keys.filter((k) => !k.disabled).map(toSSHKey);
    }

    /**
     * A new key in the Project. Scaleway accepts the same key twice, as two
     * registrations (checked live): the one that must not add a copy looks first
     * (addSSHKey), and deleting one leaves the other, which still authorizes it.
     */
    async registerSSHKey(publicKey: string, keyName: string): Promise<InitializedSSHKeyData> {
        const project = this.requireProject('add an SSH key');
        return toSSHKey(await this.call<ScalewaySSHKey>(SCALEWAY_ENDPOINTS.createSSHKey, { json: { name: keyName, public_key: publicKey, project_id: project } satisfies ScalewayCreateSSHKeyBody }));
    }

    /** true when it was deleted, false when the Project did not hold it. */
    async deleteSSHKey(id: string | number): Promise<boolean> {
        return isUuid(String(id)) && this.deleted(SCALEWAY_ENDPOINTS.deleteSSHKey, { path: { ssh_key_id: String(id) } });
    }

    // ── Marketplace ──────────────────────────────────────────────────────

    /** The OS images an Instance can boot, by label ('ubuntu_noble'). */
    listMarketplaceImages(): Promise<ScalewayMarketplaceImage[]> {
        return this.pages(SCALEWAY_ENDPOINTS.listMarketplaceImages, { query: { include_eol: false }, size: 'page_size' }, (b) => listOf(b, 'images'));
    }
}

/** The list `key` of an answer: Scaleway's lists are always there, so an answer without one is not Scaleway's. */
function listOf<T>(body: any, key: string): T[] {
    if (!Array.isArray(body?.[key])) throw new ProviderError(SCALEWAY_ID, `the answer has no "${key}" list`, { code: 'bad_answer' });
    return body[key];
}

/** The map `key` of an answer, as entries (Instance types are keyed by commercial type). */
function entriesOf<T>(body: any, key: string): Array<[string, T]> {
    const map = body?.[key];
    if (!map || typeof map !== 'object' || Array.isArray(map)) throw new ProviderError(SCALEWAY_ID, `the answer has no "${key}" map`, { code: 'bad_answer' });
    return Object.entries(map);
}
