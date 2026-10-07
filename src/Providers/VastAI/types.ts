// The parts of Vast.ai's API objects the VastAI provider reads and sends
// (https://docs.vast.ai/api-reference/openapi.yaml, read 2026-09-29 and
// 2026-10-06), and VastTypes, which types its records and create options by them.

import type { MountPath, ProviderParams, VolumeSize } from '../../types';
import type { VAST_REFUSED } from './mappers';

export type VastAIParams = ProviderParams & {
    /** Machines below this reliability score are not offered (default 0.95). */
    minReliability?: number,
    /** Only machines Vast has verified (default true). */
    verifiedOnly?: boolean,
    /** Only machines whose driver runs at least this CUDA version, e.g. 12.8, where a query sets none. */
    minCudaVersion?: number,
    /** Offer pages of 64 read per search, cheapest first (default 8: 512 offers). */
    offerPages?: number,
    /**
     * Where createImage pushes a snapshot of an instance (Vast keeps no images:
     * it commits the container and pushes it to a registry of yours): a
     * repository and a login that can push to it. Its tags are the account's
     * images, and an instance boots one with this login.
     */
    snapshots?: VastSnapshotRepository,
};

/** A repository of yours that snapshots are pushed to (VastAIParams.snapshots). */
export type VastSnapshotRepository = {
    /** The registry's host: 'ghcr.io', 'docker.io', 'rg.fr-par.scw.cloud'... */
    server: string,
    /** The repository in it: 'acme/snapshots'. */
    repository: string,
    username: string,
    /** A password or token that can push and pull. */
    password: string,
};

/** An image: a snapshot an instance pushed, a tag of the snapshot repository. */
export type VastImage = {
    /** `<server>/<repository>:<tag>`: what createServer boots. */
    reference: string,
    tag: string,
    /** Its manifest's digest, where the manifest was read. */
    digest?: string,
    /** Its layers' size (compressed), bytes, where the manifest was read. */
    size?: number,
};

export type VastOffer = {
    /** The ask id a create rents. */
    id: number,
    /** The same ask id: what the offer search filters by (a filter on `id` matches nothing). */
    ask_contract_id?: number,
    gpu_name?: string,
    num_gpus?: number,
    /** Per GPU, MB. */
    gpu_ram?: number,
    /** USD per hour for the whole offer (a bid search: the minimum bid plus storage). */
    dph_total: number,
    /** The least an interruptible rental of this machine may bid, USD per hour. */
    min_bid?: number,
    /** 'City, CC'. */
    geolocation?: string,
    rentable?: boolean,
    cuda_max_good?: number,
    reliability?: number,
    machine_id?: number,
    cpu_cores_effective?: number,
    /** MB. */
    cpu_ram?: number,
    /** GB. */
    disk_space?: number,
};

export type VastInstance = {
    id: number,
    label?: string | null,
    /** The container: 'running', 'loading', 'exited', 'created', 'offline', ... */
    actual_status?: string | null,
    intended_status?: string | null,
    /** The machine contract: 'running' or 'stopped'. */
    cur_state?: string | null,
    status_msg?: string | null,
    public_ipaddr?: string | null,
    geolocation?: string | null,
    gpu_name?: string | null,
    num_gpus?: number | null,
    dph_total?: number | null,
    /** Epoch seconds. */
    start_date?: number | null,
    machine_id?: number | null,
    ssh_host?: string | null,
    ssh_port?: number | null,
    /** Each open container port and the RANDOM public port it maps to: {"8080/tcp": [{HostIp, HostPort}]}. */
    ports?: Record<string, Array<{ HostIp?: string, HostPort?: string }> | null> | null,
    /** Its env as Vast keeps it: [name, value] pairs, a mounted volume among them as a docker flag, ["-v <volume name>:<path>", "1"] (observed 2026-10-06). */
    extra_env?: Array<[string, string]> | Record<string, string> | null,
    /**
     * The volumes it mounts: in the instance list (/api/v1/instances/) only, not
     * the single read (observed 2026-10-06). Each its id and name (`label`);
     * where it is mounted is in `extra_env`.
     */
    volume_info?: Array<{ id?: number | null, label?: string | null, type?: string | null, total_space?: number | null }> | null,
};

/**
 * A volume of the account (`GET /api/v0/volumes?owner=me&type=all_volume`):
 * storage on ONE machine (`type` 'machine'), mounted only by instances on that
 * machine, one at a time. It lives until deleted, or until its host's listing
 * ends (`end_date`). Observed 2026-10-06.
 */
export type VastVolume = {
    /** The volume's contract id: what deletes it and what a rental links. */
    id: number,
    /** Its name: letters, digits and underscores, at most 64. */
    label?: string | null,
    /** 'created' once it can be mounted. */
    status?: string | null,
    machine_id: number,
    host_id?: number | null,
    /** 'machine' (local); network volumes were withdrawn in July 2026. */
    type?: string | null,
    /** GB. */
    disk_space?: number | null,
    /** The instances that mount it. */
    instances?: Array<number | { id?: number | null }> | null,
    /** Epoch seconds, fractional. */
    start_date?: number | null,
    /** When its host's listing ends, and the volume with it (epoch seconds). */
    end_date?: number | null,
    geolocation?: string | null,
    /** USD per hour. */
    storage_total_cost?: number | null,
};

/** An offer of storage on a machine (`POST /api/v0/volumes/search/`): what createVolume rents a volume from. */
export type VastVolumeOffer = {
    /** The offer id a create sends. */
    id: number,
    machine_id: number,
    /** GB the machine has free for volumes. */
    disk_space: number,
    /** USD per GB-month. */
    storage_cost?: number,
    geolocation?: string,
    reliability?: number,
};

/** The body of `PUT /api/v0/volumes/`: a volume from an offer. */
export type VastCreateVolumeBody = {
    /** The volume offer's id. */
    id: number,
    /** GB, whole. */
    size: number,
    /** Letters, digits and underscores, at most 64. */
    name?: string,
};

/** A volume a rental mounts (`volume_info` of `PUT /api/v0/asks/{id}/`): one, an existing one linked (`create_new` false). */
export type VastVolumeInfo = {
    create_new: boolean,
    /** An existing volume's id (`create_new` false), or a volume offer's (true). */
    volume_id: number,
    mount_path: string,
    /** GB, a new volume's. */
    size?: number,
    name?: string,
};

export type VastSSHKeyData = { id: number, key?: string, public_key?: string, deleted_at?: string | null };

/** The body of `PUT /api/v0/asks/{id}/` (renting an offer's machine): what CreateServerOptions.providerOptions adds fields to. */
export type VastCreateInstanceBody = {
    image: string,
    label: string,
    /** 'args': the container runs `args` (or the image's CMD); 'ssh' authorizes every account key on an sshd image. */
    runtype: 'args' | 'ssh' | 'jupyter' | string,
    args?: string[],
    /** Environment variables, and ports as "-p <port>:<port>[/udp]" keys. */
    env?: Record<string, string>,
    /** GB. */
    disk?: number,
    /** An interruptible rental's bid, USD per hour. */
    price?: number,
    cancel_unavail?: boolean,
    /** The private registry's login, as `docker login` arguments: '-u <user> -p <password> <host>'. */
    image_login?: string,
    /** runtype 'args': the container's ENTRYPOINT, overridden ('sh'); 'ssh' / 'jupyter': a script run when it starts. */
    onstart?: string,
    /** The volume it mounts (CreateServerOptions.mounts). */
    volume_info?: VastVolumeInfo,
};

/**
 * Vast's records, as the VastAI provider's records carry them (`raw`), and the
 * options its createServer takes. Instances boot registry images; the
 * account's own are snapshots in a repository of yours. A volume is sized when
 * made, on one machine (its region, `machine:<id>`), and mounted at a path of your choosing.
 */
export type VastTypes = {
    server: VastInstance,
    offer: VastOffer,
    image: VastImage,
    volume: VastVolume,
    createBody: VastCreateInstanceBody,
    volumeBody: VastCreateVolumeBody,
    imageImportBody: never,
    endpoint: never,
    endpointOffer: never,
    endpointBody: never,
    refused: (typeof VAST_REFUSED)[number],
    volumeSize: VolumeSize,
    volumeKind: {},
    mount: MountPath,
};
