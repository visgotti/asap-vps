// How Vast's records read as asap-vps's: an ask (one machine) as an offer, an
// instance as a server (its status read from three fields), a volume (on one
// machine) as a volume, an account key as a key, its billing, and what of a
// query Vast's own search can filter. Pure functions of the raw records, typed by VastTypes.

import { canonicalGpu, cudaVersion, gpuName, gpuVendor, parseSSHPublicKey, sshKeyFingerprint } from '../../Core/utils';
import type { Billing, InitializedSSHKeyData, Offer, OfferQuery, RefusableOption, Server, ServerImage, ServerMount, ServerStatus, Volume, VolumeStatus } from '../../types';
import type { VastImage, VastInstance, VastOffer, VastSnapshotRepository, VastSSHKeyData, VastVolume } from './types';

export const VAST_ID = 'vast';

/**
 * The createServer options Vast cannot honor: tags (an instance has none); a
 * disk of its own that goes with it (`volume`: a Vast volume outlives its
 * instance; mount one with `mounts`); and a choice of keys (every account key
 * is authorized on an `ssh` runtype image). Left out of its
 * CreateServerOptions, refused at run time.
 */
export const VAST_REFUSED = ['tags', 'volume', 'sshKeyIds'] as const satisfies readonly RefusableOption[];

/** A machine as a region (`machine:<id>`): where a volume is, and the place of an offer finer than its geolocation. */
export const MACHINE_REGION = 'machine:';

export function machineRegion(machineId: number): string {
    return `${MACHINE_REGION}${machineId}`;
}

/** The machine a region names (`machine:<id>`), else undefined. */
export function machineOf(region: string): number | undefined {
    const m = /^machine:(\d+)$/.exec(region.trim());
    return m ? Number(m[1]) : undefined;
}

/** Where an instance mounts a volume unless its mount says otherwise: where Vast's own console mounts one. */
export const VAST_MOUNT_PATH = '/data';

/** What Vast takes as a volume's name (a 422 otherwise, observed 2026-10-06). */
export const VOLUME_NAME = /^[A-Za-z0-9_]{1,64}$/;

/** A volume's status as asap-vps's: 'created' it can be mounted, 'in-use' an instance mounts it (observed 2026-10-06). */
export const VOLUME_STATUS: Readonly<Record<string, VolumeStatus>> = { created: 'available', 'in-use': 'attached' };

/** Rentals bill per second while they run; disk and bandwidth bill on top, the disk while stopped too (docs.vast.ai, 2026-10-02). */
export const VAST_BILLING: Billing = Object.freeze({ incrementSeconds: 1, minimumSeconds: 0 });

/**
 * After a start or reboot, Vast reports the container as it left it
 * (`exited`) until it relaunches (observed 2026-10-02): for this long after
 * the provider asked, that reads as pending, not as a crash.
 */
export const RELAUNCH_GRACE_MS = 10 * 60_000;

/** An ask as an offer; an interruptible one's id carries the bid to send (`<ask>:bid:<price>`). */
export function toOffer(a: VastOffer, interruptible: boolean): Offer<VastOffer> {
    const raw = String(a.gpu_name ?? '').replace(/_/g, ' ');
    const canon = canonicalGpu(raw);
    // Vast reports USABLE memory: within 10% below the model's size is that model's size.
    const reported = Number(a.gpu_ram ?? 0) / 1024;
    const vramGb = canon?.vramGb && reported <= canon.vramGb && reported >= canon.vramGb * 0.9 ? canon.vramGb : Math.round(reported);
    const bid = interruptible ? Number(a.min_bid ?? a.dph_total) : undefined;
    const cuda = hostCuda(a);
    return {
        provider: VAST_ID,
        // The same machine, rented with a bid: the id carries the price to send.
        id: bid !== undefined ? `${a.id}:bid:${bid}` : String(a.id),
        gpu: canon?.name ?? gpuName(raw),
        vendor: gpuVendor(raw),
        gpuCount: Number(a.num_gpus ?? 1),
        vramGb,
        // As the search prices it, with 8 GB of disk; a bid offer, its minimum bid alone. The disk rented bills on top (raw.storage_cost).
        pricePerHour: bid ?? Number(a.dph_total),
        billing: VAST_BILLING,
        // Where it is, and the machine it is (where a volume of it is: `machine:<id>`).
        regions: a.rentable === false ? [] : [String(a.geolocation ?? 'unknown'), ...(a.machine_id !== undefined ? [machineRegion(a.machine_id)] : [])],
        interruptible,
        vcpus: a.cpu_cores_effective,
        memoryGb: a.cpu_ram ? Math.round(a.cpu_ram / 1024) : undefined,
        diskGb: a.disk_space,
        ...(cuda ? { cudaVersion: cuda } : {}),
        raw: a,
    };
}

/**
 * The status of an instance, from its container's state, its contract's and
 * what was last asked of it; `relaunchedAt`: when the provider last started or
 * rebooted it (epoch ms), so a container still reported as it was left reads as pending.
 */
export function instanceStatus(i: VastInstance, relaunchedAt = 0, now = Date.now()): ServerStatus {
    const actual = i.actual_status ?? null;
    if (actual === 'running') return i.intended_status === 'stopped' ? 'stopping' : 'running';
    if (i.cur_state === 'stopped') return i.intended_status === 'running' ? 'pending' : 'stopped';
    // Just started or rebooted from here: still reported as it was left until it relaunches.
    if (actual === 'exited' && i.intended_status === 'running' && now - relaunchedAt < RELAUNCH_GRACE_MS) return 'pending';
    // A crashed container (exited), a silent host (unknown) or an offline one never reaches running.
    if (actual === 'exited' || actual === 'unknown' || actual === 'offline' || /error/i.test(i.status_msg ?? '')) {
        return i.intended_status === 'stopped' ? 'stopped' : 'error';
    }
    return 'pending';
}

export function toServer(i: VastInstance, relaunchedAt?: number): Server<VastInstance> {
    const status = instanceStatus(i, relaunchedAt);
    const ip = i.public_ipaddr ? String(i.public_ipaddr).trim() : undefined;
    const ports = Object.entries(i.ports ?? {}).flatMap(([key, maps]) => {
        const [port, protocol = 'tcp'] = key.split('/');
        return (maps ?? []).filter((x) => x?.HostPort).map((x) => ({ privatePort: Number(port), publicPort: Number(x.HostPort), ip, protocol }));
    });
    const mounts = instanceMounts(i);
    return {
        provider: VAST_ID,
        id: String(i.id),
        name: i.label ?? '',
        status,
        providerStatus: `${i.actual_status ?? 'none'}/${i.cur_state ?? '?'}${i.status_msg ? `: ${String(i.status_msg).slice(0, 120)}` : ''}`,
        gpu: i.gpu_name ? canonicalGpu(i.gpu_name.replace(/_/g, ' '))?.name ?? i.gpu_name : undefined,
        gpuCount: i.num_gpus ?? undefined,
        region: i.geolocation ?? undefined,
        ip,
        ...(ports.length ? { ports } : {}),
        ...(mounts.length ? { mounts } : {}),
        // Vast's ssh endpoint (a proxy host and port it assigns), for images that run sshd.
        ...(i.ssh_host && i.ssh_port ? { ssh: { host: i.ssh_host, port: Number(i.ssh_port), username: 'root' } } : {}),
        pricePerHour: i.dph_total ?? undefined,
        // Billed while it runs; a stopped instance bills only its disk. Vast reports the rental's start, not the
        // current run's, so after a stop and start this counts the stopped time too: an upper bound.
        billingStartedAt: i.start_date && i.cur_state !== 'stopped' && status !== 'stopped' ? Math.round(i.start_date * 1000) : undefined,
        billing: VAST_BILLING,
        createdAt: i.start_date ? Math.round(i.start_date * 1000) : undefined,
        raw: i,
    };
}

/**
 * The volumes an instance mounts: each of its `volume_info` (the volume's id
 * and name), at the path its env's docker flag for that name says
 * (`-v <name>:<path>`).
 */
export function instanceMounts(i: VastInstance): ServerMount[] {
    const env: Array<[string, unknown]> = Array.isArray(i.extra_env) ? i.extra_env : Object.entries(i.extra_env ?? {});
    const paths = new Map<string, string>();
    for (const [flag] of env) {
        const m = /^-v\s+(\S+?):(\/\S*)$/.exec(String(flag));
        if (m) paths.set(m[1], m[2]);
    }
    return (i.volume_info ?? []).flatMap((v) => {
        if (typeof v.id !== 'number') return [];
        const path = v.label ? paths.get(v.label) : undefined;
        return [{ volumeId: String(v.id), ...(path ? { path } : {}) }];
    });
}

/** A volume as a volume: its region its machine; attached while an instance mounts it. */
export function toVolume(v: VastVolume): Volume<VastVolume> {
    const serverIds = (v.instances ?? []).map((x) => (typeof x === 'object' ? x?.id : x)).filter((x): x is number => typeof x === 'number').map(String);
    return {
        provider: VAST_ID,
        id: String(v.id),
        name: v.label ?? '',
        region: machineRegion(v.machine_id),
        shared: false,
        ...(typeof v.disk_space === 'number' ? { sizeGb: v.disk_space } : {}),
        status: serverIds.length ? 'attached' : VOLUME_STATUS[v.status ?? ''] ?? 'unknown',
        providerStatus: v.status ?? '',
        serverIds,
        mountPath: VAST_MOUNT_PATH,
        ...(v.start_date ? { createdAt: Math.round(v.start_date * 1000) } : {}),
        raw: v,
    };
}

/** The tag Vast gives a snapshot: the instance's id and the time, `instance_54548215_at_October_6th_2026_at_10-08-32_PM_UTC` (observed 2026-10-06). */
export const SNAPSHOT_TAG = /^instance_(\d+)_at_/;

/** A Docker tag: what an image's name becomes (letters, digits, `_`, `.` and `-`, at most 128, not starting with `.` or `-`). */
export const IMAGE_TAG = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;

/** A snapshot, a tag of the snapshot repository, as an image (with its manifest's digest and size, where it was read). It boots anywhere. */
export function toImage(r: VastSnapshotRepository, tag: string, manifest?: { digest: string, json: { layers?: Array<{ size?: number }> } }): ServerImage<VastImage> {
    const reference = `${r.server}/${r.repository}:${tag}`;
    const size = manifest ? (manifest.json.layers ?? []).reduce((sum, l) => sum + Number(l.size ?? 0), 0) : undefined;
    return {
        provider: VAST_ID,
        id: reference,
        name: tag,
        status: 'available',
        providerStatus: 'pushed',
        regions: [],
        // Its layers as stored (compressed): what the registry holds, not what it unpacks to.
        ...(size ? { sizeGb: size / 1e9 } : {}),
        raw: { reference, tag, ...(manifest ? { digest: manifest.digest, size } : {}) },
    };
}

/** Vast's numeric id, as Vast gives it; Vast keys have no name, so it rides as the key's comment. */
export function toSSHKey(k: VastSSHKeyData): InitializedSSHKeyData {
    const line = String(k.key ?? k.public_key ?? '');
    let name = '';
    let fingerprint = '';
    try {
        name = parseSSHPublicKey(line).comment;
        fingerprint = sshKeyFingerprint(line);
    } catch {
        // A key this parser does not read keeps no fingerprint.
    }
    return { id: k.id, name, publicKey: line, fingerprint };
}

/**
 * What of a query Vast can filter itself: the vendor (gpu_arch), and for known
 * NVIDIA models their compute capability (compute_cap, e.g. 890 for sm_89).
 * Only filters that can never drop a match: an unknown or AMD model sends none.
 */
export function serverSideModels(q: OfferQuery): Record<string, unknown> {
    const out: Record<string, unknown> = q.vendor ? { gpu_arch: { eq: q.vendor } } : {};
    if (!q.gpus?.length) return out;
    const models = q.gpus.map((g) => canonicalGpu(g));
    if (models.some((m) => !m || m.vendor !== 'nvidia' || !/^sm\d+$/.test(m.arch))) return out;
    const caps = [...new Set(models.map((m) => Number(m!.arch.slice(2)) * 10))];
    return { ...out, compute_cap: { in: caps } };
}

/** The machine's newest CUDA version ('12.8'): Vast reports it as a number, cuda_max_good. */
export function hostCuda(a: VastOffer): string | undefined {
    const v = Number(a.cuda_max_good);
    return Number.isFinite(v) && v > 0 ? cudaVersion(v.toFixed(1)) : undefined;
}
