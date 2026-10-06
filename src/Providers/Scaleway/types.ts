// Scaleway's API objects and enums as the Scaleway provider reads and sends
// them: the wire format (snake_case), from Scaleway's OpenAPI specs, checked
// 2026-10-01 against the live reference and against the live answers of its
// public catalog endpoints (Instance types, availability, Marketplace images).
// Where the live API sends a field its spec does not list, the field says so.
// Each type cites a page of the API reference that takes or returns it (see
// SCALEWAY_ENDPOINTS for the whole table), and `npm run scaleway:spec`
// (scripts/scaleway-spec-check.ts) holds every type, field and enum to the
// specs: a field that is not in them, an enum member that is missing, a page
// that does not document the type, fail it.
//
//   Instance API v1   https://www.scaleway.com/en/developers/api/instance/v1
//   IAM API           https://www.scaleway.com/en/developers/api/iam
//   Block Storage v1  https://www.scaleway.com/en/developers/api/block/v1
//   Marketplace v2    https://www.scaleway.com/en/developers/api/marketplace
//
// Sizes are bytes. A GPU's memory and an Instance's RAM are binary (24 GiB:
// 25769803776), volume sizes decimal (a 10 GB volume: 10000000000).

import type { MountPath, ProviderParams, VolumeSize } from '../../types';
import type { SCALEWAY_REFUSED } from './mappers';

// ── configuration ─────────────────────────────────────────────────────────

export type ScalewayParams = ProviderParams & {
    /**
     * The Project new servers and SSH keys belong to (the console shows it under
     * Project settings; SCW_DEFAULT_PROJECT_ID). Needed to create a server or an
     * SSH key, not to read offers or servers. Scaleway keeps SSH keys per
     * Project, and the Project's keys are authorized on every server created in
     * it, so asap-vps never guesses one.
     */
    projectId?: string,
    /**
     * The zones to read and create in, e.g. `['fr-par-2', 'pl-waw-2']`, or a
     * comma-separated string (SCW_ZONES); a region (`fr-par`) stands for its
     * zones. Default: every zone. Every Instance call is zonal, so fewer zones
     * are fewer calls.
     */
    zones?: Array<ScalewayZone | ScalewayRegion> | string,
    /**
     * The API key's access key (SCW_ACCESS_KEY, `SCW...`): what Object Storage
     * signs requests with, with `apiKey` (the secret key). Needed only to
     * import an image (its file goes through a bucket of the run's own).
     */
    accessKey?: string,
    /**
     * USD per EUR. Scaleway bills in euros (`hourly_price`), while offers are
     * priced in USD so providers compare: the default is SCALEWAY_EUR_USD, an
     * approximation. The euro price stays in an offer's `raw`.
     */
    eurToUsd?: number,
};

/** EUR/USD was 1.147 on 2026-09-16: what ScalewayParams.eurToUsd defaults to. */
export const SCALEWAY_EUR_USD = 1.15;

// ── zones and regions ─────────────────────────────────────────────────────
// https://www.scaleway.com/en/developers/api/instance/v1#availability-zones

/** Paris, Amsterdam, Warsaw and Milan; three Availability Zones each (Milan: one). */
export const SCALEWAY_ZONES = [
    'fr-par-1', 'fr-par-2', 'fr-par-3',
    'nl-ams-1', 'nl-ams-2', 'nl-ams-3',
    'pl-waw-1', 'pl-waw-2', 'pl-waw-3',
    'it-mil-1',
] as const;
export type ScalewayZone = typeof SCALEWAY_ZONES[number];

export const SCALEWAY_REGIONS = ['fr-par', 'nl-ams', 'pl-waw', 'it-mil'] as const;
export type ScalewayRegion = typeof SCALEWAY_REGIONS[number];

// ── Instance API v1: enums ────────────────────────────────────────────────

/** https://www.scaleway.com/en/developers/api/instance/v1/instance-types#list-instance-types */
export type ScalewayArch = 'unknown_arch' | 'x86_64' | 'arm' | 'arm64';

/** https://www.scaleway.com/en/developers/api/instance/v1/instances#create-an-instance */
export type ScalewayBootType = 'local' | 'bootscript' | 'rescue';

/**
 * https://www.scaleway.com/en/developers/api/instance/v1/instances#get-an-instance
 * A server created through the API is `stopped` until it is powered on.
 * `stopped` has released its hypervisor slot (only its volumes and IPs bill,
 * and starting it again needs stock); `stopped in place` keeps the slot (billed
 * as running); `locked` is an administrative lock.
 */
export type ScalewayServerState = 'running' | 'stopped' | 'stopped in place' | 'starting' | 'stopping' | 'locked';

/**
 * https://www.scaleway.com/en/developers/api/instance/v1/instances#perform-action
 *   poweron         start a stopped Instance
 *   poweroff        fully stop it and release the hypervisor slot (compute stops billing)
 *   stop_in_place   stop it but keep the slot (still billed)
 *   reboot          stop it and start it again
 *   backup          create an image of its volumes
 *   terminate       delete it with its `l_ssd` and `scratch` volumes: an `sbs_volume` is only detached.
 *                   Not for a stopped server (`allowed_actions` has none: 400 precondition_failed,
 *                   checked live): that one is deleted with DELETE, which keeps every volume
 *   enable_routed_ip  migrate to the routed IP network stack
 */
export type ScalewayServerAction = 'poweron' | 'poweroff' | 'stop_in_place' | 'reboot' | 'backup' | 'terminate' | 'enable_routed_ip';

/** https://www.scaleway.com/en/developers/api/instance/v1/instance-types#get-availability */
export type ScalewayServerTypesAvailability = 'available' | 'scarce' | 'shortage';

/**
 * https://www.scaleway.com/en/developers/api/instance/v1/images#get-an-instance-image
 * A volume as a request names it and as images carry it (`sbs_snapshot`: a
 * snapshot of a Block Storage volume).
 */
export type ScalewayVolumeType = 'l_ssd' | 'b_ssd' | 'unified' | 'scratch' | 'sbs_volume' | 'sbs_snapshot';
/** https://www.scaleway.com/en/developers/api/instance/v1/instances#get-an-instance (a volume attached to a server) */
export type ScalewayServerVolumeType = 'l_ssd' | 'b_ssd' | 'sbs_volume' | 'scratch';
/** https://www.scaleway.com/en/developers/api/instance/v1/instances#perform-action (what a `backup` can make of a volume) */
export type ScalewaySnapshotVolumeType = 'unknown_volume_type' | 'l_ssd' | 'b_ssd' | 'unified';

/** https://www.scaleway.com/en/developers/api/instance/v1/images#get-an-instance-image (the same states on a server's volume) */
export type ScalewayVolumeState = 'available' | 'snapshotting' | 'fetching' | 'saving' | 'attaching' | 'resizing' | 'hotsyncing' | 'error';

/** https://www.scaleway.com/en/developers/api/instance/v1/images#get-an-instance-image */
export type ScalewayImageState = 'available' | 'creating' | 'error';

/** https://www.scaleway.com/en/developers/api/instance/v1/instances#get-an-instance (`public_ips[].family`) */
export type ScalewayIpFamily = 'inet' | 'inet6';
/** https://www.scaleway.com/en/developers/api/instance/v1/instances#get-an-instance */
export type ScalewayIpState = 'unknown_state' | 'detached' | 'attached' | 'pending' | 'error';
/** https://www.scaleway.com/en/developers/api/instance/v1/instances#get-an-instance */
export type ScalewayIpProvisioningMode = 'manual' | 'dhcp' | 'slaac';

/** https://www.scaleway.com/en/developers/api/instance/v1/instances#perform-action */
export type ScalewayTaskStatus = 'pending' | 'started' | 'success' | 'failure' | 'retry';

// ── Instance API v1: Instance types ───────────────────────────────────────

/** https://www.scaleway.com/en/developers/api/instance/v1/instance-types#list-instance-types */
export type ScalewayVolumeConstraintSizes = {
    /** Bytes. */
    min_size: number,
    /** Bytes; 0 with a min of 0: no such volume. */
    max_size: number,
};

/** https://www.scaleway.com/en/developers/api/instance/v1/instance-types#list-instance-types */
export type ScalewayGpuInfo = {
    /** 'NVIDIA'. */
    gpu_manufacturer: string,
    /** 'L4', 'L40S', 'H100-PCIe', 'H100-SXM', 'B300-SXM', 'P100'. */
    gpu_name: string,
    /** One GPU's memory, bytes (an L4: 25769803776 = 24 GiB). */
    gpu_memory: number,
};

/** https://www.scaleway.com/en/developers/api/instance/v1/instance-types#list-instance-types */
export type ScalewayServerTypeCapabilities = {
    /** Whether the type boots from Block Storage (`sbs_volume`): every GPU type does. */
    block_storage?: boolean | null,
    boot_types: ScalewayBootType[],
    max_file_systems: number,
    // Seen in the live API, not in the spec:
    placement_groups?: boolean,
    hot_snapshots_local_volume?: boolean,
    /** How many Private Networks it can join. */
    private_network?: number,
};

/** https://www.scaleway.com/en/developers/api/instance/v1/instance-types#list-instance-types */
export type ScalewayServerTypeNetwork = {
    interfaces: Array<{ internal_bandwidth?: number | null, internet_bandwidth?: number | null }>,
    sum_internal_bandwidth?: number | null,
    sum_internet_bandwidth?: number | null,
    ipv6_support: boolean,
};

/**
 * An Instance type, by its commercial type ('L4-1-24G'); GET
 * https://www.scaleway.com/en/developers/api/instance/v1/instance-types#list-instance-types
 */
export type ScalewayServerType = {
    /** EUR. */
    hourly_price: number,
    /** EUR, for a 30 day month; deprecated. */
    monthly_price?: number,
    alt_names: string[],
    /** A GPU type allows no local volume (min and max 0): it boots from Block Storage. */
    volumes_constraint: ScalewayVolumeConstraintSizes,
    per_volume_constraint?: { l_ssd?: ScalewayVolumeConstraintSizes },
    ncpus: number,
    /** How many GPUs: 0 or null for a CPU type. */
    gpu?: number | null,
    /** Bytes. */
    ram: number,
    gpu_info?: ScalewayGpuInfo | null,
    arch: ScalewayArch,
    network?: ScalewayServerTypeNetwork,
    capabilities?: ScalewayServerTypeCapabilities,
    /** Scratch (local NVMe) storage the type can add, bytes. */
    scratch_storage_max_size?: number | null,
    scratch_storage_max_volumes_count: number,
    block_bandwidth?: number | null,
    /** No longer offered. */
    end_of_service: boolean,
    /** Seen in the live API, not in the spec: a MIG profile, or null. */
    mig_profile?: unknown,
};

// ── Instance API v1: servers ──────────────────────────────────────────────

/** https://www.scaleway.com/en/developers/api/instance/v1/instances#get-an-instance (`public_ips[]`) */
export type ScalewayServerIp = {
    id: string,
    address: string,
    gateway: string,
    netmask: string,
    family: ScalewayIpFamily,
    /** A dynamic IP is released with its server; a flexible IP is not. */
    dynamic: boolean,
    provisioning_mode: ScalewayIpProvisioningMode,
    tags: string[],
    ipam_id: string,
    state: ScalewayIpState,
};

/** https://www.scaleway.com/en/developers/api/instance/v1/instances#get-an-instance (the server a volume or an image names) */
export type ScalewayServerSummary = { id: string, name: string };

/**
 * https://www.scaleway.com/en/developers/api/instance/v1/instances#get-an-instance
 * One entry of a server's `volumes` map (keyed '0', '1', ...; '0' boots).
 */
export type ScalewayServerVolume = {
    id: string,
    /** null in an answer to a create: the root volume is named by the server's, later. */
    name?: string | null,
    organization?: string | null,
    project?: string | null,
    server?: ScalewayServerSummary | null,
    /** Bytes. */
    size?: number | null,
    volume_type: ScalewayServerVolumeType,
    creation_date?: string | null,
    modification_date?: string | null,
    state?: ScalewayVolumeState,
    boot: boolean,
    zone: ScalewayZone,
};

/** https://www.scaleway.com/en/developers/api/instance/v1/instances#get-an-instance (deprecated: routed IPs replace it) */
export type ScalewayServerIpv6 = { address: string, gateway: string, netmask: string };

/** GET/POST https://www.scaleway.com/en/developers/api/instance/v1/instances#get-an-instance */
export type ScalewayServer = {
    id: string,
    name: string,
    organization: string,
    project: string,
    allowed_actions: ScalewayServerAction[],
    tags: string[],
    /** The Instance type ('L4-1-24G'). */
    commercial_type: string,
    creation_date?: string | null,
    modification_date?: string | null,
    dynamic_ip_required: boolean,
    hostname: string,
    image?: ScalewayImage | null,
    protected: boolean,
    /** Deprecated; null with routed IPs. */
    private_ip?: string | null,
    /** Deprecated in favor of `public_ips`. */
    public_ip?: ScalewayServerIp | null,
    public_ips: ScalewayServerIp[],
    mac_address: string,
    state: ScalewayServerState,
    /** What the state is waiting on or why it is locked. */
    state_detail: string,
    boot_type: ScalewayBootType,
    volumes: Record<string, ScalewayServerVolume>,
    /** The File Storage filesystems attached to it. */
    filesystems?: ScalewayServerFileSystem[],
    arch: ScalewayArch,
    zone: ScalewayZone,
    /** The server type has reached end of service. */
    end_of_service: boolean,
    dns?: string | null,
    /** Deprecated (routed IPs). */
    ipv6?: ScalewayServerIpv6 | null,
};

/**
 * https://www.scaleway.com/en/developers/api/instance/v1/instances#create-an-instance
 * A volume of a server to create (`volumes` of the create request, keyed '0', '1', ...).
 */
export type ScalewayVolumeTemplate = {
    /** A volume that exists already (not for the root volume). */
    id?: string,
    name?: string,
    /** Bytes, a multiple of 512. */
    size?: number,
    volume_type?: ScalewayVolumeType,
    base_snapshot?: string,
    boot?: boolean,
    project?: string,
};

/**
 * POST https://www.scaleway.com/en/developers/api/instance/v1/instances#create-an-instance
 * There is no SSH key and no user data here: a Project's SSH keys are applied
 * at boot (and `AUTHORIZED_KEY=ssh-ed25519_AAAA...` tags add keys to one
 * server), and user data is set before the first power-on.
 */
export type ScalewayCreateServerBody = {
    name: string,
    commercial_type: string,
    /** An image id, or a Marketplace label ('ubuntu_noble_gpu_os_13_nvidia'): a label means the latest image of it. */
    image?: string,
    /** Without it the API makes the root volume from the image. */
    volumes?: Record<string, ScalewayVolumeTemplate>,
    /** Default true: a dynamic public IPv4. */
    dynamic_ip_required?: boolean,
    boot_type?: ScalewayBootType,
    project?: string,
    tags?: string[],
    security_group?: string,
    placement_group?: string,
    protected: boolean,
};

/** https://www.scaleway.com/en/developers/api/instance/v1/instances#attach-a-volume-to-an-instance */
export type ScalewayAttachVolumeType = 'unknown_volume_type' | 'l_ssd' | 'b_ssd' | 'sbs_volume';

/** POST https://www.scaleway.com/en/developers/api/instance/v1/instances#attach-a-volume-to-an-instance: a Block Storage volume is `sbs_volume`. */
export type ScalewayAttachServerVolumeBody = {
    volume_id: string,
    volume_type?: ScalewayAttachVolumeType,
};

/** POST https://www.scaleway.com/en/developers/api/instance/v1/instances#detach-a-volume-from-an-instance */
export type ScalewayDetachServerVolumeBody = {
    volume_id: string,
};

/** PATCH https://www.scaleway.com/en/developers/api/instance/v1/instances#update-an-instance: what the Scaleway provider changes of a server, its tags. */
export type ScalewayUpdateServerBody = {
    tags?: string[] | null,
};

/**
 * POST https://www.scaleway.com/en/developers/api/instance/v1/instances#perform-action
 * `name` (and `volumes`) belong to `backup` only.
 */
export type ScalewayServerActionBody = {
    action: ScalewayServerAction,
    name?: string,
    /** `backup` only: the volumes (by id) to make snapshots of; all but `scratch` ones without it. */
    volumes?: Record<string, { volume_type?: ScalewaySnapshotVolumeType }>,
};

/**
 * https://www.scaleway.com/en/developers/api/instance/v1/instances#perform-action
 * What an action answers: `href_result` locates the resource it made (`/images/<id>` for a backup). The other fields are deprecated.
 */
export type ScalewayTask = {
    href_from?: string,
    href_result?: string,
    status?: ScalewayTaskStatus,
};

// ── Instance API v1: images ───────────────────────────────────────────────

/**
 * https://www.scaleway.com/en/developers/api/instance/v1/images#get-an-instance-image
 * An image's root volume: for a snapshot of a block volume, `volume_type` is `sbs_snapshot`.
 */
export type ScalewayVolumeSummary = {
    id: string,
    name: string,
    size: number,
    volume_type: ScalewayVolumeType,
};

/**
 * https://www.scaleway.com/en/developers/api/instance/v1/images#get-an-instance-image
 * An image's other volumes, in full (a root volume is a summary).
 */
export type ScalewayVolume = {
    id: string,
    name: string,
    /** Deprecated. */
    export_uri?: string,
    /** Bytes. */
    size: number,
    volume_type: ScalewayVolumeType,
    creation_date?: string | null,
    modification_date?: string | null,
    organization: string,
    project: string,
    tags: string[],
    server?: ScalewayServerSummary | null,
    state: ScalewayVolumeState,
    zone: ScalewayZone,
};

/**
 * https://www.scaleway.com/en/developers/api/instance/v1/images#get-an-instance-image
 * An image is zone-bound, and holds snapshots of its server's volumes.
 */
export type ScalewayImage = {
    id: string,
    name: string,
    arch: ScalewayArch,
    creation_date?: string | null,
    modification_date?: string | null,
    extra_volumes: Record<string, ScalewayVolume>,
    /** The server it was made from. */
    from_server: string,
    organization: string,
    public: boolean,
    root_volume?: ScalewayVolumeSummary | null,
    state: ScalewayImageState,
    project: string,
    tags: string[],
    zone: ScalewayZone,
};

// ── Block Storage API v1 ──────────────────────────────────────────────────

/** https://www.scaleway.com/en/developers/api/block/v1/volume#get-a-volume */
export type ScalewayBlockVolumeStatus =
    'unknown_status' | 'creating' | 'available' | 'in_use' | 'deleting' | 'deleted' | 'resizing' | 'error' | 'snapshotting' | 'locked' | 'updating';

/** https://www.scaleway.com/en/developers/api/block/v1/volume#get-a-volume */
export type ScalewayBlockReferenceType = 'unknown_type' | 'link' | 'exclusive' | 'read_only';
/** https://www.scaleway.com/en/developers/api/block/v1/volume#get-a-volume */
export type ScalewayBlockReferenceStatus = 'unknown_status' | 'attaching' | 'attached' | 'detaching' | 'detached' | 'creating' | 'error';

/** https://www.scaleway.com/en/developers/api/block/v1/volume#get-a-volume: what a volume is attached to (a server, as `instance_server`). */
export type ScalewayBlockReference = {
    id: string,
    product_resource_type: string,
    product_resource_id: string,
    created_at?: string | null,
    type: ScalewayBlockReferenceType,
    status: ScalewayBlockReferenceStatus,
};

/** https://www.scaleway.com/en/developers/api/block/v1/volume#get-a-volume: deletable once `available` (detached). */
export type ScalewayBlockVolume = {
    id: string,
    name: string,
    /** 'sbs_5k' or 'sbs_15k': its IOPS class. */
    type: string,
    /** Bytes (decimal: 1 GB = 10^9). */
    size: number,
    project_id: string,
    created_at?: string | null,
    references: ScalewayBlockReference[],
    status: ScalewayBlockVolumeStatus,
    tags: string[],
    zone: ScalewayZone,
};

/** https://www.scaleway.com/en/developers/api/block/v1/volume#create-a-volume: an empty volume's size. */
export type ScalewayBlockVolumeFromEmpty = {
    /** Bytes, by 1 GB (10^9). */
    size: number,
};

/**
 * POST https://www.scaleway.com/en/developers/api/block/v1/volume#create-a-volume
 * The volume the Scaleway provider makes: an empty one (`from_empty`).
 */
export type ScalewayCreateBlockVolumeBody = {
    name: string,
    /** 5000 or 15000. */
    perf_iops?: number | null,
    project_id: string,
    from_empty?: ScalewayBlockVolumeFromEmpty | null,
    tags?: string[],
};

// ── IAM API ───────────────────────────────────────────────────────────────

/** POST https://www.scaleway.com/en/developers/api/iam/ssh-keys#create-an-ssh-key (ssh-rsa, ssh-dss, ssh-ed25519 and NIST ecdsa keys) */
export type ScalewayCreateSSHKeyBody = {
    name: string,
    public_key: string,
    project_id: string,
};

/** https://www.scaleway.com/en/developers/api/iam/ssh-keys#create-an-ssh-key */
export type ScalewaySSHKey = {
    id: string,
    name: string,
    public_key: string,
    /** Scaleway's own; asap-vps reports the SHA256 one. */
    fingerprint: string,
    organization_id: string,
    project_id: string,
    /** A disabled key is not applied to new servers. */
    disabled: boolean,
    created_at?: string | null,
    updated_at?: string | null,
};

// ── Marketplace API v2 ────────────────────────────────────────────────────

/** https://www.scaleway.com/en/developers/api/marketplace/marketplace-images#list-marketplace-images */
export type ScalewayMarketplaceImage = {
    id: string,
    name: string,
    /** What an Instance create takes as `image`: 'ubuntu_noble', 'ubuntu_noble_gpu_os_13_nvidia', 'debian_bookworm'. */
    label: string,
    description: string,
    /** 'distribution', 'instantapp', 'Machine Learning', 'kapsule'. */
    categories: string[],
    valid_until?: string | null,
};

// ── errors ────────────────────────────────────────────────────────────────

/**
 * The `type` of an error answer: the ten standard ones of every Scaleway API, and
 * the two only the Instance API sends. Scaleway documents no list of them: these
 * are the ones its SDKs read (Go: https://github.com/scaleway/scaleway-sdk-go/blob/master/scw/errors.go,
 * JS: https://github.com/scaleway/scaleway-sdk-js/tree/main/packages/client/src/scw/errors).
 * `out_of_stock`: no capacity; `quotas_exceeded`: an account limit, lifted by
 * verifying the account's identity or by support
 * (https://www.scaleway.com/en/docs/account/troubleshooting/quotas-exceeded-error-message/);
 * `transient_state`: the resource is busy changing state.
 */
export type ScalewayErrorType =
    | 'invalid_arguments' | 'quotas_exceeded' | 'transient_state' | 'not_found' | 'locked'
    | 'permissions_denied' | 'out_of_stock' | 'resource_expired' | 'denied_authentication' | 'precondition_failed'
    | 'unknown_resource' | 'invalid_request_error';

/** An error answer. Which fields are set depends on `type`. */
export type ScalewayErrorBody = {
    type?: ScalewayErrorType | (string & {}),
    message?: string,
    resource?: string,
    resource_id?: string,
    /** transient_state. */
    current_state?: string,
    /** invalid_arguments (argument_name, reason, help_message), quotas_exceeded (resource, quota, current), permissions_denied (action, resource). */
    details?: Array<{
        argument_name?: string, reason?: string, help_message?: string, resource?: string, quota?: number, current?: number, action?: string,
        /** quotas_exceeded, as the live API answers it: the resource (`cp_servers_type_L4_1_24G`) and the Organization, and again with the Project, that has no quota. */
        organization_id?: string, project_id?: string,
    }>,
    /** invalid_request_error: messages per field. */
    fields?: Record<string, string[]>,
    /** precondition_failed: 'resource_still_in_use', 'attribute_must_be_set'. */
    precondition?: string,
    help_message?: string,
};

// ── what the Scaleway provider's records carry ───────────────────────────

/** What an offer's `raw` holds: the type's record, and its stock in each zone it is offered in. */
export type ScalewayOfferRaw = {
    serverType: ScalewayServerType,
    /** Stock per zone the type is offered in. */
    availability: Partial<Record<ScalewayZone, ScalewayServerTypesAvailability>>,
};

/**
 * Scaleway's records, as the Scaleway provider's records carry them (`raw`),
 * and the options it takes. Its volumes are Block Storage: sized when made, and
 * attached as a disk the server formats and mounts itself (no path).
 */
export type ScalewayTypes = {
    server: ScalewayServer,
    offer: ScalewayOfferRaw,
    image: ScalewayImage,
    /** A Block Storage volume, or a File Storage filesystem (`shared`). */
    volume: ScalewayBlockVolume | ScalewayFileSystem,
    createBody: ScalewayCreateServerBody,
    volumeBody: ScalewayCreateBlockVolumeBody | ScalewayCreateFileSystemBody,
    imageImportBody: ScalewayCreateImageBody,
    endpoint: ScalewayContainer,
    endpointOffer: ScalewayContainerSize,
    endpointBody: ScalewayCreateContainerBody,
    refused: (typeof SCALEWAY_REFUSED)[number],
    volumeSize: VolumeSize,
    /** Block Storage by default; `shared: true` makes a File Storage filesystem: each takes its own request's fields. */
    volumeKind:
        | { shared?: false, providerOptions?: Partial<ScalewayCreateBlockVolumeBody> & Record<string, unknown> }
        | { shared: true, providerOptions?: Partial<ScalewayCreateFileSystemBody> & Record<string, unknown> },
    /** A path for a shared volume (a filesystem); a block volume is a disk the server mounts itself. */
    mount: MountPath,
};

// ── Serverless Containers API v1 (https://www.scaleway.com/en/developers/api/serverless-containers/v1) ──

/** https://www.scaleway.com/en/developers/api/serverless-containers/v1/containers#get-the-container-associated-with-the-specified-id */
export type ScalewayContainerStatus = 'unknown_status' | 'updating' | 'deleting' | 'locking' | 'ready' | 'error' | 'locked' | 'creating' | 'upgrading';

/** https://www.scaleway.com/en/developers/api/serverless-containers/v1/namespaces#get-the-namespace-associated-with-the-specified-id */
export type ScalewayContainerNamespaceStatus = 'unknown_status' | 'updating' | 'deleting' | 'locking' | 'ready' | 'error' | 'locked' | 'creating' | 'upgrading';

/** Who may call it: anyone ('public'), or a principal with the Project's ContainersPrivateAccess (its key in X-Auth-Token). https://www.scaleway.com/en/developers/api/serverless-containers/v1/containers#get-the-container-associated-with-the-specified-id */
export type ScalewayContainerPrivacy = 'unknown_privacy' | 'public' | 'private';

/** https://www.scaleway.com/en/developers/api/serverless-containers/v1/containers#get-the-container-associated-with-the-specified-id */
export type ScalewayContainerProtocol = 'unknown_protocol' | 'http1' | 'h2c';

/** https://www.scaleway.com/en/developers/api/serverless-containers/v1/containers#get-the-container-associated-with-the-specified-id */
export type ScalewayContainerSandbox = 'unknown_sandbox' | 'v1' | 'v2';

/** A namespace: a group of containers (with an IAM application of its own). https://www.scaleway.com/en/developers/api/serverless-containers/v1/namespaces#get-the-namespace-associated-with-the-specified-id */
export type ScalewayContainerNamespace = {
    id: string,
    name: string,
    organization_id: string,
    project_id: string,
    description: string,
    status: ScalewayContainerNamespaceStatus,
    error_message: string | null,
    environment_variables: Record<string, string>,
    tags: string[],
    created_at: string | null,
    updated_at: string | null,
    region: string,
};

/**
 * A serverless container: one image, from `min_scale` instances (0: none
 * while idle; Scaleway stops an idle one after 15 min) to `max_scale`, each
 * with `mvcpu_limit` thousandths of a vCPU and `memory_limit_bytes`.
 * https://www.scaleway.com/en/developers/api/serverless-containers/v1/containers#get-the-container-associated-with-the-specified-id
 */
export type ScalewayContainer = {
    id: string,
    name: string,
    namespace_id: string,
    description: string,
    status: ScalewayContainerStatus,
    error_message: string | null,
    created_at: string | null,
    updated_at: string | null,
    environment_variables: Record<string, string>,
    min_scale: number,
    max_scale: number,
    memory_limit_bytes: number,
    mvcpu_limit: number,
    local_storage_limit_bytes: number,
    /** Per request, e.g. '300s'. */
    timeout: string | null,
    privacy: ScalewayContainerPrivacy,
    image: string,
    protocol: ScalewayContainerProtocol,
    /** Given to the container as PORT. */
    port: number,
    https_connections_only: boolean,
    sandbox: ScalewayContainerSandbox,
    tags: string[],
    /** Replaces the image's ENTRYPOINT. */
    command: string[],
    /** Replaces the image's CMD. */
    args: string[],
    /** https://<namespace><id>-<name>.functions.fnc.<region>.scw.cloud */
    public_endpoint: string,
    private_endpoint: string | null,
    region: string,
};

/** POST .../namespaces. https://www.scaleway.com/en/developers/api/serverless-containers/v1/namespaces#create-a-new-namespace */
export type ScalewayCreateContainerNamespaceBody = {
    project_id: string,
    /** 1-50 characters, a letter first. */
    name: string,
    description?: string | null,
    environment_variables?: Record<string, string>,
    tags?: string[],
};

/** POST .../containers: created and deployed. https://www.scaleway.com/en/developers/api/serverless-containers/v1/containers#create-a-new-container-in-a-namespace */
export type ScalewayCreateContainerBody = {
    namespace_id: string,
    /** 2-34 lowercase letters, digits and dashes. */
    name: string,
    /** From any public registry, or the Project's own (no other login). */
    image: string,
    environment_variables?: Record<string, string>,
    secret_environment_variables?: Record<string, string>,
    /** 0-10. */
    min_scale?: number | null,
    /** 1-200. */
    max_scale?: number | null,
    /** 128 MB to 12288 MB, in bytes. */
    memory_limit_bytes?: number | null,
    /** 70-6000 thousandths of a vCPU. */
    mvcpu_limit?: number | null,
    timeout?: string | null,
    privacy?: ScalewayContainerPrivacy,
    description?: string | null,
    protocol?: ScalewayContainerProtocol,
    port?: number | null,
    https_connections_only?: boolean | null,
    sandbox?: ScalewayContainerSandbox,
    local_storage_limit_bytes?: number | null,
    tags?: string[],
    command?: string[],
    args?: string[],
};

/** A container's size, what a serverless offer is made from: thousandths of a vCPU, and memory in bytes. */
export type ScalewayContainerSize = { mvcpu: number, memoryBytes: number };

// ── File Storage API v1alpha1 (https://www.scaleway.com/en/developers/api/file-storage/v1alpha1; paths /file/v1alpha1) ──

/** https://www.scaleway.com/en/developers/api/file-storage/v1alpha1/filesystem#get-filesystem-details */
export type ScalewayFileSystemStatus = 'unknown_status' | 'available' | 'error' | 'creating' | 'updating';

/**
 * A File Storage filesystem: one region's (Paris for now), attached to
 * Instances of its zones (of a type that can: `max_file_systems`), many at
 * once, each mounting it with virtiofs (its id is the tag).
 * https://www.scaleway.com/en/developers/api/file-storage/v1alpha1/filesystem#get-filesystem-details
 */
export type ScalewayFileSystem = {
    id: string,
    name: string,
    /** Bytes (GB steps: 10^9). */
    size: number,
    status: ScalewayFileSystemStatus,
    project_id: string,
    organization_id: string,
    tags: string[],
    /** How many Instances have it attached. */
    number_of_attachments: number,
    region: string,
    created_at: string | null,
    updated_at: string | null,
};

/** POST .../filesystems: 25 GB to 50 TB, in GB steps. https://www.scaleway.com/en/developers/api/file-storage/v1alpha1/filesystem#create-a-new-filesystem */
export type ScalewayCreateFileSystemBody = {
    name: string,
    project_id: string,
    /** Bytes, a multiple of 10^9. */
    size: number,
    type?: string | null,
    tags?: string[],
};

/** https://www.scaleway.com/en/developers/api/instance/v1/instances#attach-a-filesystem-volume-to-an-instance */
export type ScalewayServerFileSystemState = 'unknown_state' | 'attaching' | 'available' | 'detaching';

/** A filesystem attached to an Instance. https://www.scaleway.com/en/developers/api/instance/v1/instances#attach-a-filesystem-volume-to-an-instance */
export type ScalewayServerFileSystem = {
    filesystem_id: string,
    state: ScalewayServerFileSystemState,
};

/** POST .../servers/{id}/attach-filesystem (and detach-filesystem). https://www.scaleway.com/en/developers/api/instance/v1/instances#attach-a-filesystem-volume-to-an-instance */
export type ScalewayServerFileSystemBody = {
    filesystem_id: string,
};

// ── Block Storage snapshots, to and from Object Storage (images in and out) ──

/** https://www.scaleway.com/en/developers/api/block/v1/snapshot#get-a-snapshot */
export type ScalewayBlockSnapshotStatus = 'unknown_status' | 'creating' | 'available' | 'error' | 'deleting' | 'deleted' | 'in_use' | 'locked' | 'exporting';

/** A Block Storage snapshot: an image's disk, an import of a QCOW2, an export's source. https://www.scaleway.com/en/developers/api/block/v1/snapshot#get-a-snapshot */
export type ScalewayBlockSnapshot = {
    id: string,
    name: string,
    /** Bytes. */
    size: number,
    project_id: string,
    created_at: string | null,
    updated_at: string | null,
    status: ScalewayBlockSnapshotStatus,
    tags: string[],
    zone: string,
};

/** POST .../snapshots/import-from-object-storage: a QCOW2 of a bucket of the zone's region, as a snapshot. https://www.scaleway.com/en/developers/api/block/v1/snapshot#import-a-snapshot-from-a-scaleway-object-storage-bucket */
export type ScalewayImportBlockSnapshotBody = {
    bucket: string,
    key: string,
    name: string,
    project_id?: string,
    tags?: string[],
    /** Bytes; default: the QCOW2's virtual size. */
    size?: number | null,
};

/** POST .../snapshots/{id}/export-to-object-storage: its QCOW2, to a bucket of the zone's region. https://www.scaleway.com/en/developers/api/block/v1/snapshot#export-a-snapshot-to-a-scaleway-object-storage-bucket */
export type ScalewayExportBlockSnapshotBody = {
    bucket: string,
    key: string,
};

/** POST /instance/v1/zones/{zone}/images: an image of snapshots (what ImportImageOptions.providerOptions adds fields to). https://www.scaleway.com/en/developers/api/instance/v1/images#create-an-instance-image */
export type ScalewayCreateImageBody = {
    name: string,
    /** The root disk's snapshot (an `sbs` one too). */
    root_volume: string,
    arch: ScalewayArch,
    project?: string | null,
    tags?: string[],
    public?: boolean | null,
};

/** https://www.scaleway.com/en/developers/api/instance/v1/snapshots#get-a-snapshot */
export type ScalewayInstanceSnapshotState = 'available' | 'snapshotting' | 'error' | 'invalid_data' | 'importing' | 'exporting';

/** A snapshot of the Instance API (a local volume's, `l_ssd`: the root of an image of a server on local storage). https://www.scaleway.com/en/developers/api/instance/v1/snapshots#get-a-snapshot */
export type ScalewayInstanceSnapshot = {
    id: string,
    name: string,
    volume_type: ScalewayVolumeType,
    /** Bytes. */
    size: number,
    state: ScalewayInstanceSnapshotState,
    zone: string,
    project: string,
    tags: string[],
};
