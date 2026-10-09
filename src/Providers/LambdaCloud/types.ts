// The parts of Lambda Cloud's API objects the LambdaCloud provider reads and
// sends (https://cloud.lambda.ai/api/v1/openapi.json, read 2026-09-29;
// filesystems 2026-10-06), and LambdaTypes, which types its records and create
// options by them.

import type { MountPath } from '../../types';
import type { LAMBDA_REFUSED } from './mappers';

export type LambdaInstanceType = {
    name: string,
    description: string,
    /** e.g. 'A10 (24 GB PCIe)'. */
    gpu_description: string,
    price_cents_per_hour: number,
    specs: { vcpus: number, memory_gib: number, storage_gib: number, gpus: number },
    architecture?: 'x86_64' | 'arm64',
};

export type LambdaInstanceTypes = Record<string, {
    instance_type: LambdaInstanceType,
    regions_with_capacity_available: Array<{ name: string, description: string }>,
}>;

export type LambdaInstanceStatus = 'booting' | 'active' | 'unhealthy' | 'terminated' | 'terminating' | 'preempted';

export type LambdaInstance = {
    id: string,
    name?: string,
    ip?: string,
    private_ip?: string,
    status: LambdaInstanceStatus,
    ssh_key_names: string[],
    region: { name: string, description: string },
    instance_type: LambdaInstanceType,
    hostname?: string,
    /** When the instance first became healthy (null if it never has): when Lambda starts billing it. */
    first_healthy?: string | null,
    /** The filesystems it mounts, by name. */
    file_system_names?: string[],
    /** The filesystems it mounts and where: missing when it mounts none. */
    file_system_mounts?: LambdaFilesystemMount[],
};

/** A filesystem mounted on an instance, and where. */
export type LambdaFilesystemMount = { file_system_id: string, mount_point: string };

/**
 * A filesystem: shared storage in one region, mounted when an instance
 * launches (never while it runs) by any number of instances there, as a
 * virtiofs mount (seen live 2026-10-06). It grows as it fills, and bills for what it holds.
 */
export type LambdaFilesystem = {
    id: string,
    name: string,
    /** Where an instance mounts it unless its launch says otherwise: /lambda/nfs/<name>. */
    mount_point: string,
    created: string,
    /** Mounted on an instance: it cannot be deleted then. */
    is_in_use: boolean,
    region: { name: string, description: string },
    /** About what it holds, updated every few hours. */
    bytes_used?: number,
};

/** The body of `POST /api/v1/filesystems`: what CreateVolumeOptions.providerOptions adds fields to. */
export type LambdaCreateFilesystemBody = {
    /** 1-60 characters: a letter, then letters, digits and dashes. */
    name: string,
    region: string,
};

export type LambdaSSHKeyData = { id: string, name: string, public_key: string };

export type LambdaErrorBody = { error?: { code?: string, message?: string, suggestion?: string } };

/** The body of `POST /api/v1/instance-operations/launch`: what CreateServerOptions.providerOptions adds fields to. */
export type LambdaLaunchBody = {
    region_name: string,
    instance_type_name: string,
    /** Exactly one key, by name. */
    ssh_key_names: string[],
    name: string,
    /** An image by id, or the newest of a family. */
    image?: { id: string } | { family: string },
    user_data?: string,
    tags?: Array<{ key: string, value: string }>,
    /** Filesystems to mount at their own mount point, by name. */
    file_system_names?: string[],
    /** Filesystems to mount, each where it says (under /home, /lambda/nfs or /data). */
    file_system_mounts?: LambdaFilesystemMount[],
};

/**
 * Lambda's records, as the LambdaCloud provider's records carry them (`raw`),
 * and the options it takes. Lambda cannot capture a server as an image; its
 * volumes are filesystems, which grow as they fill and mount at a path of your choosing.
 */
export type LambdaTypes = {
    server: LambdaInstance,
    offer: LambdaInstanceTypes[string],
    image: never,
    volume: LambdaFilesystem,
    createBody: LambdaLaunchBody,
    volumeBody: LambdaCreateFilesystemBody,
    imageImportBody: never,
    endpoint: never,
    endpointOffer: never,
    endpointBody: never,
    refused: (typeof LAMBDA_REFUSED)[number],
    volumeSize: {},
    volumeKind: {},
    mount: MountPath,
};
