// How Vast's records read as asap-vps's: an ask (one machine) as an offer, an
// instance as a server (its status read from three fields), an account key as
// a key, its billing, and what of a query Vast's own search can filter. Pure
// functions of the raw records, typed by VastTypes.

import { canonicalGpu, cudaVersion, gpuName, gpuVendor, parseSSHPublicKey, sshKeyFingerprint } from '../../Core/utils';
import type { Billing, InitializedSSHKeyData, Offer, OfferQuery, RefusableOption, Server, ServerStatus } from '../../types';
import type { VastInstance, VastOffer, VastSSHKeyData } from './types';

export const VAST_ID = 'vast';

/**
 * The createServer options Vast cannot honor: tags (an instance has none); a
 * disk of its own and volumes (Vast's volumes live on one machine: no volumes
 * capability); and a choice of keys (every account key is authorized on an
 * `ssh` runtype image). Left out of its CreateServerOptions, refused at run time.
 */
export const VAST_REFUSED = ['tags', 'volume', 'mounts', 'sshKeyIds'] as const satisfies readonly RefusableOption[];

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
        pricePerHour: bid ?? Number(a.dph_total),
        billing: VAST_BILLING,
        regions: a.rentable === false ? [] : [String(a.geolocation ?? 'unknown')],
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
