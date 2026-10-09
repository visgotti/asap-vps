// How RunPod's records read as asap-vps's: a GPU type of the catalog as an
// offer, a pod as a server, a network volume as a volume, a line of the
// account's key list as a key, its status words, its billing, and its log
// stream's events as lines. Pure functions of the raw records, typed by RunPodTypes.

import { canonicalGpu, compareCudaVersions, cudaVersion, gpuName, parseSSHPublicKey, sshKeyFingerprint } from '../../Core/utils';
import type { Billing, Endpoint, InitializedSSHKeyData, Offer, RefusableOption, Server, ServerStatus, Volume } from '../../types';
import type { RunPodCloud, RunPodCpuOffer, RunPodCpuType, RunPodEndpoint, RunPodGpuType, RunPodNetworkVolume, RunPodPod, RunPodPodStatus } from './types';

export const RUNPOD_ID = 'runpod';

/** The createServer options RunPod cannot honor (a pod has no cloud-init and no tags): left out of its CreateServerOptions, refused at run time. */
export const RUNPOD_REFUSED = ['userData', 'tags'] as const satisfies readonly RefusableOption[];

/** Where a pod mounts a network volume unless a mount says otherwise: where RunPod's own pods do. */
export const RUNPOD_MOUNT_PATH = '/workspace';

export const POD_STATUS: Readonly<Record<RunPodPodStatus, ServerStatus>> = {
    PROVISIONING: 'pending',
    STARTING: 'pending',
    RUNNING: 'running',
    EXITED: 'stopped',
    ERROR: 'error',
    TERMINATED: 'terminated',
};

/** Pods bill per second while they run (docs.runpod.io/pods/pricing, 2026-10-02); a stopped pod bills only its volume. */
export const RUNPOD_BILLING: Billing = Object.freeze({ incrementSeconds: 1, minimumSeconds: 0 });

const IN_STOCK = new Set(['LOW', 'MEDIUM', 'HIGH']);

/**
 * The canonical model name, except for a MIG slice ("NVIDIA RTX PRO 6000 ...
 * MIG 1g.24gb"): a fraction of a card, named card + profile ("RTX PRO 6000
 * MIG 1g.24gb") so that asking for the card never rents a slice of it. Read from
 * the GPU type id, which offers and pods both carry.
 */
export function runPodGpuName(id: string): string {
    const mig = /^(.*?)\s*\bMIG\s+(\S+)/i.exec(id);
    return mig ? `${gpuName(mig[1])} MIG ${mig[2]}` : gpuName(id);
}

/**
 * A GPU type as an offer of `count` GPUs on `cloud`; null when that cloud does
 * not sell it (the catalog's own flag: a price alone is not), or has no price for it.
 */
export function toOffer(g: RunPodGpuType, count: number, cloud: RunPodCloud): Offer<RunPodGpuType> | null {
    if (!(cloud === 'COMMUNITY' ? g.community : g.secure)) return null;
    const price = cloud === 'COMMUNITY' ? g.price?.community : g.price?.secure;
    if (!(Number(price) > 0)) return null;
    const cuda = newestCuda((g.cudaVersions ?? []).filter((c) => c.available).map((c) => c.version));
    return {
        provider: RUNPOD_ID,
        id: g.id,
        gpu: runPodGpuName(g.id),
        vendor: g.manufacturer === 'AMD' ? 'amd' : 'nvidia',
        gpuCount: count,
        // Per GPU, as the catalog states it (a MIG slice has its slice's memory).
        vramGb: Number(g.memory ?? canonicalGpu(g.id)?.vramGb ?? 0),
        pricePerHour: Number(price) * count,
        billing: RUNPOD_BILLING,
        regions: (g.dataCenters ?? []).filter((d) => IN_STOCK.has(d.availability)).map((d) => d.id),
        ...(cuda ? { cudaVersion: cuda } : {}),
        raw: g,
    };
}

/** A CPU offer's id: the flavor and its vCPU count, `cpu5c:4` (no GPU type id has a colon). */
export function cpuOfferId(flavor: string, vcpuCount: number): string {
    return `${flavor}:${vcpuCount}`;
}

/** A CPU offer's id read back; null for a GPU type's id. */
export function parseCpuOfferId(id: string): { flavor: string, vcpuCount: number } | null {
    const m = /^([^:\s]+):(\d+)$/.exec(id);
    return m ? { flavor: m[1], vcpuCount: Number(m[2]) } : null;
}

/** The vCPU counts a flavor is rented in: the powers of two from its minimum to its maximum. */
export function vcpuCounts(cpu: Pick<RunPodCpuType, 'vcpu'>): number[] {
    const out: number[] = [];
    for (let n = 2; n <= cpu.vcpu.max; n *= 2) if (n >= cpu.vcpu.min) out.push(n);
    return out;
}

/**
 * A CPU flavor at `vcpuCount` vCPUs as an offer (a machine without GPUs),
 * priced per vCPU on the secure cloud; null when it has no price. Its regions
 * are the data centers with stock of it at that count.
 */
export function toCpuOffer(cpu: RunPodCpuType, vcpuCount: number): Offer<RunPodCpuOffer> | null {
    if (!(Number(cpu.price?.securePerVcpu) > 0)) return null;
    return {
        provider: RUNPOD_ID,
        id: cpuOfferId(cpu.id, vcpuCount),
        gpu: '',
        vendor: null,
        gpuCount: 0,
        vramGb: 0,
        pricePerHour: Number(cpu.price.securePerVcpu) * vcpuCount,
        billing: RUNPOD_BILLING,
        regions: (cpu.dataCenters ?? []).filter((d) => IN_STOCK.has(d.availability)).map((d) => d.id),
        vcpus: vcpuCount,
        memoryGb: Number(cpu.ramGbPerVcpu) * vcpuCount,
        raw: { cpu, vcpuCount },
    };
}

export function toServer(p: RunPodPod): Server<RunPodPod> {
    const ports = (p.runtime?.ports ?? []).map((x) => ({
        privatePort: x.private,
        ...(x.public != null ? { publicPort: x.public } : {}),
        ...(x.ip ? { ip: x.ip } : {}),
        protocol: x.type ?? 'tcp',
    }));
    return {
        provider: RUNPOD_ID,
        id: p.id,
        name: p.name,
        status: POD_STATUS[p.status] ?? 'unknown',
        providerStatus: p.status,
        offerId: p.gpu?.id ?? (p.cpu ? cpuOfferId(p.cpu.id, p.cpu.vcpuCount) : undefined),
        gpu: p.gpu ? runPodGpuName(p.gpu.id) : undefined,
        gpuCount: p.gpu?.count,
        region: p.dataCenterId ?? undefined,
        // The host's public address: sshd's direct endpoint, else a mapped tcp port.
        // An http port's ip is RunPod's proxy network, not the host.
        ip: p.ssh?.direct?.host ?? ports.find((x) => x.protocol === 'tcp' && x.ip && x.publicPort != null)?.ip,
        ports,
        // The direct endpoint (full ssh); RunPod's proxy carries an interactive shell only.
        ...(p.ssh?.direct ? { ssh: { host: p.ssh.direct.host, port: p.ssh.direct.port, username: p.ssh.direct.username } } : {}),
        ...(p.mounts?.network?.length ? { mounts: p.mounts.network.map((m) => ({ volumeId: m.volumeId, path: m.path })) } : {}),
        // RunPod states the rate only while the pod runs: a stopped pod's cost reads 0 (it bills only its volume then).
        pricePerHour: p.cost ? p.cost : undefined,
        // Billed from the pod's last start, while it is not stopped.
        billingStartedAt: p.startedAt && !['EXITED', 'TERMINATED'].includes(p.status) ? Date.parse(p.startedAt) || undefined : undefined,
        billing: RUNPOD_BILLING,
        createdAt: p.createdAt ? Date.parse(p.createdAt) || undefined : undefined,
        raw: p,
    };
}

/**
 * A network volume as a volume. RunPod reports no state for one, nor what
 * mounts it: one that is listed can be mounted, by any number of pods in its data center.
 */
export function toVolume(v: RunPodNetworkVolume): Volume<RunPodNetworkVolume> {
    return {
        provider: RUNPOD_ID,
        id: v.id,
        name: v.name,
        region: v.dataCenter,
        sizeGb: v.size,
        shared: true,
        status: 'available',
        providerStatus: '',
        mountPath: RUNPOD_MOUNT_PATH,
        raw: v,
    };
}

/** A line of the account's key list as a key: its id is its SHA256 fingerprint. null for a line this parser does not read. */
export function toSSHKey(line: string): InitializedSSHKeyData | null {
    try {
        const fingerprint = sshKeyFingerprint(line);
        return { id: fingerprint, name: parseSSHPublicKey(line).comment, publicKey: line, fingerprint };
    } catch {
        return null;
    }
}

/** The newest of these 'major.minor' versions, or undefined. */
export function newestCuda(versions: string[]): string | undefined {
    let best: string | undefined;
    for (const v of versions) {
        try {
            if (best === undefined || compareCudaVersions(v, best) > 0) best = cudaVersion(v);
        } catch {
            // A version this reader does not parse is not a version to promise.
        }
    }
    return best;
}

/** `data: {"source":"container","line":"...","ts":"..."}` events -> the lines. */
export function sseLogLines(text: string): string[] {
    const out: string[] = [];
    for (const raw of text.split('\n')) {
        if (!raw.startsWith('data:')) continue;
        try {
            const d = JSON.parse(raw.slice(5).trim());
            if (typeof d.line === 'string') out.push(d.line);
        } catch {
            // A partial event at the window's edge.
        }
    }
    return out;
}

/** The host a load-balancing endpoint answers on: `<id>.api.runpod.ai`. */
export const RUNPOD_SERVERLESS_HOST = 'api.runpod.ai';

/**
 * A GPU type of a serverless pool as an endpoint offer: one GPU per worker, at
 * the pool's flex price (per second while a worker runs); null for a type in
 * no pool, or with no serverless price. Its regions: the data centers with stock.
 */
export function toServerlessGpuOffer(g: RunPodGpuType): Offer<RunPodGpuType> | null {
    const price = Number(g.price?.serverless);
    if (!g.pool || !(price > 0)) return null;
    return {
        provider: RUNPOD_ID,
        id: g.id,
        gpu: runPodGpuName(g.id),
        vendor: g.manufacturer === 'AMD' ? 'amd' : 'nvidia',
        gpuCount: 1,
        vramGb: Number(g.memory ?? canonicalGpu(g.id)?.vramGb ?? 0),
        pricePerHour: price,
        billing: RUNPOD_BILLING,
        regions: (g.dataCenters ?? []).filter((d) => IN_STOCK.has(d.availability)).map((d) => d.id),
        raw: g,
    };
}

/** A CPU flavor at `vcpuCount` (2 or more) as an endpoint offer, at its serverless price; null when it has none. */
export function toServerlessCpuOffer(cpu: RunPodCpuType, vcpuCount: number): Offer<RunPodCpuOffer> | null {
    if (vcpuCount < 2 || !(Number(cpu.price?.serverlessPerVcpu) > 0)) return null;
    const offer = toCpuOffer({ ...cpu, price: { ...cpu.price, securePerVcpu: cpu.price.serverlessPerVcpu } }, vcpuCount);
    return offer && { ...offer, raw: { cpu, vcpuCount } };
}

/** A serverless endpoint as asap-vps reports it. RunPod gives an endpoint no status: one that exists takes requests. */
export function toEndpoint(e: RunPodEndpoint): Endpoint<RunPodEndpoint> {
    const urls = e.requestUrls;
    const base = urls && 'base' in urls ? urls.base : `https://${e.type === 'LOAD_BALANCER' ? `${e.id}.${RUNPOD_SERVERLESS_HOST}` : `${RUNPOD_SERVERLESS_HOST}/v2/${e.id}`}`;
    const port = Number(e.env?.PORT ?? /^(\d+)\/http$/.exec(e.ports?.[0] ?? '')?.[1] ?? 80);
    const cpu = e.cpu?.[0];
    return {
        provider: RUNPOD_ID,
        id: e.id,
        name: e.name,
        url: base.replace(/\/$/, ''),
        status: 'ready',
        providerStatus: e.type ?? 'QUEUE',
        image: e.image ?? '',
        port,
        ...(cpu ? { offerId: cpuOfferId(cpu.id, cpu.vcpuCount) } : {}),
        ...(e.dataCenterIds?.length === 1 ? { region: e.dataCenterIds[0] } : {}),
        minWorkers: e.workers?.min ?? 0,
        maxWorkers: e.workers?.max ?? 0,
        ...(e.workers?.idleTimeout !== undefined ? { idleTimeoutSeconds: e.workers.idleTimeout } : {}),
        private: true,
        createdAt: Date.parse(e.createdAt) || undefined,
        raw: e,
    };
}
