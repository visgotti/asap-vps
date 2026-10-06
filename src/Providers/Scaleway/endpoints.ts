// Every Scaleway endpoint asap-vps calls: its HTTP method, its path as the API
// reference writes it, the operation's id in Scaleway's OpenAPI spec, the query
// parameters it sends, and the page of the API reference that documents it.
// ScalewayApi builds each request from this table (and refuses a query
// parameter that is not listed), so a request and its documentation cannot
// drift apart, and endpoints.spec.ts holds every entry to the reference's URL
// scheme. `npm run scaleway:spec` (scripts/scaleway-spec-check.ts) holds the
// table to the live specs: each method, path, operationId, query parameter and
// docs anchor (the page of the operation's tag, at its summary). Last run
// 2026-10-02 against
//   Instance API v1   https://www.scaleway.com/en/developers/api/instance/v1   (spec: .../instance/v1/schema.yml)
//   IAM API           https://www.scaleway.com/en/developers/api/iam           (spec: .../iam/v1alpha1/schema.yml)
//   Block Storage v1  https://www.scaleway.com/en/developers/api/block/v1      (spec: .../block/v1/schema.yml)
//   Marketplace v2    https://www.scaleway.com/en/developers/api/marketplace   (spec: .../marketplace/v2/schema.yml)
//   Serverless Containers v1  https://www.scaleway.com/en/developers/api/serverless-containers/v1  (spec: .../serverless-containers/v1/schema.yml; paths /containers/v1)
//   File Storage v1alpha1     https://www.scaleway.com/en/developers/api/file-storage/v1alpha1      (spec: .../file-storage/v1alpha1/schema.yml; paths /file/v1alpha1)
// Every request carries the secret key in the `X-Auth-Token` header, and the
// Instance and Block Storage paths are zonal: `/zones/{zone}/...`.

const DOCS = 'https://www.scaleway.com/en/developers/api';

export type ScalewayEndpoint = {
    /** The operation's id in the API's OpenAPI spec. */
    operationId: string,
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    /** `{placeholders}` are named as in the spec; fillPath fills them. */
    path: string,
    /** The query parameters asap-vps sends (all of them are the operation's: `npm run scaleway:spec` checks). */
    query?: readonly string[],
    /** This endpoint's entry in Scaleway's API reference. */
    docs: string,
};

export const SCALEWAY_ENDPOINTS = {
    // ── Instance API v1: servers ("Instances"), their types, user data ──

    /** All Instance types of a zone (GPU and CPU), with `hourly_price` in EUR; `X-Total-Count` says how many there are. */
    listServerTypes: {
        operationId: 'ListServersTypes', method: 'GET', path: '/instance/v1/zones/{zone}/products/servers', query: ['per_page', 'page'],
        docs: `${DOCS}/instance/v1/instance-types#list-instance-types`,
    },
    /** Live stock per Instance type: `available`, `scarce` or `shortage`. */
    getServerTypesAvailability: {
        operationId: 'GetServerTypesAvailability', method: 'GET', path: '/instance/v1/zones/{zone}/products/servers/availability', query: ['per_page', 'page'],
        docs: `${DOCS}/instance/v1/instance-types#get-availability`,
    },
    listServers: {
        operationId: 'ListServers', method: 'GET', path: '/instance/v1/zones/{zone}/servers', query: ['per_page', 'page'],
        docs: `${DOCS}/instance/v1/instances#list-all-instances`,
    },
    /** Creates the Instance powered off (`stopped`): it starts with the `poweron` action. */
    createServer: {
        operationId: 'CreateServer', method: 'POST', path: '/instance/v1/zones/{zone}/servers',
        docs: `${DOCS}/instance/v1/instances#create-an-instance`,
    },
    getServer: {
        operationId: 'GetServer', method: 'GET', path: '/instance/v1/zones/{zone}/servers/{server_id}',
        docs: `${DOCS}/instance/v1/instances#get-an-instance`,
    },
    /** poweron, poweroff, stop_in_place, reboot, terminate, backup: see ScalewayServerAction. `terminate` is for a server that runs: a stopped one refuses it (precondition_failed) and is deleted with deleteServer. */
    serverAction: {
        operationId: 'ServerAction', method: 'POST', path: '/instance/v1/zones/{zone}/servers/{server_id}/action',
        docs: `${DOCS}/instance/v1/instances#perform-action`,
    },
    /** Deletes a STOPPED Instance (checked live: no `terminate` on a stopped one) and keeps every volume it had: they bill until deleted. */
    deleteServer: {
        operationId: 'DeleteServer', method: 'DELETE', path: '/instance/v1/zones/{zone}/servers/{server_id}',
        docs: `${DOCS}/instance/v1/instances#delete-an-instance`,
    },
    /** Its tags (the Scaleway provider changes nothing else of a server). */
    updateServer: {
        operationId: 'UpdateServer', method: 'PATCH', path: '/instance/v1/zones/{zone}/servers/{server_id}',
        docs: `${DOCS}/instance/v1/instances#update-an-instance`,
    },
    /** A Block Storage volume to a server that runs (`volume_type: sbs_volume`): it is attached as its next disk. */
    attachServerVolume: {
        operationId: 'AttachServerVolume', method: 'POST', path: '/instance/v1/zones/{zone}/servers/{server_id}/attach-volume',
        docs: `${DOCS}/instance/v1/instances#attach-a-volume-to-an-instance`,
    },
    detachServerVolume: {
        operationId: 'DetachServerVolume', method: 'POST', path: '/instance/v1/zones/{zone}/servers/{server_id}/detach-volume',
        docs: `${DOCS}/instance/v1/instances#detach-a-volume-from-an-instance`,
    },
    /** The body is the raw content (text/plain); the `cloud-init` key is what the Instance's cloud-init reads. */
    setServerUserData: {
        operationId: 'SetServerUserData', method: 'PATCH', path: '/instance/v1/zones/{zone}/servers/{server_id}/user_data/{key}',
        docs: `${DOCS}/instance/v1/user-data#add-set-user-data`,
    },

    // ── Instance API v1: images and their snapshots ──

    listImages: {
        operationId: 'ListImages', method: 'GET', path: '/instance/v1/zones/{zone}/images', query: ['per_page', 'page', 'public'],
        docs: `${DOCS}/instance/v1/images#list-instance-images`,
    },
    getImage: {
        operationId: 'GetImage', method: 'GET', path: '/instance/v1/zones/{zone}/images/{image_id}',
        docs: `${DOCS}/instance/v1/images#get-an-instance-image`,
    },
    /** Deletes the image only: its snapshots stay (and bill) until they are deleted too. */
    deleteImage: {
        operationId: 'DeleteImage', method: 'DELETE', path: '/instance/v1/zones/{zone}/images/{image_id}',
        docs: `${DOCS}/instance/v1/images#delete-an-instance-image`,
    },
    /** A snapshot of a local (`l_ssd` / `unified`) volume. */
    deleteSnapshot: {
        operationId: 'DeleteSnapshot', method: 'DELETE', path: '/instance/v1/zones/{zone}/snapshots/{snapshot_id}',
        docs: `${DOCS}/instance/v1/snapshots#delete-a-snapshot`,
    },

    /** A volume of the Instance API (`l_ssd`, `b_ssd`): what deleteServer leaves of a stopped server. */
    deleteVolume: {
        operationId: 'DeleteVolume', method: 'DELETE', path: '/instance/v1/zones/{zone}/volumes/{volume_id}',
        docs: `${DOCS}/instance/v1/volumes#delete-a-volume`,
    },

    // ── IAM API: the SSH keys of a Project ──

    listSSHKeys: {
        operationId: 'ListSSHKeys', method: 'GET', path: '/iam/v1alpha1/ssh-keys', query: ['page_size', 'page', 'project_id'],
        docs: `${DOCS}/iam/ssh-keys#list-ssh-keys`,
    },
    /** Needs the Project the key belongs to (`project_id`). */
    createSSHKey: {
        operationId: 'CreateSSHKey', method: 'POST', path: '/iam/v1alpha1/ssh-keys',
        docs: `${DOCS}/iam/ssh-keys#create-an-ssh-key`,
    },
    deleteSSHKey: {
        operationId: 'DeleteSSHKey', method: 'DELETE', path: '/iam/v1alpha1/ssh-keys/{ssh_key_id}',
        docs: `${DOCS}/iam/ssh-keys#delete-an-ssh-key`,
    },

    // ── Block Storage API v1: volumes (what `terminate` only detaches: `sbs_volume`), snapshots (`sbs_snapshot`) ──

    /** A Project's volumes in the zone (`project_id`), or every one the key can read. */
    listBlockVolumes: {
        operationId: 'ListVolumes', method: 'GET', path: '/block/v1/zones/{zone}/volumes', query: ['page_size', 'page', 'project_id'],
        docs: `${DOCS}/block/v1/volume#list-volumes`,
    },
    /** An empty volume (`from_empty`), `creating` and then `available` (within a second, checked live 2026-10-06). It bills until deleted. */
    createBlockVolume: {
        operationId: 'CreateVolume', method: 'POST', path: '/block/v1/zones/{zone}/volumes',
        docs: `${DOCS}/block/v1/volume#create-a-volume`,
    },
    getBlockVolume: {
        operationId: 'GetVolume', method: 'GET', path: '/block/v1/zones/{zone}/volumes/{volume_id}',
        docs: `${DOCS}/block/v1/volume#get-a-volume`,
    },
    deleteBlockVolume: {
        operationId: 'DeleteVolume', method: 'DELETE', path: '/block/v1/zones/{zone}/volumes/{volume_id}',
        docs: `${DOCS}/block/v1/volume#delete-a-detached-volume`,
    },
    deleteBlockSnapshot: {
        operationId: 'DeleteSnapshot', method: 'DELETE', path: '/block/v1/zones/{zone}/snapshots/{snapshot_id}',
        docs: `${DOCS}/block/v1/snapshot#delete-a-snapshot`,
    },

    // ── Marketplace API v2: the OS images an Instance can boot ──

    listMarketplaceImages: {
        operationId: 'ListImages', method: 'GET', path: '/marketplace/v2/images', query: ['page_size', 'page', 'include_eol'],
        docs: `${DOCS}/marketplace/marketplace-images#list-marketplace-images`,
    },

    // ── Block Storage snapshots and Instance images, to and from Object Storage ──

    /** A QCOW2 of a bucket of the zone's region, as a snapshot: `creating`, then `available` (or `error`). */
    importBlockSnapshot: {
        operationId: 'ImportSnapshotFromObjectStorage', method: 'POST', path: '/block/v1/zones/{zone}/snapshots/import-from-object-storage',
        docs: `${DOCS}/block/v1/snapshot#import-a-snapshot-from-a-scaleway-object-storage-bucket`,
    },
    /** Its QCOW2, to a bucket of the zone's region: `exporting`, then back to what it was. */
    exportBlockSnapshot: {
        operationId: 'ExportSnapshotToObjectStorage', method: 'POST', path: '/block/v1/zones/{zone}/snapshots/{snapshot_id}/export-to-object-storage',
        docs: `${DOCS}/block/v1/snapshot#export-a-snapshot-to-a-scaleway-object-storage-bucket`,
    },
    listBlockSnapshots: {
        operationId: 'ListSnapshots', method: 'GET', path: '/block/v1/zones/{zone}/snapshots', query: ['page_size', 'page', 'project_id'],
        docs: `${DOCS}/block/v1/snapshot#list-all-snapshots`,
    },
    getBlockSnapshot: {
        operationId: 'GetSnapshot', method: 'GET', path: '/block/v1/zones/{zone}/snapshots/{snapshot_id}',
        docs: `${DOCS}/block/v1/snapshot#get-a-snapshot`,
    },
    /** An Instance snapshot (a local volume's), its QCOW2 to a bucket of the zone's region: `exporting`, then `available`. */
    exportInstanceSnapshot: {
        operationId: 'ExportSnapshot', method: 'POST', path: '/instance/v1/zones/{zone}/snapshots/{snapshot_id}/export',
        docs: `${DOCS}/instance/v1/snapshots#export-a-snapshot`,
    },
    listInstanceSnapshots: {
        operationId: 'ListSnapshots', method: 'GET', path: '/instance/v1/zones/{zone}/snapshots', query: ['per_page', 'page', 'project'],
        docs: `${DOCS}/instance/v1/snapshots#list-snapshots`,
    },
    getInstanceSnapshot: {
        operationId: 'GetSnapshot', method: 'GET', path: '/instance/v1/zones/{zone}/snapshots/{snapshot_id}',
        docs: `${DOCS}/instance/v1/snapshots#get-a-snapshot`,
    },
    /** An image of snapshots: `creating`, then `available`. */
    createImage: {
        operationId: 'CreateImage', method: 'POST', path: '/instance/v1/zones/{zone}/images',
        docs: `${DOCS}/instance/v1/images#create-an-instance-image`,
    },

    // ── File Storage API v1alpha1 (regional: Paris for now): shared filesystems ──

    listFileSystems: {
        operationId: 'ListFileSystems', method: 'GET', path: '/file/v1alpha1/regions/{region}/filesystems', query: ['page', 'page_size', 'project_id'],
        docs: `${DOCS}/file-storage/v1alpha1/filesystem#list-all-filesystems`,
    },
    /** `creating`, then `available`. */
    createFileSystem: {
        operationId: 'CreateFileSystem', method: 'POST', path: '/file/v1alpha1/regions/{region}/filesystems',
        docs: `${DOCS}/file-storage/v1alpha1/filesystem#create-a-new-filesystem`,
    },
    getFileSystem: {
        operationId: 'GetFileSystem', method: 'GET', path: '/file/v1alpha1/regions/{region}/filesystems/{filesystem_id}',
        docs: `${DOCS}/file-storage/v1alpha1/filesystem#get-filesystem-details`,
    },
    /** Only once no Instance has it attached. */
    deleteFileSystem: {
        operationId: 'DeleteFileSystem', method: 'DELETE', path: '/file/v1alpha1/regions/{region}/filesystems/{filesystem_id}',
        docs: `${DOCS}/file-storage/v1alpha1/filesystem#delete-a-detached-filesystem`,
    },
    /** The Instance's `filesystems` list it, `attaching`, then `available`. */
    attachServerFileSystem: {
        operationId: 'AttachServerFileSystem', method: 'POST', path: '/instance/v1/zones/{zone}/servers/{server_id}/attach-filesystem',
        docs: `${DOCS}/instance/v1/instances#attach-a-filesystem-volume-to-an-instance`,
    },
    detachServerFileSystem: {
        operationId: 'DetachServerFileSystem', method: 'POST', path: '/instance/v1/zones/{zone}/servers/{server_id}/detach-filesystem',
        docs: `${DOCS}/instance/v1/instances#detach-a-filesystem-volume-from-an-instance`,
    },

    // ── Serverless Containers API v1 (regional): a namespace and a container per endpoint ──

    /** A namespace for an endpoint's container (with its own IAM application): `creating`, then `ready`. */
    createContainerNamespace: {
        operationId: 'CreateNamespace', method: 'POST', path: '/containers/v1/regions/{region}/namespaces',
        docs: `${DOCS}/serverless-containers/v1/namespaces#create-a-new-namespace`,
    },
    getContainerNamespace: {
        operationId: 'GetNamespace', method: 'GET', path: '/containers/v1/regions/{region}/namespaces/{namespace_id}',
        docs: `${DOCS}/serverless-containers/v1/namespaces#get-the-namespace-associated-with-the-specified-id`,
    },
    /** Deletes it, and its containers with it: `deleting`, then a 404. */
    deleteContainerNamespace: {
        operationId: 'DeleteNamespace', method: 'DELETE', path: '/containers/v1/regions/{region}/namespaces/{namespace_id}',
        docs: `${DOCS}/serverless-containers/v1/namespaces#delete-the-namespace-associated-with-the-specified-id`,
    },
    listContainers: {
        operationId: 'ListContainers', method: 'GET', path: '/containers/v1/regions/{region}/containers', query: ['page', 'page_size', 'project_id'],
        docs: `${DOCS}/serverless-containers/v1/containers#list-all-containers-the-caller-can-access-read-permission`,
    },
    /** Creates and deploys it: `creating`, then `ready` (or `error`, with its `error_message`). */
    createContainer: {
        operationId: 'CreateContainer', method: 'POST', path: '/containers/v1/regions/{region}/containers',
        docs: `${DOCS}/serverless-containers/v1/containers#create-a-new-container-in-a-namespace`,
    },
    getContainer: {
        operationId: 'GetContainer', method: 'GET', path: '/containers/v1/regions/{region}/containers/{container_id}',
        docs: `${DOCS}/serverless-containers/v1/containers#get-the-container-associated-with-the-specified-id`,
    },
    /** `deleting`, then a 404. */
    deleteContainer: {
        operationId: 'DeleteContainer', method: 'DELETE', path: '/containers/v1/regions/{region}/containers/{container_id}',
        docs: `${DOCS}/serverless-containers/v1/containers#delete-the-container-associated-with-the-specified-id`,
    },
} as const satisfies Record<string, ScalewayEndpoint>;

export type ScalewayEndpointName = keyof typeof SCALEWAY_ENDPOINTS;

/** `/zones/{zone}/servers/{server_id}` with its placeholders filled (URL-encoded); a placeholder left unfilled throws. */
export function fillPath(path: string, params: Record<string, string> = {}): string {
    return path.replace(/\{([a-z_]+)\}/g, (_, name: string) => {
        const v = params[name];
        if (v === undefined || v === '') throw new Error(`Scaleway path ${path} needs "${name}"`);
        return encodeURIComponent(v);
    });
}

/** `?a=1&b=2` from the defined values (an array is comma-separated, as Scaleway reads it); '' when there are none. */
export function queryString(query: Record<string, string | number | boolean | string[] | undefined>): string {
    const parts = Object.entries(query)
        .filter(([, v]) => v !== undefined && !(Array.isArray(v) && v.length === 0))
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(Array.isArray(v) ? v.join(',') : String(v))}`);
    return parts.length ? `?${parts.join('&')}` : '';
}
