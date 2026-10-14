// How Lambda's records read as asap-vps's: an instance type as an offer, an
// instance as a server, a filesystem as a volume, an account key as a key, its
// status words and its billing. Pure functions of the raw records, typed by LambdaTypes.

import { COUNTRY_TYPES, MACHINE_TYPES } from '../../constants';
import type { EnumTranslations } from '../../Core/BaseProvider';
import { canonicalGpu, gpuName, placed, regionTable, sshKeyFingerprint } from '../../Core/utils';
import { LAMBDA_REGIONS } from './places';
import type { Billing, InitializedSSHKeyData, Offer, RefusableOption, Server, ServerStatus, Volume } from '../../types';
import type { LambdaFilesystem, LambdaInstance, LambdaInstanceStatus, LambdaInstanceTypes, LambdaRegionName, LambdaSSHKeyData } from './types';

export const LAMBDA_ID = 'lambda';
/** Whom Lambda's images log in as: a sudoer, not root. */
export const LAMBDA_SSH_USER = 'ubuntu';

/**
 * The createServer options Lambda cannot honor: a container's (env, command,
 * ports, a registry login, a disk of its own) and a disk size (fixed by the
 * instance type). Left out of its CreateServerOptions, refused at run time.
 */
export const LAMBDA_REFUSED = ['env', 'command', 'ports', 'registryAuth', 'volume', 'diskGb'] as const satisfies readonly RefusableOption[];

/**
 * The library's enums by Lambda's names, its image families (the newest image
 * of each is booted): plain Ubuntu, and with `cuda` Lambda Stack, its image
 * with the NVIDIA driver, CUDA and the frameworks. It has none of Ubuntu
 * 20.04 (GET /api/v1/images, 2026-10-11). The regions are its regions'
 * (LAMBDA_REGIONS): each by its own, and a city, state or country by its first
 * region there (US_WASHINGTON_DC: us-east-2).
 */
export const LAMBDA_ENUMS = Object.freeze({
    regions: regionTable(LAMBDA_REGIONS, (r) => r.name),
    machines: {
        [MACHINE_TYPES.UBUNTU_24]: 'ubuntu-24-04',
        [MACHINE_TYPES.UBUNTU_22]: 'ubuntu-22-04',
    },
    cudaMachines: {
        [MACHINE_TYPES.UBUNTU_24]: 'lambda-stack-24-04',
        [MACHINE_TYPES.UBUNTU_22]: 'lambda-stack-22-04',
    },
} as const satisfies EnumTranslations);

/** Countries as Lambda's region descriptions name them ('Virginia, USA', 'India'), by their ISO code. */
const COUNTRY_NAMES = Object.freeze({
    USA: COUNTRY_TYPES.US, 'United States': COUNTRY_TYPES.US, Canada: COUNTRY_TYPES.CA, India: COUNTRY_TYPES.IN, Japan: COUNTRY_TYPES.JP, Germany: COUNTRY_TYPES.DE,
    France: COUNTRY_TYPES.FR, 'United Kingdom': COUNTRY_TYPES.GB, Israel: COUNTRY_TYPES.IL, Australia: COUNTRY_TYPES.AU,
} as const satisfies Record<string, COUNTRY_TYPES>);

/** The countries a Lambda region can read as being in: its pick of COUNTRY_TYPES, and what its `countries` offers (LambdaTypes.country). */
export type LambdaCountry = (typeof COUNTRY_NAMES)[keyof typeof COUNTRY_NAMES];

/**
 * The country a region is in: the one its description ends with ('Virginia,
 * USA', 'India': seen 2026-10-12), else the United States for a `us-` code;
 * undefined for a country this does not know by name.
 */
export function countryOf(region: { name?: string, description?: string } | null | undefined): COUNTRY_TYPES | undefined {
    const named = (COUNTRY_NAMES as Readonly<Record<string, COUNTRY_TYPES | undefined>>)[(region?.description ?? '').split(',').pop()!.trim()];
    return named ?? (region?.name?.startsWith('us-') ? COUNTRY_TYPES.US : undefined);
}

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
export function toOffer(t: LambdaInstanceTypes[string]): Offer<LambdaInstanceTypes[string], LambdaRegionName> {
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
        regions: (t.regions_with_capacity_available ?? []).map((r) => r.name as LambdaRegionName),
        locations: (t.regions_with_capacity_available ?? []).map((r) => placed(r.name as LambdaRegionName, countryOf(r))),
        vcpus: it.specs.vcpus,
        memoryGb: it.specs.memory_gib,
        diskGb: it.specs.storage_gib,
        raw: t,
    };
}

export function toServer(i: LambdaInstance): Server<LambdaInstance, LambdaRegionName> {
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
        region: i.region?.name as LambdaRegionName | undefined,
        ...(countryOf(i.region) ? { country: countryOf(i.region) } : {}),
        ip: i.ip || undefined,
        privateIp: i.private_ip || undefined,
        // Lambda Stack's login is ubuntu, not root.
        ...(i.ip ? { ssh: { host: i.ip, port: 22, username: LAMBDA_SSH_USER } } : {}),
        pricePerHour: it ? it.price_cents_per_hour / 100 : undefined,
        // Billed from its first passed health check (Lambda has no stop).
        billingStartedAt: i.first_healthy ? Date.parse(i.first_healthy) || undefined : undefined,
        billing: LAMBDA_BILLING,
        ...(i.file_system_mounts?.length ? { mounts: i.file_system_mounts.map((m) => ({ volumeId: m.file_system_id, path: m.mount_point })) } : {}),
        raw: i,
    };
}

/** A filesystem as a volume: it grows as it fills (no size), and one in use (mounted) cannot be deleted. */
export function toVolume(f: LambdaFilesystem): Volume<LambdaFilesystem, LambdaRegionName> {
    return {
        provider: LAMBDA_ID,
        id: f.id,
        name: f.name,
        region: f.region?.name as LambdaRegionName,
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
