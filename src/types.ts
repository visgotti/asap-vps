import { MACHINE_TYPES, PLATFORM, PlatformFamily, REGION_TYPES } from "./constants";
import type { NodeSSH } from 'node-ssh';
import type { Sleep } from './Core/utils/async';
import type { FetchImpl } from './Core/utils/http';

// ── SSH ──────────────────────────────────────────────────────────────────

export type SSHOptions = { username?: string, privateKey?: string, publicKey?: string, password?: string };

export type SSHKeyData = {
    publicKey: string,
    privateKey: string,
}

export type SSHData<T extends (true | false)> = SSHKeyData & {
    id?: string | number,
    isEncrypted?: T,
    username?: string,
}
export type EncryptedSSHData = SSHData<true>
export type UnencryptedSSHData = SSHData<false>

/** How often SSHService.connect tries before it gives up, and how long it waits between tries (ms). */
export type SSHRetryOptions = { maxRetries: number, retryTimeout: number };

/** Where a server's sshd listens, and as whom to log in. */
export type SSHEndpoint = {
    host: string,
    port: number,
    /** 'root' on most images; 'ubuntu' on Lambda's. */
    username: string,
}

/** SSHService.connect's options: a server's `ssh` endpoint spreads straight in. */
export type SSHConnectOptions = {
    host: string,
    /** Default 22. */
    port?: number,
    /** Default 'root'. */
    username?: string,
    privateKey: string,
    /** Decrypts `privateKey` when it is stored encrypted (SSHService.initKeys with an encryptionKey). */
    decryptionKey?: string,
    /** Default 10 tries, 5 s apart. */
    retry?: SSHRetryOptions,
}

/**
 * An SSH key registered with a provider's account, its `id` as the provider
 * gives it. `fingerprint` is OpenSSH's `SHA256:...` form; for a key in a format
 * asap-vps does not read, the provider's own fingerprint, or ''.
 */
export type InitializedSSHKeyData = { id: number | string, publicKey: string, name: string, fingerprint: string }

// ── setup over SSH (SetupPipeline, ServerProvisioner) ────────────────────

/** A server's addresses, as a setup step sees them. */
export type CreatedServerData = {
    ip: string,
    id: number | string,
    ipv6?: string,
    privateIp?: string
};

export type FirewallRule = {
    port: number,
    protocol: 'tcp' | 'udp',
    allow?: boolean,
}

export type SSLCertificateConfig = {
    certContent: string,
    keyContent: string,
    certPath?: string,
    keyPath?: string,
}

export type SetupStepResult = {
    step: string,
    success: boolean,
    message?: string,
    output?: string,
}

export interface ISetupStep {
    readonly name: string;
    execute(ssh: NodeSSH, context: SetupContext): Promise<SetupStepResult>;
}

export type SetupContext = {
    platform: PLATFORM,
    platformFamily: PlatformFamily,
    ip: string,
    serverData?: CreatedServerData,
    [key: string]: unknown,
}

export type SetupPipelineOptions = {
    stopOnFailure?: boolean,
    onStepComplete?: (result: SetupStepResult) => void,
    onStepStart?: (stepName: string) => void,
}

// ── providers ────────────────────────────────────────────────────────────

/** What every provider is built from: its API key, or these (each provider adds its own settings: ScalewayParams, RunPodParams, ...). */
export type ProviderParams = {
    apiKey: string,
    /** Another endpoint for the same API (a proxy, a test double). */
    baseUrl?: string,
    /** The fetch every API call goes through (default: the global fetch). */
    fetchImpl?: FetchImpl,
    /** How waits and retries wait (default: real time). */
    sleep?: Sleep,
}

/** @deprecated The name ProviderParams had before providers were capability-based. */
export type InitializerParams = ProviderParams;

/**
 * One platform's own records, as its API sends and takes them: what the
 * normalized records of its provider carry as `raw`, what its create options'
 * `providerOptions` adds to, and which of the library's options it takes. Each
 * provider names its platform's (DigitalOceanTypes, RunPodTypes, ...), so
 * `server.raw` is a droplet on DigitalOcean and a pod on RunPod, with no cast,
 * and an editor offers each provider's createServer only the options it
 * honors; code that works across providers uses the default, where every
 * record is `unknown` and every option is offered.
 */
export interface PlatformTypes {
    /** A server as the platform reports it (a droplet, a pod, an instance). */
    server: unknown;
    /** What one offer is made from (a size, a GPU type, a marketplace ask). */
    offer: unknown;
    /** An image of the account's own; `never` where the platform has none. */
    image: unknown;
    /** A volume of the account's own (a network volume, a filesystem, a block volume); `never` where the platform has none. */
    volume: unknown;
    /** The body of the platform's create request: what `providerOptions` adds fields to. */
    createBody: object;
    /** The body of its volume create: what CreateVolumeOptions.providerOptions adds fields to. */
    volumeBody: object;
    /** The body of its image import (IImageImport): what ImportImageOptions.providerOptions adds fields to; `never` where it has none. */
    imageImportBody: object;
    /** A serverless endpoint as the platform reports it (IServerless); `never` where it has none. */
    endpoint: unknown;
    /** What one serverless offer is made from (a GPU pool's type, a CPU flavor, a container size). */
    endpointOffer: unknown;
    /** The body of its endpoint create: what CreateEndpointOptions.providerOptions adds fields to. */
    endpointBody: object;
    /**
     * The createServer options it cannot honor (RefusableOption names): left out
     * of its CreateServerOptions, and refused at run time when passed anyway.
     * The default refuses none.
     */
    refused: unknown;
    /** What its createVolume takes for a size: VolumeSize where a volume is sized when it is made, `{}` where it grows as it fills. */
    volumeSize: Partial<VolumeSize>;
    /** What its createVolume takes to pick a kind: VolumeKind where it makes block devices and shared filesystems both, `{}` where it makes one kind. */
    volumeKind: Partial<VolumeKind>;
    /** What a mount takes besides the volume: MountPath where the platform mounts at a path of your choosing, `{}` where it picks the place. */
    mount: MountPath;
}

// ── compute: offers, servers, images ─────────────────────────────────────
// The shapes every compute provider (ICompute) maps its platform's API onto,
// so offers are compared, and servers created, read, stopped and deleted, the
// same way on every provider, whatever they rent: a VPS is a server whose
// offer has no GPU.

export type GpuVendor = 'nvidia' | 'amd';

/** Which offers or servers: those with GPUs, those without, or both (the default). */
export type ComputeKind = 'gpu' | 'cpu' | 'any';

/**
 * How a provider bills a server's time, from its docs: the time is counted in
 * steps of `incrementSeconds` (1 per second, 60 per minute, 3600 per hour) and
 * never less than `minimumSeconds`.
 */
export type Billing = {
    incrementSeconds: number,
    minimumSeconds: number,
    /** A run never costs less than `minimumUsd` (DigitalOcean: 60 s or $0.01, whichever is higher). */
    minimumUsd?: number,
};

/**
 * What a server's time came to, estimated from its rate and how long it was
 * billed (estimateCost, ICompute.getServerCost). The provider's invoice is the
 * truth: disks, bandwidth and addresses bill on top of this.
 */
export type CostEstimate = {
    usd: number,
    /** The rate applied, USD per hour. */
    pricePerHour: number,
    /** The billed run, epoch ms: from when it began billing to the moment estimated. */
    from: number,
    to: number,
    /** The elapsed time rounded up to the billing increment, never under its minimum. */
    billedSeconds: number,
};

/** Something you can rent: a machine type (its GPUs, if any), its price, and where it can be created now. */
export type Offer<TRaw = unknown> = {
    /** The provider's `id`. */
    provider: string,
    /**
     * The provider's key for it: a size slug, GPU type id, marketplace ask id or
     * instance type. createServer takes the whole offer (or this id).
     */
    id: string,
    /** Canonical GPU model name (Core/utils/gpus.ts): 'L4', 'RTX 4000 Ada', 'H100'; '' for a machine without GPUs. */
    gpu: string,
    /** null for a machine without GPUs. */
    vendor: GpuVendor | null,
    /** 0 for a machine without GPUs. */
    gpuCount: number,
    /** Per GPU; 0 for a machine without GPUs. */
    vramGb: number,
    /** USD per hour for the whole offer (all its GPUs). */
    pricePerHour: number,
    /** How a server of this offer is billed by time. */
    billing?: Billing,
    /** Where it can be created right now; [] = no stock anywhere. */
    regions: string[],
    interruptible?: boolean,
    vcpus?: number,
    memoryGb?: number,
    diskGb?: number,
    /**
     * The newest CUDA version, as 'major.minor', that the host's driver runs,
     * where the provider reports one (container providers: the driver is the
     * host's). A VM boots the driver its image carries, so VM offers have none.
     */
    cudaVersion?: string,
    /** The platform's own record. */
    raw: TRaw,
};

export type OfferQuery = {
    /**
     * Machines with GPUs, without, or both (default 'any'). A GPU filter below
     * (vendor, gpus, minVramGb, gpuCount, minCudaVersion) matches no machine
     * without GPUs, so asking for one is asking for GPUs.
     */
    kind?: ComputeKind,
    vendor?: GpuVendor,
    /** Canonical model names to keep, e.g. ['L4', 'L40S']. */
    gpus?: string[],
    minVramGb?: number,
    /** Exactly this many GPUs. */
    gpuCount?: number,
    maxPricePerHour?: number,
    /** Also return offers with no stock right now (default false). */
    includeUnavailable?: boolean,
    /** Also return interruptible (spot / bid) offers (default false). */
    includeInterruptible?: boolean,
    /**
     * Only hosts whose driver runs at least this CUDA version, as 'major.minor'
     * (e.g. '12.8'): what a CUDA image needs of a machine it does not install
     * the driver on. Applies on container providers (`capabilities.compute.kind`
     * 'container'), whose hosts come with their driver; a VM runs the driver of
     * the image it boots, so VM offers are not filtered by it. AMD offers are
     * left out either way.
     */
    minCudaVersion?: string,
};

export type ServerListOptions = {
    /** Servers with GPUs, without, or both (default 'any'). */
    kind?: ComputeKind,
};

export type ServerStatus = 'pending' | 'running' | 'stopping' | 'stopped' | 'terminating' | 'terminated' | 'error' | 'unknown';

export type ServerPort = {
    privatePort: number,
    publicPort?: number,
    ip?: string,
    /** 'tcp', 'udp' or 'http'. */
    protocol: string,
};

/** A server; its addresses are named as in CreatedServerData. */
export type Server<TRaw = unknown> = {
    /** The provider's `id`. */
    provider: string,
    id: string,
    name: string,
    status: ServerStatus,
    /** The platform's own status word(s). */
    providerStatus: string,
    offerId?: string,
    /** Canonical GPU model name; undefined for a server without GPUs. */
    gpu?: string,
    gpuCount?: number,
    region?: string,
    ip?: string,
    ipv6?: string,
    privateIp?: string,
    ports?: ServerPort[],
    /** USD per hour while it runs (all its GPUs), when the provider reports it. */
    pricePerHour?: number,
    /**
     * Epoch ms when its provider began billing the current run at
     * `pricePerHour`, when the provider reports it: what a cost estimate counts
     * from. DigitalOcean bills a droplet from creation to deletion, stopped or
     * not; RunPod from the pod's last start; Lambda from when the instance first
     * passed its health checks; Scaleway from its last change of state (an edit
     * moves it too, so it may be later than the power-on). Vast reports only the
     * rental's start, which a stop and start does not move: after one, an
     * estimate from it is an upper bound. Undefined while nothing bills at that
     * rate (a stopped pod or instance bills only its disk).
     */
    billingStartedAt?: number,
    /** How its time is billed. */
    billing?: Billing,
    /** Its sshd, once it has one: `SSHService.connect({ ...server.ssh, privateKey })`. */
    ssh?: SSHEndpoint,
    /** The volumes mounted on it (CreateServerOptions.mounts), where the platform reports them. */
    mounts?: ServerMount[],
    /** Epoch ms. */
    createdAt?: number,
    /** The platform's own record. */
    raw: TRaw,
};

/** A volume a server has mounted: its id, and where the server sees it when the platform says. */
export type ServerMount = { volumeId: string, path?: string };

/** What every platform's createServer takes: what to rent, where, and what it boots. */
export type CreateServerBase = {
    name: string,
    /**
     * What to rent: an offer from this provider's listOffers(), whose region, GPU
     * count and (interruptible) bid come with it; or an offer's `id`.
     */
    offer: Offer<any> | string,
    /**
     * A region / data center from the offer's `regions`, or a REGION_TYPES
     * member the provider maps onto one of its own. Default: the offer's first
     * region with stock (an id string carries none: VM providers then need this).
     */
    region?: string | REGION_TYPES,
    /**
     * GPUs per server. Default: the offer's own count. Only a provider whose offers
     * let the count vary (RunPod) takes another; elsewhere it must equal the offer's.
     */
    gpuCount?: number,
    /**
     * VM: an OS image slug or id (default: the provider's image for the offer: its
     * GPU-ready image for a GPU, plain Ubuntu otherwise), or a MACHINE_TYPES member
     * the provider maps onto its own. Container: an image reference.
     */
    image?: string | MACHINE_TYPES,
    /**
     * Container: place the server only on a host whose driver runs at least
     * this CUDA version ('major.minor'). An offer that stands for many machines
     * (RunPod's GPU types) is placed by it; an offer that is one machine
     * (Vast) is checked before it is rented (CapacityError when below). A VM
     * runs its image's driver: nothing to place by, so VM providers ignore it.
     */
    minCudaVersion?: string,
};

/**
 * The createServer options some platforms cannot honor. A platform's own
 * CreateServerOptions leave out the ones it refuses (PlatformTypes.refused),
 * so an editor never offers them, and its createServer refuses them at run time.
 */
export type CreateServerExtras<T extends PlatformTypes = PlatformTypes> = {
    /**
     * Keys registered with the provider (listSSHKeys / addSSHKey) to authorize on
     * the server, by id: exactly these; an id the account does not hold is refused.
     */
    sshKeyIds?: Array<string | number>,
    /** VM: cloud-init user data, plain text. */
    userData?: string,
    /** Container: environment variables. */
    env?: Record<string, string>,
    /** Container: the command (Docker CMD); the image's ENTRYPOINT is kept. */
    command?: string[],
    /** Container: ports to expose, as '<port>/<tcp|udp|http>'. */
    ports?: string[],
    /** Container: the login for the private registry `image` is pulled from. */
    registryAuth?: RegistryAuth,
    /**
     * A container to run, on any provider: a container platform runs it as the
     * server (as `image`, `env`, `command`, `ports` and `registryAuth` do, which
     * it stands for: one or the other); a VM runs it with Docker, from cloud-init
     * at its first boot, as `asap-vps` (`docker logs asap-vps`), on its OS image
     * (`image`), its GPUs passed through.
     */
    container?: ContainerSpec,
    diskGb?: number,
    /** Container: a disk of its own that survives stopping the server (and goes with it). */
    volume?: { sizeGb: number, path: string },
    /**
     * Volumes of the account (IVolumes) to mount: each must be in the server's
     * region, and one a block device holds (a volume whose `shared` is false)
     * must not be mounted elsewhere. They outlive the server: deleteServer leaves them.
     */
    mounts?: Array<VolumeMount<T>>,
    tags?: string[],
};

/** The name of an option some platform cannot honor: what a platform's PlatformTypes.refused lists. */
export type RefusableOption = keyof CreateServerExtras;

/** The options `T` refuses, as RefusableOption names (none for the default PlatformTypes). */
type Refused<T extends PlatformTypes> = Extract<T['refused'], RefusableOption>;

/**
 * What createServer takes on a platform: what every platform takes, the options
 * this one honors (one it refuses is not in its type), and fields of its own
 * create request (`providerOptions`).
 */
export type CreateServerOptions<T extends PlatformTypes = PlatformTypes> = CreateServerBase & Omit<CreateServerExtras<T>, Refused<T>> & {
    /**
     * Fields merged into the platform's create request, as its API names them:
     * typed by the platform's request body (autocompleted per provider), and open
     * to fields its type does not list yet.
     */
    providerOptions?: Partial<T['createBody']> & Record<string, unknown>,
};

/**
 * A container to run on a server (CreateServerOptions.container): natively on
 * a container platform (RunPod, Vast), through cloud-init and Docker on a VM
 * (DigitalOcean, Scaleway, Lambda), which boots its OS image (`image`) first.
 */
export type ContainerSpec = {
    /** The image, a registry reference. */
    image: string,
    env?: Record<string, string>,
    /** The command (Docker CMD); the image's ENTRYPOINT is kept. */
    command?: string[],
    /** Ports to publish, as '<port>/<tcp|udp>' (on a VM, on the host's own). */
    ports?: string[],
    /** The login for the image's private registry. */
    registryAuth?: RegistryAuth,
};

/** The login for a private container registry, as `docker login` takes it (CreateServerOptions.registryAuth). */
export type RegistryAuth = {
    username: string,
    /** A password or an access token; a token that can only pull is enough. */
    password: string,
    /** The registry's host, e.g. 'ghcr.io' (default: the host the image reference names, else Docker Hub). */
    server?: string,
};

/** A volume of the account (IVolumes) to mount on a server being created, with what the platform takes besides it. */
export type VolumeMount<T extends PlatformTypes = PlatformTypes> = {
    /** A volume from listVolumes or createVolume, or its id. */
    volume: Volume<any> | string,
} & T['mount'];

/** Where a server sees a volume, on a platform that mounts one at a path of your choosing (`capabilities.volumes.<kind>.mount` 'path'). */
export type MountPath = {
    /** An absolute path in the server (default: the platform's own place for it, as the volume's `mountPath` says). */
    path?: string,
};

export type ImageStatus = 'pending' | 'available' | 'error' | 'unknown';

/** A bootable image of this account's own: pass its `id` as CreateServerOptions.image. */
export type ServerImage<TRaw = unknown> = {
    /** The provider's `id`. */
    provider: string,
    id: string,
    name: string,
    status: ImageStatus,
    /** The platform's own status word(s). */
    providerStatus: string,
    /** Where createServer can boot it; [] = anywhere (a global image). */
    regions: string[],
    sizeGb?: number,
    /** Epoch ms. */
    createdAt?: number,
    /** The platform's own record. */
    raw: TRaw,
};

/** A disk image file's format, as an image import reads it. */
export type DiskImageFormat = 'raw' | 'qcow2' | 'vhdx' | 'vdi' | 'vmdk';

/**
 * An image imported from a disk image file (IImageImport): the file at `url`
 * made bootable in `region`. It bills as the account's images do, until deleteImage.
 */
export type ImportImageOptions<T extends PlatformTypes = PlatformTypes> = {
    name: string,
    /** Where the file is: an http(s) URL anyone can read (no login), ending in the file's extension. */
    url: string,
    /** Where it boots: one region (IImageCopy adds more where the platform has it). */
    region: string | REGION_TYPES,
    /** Fields merged into the platform's import request, as its API names them (DigitalOcean: distribution, description, tags). */
    providerOptions?: Partial<T['imageImportBody']> & Record<string, unknown>,
} & WaitOptions;

// ── serverless ───────────────────────────────────────────────────────────

/** 'deploying': not taking requests yet; 'ready': taking them (a worker starts on demand); 'error': it cannot run. */
export type EndpointStatus = 'deploying' | 'ready' | 'deleting' | 'error' | 'unknown';

/**
 * A serverless endpoint (IServerless): one image the platform runs on demand
 * behind an HTTPS URL, from `minWorkers` copies (0: none, and no bill, while
 * it is idle) to `maxWorkers`, each billed while it runs. The image serves
 * plain HTTP on `port`: no platform SDK in it.
 */
export type Endpoint<TRaw = unknown> = {
    /** The provider's `id`. */
    provider: string,
    id: string,
    name: string,
    /** Where requests go, `${url}<path>`: requestEndpoint adds the auth it takes. */
    url: string,
    status: EndpointStatus,
    /** The platform's own status word(s). */
    providerStatus: string,
    image: string,
    /** The port the image serves HTTP on (given to it as PORT). */
    port: number,
    /** What each worker runs on: an offer of listEndpointOffers. */
    offerId?: string,
    /** Where its workers run, where the platform pins them. */
    region?: string,
    minWorkers: number,
    maxWorkers: number,
    /** Seconds an idle worker is kept before it is stopped, where the platform says. */
    idleTimeoutSeconds?: number,
    /** Requests need the account's auth (requestEndpoint adds it), or anyone may call it. */
    private: boolean,
    /** Epoch ms. */
    createdAt?: number,
    /** The platform's own record. */
    raw: TRaw,
};

/** What createEndpoint takes. */
export type CreateEndpointOptions<T extends PlatformTypes = PlatformTypes> = {
    name: string,
    /** The image and how it runs: env, command, a registry login where the platform takes one. It serves HTTP on `port`. */
    container: Omit<ContainerSpec, 'ports'>,
    /** The port it serves HTTP on: given to it as PORT. Default 80. */
    port?: number,
    /** What each worker runs on: an offer of listEndpointOffers, or its id. Default: the cheapest in stock. */
    offer?: Offer<T['endpointOffer']> | string,
    /** Where its workers run (a region, a data center), where the platform pins them. */
    region?: string | REGION_TYPES,
    /** Workers kept running when idle: default 0, none, and nothing billed. */
    minWorkers?: number,
    /** The most workers at once: default 1. */
    maxWorkers?: number,
    /** Seconds an idle worker is kept before it is stopped (the platform's default when absent). */
    idleTimeoutSeconds?: number,
    /** Fields merged into the platform's own create request, as its API names them. */
    providerOptions?: Partial<T['endpointBody']> & Record<string, unknown>,
} & WaitOptions;

/** What requestEndpoint takes besides fetch's own: how long to wait out a cold start. */
/** What requestEndpoint sends, and how long it waits out a cold start. A redirect is never followed (its answer is returned), so `redirect` is not one of them. */
export type EndpointRequestInit = Omit<RequestInit, 'redirect'> & WaitOptions;

// ── volumes ──────────────────────────────────────────────────────────────

/** 'available': it can be mounted; 'attached': a server has it (a block device is then mounted nowhere else). */
export type VolumeStatus = 'pending' | 'available' | 'attached' | 'deleting' | 'error' | 'unknown';

/**
 * Storage of the account's own that outlives the servers that mount it (a
 * network volume, a shared filesystem, a block volume): where model weights
 * and data stay between servers. A server mounts it when it is created
 * (CreateServerOptions.mounts).
 */
export type Volume<TRaw = unknown> = {
    /** The provider's `id`. */
    provider: string,
    id: string,
    name: string,
    /** Where it is: only a server in this region (zone, data center) can mount it. */
    region: string,
    /** A filesystem many servers mount at once (true), or a block device one server holds at a time. */
    shared: boolean,
    /** GB; undefined where it grows as it fills (Lambda's filesystems). */
    sizeGb?: number,
    status: VolumeStatus,
    /** The platform's own status word(s). */
    providerStatus: string,
    /** The servers it is attached to, where the platform says. */
    serverIds?: string[],
    /** Where a server sees it unless its mount says otherwise, where the platform decides that (Lambda: /lambda/nfs/<name>; DigitalOcean: /mnt/<name>). */
    mountPath?: string,
    /** Epoch ms. */
    createdAt?: number,
    /** The platform's own record. */
    raw: TRaw,
};

/**
 * What createVolume takes: a name, where, a size where the platform sizes
 * volumes, fields of the platform's own request, and how long to wait for the
 * volume where the platform makes it in the background (Scaleway).
 */
export type CreateVolumeOptions<T extends PlatformTypes = PlatformTypes> = {
    name: string,
    /** Where the servers that mount it will be: a region of an offer's `regions`, or a REGION_TYPES member the provider maps onto one of its own. */
    region: string | REGION_TYPES,
    /** Fields merged into the platform's volume create request, as its API names them. */
    providerOptions?: Partial<T['volumeBody']> & Record<string, unknown>,
} & T['volumeSize'] & T['volumeKind'] & WaitOptions;

/** On a platform that makes both kinds (`capabilities.volumes` has `block` and `shared`): which createVolume makes. */
export type VolumeKind = {
    /** A filesystem many servers mount at once; default false, a block device. */
    shared: boolean,
};

/** A volume's size, on a platform that sizes a volume when it is made (`capabilities.volumes.<kind>.size` 'fixed'). */
export type VolumeSize = {
    /** Whole GB, within the platform's own bounds (RunPod 10-4096, DigitalOcean 1-16384). */
    sizeGb: number,
};

export type WaitOptions = {
    /** Default 15 min. */
    timeoutMs?: number,
    /** Default 10 s. */
    intervalMs?: number,
};

/** What getServerLogs reads: the last `tail` lines (each provider caps it). */
export type LogOptions = {
    tail?: number,
};
