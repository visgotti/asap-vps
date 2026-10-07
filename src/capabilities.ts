// What a provider can do, as interfaces: one per capability. A provider class
// implements exactly the capabilities its platform has and declares them in
// its `capabilities` descriptor, whose keys name them and whose values say how
// each behaves there. The compiler holds the two together (ProviderCapabilities):
// a declared capability whose methods are missing does not compile, and a
// method a platform lacks is not on its class at all, so `lambda.stopServer`
// is a type error rather than a NotSupportedError at run time. Code that works
// on any provider asks `supports(p, 'power')`, which narrows `p` to one that has
// stopServer and startServer.
//
// Adding a capability (object storage, firewalls, ...): its
// interface here, its traits in CapabilityTraits, its interface in
// CapabilityInterfaces and its methods in CAPABILITY_METHODS; then the
// providers whose platforms have it implement it and declare it.

import { NotSupportedError } from './errors';
import type {
    CostEstimate, CreateEndpointOptions, CreateServerOptions, CreateVolumeOptions, DiskImageFormat, Endpoint, EndpointRequestInit, ImportImageOptions, InitializedSSHKeyData,
    LogOptions, Offer, OfferQuery, PlatformTypes, Server, ServerImage, ServerListOptions, Volume, WaitOptions,
} from './types';

// ── the capabilities ─────────────────────────────────────────────────────

/**
 * Servers: what can be rented (offers), and servers created, read, listed,
 * waited for and deleted. A VPS and a GPU server are both servers: an offer's
 * GPU fields say which it is.
 */
export interface ICompute<T extends PlatformTypes = PlatformTypes> {
    /** The provider's id: what its offers, servers and errors report. */
    readonly id: string;
    /** What can be rented, with price and where it can be created now. Cheapest first. */
    listOffers(query?: OfferQuery): Promise<Offer<T['offer']>[]>;
    /**
     * Asks the provider for a server and returns at once, usually `pending`
     * (waitUntilRunning waits). Throws CapacityError when this offer or region
     * has no stock right now. An option the provider cannot honor is refused
     * (NotSupportedError) before anything is rented, never dropped.
     */
    createServer(options: CreateServerOptions<T>): Promise<Server<T['server']>>;
    /** null when the provider has no such server. */
    getServer(id: string): Promise<Server<T['server']> | null>;
    /** The account's servers, every one of them (other people's included): pick yours by name. */
    listServers(options?: ServerListOptions): Promise<Server<T['server']>[]>;
    /**
     * Idempotent: deleting a server that is already gone succeeds. A provider
     * whose delete waits (Scaleway deletes the server's volumes as they come
     * free) waits for at most `o.timeoutMs`.
     */
    deleteServer(id: string, o?: WaitOptions): Promise<void>;
    /** Poll getServer until `done` accepts what it read (a server, or null once it is gone). */
    waitForServer(id: string, done: (s: Server<T['server']> | null) => boolean, o?: WaitOptions): Promise<Server<T['server']> | null>;
    /** Until the server is running (a VM also needs its public address); throws when it errors or disappears instead. */
    waitUntilRunning(id: string, o?: WaitOptions & { requireIp?: boolean }): Promise<Server<T['server']>>;
    /** Delete, and keep asking until the provider says it is gone: true only when verified. */
    deleteServerAndWait(id: string, o?: WaitOptions): Promise<boolean>;
    /** What the server's current run has cost so far, from its rate and billing start; null when the provider reports neither. */
    getServerCost(id: string, at?: number): Promise<CostEstimate | null>;
}

/** Power a server off and on again, keeping it. */
export interface IPower {
    stopServer(id: string): Promise<void>;
    startServer(id: string): Promise<void>;
}

/** Reboot a server. */
export interface IRestart {
    restartServer(id: string): Promise<void>;
}

/** A container server's recent output. */
export interface ILogs {
    getServerLogs(id: string, o?: LogOptions): Promise<string>;
}

/** SSH keys registered with the account, to authorize on servers (CreateServerOptions.sshKeyIds). */
export interface ISSHKeys {
    listSSHKeys(): Promise<InitializedSSHKeyData[]>;
    /**
     * Register a public key with the account, or return the account's existing
     * registration of the same key (matched by fingerprint, whatever its name):
     * safe to call on every run.
     */
    addSSHKey(publicKey: string, keyName: string): Promise<InitializedSSHKeyData>;
    /** true when the key was deleted, false when the account did not hold it (already gone). */
    deleteSSHKey(id: string | number): Promise<boolean>;
}

/** Images of a server's disk, to boot new servers from (CreateServerOptions.image). */
export interface IImages<T extends PlatformTypes = PlatformTypes> {
    /**
     * The account's own images (snapshots, captured disks), every one of them:
     * the account may hold images that are not yours to boot or delete, so pick
     * yours by name.
     */
    listImages(): Promise<ServerImage<T['image']>[]>;
    /** null when the provider has no such image. */
    getImage(id: string): Promise<ServerImage<T['image']> | null>;
    /**
     * Capture a server's disk as a bootable image, and wait until it is
     * available (minutes for tens of GB). The server keeps its state: stop it
     * first when the image must be consistent. With `capabilities.images.scope`
     * 'region' the image boots only in the server's region (until IImageCopy adds more).
     */
    createImage(serverId: string, o: { name: string } & WaitOptions): Promise<ServerImage<T['image']>>;
    /** Idempotent: deleting an image that is already gone succeeds. */
    deleteImage(id: string): Promise<void>;
}

/**
 * Import a disk image file as an image of the account's own (IImages: listed,
 * booted and deleted like a captured one): a machine image built elsewhere
 * (Packer, a distribution's cloud image), from a URL.
 */
export interface IImageImport<T extends PlatformTypes = PlatformTypes> {
    /**
     * The image made from the file at `url`, in `region`, once it can boot a
     * server (minutes to an hour: the platform fetches and converts it; default
     * wait 1 h). A file the platform cannot read is an error, and so is a wait
     * that runs out: either way the import is deleted, and nothing is left billing.
     */
    importImage(options: ImportImageOptions<T>): Promise<ServerImage<T['image']>>;
}

/**
 * Serverless endpoints: an image the platform runs on demand behind one HTTPS
 * URL, from zero workers (nothing billed while idle) to a cap. The image
 * serves plain HTTP on its port: no platform SDK in it.
 */
export interface IServerless<T extends PlatformTypes = PlatformTypes> {
    /** What a worker can run on, priced per hour while it runs (the serverless price), cheapest first; in stock unless the query says otherwise. */
    listEndpointOffers(query?: OfferQuery): Promise<Offer<T['endpointOffer']>[]>;
    /** The account's endpoints. */
    listEndpoints(): Promise<Endpoint<T['endpoint']>[]>;
    /** null when the account has no such endpoint. */
    getEndpoint(id: string): Promise<Endpoint<T['endpoint']> | null>;
    /** The endpoint, once it takes requests ('ready'): a request starts a worker where none runs. */
    createEndpoint(options: CreateEndpointOptions<T>): Promise<Endpoint<T['endpoint']>>;
    /** Deletes it and stops its workers, and waits until it is gone where the platform deletes it in the background; one gone already is no error. */
    deleteEndpoint(id: string, o?: WaitOptions): Promise<void>;
    /**
     * A request to `path` under its URL, with the auth it takes (sent to the
     * platform's own host only: a redirect is not followed, its answer is
     * returned). A cold start is waited out: while no worker answers yet, the
     * request is sent again, until `timeoutMs` (default 5 min).
     */
    requestEndpoint(endpoint: Endpoint | string, path: string, init?: EndpointRequestInit): Promise<Response>;
}

/** Make a region-bound image bootable in more regions. */
export interface IImageCopy<T extends PlatformTypes = PlatformTypes> {
    /** Copies the image to every region it is not in yet, and waits until it is in all of them. */
    copyImage(id: string, regions: string[], o?: WaitOptions): Promise<ServerImage<T['image']>>;
}

/**
 * Volumes: storage of the account's own that outlives the servers that mount it
 * (a network volume, a shared filesystem, a block volume), where model weights
 * and data stay between servers. A server mounts them when it is created
 * (CreateServerOptions.mounts), and deleteServer leaves them.
 */
export interface IVolumes<T extends PlatformTypes = PlatformTypes> {
    /**
     * The account's volumes, every one of them: the account may hold volumes
     * that are not yours to mount or delete, so pick yours by name.
     */
    listVolumes(): Promise<Volume<T['volume']>[]>;
    /** null when the provider has no such volume. */
    getVolume(id: string): Promise<Volume<T['volume']> | null>;
    /** An empty volume in `region`, once it can be mounted. It bills until deleteVolume, mounted or not. */
    createVolume(options: CreateVolumeOptions<T>): Promise<Volume<T['volume']>>;
    /**
     * Deletes the volume and its data, and waits until it is gone where the
     * platform deletes it in the background (a shared filesystem: `o`).
     * Idempotent: deleting a volume that is already gone succeeds. One a server
     * still holds is refused: delete the server first.
     */
    deleteVolume(id: string, o?: WaitOptions): Promise<void>;
}

/**
 * Attach a volume (IVolumes) to a server that runs, and detach it again,
 * without recreating the server. What the server's OS sees is as at create:
 * `capabilities.volumes.<kind>.mount` says whether it mounts the volume itself.
 */
export interface IVolumeAttach {
    /**
     * Attaches the volume, which must be in the server's region and, where it
     * is a block device, held by no other server; waits until it is attached.
     * Attaching a volume the server holds already succeeds. Like a volume it
     * was created with, it outlives the server: deleteServer leaves it.
     */
    attachVolume(volumeId: string, serverId: string, o?: WaitOptions): Promise<void>;
    /** Detaches it, and waits until it is free. Idempotent: a volume the server does not hold is left as it is. */
    detachVolume(volumeId: string, serverId: string, o?: WaitOptions): Promise<void>;
}

// ── how each capability behaves on a platform ────────────────────────────

export type ComputeTraits = {
    /** A VM boots an OS image (set up over SSH, cloud-init); a container runs a registry image on the host's driver. */
    kind: 'vm' | 'container',
    /** It rents machines with GPUs. */
    gpu: boolean,
    /** It rents machines without GPUs (a VPS). */
    cpu: boolean,
    /** createServer takes userData (cloud-init). */
    userData: boolean,
    /** listOffers reflects what can be created right now. */
    liveAvailability: boolean,
};

export type PowerTraits = {
    /** What a stopped server bills: its disk only, or as if running. */
    stoppedBilling: 'storage' | 'full',
};

export type SSHKeyTraits = {
    /**
     * The provider applies the account's registered keys to a server at every
     * boot, not only when it is created (Scaleway: a Project's keys, read at each
     * boot): a key deleted from the account is gone from the server at its next
     * reboot, stop/start or power-on, and the login is lost. So the key a
     * provisioner registered must stay registered while its server is used
     * (ServerProvisioner keeps it unless told to clean it up), and the caller
     * deletes it, with deleteSSHKey(providerSshKeyId), once it has deleted the
     * server. The side effect: the key is authorized on every server of the
     * account's Project that boots meanwhile, not only on its own. false: keys
     * are applied at creation only (DigitalOcean, Lambda), and deleting one
     * afterwards does not affect running servers.
     */
    appliedAtBoot: boolean,
};

export type ImageTraits = {
    /** 'region': an image boots only in the regions it is in; 'global': anywhere. */
    scope: 'region' | 'global',
};

export type ServerlessTraits = {
    /** Workers with GPUs can be asked for (an offer with a GPU). */
    gpu: boolean,
    /** Workers without GPUs can be asked for. */
    cpu: boolean,
    /** It takes `container.registryAuth` for a private image. */
    registryAuth: boolean,
};

export type ImageImportTraits = {
    /** The file formats it reads. */
    formats: readonly DiskImageFormat[],
    /** Compressions it reads the file in, besides none. */
    compressions: readonly ('gzip' | 'bzip2')[],
    /** The largest file it takes, uncompressed (GB). */
    maxGb: number,
};

/** How one kind of volume behaves on a platform. */
export type VolumeKindTraits = {
    /**
     * How a server sees it: mounted at the mount's `path` ('path', default the
     * volume's `mountPath`); mounted by the platform at its own path, the
     * volume's `mountPath` ('auto'); or as a disk the server formats and mounts
     * itself ('device').
     */
    mount: 'path' | 'auto' | 'device',
    /** 'fixed': sized when it is made (CreateVolumeOptions.sizeGb, within minGb-maxGb); 'elastic': it grows as it fills. */
    size: 'fixed' | 'elastic',
    /** The smallest it is made, where it is sized (GB). */
    minGb?: number,
    /** The largest it is made, where the platform says (GB). */
    maxGb?: number,
};

/**
 * The volumes a platform makes, by kind: `block`, a block device one server
 * holds at a time; `shared`, a filesystem many servers mount at once. Where it
 * makes both, createVolume's `shared` picks (default: block).
 */
export type VolumeTraits =
    | { block: VolumeKindTraits, shared?: VolumeKindTraits }
    | { block?: VolumeKindTraits, shared: VolumeKindTraits };

/** Each capability's facts on a platform: what its `capabilities` descriptor holds under that capability's name. */
export type CapabilityTraits = {
    compute: ComputeTraits,
    power: PowerTraits,
    restart: {},
    logs: {},
    sshKeys: SSHKeyTraits,
    images: ImageTraits,
    imageCopy: {},
    imageImport: ImageImportTraits,
    volumes: VolumeTraits,
    volumeAttach: {},
    serverless: ServerlessTraits,
};

export type CapabilityName = keyof CapabilityTraits;

/** What a provider can do (its keys) and how (its values): a provider's `capabilities`. */
export type CapabilityDescriptor = { readonly [K in CapabilityName]?: Readonly<CapabilityTraits[K]> };

/** The interface each capability name stands for, on a platform's types. */
export interface CapabilityInterfaces<T extends PlatformTypes = PlatformTypes> {
    compute: ICompute<T>;
    power: IPower;
    restart: IRestart;
    logs: ILogs;
    sshKeys: ISSHKeys;
    images: IImages<T>;
    imageCopy: IImageCopy<T>;
    imageImport: IImageImport<T>;
    volumes: IVolumes<T>;
    volumeAttach: IVolumeAttach;
    serverless: IServerless<T>;
}

/** The methods each capability adds: a provider declaring it has them all, one not declaring it has none. */
export const CAPABILITY_METHODS = Object.freeze({
    compute: ['listOffers', 'createServer', 'getServer', 'listServers', 'deleteServer', 'waitForServer', 'waitUntilRunning', 'deleteServerAndWait', 'getServerCost'],
    power: ['stopServer', 'startServer'],
    restart: ['restartServer'],
    logs: ['getServerLogs'],
    sshKeys: ['listSSHKeys', 'addSSHKey', 'deleteSSHKey'],
    images: ['listImages', 'getImage', 'createImage', 'deleteImage'],
    imageCopy: ['copyImage'],
    imageImport: ['importImage'],
    volumes: ['listVolumes', 'getVolume', 'createVolume', 'deleteVolume'],
    volumeAttach: ['attachVolume', 'detachVolume'],
    serverless: ['listEndpointOffers', 'listEndpoints', 'getEndpoint', 'createEndpoint', 'deleteEndpoint', 'requestEndpoint'],
} as const satisfies { readonly [K in CapabilityName]: ReadonlyArray<keyof CapabilityInterfaces[K]> });

type UnionToIntersection<U> = (U extends unknown ? (x: U) => void : never) extends (x: infer I) => void ? I : never;

/**
 * Every interface a descriptor declares, as one type: what a provider class
 * `implements`, so that declaring a capability without its methods does not compile.
 *
 *     const CAPABILITIES = { compute: {...}, power: {...} } as const satisfies CapabilityDescriptor;
 *     class Acme extends ComputeProvider<AcmeTypes> implements ProviderCapabilities<AcmeTypes, typeof CAPABILITIES> { ... }
 */
export type ProviderCapabilities<T extends PlatformTypes, D extends CapabilityDescriptor> =
    UnionToIntersection<{ [K in keyof D & CapabilityName]: CapabilityInterfaces<T>[K] }[keyof D & CapabilityName]>;

/** Anything that says what it can do: every provider. */
export interface Capable {
    readonly id: string;
    readonly capabilities: CapabilityDescriptor;
}

/** The platform types a provider was written for (its ICompute's), else the defaults. */
export type TypesOf<P> = P extends ICompute<infer T> ? T : PlatformTypes;

/** `P`, known to have capability `C`: its methods, and its traits in `capabilities`. */
export type With<P, C extends CapabilityName> = P & CapabilityInterfaces<TypesOf<P>>[C] & { readonly capabilities: { readonly [K in C]: Readonly<CapabilityTraits[K]> } };

/** Whether `p` has capability `c`; when it does, `p` is typed with that capability's methods and traits. */
export function supports<P extends Capable, C extends CapabilityName>(p: P, c: C): p is With<P, C> {
    return p.capabilities[c] !== undefined;
}

/** `p` with capability `c`, or NotSupportedError naming what it lacks. */
export function requireCapability<P extends Capable, C extends CapabilityName>(p: P, c: C): With<P, C> {
    if (!supports(p, c)) throw new NotSupportedError(p.id, `the "${c}" capability (${CAPABILITY_METHODS[c].join(', ')})`);
    return p;
}

/** The capability names a descriptor declares, in CAPABILITY_METHODS order. */
export function capabilityNames(d: CapabilityDescriptor): CapabilityName[] {
    return (Object.keys(CAPABILITY_METHODS) as CapabilityName[]).filter((c) => d[c] !== undefined);
}
