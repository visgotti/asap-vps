// The parts of RunPod's REST v2 objects the RunPod provider reads and sends
// (https://api.runpod.io/v2/openapi.json, read 2026-09-29; registries and
// network volumes 2026-10-06), and RunPodTypes, which types its records and
// create options by them.

import type { MountPath, ProviderParams, VolumeSize } from '../../types';
import type { RUNPOD_REFUSED } from './mappers';

export type RunPodParams = ProviderParams & {
    /** Which cloud offers are read and pods are placed on (default SECURE). */
    cloud?: RunPodCloud,
};

export type RunPodCloud = 'SECURE' | 'COMMUNITY';
export type RunPodAvailability = 'NONE' | 'LOW' | 'MEDIUM' | 'HIGH';

export type RunPodGpuType = {
    /** The id a pod create takes, e.g. 'NVIDIA GeForce RTX 4090'. A MIG slice is a type of its own. */
    id: string,
    name: string,
    manufacturer: 'NVIDIA' | 'AMD' | 'UNKNOWN',
    /** VRAM in GB. */
    memory: number,
    /** Sold on the secure / community cloud. */
    secure: boolean,
    community: boolean,
    /** Per GPU per hour: on the secure and community clouds, and as a serverless worker (with product=SERVERLESS: its pool's flex price). */
    price: { secure?: number | null, community?: number | null, serverless?: number | null },
    /** The serverless pool it is in (what an endpoint's gpu.pools takes, e.g. 'AMPERE_16'); null when it is in none. */
    pool?: string | null,
    /** The most GPUs one pod of this type can have, per cloud. */
    maxCount?: { secure?: number, community?: number },
    /** With include=AVAILABILITY. */
    availability?: RunPodAvailability,
    /** With include=AVAILABILITY; omitted when there is no stock anywhere. */
    dataCenters?: Array<{ id: string, name?: string, availability: RunPodAvailability }>,
    /** With include=AVAILABILITY: the CUDA versions hosts of this type run; absent for AMD. */
    cudaVersions?: Array<{ version: string, available: boolean }>,
};

/** A CPU flavor of the catalog (`GET /v2/catalog/cpus`): priced per vCPU, rented in a power-of-two count of them within `vcpu`. */
export type RunPodCpuType = {
    /** What a pod create takes as `cpu.id`, e.g. 'cpu5c'. */
    id: string,
    name: string,
    /** The generation, e.g. 'Gen 5'. */
    group: string,
    vcpu: { min: number, max: number },
    ramGbPerVcpu: number,
    price: { securePerVcpu: number, serverlessPerVcpu: number },
    /** With include=AVAILABILITY (and product). */
    availability?: RunPodAvailability,
    /** With include=AVAILABILITY; omitted when there is no stock anywhere. */
    dataCenters?: Array<{ id: string, name?: string, availability: RunPodAvailability }>,
};

/** What a CPU offer is made from: a flavor at one vCPU count. */
export type RunPodCpuOffer = { cpu: RunPodCpuType, vcpuCount: number };

export type RunPodPodStatus = 'PROVISIONING' | 'STARTING' | 'RUNNING' | 'EXITED' | 'ERROR' | 'TERMINATED';

export type RunPodPod = {
    id: string,
    name: string,
    status: RunPodPodStatus,
    image?: string,
    /** Omitted from CPU pods. */
    gpu?: { id: string, count: number, vcpuCount?: number, memory?: number } | null,
    /** CPU pods only: the flavor, its vCPUs and the memory that comes with them (GB). */
    cpu?: { id: string, vcpuCount: number, memory?: number } | null,
    dataCenterId?: string | null,
    /** The host's CUDA version, kept while the pod is stopped; null when unknown. */
    cudaVersion?: string | null,
    /** USD per hour; 0 when stopped. */
    cost?: number,
    createdAt?: string,
    /** When the pod last started; null when it has not. */
    startedAt?: string | null,
    /** The actions the current status allows. */
    actions?: string[],
    runtime?: { uptime?: number, ports?: Array<{ private: number, public?: number | null, type?: string, ip?: string | null }> } | null,
    ssh?: { proxy?: RunPodSshEndpoint | null, direct?: RunPodSshEndpoint | null },
    /** Its disk of its own (`persistent`) or the network volume it mounts (`network`, at most one): never both. */
    mounts?: RunPodMounts | null,
    /** The stored registry login it pulls its image with. */
    registry?: string | null,
};

/** A pod's storage: a disk of its own that survives a stop, or a network volume of the account. */
export type RunPodMounts = {
    persistent?: { size: number, path: string } | null,
    network?: Array<{ volumeId: string, path: string }> | null,
};

/** The storage tier of a network volume, fixed when it is made. */
export type RunPodVolumeType = 'STANDARD' | 'HIGH_PERFORMANCE';

/** A network volume: storage of the account in one data center, which any number of pods and serverless workers there mount. */
export type RunPodNetworkVolume = {
    id: string,
    /** Not required to be unique. */
    name: string,
    /** GB; it can grow, never shrink. */
    size: number,
    /** The data center it is in; a pod that mounts it is placed there. */
    dataCenter: string,
    type?: RunPodVolumeType,
};

/** The body of `POST /v2/network-volumes`: what CreateVolumeOptions.providerOptions adds fields to. */
export type RunPodCreateNetworkVolumeBody = {
    name: string,
    /** GB, 10-4096. */
    size: number,
    dataCenter: string,
    /** Default: the data center's own. */
    type?: RunPodVolumeType,
};

/** A stored registry login: RunPod never shows its username or password again. */
export type RunPodRegistry = { id: string, name: string };

export type RunPodSshEndpoint = { host: string, port: number, username: string, command: string };

/** The body of `POST /v2/pods`, as the RunPod provider sends it: what CreateServerOptions.providerOptions adds fields to. */
export type RunPodCreatePodBody = {
    name: string,
    image: string,
    /** Exactly one of `gpu` and `cpu`. */
    gpu?: { id: string, count: number, minCudaVersion?: string },
    cpu?: { id: string, vcpuCount: number },
    cloud: RunPodCloud,
    dataCenterIds?: string[],
    env?: Record<string, string>,
    /** '<port>/<tcp|http>': RunPod takes no UDP. */
    ports?: string[],
    cmd?: string[],
    /** The container disk, whole GB. */
    disk: number,
    mounts?: RunPodMounts,
    /** The id of a stored registry login, for a private image. */
    registry?: string,
    startSsh?: boolean,
};

/**
 * RunPod's records, as the RunPod provider's records carry them (`raw`), and
 * the options it takes. Pods boot registry images: no images of the account's
 * own. A network volume is sized when it is made, and mounted at a path of your choosing.
 */
export type RunPodTypes = {
    server: RunPodPod,
    /** A GPU type, or a CPU flavor at a vCPU count. */
    offer: RunPodGpuType | RunPodCpuOffer,
    image: never,
    volume: RunPodNetworkVolume,
    createBody: RunPodCreatePodBody,
    volumeBody: RunPodCreateNetworkVolumeBody,
    imageImportBody: never,
    endpoint: RunPodEndpoint,
    /** A GPU type of a serverless pool, or a CPU flavor at a vCPU count. */
    endpointOffer: RunPodGpuType | RunPodCpuOffer,
    endpointBody: RunPodCreateEndpointBody,
    refused: (typeof RUNPOD_REFUSED)[number],
    volumeSize: VolumeSize,
    volumeKind: {},
    mount: MountPath,
};

// ── serverless (REST v2 /v2/serverless, api.runpod.io/v2/openapi.json, read 2026-10-06) ──

/** How an endpoint's workers scale: on queue delay (a queue endpoint), or on requests in flight (a load-balancing one must). */
export type RunPodScaling = { type: 'QUEUE_DELAY', queueDelay: number } | { type: 'REQUEST_COUNT', requestCount: number };

/** A serverless endpoint: workers of one image, scaled from `workers.min` to `workers.max`. */
export type RunPodEndpoint = {
    id: string,
    name: string,
    /** 'LOAD_BALANCER': workers serve plain HTTP behind requestUrls.base; 'QUEUE': jobs through RunPod's queue API (and its Python SDK in the worker). */
    type?: 'QUEUE' | 'LOAD_BALANCER',
    image?: string,
    env?: Record<string, string>,
    ports?: string[],
    cmd?: string[],
    entrypoint?: string[],
    /** The container's command as one raw string (what entrypoint and cmd encode into). */
    args?: string,
    /** Container disk, GB (ephemeral). */
    disk?: number,
    /** A stored registry login's id (/v2/registries). */
    registry?: string | null,
    requestUrls?: { base: string, health: string } | { run: string, runSync: string, status: string, stream: string, cancel: string, retry: string, purgeQueue: string, health: string },
    gpu?: { pools: string[], excludedTypes?: string[], count: number, allowedCudaVersions: string[], minCudaVersion: string | null } | null,
    cpu?: Array<{ id: string, vcpuCount: number, memory: number }>,
    workers: { min?: number, max?: number, idleTimeout?: number },
    scaling: RunPodScaling,
    dataCenterIds: string[],
    networkVolumes: string[],
    /** Per-request execution timeout, ms. */
    timeout: number,
    flashboot: 'OFF' | 'FLASHBOOT' | 'PRIORITY_FLASHBOOT',
    createdAt: string,
};

/** POST /v2/serverless: one call makes the endpoint and the template it runs (unknown fields are refused). Exactly one of gpu and cpu. */
export type RunPodCreateEndpointBody = {
    name: string,
    type: 'QUEUE' | 'LOAD_BALANCER',
    scaling: RunPodScaling,
    image?: string,
    templateId?: string,
    /** Pools, not GPU type ids; a type of the pools can be left out (excludedTypes). Not both allowedCudaVersions and minCudaVersion. */
    gpu?: { pools: string[], excludedTypes?: string[], count?: number, allowedCudaVersions?: string[], minCudaVersion?: string },
    /** A flavor at a power-of-two vCPU count, from 2. */
    cpu?: Array<{ id: string, vcpuCount: number }>,
    /** idleTimeout: 1-3600 s. */
    workers?: { min?: number, max?: number, idleTimeout?: number },
    timeout?: number,
    flashboot?: 'OFF' | 'FLASHBOOT' | 'PRIORITY_FLASHBOOT',
    dataCenterIds?: string[],
    networkVolumes?: string[],
    registry?: string | null,
    disk?: number,
    env?: Record<string, string>,
    ports?: string[],
    args?: string,
    entrypoint?: string[],
    cmd?: string[],
};

/** GET /v2/serverless/{id}/workers: the workers now (none listed while it idles at zero). */
export type RunPodEndpointWorkers = {
    endpointVersion?: number | null,
    summary: { running: number, idle: number, initializing: number, throttled: number, unhealthy: number, total: number },
    workers: Array<{
        id: string, status: 'RUNNING' | 'IDLE' | 'INITIALIZING' | 'THROTTLED' | 'UNHEALTHY', isStale: boolean, version?: number | null, gpuCount: number,
        image?: string | null, uptimeSeconds?: number | null, gpuTypeId?: string | null, dataCenterId?: string | null, startedAt?: string | null,
    }>,
};
