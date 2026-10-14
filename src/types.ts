import { COMPUTE_KINDS, COUNTRY_TYPES, CUDA_TYPES, GPU_VENDORS, MACHINE_TYPES, PLATFORM, PlatformFamily, REGION_TYPES } from "./constants";
import type { NodeSSH } from 'node-ssh';
import type { Sleep } from './Core/utils/async';
import type { GpuName } from './Core/utils/gpus';
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

/** Where a server's sshd listens, and as whom to log in: what RemoteMachine.connect reads from a server. A container's is its host's address and the port mapped to its 22. */
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
    /**
     * Its pick of the library's regions: the REGION_TYPES members it has a
     * place for, which are the ones its translation table (EnumTranslations.regions)
     * turns into its own names, and the only ones its `region` options take:
     * a member it has not is a compile error. `never` where it has none. The
     * default is every member: code typed for any provider (ICompute) takes
     * them all, and a provider refuses at run time (NotSupportedError) one it
     * does not have.
     */
    region: REGION_TYPES;
    /**
     * Its own names for its places: what its records say (an offer's
     * `regions`, a server's `region`), and what its `region` options take
     * besides its pick of the library's. A list where its places are known
     * (Scaleway's zones), else a pattern of them (DigitalOcean's `tor1`,
     * RunPod's `US-TX-3`): never one a name of the library's matches, so a
     * library region it has not cannot pass for one of its own (the suite
     * holds every provider to that). Any string by default.
     */
    regionName: string;
    /**
     * Its pick of the library's countries: the COUNTRY_TYPES members it has
     * places in, as its reference data has them (its places.ts). Every one by
     * default, and on a marketplace (Vast), whose machines can be anywhere. It
     * says where a platform is; a query's `countries` is a question, and takes
     * any country on every platform.
     */
    country: COUNTRY_TYPES;
}

/** A member of one of the library's enums, or the string it stands for: `REGION_TYPES.FRANCE_PARIS` or `'france_paris'`. */
type Named<E extends string> = E | `${E}`;

/**
 * Where, as a platform's `region` options take it: a region of the library's
 * that the platform has (a REGION_TYPES member or its value, translated into
 * the platform's own name), or the platform's own name for a place (what an
 * offer's `regions` lists, a server's `region` says). Nothing else: a library
 * region the platform does not have is a compile error, and so is a name of no
 * place of its (a string read from a flag is checked first, or asked through
 * code typed for any provider). Code typed for any provider takes every
 * library region and any string, and a platform refuses at run time
 * (NotSupportedError) a library region it does not have, before anything is made.
 */
export type RegionChoice<T extends PlatformTypes = PlatformTypes> = Named<T['region']> | OwnRegionName<T>;

/** A platform's own names for its places, as an option takes them; for code typed for any provider, any string. */
type OwnRegionName<T extends PlatformTypes> = string extends T['regionName'] ? AnyString : T['regionName'];

/** Any string, which an editor still offers the library's names beside (plain `string` would swallow them; this must stay its own alias). */
type AnyString = string & {};


// ── compute: offers, servers, images ─────────────────────────────────────
// The shapes every compute provider (ICompute) maps its platform's API onto,
// so offers are compared, and servers created, read, stopped and deleted, the
// same way on every provider, whatever they rent: a VPS is a server whose
// offer has no GPU.

/** Who makes a machine's GPUs: one of GPU_VENDORS. */
export type GpuVendor = (typeof GPU_VENDORS)[number];

/**
 * Which offers or servers: those with GPUs, those without, or both (the
 * default). One of COMPUTE_KINDS, the same on every provider; anything else is
 * a compile error, and refused at run time where the compiler did not see it.
 */
export type ComputeKind = (typeof COMPUTE_KINDS)[number];

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

/**
 * Something you can rent: a machine type (its GPUs, if any), its price, and
 * where it can be created now. `TRegion`: the platform's own names for its
 * places (PlatformTypes.regionName), which its `region` options take back.
 */
export type Offer<TRaw = unknown, TRegion extends string = string> = {
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
    /** Where it can be created right now, by the provider's own names for its places (what `region` takes); [] = no stock anywhere. */
    regions: TRegion[],
    /** `regions`, each with the country it is in where the provider says: what OfferQuery.countries narrows by, the same on every provider. */
    locations?: Array<Location<TRegion>>,
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
    /**
     * Canonical model names to keep, e.g. ['L4', 'L40S']: the names asap-vps
     * has (GpuName), the same on every provider. A model it has no name for
     * goes by the provider's own, as its offers' `gpu` says.
     */
    gpus?: Array<GpuName | (string & {})>,
    minVramGb?: number,
    /** Exactly this many GPUs. */
    gpuCount?: number,
    maxPricePerHour?: number,
    /**
     * Only offers with stock in one of these countries, their `regions`
     * narrowed to the ones there: the same on every provider, whatever it
     * calls its places. A country is its ISO 3166-1 alpha-2 code, and
     * COUNTRY_TYPES has every code ISO gives a country: nothing else passes
     * ('UK' is no country's: the United Kingdom's is GB). An offer in stock
     * nowhere is in no country. The list is the places allowed:
     * an empty one allows none (no offer), and only leaving it out allows any.
     * A question, fair to ask of any provider: one with no place in a country
     * lists nothing, and that is no error (PlatformTypes.country says where
     * each has places).
     */
    countries?: Array<Named<COUNTRY_TYPES>>,
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

/**
 * A place a provider has machines in: its own name for it (a region, a zone,
 * a data center; what `region` takes), and the country it is in (ISO 3166-1
 * alpha-2: 'US', 'FR'), where the provider's name or record says.
 */
export type Location<TRegion extends string = string> = {
    region: TRegion,
    /** The country it is in, where the provider says: one ISO 3166-1 gives a code (COUNTRY_TYPES). */
    country?: Named<COUNTRY_TYPES>,
};

export type ServerStatus = 'pending' | 'running' | 'stopping' | 'stopped' | 'terminating' | 'terminated' | 'error' | 'unknown';

/** How a port is exposed: 'http' is a container platform's proxied port (RunPod), plain TCP anywhere else. */
export type PortProtocol = 'tcp' | 'udp' | 'http';

export type ServerPort = {
    privatePort: number,
    publicPort?: number,
    ip?: string,
    /** A PortProtocol, or the platform's own word where it reports another. */
    protocol: PortProtocol | (string & {}),
};

/** A server; its addresses are named as in CreatedServerData, its place by the platform's own name for it (`TRegion`). */
export type Server<TRaw = unknown, TRegion extends string = string> = {
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
    region?: TRegion,
    /** The country `region` is in, where the provider says: one ISO 3166-1 gives a code (COUNTRY_TYPES). */
    country?: Named<COUNTRY_TYPES>,
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
export type CreateServerBase<T extends PlatformTypes = PlatformTypes> = {
    name: string,
    /**
     * What to rent: an offer from this provider's listOffers(), whose region, GPU
     * count and (interruptible) bid come with it; or an offer's `id`.
     */
    offer: Offer<any> | string,
    /**
     * A region / data center from the offer's `regions`, or a REGION_TYPES
     * member the provider maps onto one of its own (RegionChoice). Default: the
     * offer's first region with stock (an id string carries none: VM providers
     * then need this).
     */
    region?: RegionChoice<T>,
    /**
     * GPUs per server. Default: the offer's own count. Only a provider whose offers
     * let the count vary (RunPod) takes another; elsewhere it must equal the offer's.
     */
    gpuCount?: number,
    /**
     * What it boots, by the library's names, the same on every provider: a
     * MACHINE_TYPES member (that Ubuntu), or `{ os, cuda }` (that Ubuntu, for
     * a machine that runs CUDA software: ImageSpec). Or by a name of the
     * platform's own. VM: an OS image slug or id, or an image of the account's
     * (listImages); default: the provider's image for the offer, its GPU image
     * for a GPU, plain Ubuntu otherwise. Container: a registry reference.
     */
    image?: ImageChoice,
    /**
     * Container: place the server only on a host whose driver runs at least
     * this CUDA version ('major.minor'); default: the version its image is
     * asked for by (`image: { os, cuda }`). An offer that stands for many
     * machines (RunPod's GPU types) is placed by it; an offer that is one
     * machine (Vast) is checked before it is rented (CapacityError when below).
     * A VM runs its image's driver: nothing to place by, so VM providers ignore it.
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
     * Keys registered with the provider (listSSHKeys / addSSHKey) that log in to
     * the server, by id (or name, fingerprint or public key); one the account
     * does not hold is refused. The same on every provider: each key named logs
     * in at the endpoint the running server reports (`ssh`), as RemoteMachine
     * does. On a VM the platform installs them; in a container the library
     * starts an SSH server ahead of its command, which an image of the caller's
     * own must therefore name (`command`). Where the account's other keys log in
     * besides, `capabilities.sshKeys.atCreate` says so ('account').
     */
    sshKeyIds?: Array<string | number>,
    /** VM: cloud-init user data, plain text. */
    userData?: string,
    /** Container: environment variables. */
    env?: Record<string, string>,
    /**
     * Container: the command (Docker CMD); the image's ENTRYPOINT is kept. With
     * `sshKeyIds` on a container platform it is the whole command line: the SSH
     * server's start takes the entrypoint's place and then runs the command.
     */
    command?: string[],
    /** Container: ports to expose, as '<port>/<tcp|udp|http>' (a bare port is tcp; 'http' is a proxied port on RunPod, plain TCP elsewhere), 1-65535. */
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
export type CreateServerOptions<T extends PlatformTypes = PlatformTypes> = CreateServerBase<T> & Omit<CreateServerExtras<T>, Refused<T>> & {
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
    /** The image: a registry reference, or one Docker Hub has by the library's names (a MACHINE_TYPES member: `ubuntu`; `{ os, cuda }`: `nvidia/cuda`). */
    image: ImageChoice,
    env?: Record<string, string>,
    /** The command (Docker CMD); the image's ENTRYPOINT is kept. */
    command?: string[],
    /** Ports to publish, as '<port>/<tcp|udp|http>' (a bare port is tcp; on a VM, each on the host's own, 'http' as tcp), 1-65535. */
    ports?: string[],
    /** The login for the image's private registry. */
    registryAuth?: RegistryAuth,
};

/**
 * An image by the library's names, the same on every provider: an Ubuntu,
 * and with `cuda`, that Ubuntu for a machine that runs CUDA software.
 *
 * A container runs Docker Hub's `ubuntu:<release>`, or NVIDIA's
 * `nvidia/cuda:<version>-base-ubuntu<release>` (the newest patch of that
 * CUDA version), on a host whose driver runs that version (minCudaVersion
 * defaults to it). Given no command it runs `sleep infinity`, so it stays up
 * as a VM does: those images' own command, a shell, exits at once.
 *
 * A VM boots the provider's plain image of that Ubuntu, or, with `cuda`, its
 * GPU image of it: the one with the NVIDIA driver, which is what CUDA
 * software needs of the machine. What else that image carries is the
 * provider's (DigitalOcean's the CUDA toolkit, Lambda's CUDA and the
 * frameworks, Scaleway's Docker with NVIDIA's runtime, CUDA coming in the
 * containers it runs), and so is its driver: the version asked for picks
 * nothing there, and is not checked.
 *
 * What no image exists for is refused (NotSupportedError), never sent as it
 * is: a CUDA version NVIDIA does not publish for that Ubuntu, an Ubuntu a
 * provider has no image of, a provider's GPU image on a machine it does not
 * boot. A spec that is not well formed (a typo) is a ProviderError.
 */
export type ImageSpec = {
    os: MACHINE_TYPES | `${MACHINE_TYPES}`,
    cuda?: CUDA_TYPES | `${CUDA_TYPES}`,
};

/** What an `image` may be: a MACHINE_TYPES member, an ImageSpec, or the platform's own name for one (a slug, an id, a registry reference). */
export type ImageChoice = string | MACHINE_TYPES | ImageSpec;

/** A container as it runs: its image as a registry reference (resolveContainer). */
export type ResolvedContainer = Omit<ContainerSpec, 'image'> & { image: string };

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
export type ServerImage<TRaw = unknown, TRegion extends string = string> = {
    /** The provider's `id`. */
    provider: string,
    id: string,
    name: string,
    status: ImageStatus,
    /** The platform's own status word(s). */
    providerStatus: string,
    /** Where createServer can boot it; [] = anywhere (a global image). */
    regions: TRegion[],
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
    region: RegionChoice<T>,
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
export type Endpoint<TRaw = unknown, TRegion extends string = string> = {
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
    region?: TRegion,
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
    region?: RegionChoice<T>,
    /** Workers kept running when idle: default 0, none, and nothing billed. */
    minWorkers?: number,
    /** The most workers at once: default 1. */
    maxWorkers?: number,
    /** Seconds an idle worker is kept before it is stopped (the platform's default when absent). */
    idleTimeoutSeconds?: number,
    /**
     * GPU workers only on hosts whose driver runs at least this CUDA version
     * ('major.minor'), as CreateServerOptions.minCudaVersion places a server;
     * default: the version the image is asked for by (`{ os, cuda }`). A
     * platform whose workers have no GPU refuses it.
     */
    minCudaVersion?: string,
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
export type Volume<TRaw = unknown, TRegion extends string = string> = {
    /** The provider's `id`. */
    provider: string,
    id: string,
    name: string,
    /** Where it is: only a server in this region (zone, data center) can mount it. */
    region: TRegion,
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
    region: RegionChoice<T>,
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
