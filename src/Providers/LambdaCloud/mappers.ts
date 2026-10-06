// How Lambda's records read as asap-vps's: an instance type as an offer, an
// instance as a server, a filesystem as a volume, an account key as a key, its
// status words and its billing. Pure functions of the raw records, typed by LambdaTypes.

import { canonicalGpu, gpuName, sshKeyFingerprint } from '../../Core/utils';
import type { Billing, InitializedSSHKeyData, Offer, RefusableOption, Server, ServerStatus, Volume } from '../../types';
import type { LambdaFilesystem, LambdaInstance, LambdaInstanceStatus, LambdaInstanceTypes, LambdaSSHKeyData } from './types';

export const LAMBDA_ID = 'lambda';

/**
 * The createServer options Lambda cannot honor: a container's (env, command,
 * ports, a registry login, a disk of its own) and a disk size (fixed by the
 * instance type). Left out of its CreateServerOptions, refused at run time.
 */
export const LAMBDA_REFUSED = ['env', 'command', 'ports', 'registryAuth', 'volume', 'diskGb'] as const satisfies readonly RefusableOption[];

/** Where a launch can mount a filesystem (spec: RequestedFilesystemMountEntry.mount_point). */
export const LAMBDA_MOUNT_PATH = /^(\/home|\/lambda\/nfs|\/data)[/a-zA-Z0-9-]*$/;

export const INSTANCE_STATUS: Readonly<Record<LambdaInstanceStatus, ServerStatus>> = {
    booting: 'pending',
    active: 'running',
    unhealthy: 'error',
    terminating: 'terminating',
    terminated: 'terminated',
    preempted: 'terminated',
};

/** Billed in one-minute steps with no minimum, from when the instance passes its health checks to its termination (docs.lambda.ai, 2026-10-02). */
export const LAMBDA_BILLING: Billing = Object.freeze({ incrementSeconds: 60, minimumSeconds: 0 });

/** An instance type (with the regions that have capacity for it now) as an offer. */
export function toOffer(t: LambdaInstanceTypes[string]): Offer<LambdaInstanceTypes[string]> {
    const it = t.instance_type;
    const canon = canonicalGpu(it.gpu_description) ?? canonicalGpu(it.name);
    const vram = /(\d+)\s*GB/i.exec(it.gpu_description)?.[1];
    return {
        provider: LAMBDA_ID,
        id: it.name,
        gpu: canon?.name ?? gpuName(it.gpu_description),
        vendor: canon?.vendor ?? 'nvidia',
        gpuCount: it.specs.gpus,
        vramGb: vram ? Number(vram) : canon?.vramGb ?? 0,
        pricePerHour: it.price_cents_per_hour / 100,
        billing: LAMBDA_BILLING,
        regions: (t.regions_with_capacity_available ?? []).map((r) => r.name),
        vcpus: it.specs.vcpus,
        memoryGb: it.specs.memory_gib,
        diskGb: it.specs.storage_gib,
        raw: t,
    };
}

export function toServer(i: LambdaInstance): Server<LambdaInstance> {
    const it = i.instance_type as LambdaInstance['instance_type'] | undefined;
    return {
        provider: LAMBDA_ID,
        id: i.id,
        name: i.name ?? '',
        status: INSTANCE_STATUS[i.status] ?? 'unknown',
        providerStatus: i.status,
        offerId: it?.name,
        gpu: it ? (canonicalGpu(it.gpu_description) ?? canonicalGpu(it.name))?.name ?? it.gpu_description : undefined,
        gpuCount: it?.specs?.gpus,
        region: i.region?.name,
        ip: i.ip || undefined,
        privateIp: i.private_ip || undefined,
        // Lambda Stack's login is ubuntu, not root.
        ...(i.ip ? { ssh: { host: i.ip, port: 22, username: 'ubuntu' } } : {}),
        pricePerHour: it ? it.price_cents_per_hour / 100 : undefined,
        // Billed from its first passed health check (Lambda has no stop).
        billingStartedAt: i.first_healthy ? Date.parse(i.first_healthy) || undefined : undefined,
        billing: LAMBDA_BILLING,
        ...(i.file_system_mounts?.length ? { mounts: i.file_system_mounts.map((m) => ({ volumeId: m.file_system_id, path: m.mount_point })) } : {}),
        raw: i,
    };
}

/** A filesystem as a volume: it grows as it fills (no size), and one in use (mounted) cannot be deleted. */
export function toVolume(f: LambdaFilesystem): Volume<LambdaFilesystem> {
    return {
        provider: LAMBDA_ID,
        id: f.id,
        name: f.name,
        region: f.region?.name,
        shared: true,
        status: f.is_in_use ? 'attached' : 'available',
        providerStatus: f.is_in_use ? 'in use' : 'not in use',
        mountPath: f.mount_point,
        createdAt: Date.parse(f.created) || undefined,
        raw: f,
    };
}

export function toSSHKey(k: LambdaSSHKeyData): InitializedSSHKeyData {
    let fingerprint = '';
    try {
        fingerprint = sshKeyFingerprint(k.public_key);
    } catch {
        // A key this parser does not read keeps no fingerprint.
    }
    return { id: k.id, name: k.name, publicKey: k.public_key, fingerprint };
}
