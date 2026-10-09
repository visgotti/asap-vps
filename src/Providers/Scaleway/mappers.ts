// How Scaleway's records read as asap-vps's: an Instance type as an offer (its
// GPUs, if any, its price in USD, its zones with stock), a server as a server
// (named by its zone: `fr-par-2/<uuid>`), an image as an image, a Block
// Storage volume as a volume (named by its zone too), a Project key as a key,
// its state words, its billing, the library's region and OS enums by
// Scaleway's names; and the wire format's own helpers (zoned ids, addresses,
// dates, sizes, error text). Pure functions of the raw records, typed by
// ScalewayTypes; the API client (api.ts) builds on them, never the other way.

import type { EnumTranslations } from '../../Core/ComputeProvider';
import { errorText, gpuName, gpuVendor, sshKeyFingerprint } from '../../Core/utils';
import { MACHINE_TYPES, REGION_TYPES } from '../../constants';
import type {
    Billing, Endpoint, EndpointStatus, GpuVendor, ImageStatus, InitializedSSHKeyData, Offer, RefusableOption, Server, ServerImage, ServerStatus, Volume, VolumeStatus,
} from '../../types';
import { SCALEWAY_REGIONS, SCALEWAY_ZONES } from './types';
import type {
    ScalewayBlockVolume, ScalewayBlockVolumeStatus, ScalewayContainer, ScalewayContainerSize, ScalewayContainerStatus, ScalewayErrorBody, ScalewayFileSystem,
    ScalewayFileSystemStatus, ScalewayImage, ScalewayImageState, ScalewayOfferRaw, ScalewayRegion, ScalewayServer, ScalewayServerState, ScalewayServerType,
    ScalewaySSHKey, ScalewayVolumeSummary, ScalewayZone,
} from './types';

export const SCALEWAY_ID = 'scaleway';

/**
 * The createServer options Scaleway cannot honor: a container's (env,
 * command, ports, a registry login, a disk of its own). Left out of its
 * CreateServerOptions, refused at run time.
 */
export const SCALEWAY_REFUSED = ['env', 'command', 'ports', 'registryAuth', 'volume'] as const satisfies readonly RefusableOption[];

/**
 * The tag a server carries for each volume it was created with from
 * CreateServerOptions.mounts (`asap-vps-volume:<uuid>`): the caller's, kept
 * when the server is deleted, and left out of its images; every other Block
 * Storage volume of the server is its own and goes with it.
 */
export const MOUNT_TAG = 'asap-vps-volume:';

/** The volumes a server mounts from CreateServerOptions.mounts, by id: what its MOUNT_TAG tags name. */
export function mountedVolumeIds(s: Pick<ScalewayServer, 'tags'>): string[] {
    return (s.tags ?? []).filter((t) => t.startsWith(MOUNT_TAG)).map((t) => t.slice(MOUNT_TAG.length));
}

export const VOLUME_STATUS: Readonly<Record<ScalewayBlockVolumeStatus, VolumeStatus>> = {
    unknown_status: 'unknown',
    creating: 'pending',
    available: 'available',
    in_use: 'attached',
    deleting: 'deleting',
    deleted: 'deleting',
    resizing: 'pending',
    error: 'error',
    snapshotting: 'pending',
    locked: 'error',
    updating: 'pending',
};

/** A binary gigabyte: how Scaleway counts RAM and a GPU's memory. */
export const GIB = 2 ** 30;
/** A decimal gigabyte: how Scaleway counts volume sizes. */
export const GB = 1e9;

/** Scaleway's images log in as root. */
export const SCALEWAY_SSH_USER = 'root';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether `s` is a Scaleway id (a UUID). */
export function isUuid(s: string): boolean {
    return UUID.test(s);
}

// ── states and billing ───────────────────────────────────────────────────

export const SERVER_STATUS: Readonly<Record<ScalewayServerState, ServerStatus>> = {
    running: 'running',
    starting: 'pending',
    stopping: 'stopping',
    stopped: 'stopped',
    'stopped in place': 'stopped',
    locked: 'error',
};

export const IMAGE_STATUS: Readonly<Record<ScalewayImageState, ImageStatus>> = { available: 'available', creating: 'pending', error: 'error' };

/** The states a server's compute bills in: standby (`stopped in place`) bills as running, a powered-off (`stopped`) or locked one bills no compute. */
const BILLED: readonly ScalewayServerState[] = ['running', 'starting', 'stopping', 'stopped in place'];

/**
 * How Scaleway counts a server's time (its Instances FAQ, checked 2026-10-02,
 * https://www.scaleway.com/en/docs/instances/faq/): a GPU Instance by the minute
 * of uptime, startup and standby included, a CPU Instance and RENDER-S (a GPU
 * type) by the hour. A powered-off Instance bills no compute; its volumes and
 * IPs bill on.
 */
export const BILLING_PER_MINUTE: Billing = Object.freeze({ incrementSeconds: 60, minimumSeconds: 0 });
export const BILLING_PER_HOUR: Billing = Object.freeze({ incrementSeconds: 3600, minimumSeconds: 0 });

/** The billing of a type (by name, and by its record when it is known: a type the catalog cannot be read for has none unless it is a RENDER). */
export function billingOf(name: string, t?: ScalewayServerType): Billing | undefined {
    if (name.startsWith('RENDER-')) return BILLING_PER_HOUR;
    return t && (gpuOf(t) ? BILLING_PER_MINUTE : BILLING_PER_HOUR);
}

/** The library's enums by Scaleway's names: a region is its first zone, `_N` the zone; each Ubuntu is its Marketplace label. */
export const SCALEWAY_ENUMS: EnumTranslations = Object.freeze({
    regions: {
        [REGION_TYPES.PARIS]: 'fr-par-1',
        [REGION_TYPES.PARIS_1]: 'fr-par-1',
        [REGION_TYPES.PARIS_2]: 'fr-par-2',
        [REGION_TYPES.PARIS_3]: 'fr-par-3',
        [REGION_TYPES.AMSTERDAM]: 'nl-ams-1',
        [REGION_TYPES.AMSTERDAM_1]: 'nl-ams-1',
        [REGION_TYPES.AMSTERDAM_2]: 'nl-ams-2',
        [REGION_TYPES.AMSTERDAM_3]: 'nl-ams-3',
        [REGION_TYPES.WARSAW]: 'pl-waw-1',
        [REGION_TYPES.WARSAW_1]: 'pl-waw-1',
        [REGION_TYPES.WARSAW_2]: 'pl-waw-2',
        [REGION_TYPES.WARSAW_3]: 'pl-waw-3',
        [REGION_TYPES.MILAN]: 'it-mil-1',
        [REGION_TYPES.MILAN_1]: 'it-mil-1',
    },
    machines: {
        [MACHINE_TYPES.UBUNTU_24]: 'ubuntu_noble',
        [MACHINE_TYPES.UBUNTU_22]: 'ubuntu_jammy',
        [MACHINE_TYPES.UBUNTU_20]: 'ubuntu_focal',
    },
});

// ── records ──────────────────────────────────────────────────────────────

/**
 * A type's GPUs: how many, the model by the shared canonical name (Scaleway
 * says 'H100-SXM', 'L4', 'P100'), its vendor, and the memory of one GPU in GiB
 * (`gpu_memory` is bytes). undefined for a CPU type (`gpu_info` is null).
 */
export function gpuOf(t?: ScalewayServerType): { count: number, name: string, vendor: GpuVendor, vramGb: number } | undefined {
    const info = t?.gpu_info;
    const count = t?.gpu ?? 0;
    if (!info || count < 1) return undefined;
    return {
        count,
        name: gpuName(info.gpu_name),
        vendor: gpuVendor(`${info.gpu_manufacturer} ${info.gpu_name}`),
        vramGb: info.gpu_memory / GIB,
    };
}

/** A type as an offer: priced in USD at `eurToUsd`, its regions the zones with stock now. */
export function toOffer(name: string, raw: ScalewayOfferRaw, regions: ScalewayZone[], eurToUsd: number): Offer<ScalewayOfferRaw> {
    const t = raw.serverType;
    const g = gpuOf(t);
    const local = t.volumes_constraint.max_size / GB;
    return {
        provider: SCALEWAY_ID,
        id: name,
        gpu: g?.name ?? '',
        vendor: g?.vendor ?? null,
        gpuCount: g?.count ?? 0,
        vramGb: g?.vramGb ?? 0,
        pricePerHour: t.hourly_price * eurToUsd,
        billing: billingOf(name, t),
        regions: [...regions],
        vcpus: t.ncpus,
        memoryGb: t.ram / GIB,
        // A GPU type has no local disk: its root volume is Block Storage, sized by diskGb.
        ...(local > 0 ? { diskGb: local } : {}),
        raw,
    };
}

/** A server, with its type's record when the catalog has it (its GPUs, price and billing). */
export function toServer(s: ScalewayServer, type: ScalewayServerType | undefined, eurToUsd: number): Server<ScalewayServer> {
    const { ip, ipv6, privateIp } = serverAddresses(s);
    const g = gpuOf(type);
    return {
        provider: SCALEWAY_ID,
        id: zonedId(s.zone, s.id),
        name: s.name,
        status: SERVER_STATUS[s.state] ?? 'unknown',
        providerStatus: s.state,
        offerId: s.commercial_type,
        gpu: g?.name,
        gpuCount: g?.count,
        region: s.zone,
        ip,
        ipv6,
        privateIp,
        ...(ip ? { ssh: { host: ip, port: 22, username: SCALEWAY_SSH_USER } } : {}),
        pricePerHour: type ? type.hourly_price * eurToUsd : undefined,
        // The run's start as far as the record says: `modification_date` is stamped when the server starts and again when it runs (checked live, 2 s
        // apart), but also by any later edit to the record (a tag), so it can fall late and the estimate undercount. None while nothing bills.
        billingStartedAt: BILLED.includes(s.state) ? epochMs(s.modification_date) : undefined,
        billing: billingOf(s.commercial_type, type),
        // The volumes it was created with from `mounts`: Block Storage attached as disks (no path), File Storage mounted at a path.
        ...(mountedVolumeIds(s).length || fileSystemMounts(s).length
            ? { mounts: [...mountedVolumeIds(s).map((id) => ({ volumeId: zonedId(s.zone, id) })), ...fileSystemMounts(s)] } : {}),
        createdAt: epochMs(s.creation_date),
        raw: s,
    };
}

/** A Block Storage volume as a volume, named by its zone (`fr-par-2/<uuid>`): its servers are those it is attached to. */
export function toVolume(v: ScalewayBlockVolume): Volume<ScalewayBlockVolume> {
    const servers = (v.references ?? []).filter((r) => r.product_resource_type === 'instance_server' && (r.status === 'attached' || r.status === 'attaching'));
    return {
        provider: SCALEWAY_ID,
        id: zonedId(v.zone, v.id),
        name: v.name,
        region: v.zone,
        sizeGb: v.size / GB,
        status: VOLUME_STATUS[v.status] ?? 'unknown',
        providerStatus: v.status,
        shared: false,
        serverIds: servers.map((r) => zonedId(v.zone, r.product_resource_id)),
        createdAt: epochMs(v.created_at),
        raw: v,
    };
}

export function toImage(i: ScalewayImage): ServerImage<ScalewayImage> {
    const bytes = imageVolumes(i).reduce((sum, v) => sum + v.size, 0);
    return {
        provider: SCALEWAY_ID,
        id: zonedId(i.zone, i.id),
        name: i.name,
        status: IMAGE_STATUS[i.state] ?? 'unknown',
        providerStatus: i.state,
        // Zone-bound: it boots here only.
        regions: [i.zone],
        ...(bytes > 0 ? { sizeGb: bytes / GB } : {}),
        createdAt: epochMs(i.creation_date),
        raw: i,
    };
}

/** A key as asap-vps reports it: Scaleway's id (a UUID), and the SHA256 fingerprint. */
export function toSSHKey(k: ScalewaySSHKey): InitializedSSHKeyData {
    let fingerprint = k.fingerprint;
    try {
        fingerprint = sshKeyFingerprint(k.public_key);
    } catch {
        // Keep Scaleway's own fingerprint for a key this parser does not read.
    }
    return { id: k.id, name: k.name, publicKey: k.public_key.trim(), fingerprint };
}

// ── the wire format ──────────────────────────────────────────────────────

export function isScalewayZone(s: string): s is ScalewayZone {
    return (SCALEWAY_ZONES as readonly string[]).includes(s);
}

/**
 * A server, image or other zonal resource as asap-vps names it: `fr-par-2/<uuid>`,
 * as Scaleway's own tools (Terraform) write a zonal id.
 */
export function zonedId(zone: ScalewayZone, id: string): string {
    return `${zone}/${id}`;
}

/**
 * `fr-par-2/<uuid>`, or a bare `<uuid>` (no zone: the caller asks each zone);
 * null for anything that cannot name a Scaleway resource, which nothing has.
 */
export function parseZonedId(ref: string | number): { zone?: ScalewayZone, id: string } | null {
    const s = String(ref).trim();
    const slash = s.indexOf('/');
    const zone = slash < 0 ? undefined : s.slice(0, slash);
    const id = (slash < 0 ? s : s.slice(slash + 1)).toLowerCase();
    if (!UUID.test(id)) return null;
    if (zone === undefined) return { id };
    return isScalewayZone(zone) ? { zone, id } : null;
}

/** The zones a ScalewayParams.zones names, in Scaleway's order; a region stands for its zones; none named: all of them. */
export function parseZones(zones?: Array<ScalewayZone | ScalewayRegion> | string): ScalewayZone[] {
    const items = (typeof zones === 'string' ? zones.split(',') : zones ?? []).map((z) => z.trim()).filter(Boolean);
    if (!items.length) return [...SCALEWAY_ZONES];
    const chosen = new Set<ScalewayZone>();
    for (const item of items) {
        if (isScalewayZone(item)) chosen.add(item);
        else if ((SCALEWAY_REGIONS as readonly string[]).includes(item)) SCALEWAY_ZONES.filter((z) => z.startsWith(`${item}-`)).forEach((z) => chosen.add(z));
        else throw new Error(`unknown Scaleway zone "${item}" (zones: ${SCALEWAY_ZONES.join(', ')})`);
    }
    return SCALEWAY_ZONES.filter((z) => chosen.has(z));
}

/** An RFC 3339 date (a nullable `creation_date`) as epoch milliseconds; undefined when there is none. */
export function epochMs(date?: string | null): number | undefined {
    const ms = Date.parse(date ?? '');
    return Number.isNaN(ms) ? undefined : ms;
}

/**
 * A server's addresses: its public IPv4 and IPv6 (`public_ips`, or the deprecated
 * `public_ip` and `ipv6` fields of a server not on routed IPs), and its private
 * IPv4 where it has one (deprecated: none on routed IPs). An address a server
 * does not have yet is left out.
 */
export function serverAddresses(s: ScalewayServer): { ip?: string, ipv6?: string, privateIp?: string } {
    const public_ = (family: 'inet' | 'inet6') => s.public_ips.find((i) => i.family === family && i.address)?.address;
    return {
        ip: public_('inet') ?? (s.public_ip?.address || undefined),
        ipv6: public_('inet6') ?? (s.ipv6?.address || undefined),
        privateIp: s.private_ip || undefined,
    };
}

/** The volumes (snapshots) an image holds: its root volume, when it has one, and its extra ones. */
export function imageVolumes(i: ScalewayImage): ScalewayVolumeSummary[] {
    return [i.root_volume, ...Object.values(i.extra_volumes)].filter((v): v is ScalewayVolumeSummary => !!v);
}

/** A loggable description of an error answer: its message, and what its type adds (arguments, quotas, fields). */
export function scalewayErrorText(body: ScalewayErrorBody, raw?: unknown): string {
    const parts = [body.message ?? errorText(raw)];
    for (const d of body.details ?? []) {
        if (d.argument_name) parts.push(`${d.argument_name}: ${d.help_message ?? d.reason ?? 'invalid'}`);
        else if (d.resource && d.quota !== undefined) parts.push(`${d.resource} ${d.current ?? '?'}/${d.quota}`);
        else if (d.resource && d.action) parts.push(`${d.action} ${d.resource}`);
        else if (d.resource) parts.push(d.resource);
    }
    for (const [field, messages] of Object.entries(body.fields ?? {})) parts.push(`${field}: ${messages.join(', ')}`);
    if (body.current_state) parts.push(`state ${body.current_state}`);
    // The same resource is named once per scope (Organization, Project).
    return [...new Set(parts.filter(Boolean))].join('; ').slice(0, 400);
}

// ── serverless containers ────────────────────────────────────────────────

/** The tag of a namespace made for one endpoint: deleted with it. */
export const ENDPOINT_TAG = 'asap-vps-endpoint';

/** A container instance's sizes: memory, and CPU in proportion (thousandths of a vCPU), as Scaleway's console sizes them. */
export const CONTAINER_SIZES: readonly ScalewayContainerSize[] = Object.freeze(
    ([[128, 70], [256, 140], [512, 280], [1024, 560], [2048, 1120], [3072, 1680], [4096, 2240]] as const).map(([mb, mvcpu]) => ({ mvcpu, memoryBytes: mb * 1e6 })));

/** EUR a second, per vCPU and per GB of memory, while an instance runs (scaleway.com/en/pricing/serverless, 2026-10-06; before the monthly free tier). */
export const CONTAINER_PRICE = Object.freeze({ vcpuSecond: 0.00001, gbSecond: 0.000002 });

/** Billed by the second while an instance runs. */
export const BILLING_PER_SECOND: Billing = Object.freeze({ incrementSeconds: 1, minimumSeconds: 0 });

/** A size's offer id: `1120mvcpu-2048mb`. */
export function containerSizeId(s: ScalewayContainerSize): string {
    return `${s.mvcpu}mvcpu-${Math.round(s.memoryBytes / 1e6)}mb`;
}

/** A size's offer id read back; null for anything else. */
export function parseContainerSizeId(id: string): ScalewayContainerSize | null {
    const m = /^(\d+)mvcpu-(\d+)mb$/.exec(id);
    return m ? { mvcpu: Number(m[1]), memoryBytes: Number(m[2]) * 1e6 } : null;
}

/** A container size as an endpoint offer: no GPU, billed per second while an instance runs, in every region. */
export function toContainerOffer(s: ScalewayContainerSize, eurToUsd: number): Offer<ScalewayContainerSize> {
    const eurPerHour = ((s.mvcpu / 1000) * CONTAINER_PRICE.vcpuSecond + (s.memoryBytes / 1e9) * CONTAINER_PRICE.gbSecond) * 3600;
    return {
        provider: SCALEWAY_ID, id: containerSizeId(s), gpu: '', vendor: null, gpuCount: 0, vramGb: 0, pricePerHour: eurPerHour * eurToUsd,
        billing: BILLING_PER_SECOND, regions: [...SCALEWAY_REGIONS], vcpus: s.mvcpu / 1000, memoryGb: s.memoryBytes / 1e9, raw: s,
    };
}

export const CONTAINER_STATUS: Readonly<Record<ScalewayContainerStatus, EndpointStatus>> = Object.freeze({
    unknown_status: 'unknown', creating: 'deploying', updating: 'deploying', upgrading: 'deploying', locking: 'deploying',
    ready: 'ready', deleting: 'deleting', error: 'error', locked: 'error',
});

/** The statuses a container or namespace passes through on its way to another. */
export const CONTAINER_TRANSIENT: ReadonlySet<string> = new Set(['creating', 'updating', 'upgrading', 'locking', 'unknown_status']);

/** A container's public endpoint as a URL, https://<host> (v1 gives the scheme; a bare host is read as https). */
export function endpointUrl(c: Pick<ScalewayContainer, 'public_endpoint'>): string {
    return `https://${c.public_endpoint.replace(/^https?:\/\//, '').replace(/\/+$/, '')}`;
}

/** The region a zone is in: fr-par-2 -> fr-par. */
export function regionOfZone(zone: ScalewayZone): ScalewayRegion {
    return zone.replace(/-\d+$/, '') as ScalewayRegion;
}

/** `fr-par/<uuid>`, or a bare `<uuid>` (no region: the caller asks each); null for anything else. */
export function parseRegionalId(ref: string): { region?: ScalewayRegion, id: string } | null {
    const [a, b] = ref.trim().split('/');
    const id = (b ?? a).toLowerCase();
    if (!UUID.test(id)) return null;
    if (b === undefined) return { id };
    return (SCALEWAY_REGIONS as readonly string[]).includes(a) ? { region: a as ScalewayRegion, id } : null;
}

/** A serverless container as an endpoint, named `fr-par/<uuid>`. Scaleway stops an idle instance after 15 min. */
export function toEndpoint(c: ScalewayContainer): Endpoint<ScalewayContainer> {
    return {
        provider: SCALEWAY_ID,
        id: `${c.region}/${c.id}`,
        name: c.name,
        url: endpointUrl(c),
        status: CONTAINER_STATUS[c.status] ?? 'unknown',
        providerStatus: c.status,
        image: c.image,
        port: c.port,
        offerId: containerSizeId({ mvcpu: c.mvcpu_limit, memoryBytes: c.memory_limit_bytes }),
        region: c.region,
        minWorkers: c.min_scale,
        maxWorkers: c.max_scale,
        idleTimeoutSeconds: 900,
        private: c.privacy !== 'public',
        createdAt: epochMs(c.created_at),
        raw: c,
    };
}

// ── File Storage (shared volumes) ────────────────────────────────────────

/** Where File Storage is (the API's region enum, 2026-10-06). */
export const FILE_REGIONS: readonly ScalewayRegion[] = Object.freeze(['fr-par'] as const);

/** The tag an Instance carries for each filesystem it mounts from `mounts`: `asap-vps-fs:<uuid>=<path>`. */
export const FS_TAG = 'asap-vps-fs:';

export function fileSystemTag(id: string, path: string): string {
    return `${FS_TAG}${id}=${path}`;
}

/** The filesystems an Instance's tags say it mounts, by regional id, with their paths. */
export function fileSystemMounts(s: Pick<ScalewayServer, 'tags' | 'zone'>): Array<{ volumeId: string, path: string }> {
    return (s.tags ?? []).flatMap((t) => {
        const m = /^asap-vps-fs:([0-9a-f-]{36})=(\/.*)$/.exec(t);
        return m ? [{ volumeId: `${regionOfZone(s.zone)}/${m[1]}`, path: m[2] }] : [];
    });
}

export const FILE_SYSTEM_STATUS: Readonly<Record<ScalewayFileSystemStatus, VolumeStatus>> = Object.freeze({
    unknown_status: 'unknown', creating: 'pending', updating: 'pending', available: 'available', error: 'error',
});

/** A filesystem as a volume, named `fr-par/<uuid>`: shared, mounted at a path (default /mnt/<name>); 'attached' while an Instance has it. */
export function toFileSystemVolume(f: ScalewayFileSystem): Volume<ScalewayFileSystem> {
    const status = FILE_SYSTEM_STATUS[f.status] ?? 'unknown';
    return {
        provider: SCALEWAY_ID,
        id: `${f.region}/${f.id}`,
        name: f.name,
        region: f.region,
        shared: true,
        sizeGb: f.size / GB,
        status: status === 'available' && f.number_of_attachments > 0 ? 'attached' : status,
        providerStatus: f.status,
        mountPath: `/mnt/${f.name}`,
        createdAt: epochMs(f.created_at),
        raw: f,
    };
}

/**
 * The script (cloud-init user data, bash) that mounts an Instance's
 * filesystems with virtiofs at their paths, at once and at every boot (an
 * /etc/fstab line each); undefined when there is nothing to mount.
 */
export function fileSystemMountScript(mounts: ReadonlyArray<{ id: string, path: string }>): string | undefined {
    if (!mounts.length) return undefined;
    const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
    return [
        '#!/bin/bash',
        '# asap-vps: mounts the Instance\'s filesystems (CreateServerOptions.mounts) with virtiofs, now and at every boot.',
        'mount_fs() {',
        '  mkdir -p "$2"',
        '  grep -qs " $2 virtiofs " /etc/fstab || echo "$1 $2 virtiofs defaults,nofail 0 0" >> /etc/fstab',
        '  for i in $(seq 1 30); do findmnt -n "$2" >/dev/null && break; mount "$2" && break; sleep 2; done',
        '}',
        ...mounts.map((m) => `mount_fs ${q(m.id)} ${q(m.path)}`),
        '',
    ].join('\n');
}

// ── image copies (across zones, through Object Storage) ─────────────────

/** What the name of a bucket importImage or copyImage makes (and deletes once done) starts with. */
export const TMP_BUCKET_PREFIX = 'asap-vps-tmp-';

/** The tag a copy of an image carries: `asap-vps-copy-of:<the source's uuid>`. */
export const COPY_TAG = 'asap-vps-copy-of:';

export function copyTag(sourceId: string): string {
    return `${COPY_TAG}${sourceId}`;
}

/** Whether an image is a copy (copyImage) of the image `sourceId` (its uuid). */
export function isCopyOf(image: ScalewayImage, sourceId: string): boolean {
    return image.tags.includes(copyTag(sourceId));
}

/** An image with every region createServer boots it in: its zone, and those of its copies among `images`. */
export function toImageWithCopies(image: ScalewayImage, images: ScalewayImage[]): ServerImage<ScalewayImage> {
    return { ...toImage(image), regions: [image.zone, ...images.filter((i) => isCopyOf(i, image.id)).map((i) => i.zone)] };
}
