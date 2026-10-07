// Every DigitalOcean endpoint asap-vps calls: its operation in DigitalOcean's
// OpenAPI spec, the query parameters it is sent with, and its entry in the API
// reference (a page per tag, the operation at #<operationId>). DigitalOceanApi
// refuses a request none of these describes. `npm run api:spec -- digitalocean`
// holds the table to the live spec and reference. Checked 2026-10-07 against
//   spec       https://api-engineering.nyc3.cdn.digitaloceanspaces.com/spec-ci/DigitalOcean-public.v2.yaml (2.0)
//   reference  https://docs.digitalocean.com/reference/api/reference/
// Every list is read in pages (per_page, page: links.pages.next), and every
// request carries the token as `Authorization: Bearer`.

import type { ApiEndpoint } from '../../Core/utils';

const DOCS = 'https://docs.digitalocean.com/reference/api/reference';

export const DIGITALOCEAN_ENDPOINTS = {
    // ── Droplets ──
    listSizes: { operationId: 'sizes_list', method: 'GET', path: '/v2/sizes', query: ['per_page', 'page'], docs: `${DOCS}/sizes/#sizes_list` },
    /** The droplet limit, for the live suites' preflight. */
    getAccount: { operationId: 'account_get', method: 'GET', path: '/v2/account', docs: `${DOCS}/account/#account_get` },
    createDroplet: { operationId: 'droplets_create', method: 'POST', path: '/v2/droplets', docs: `${DOCS}/droplets/#droplets_create` },
    /** GPU droplets with `type=gpus`; without it, only the others. */
    listDroplets: { operationId: 'droplets_list', method: 'GET', path: '/v2/droplets', query: ['type', 'per_page', 'page'], docs: `${DOCS}/droplets/#droplets_list` },
    getDroplet: { operationId: 'droplets_get', method: 'GET', path: '/v2/droplets/{droplet_id}', docs: `${DOCS}/droplets/#droplets_get` },
    deleteDroplet: { operationId: 'droplets_destroy', method: 'DELETE', path: '/v2/droplets/{droplet_id}', docs: `${DOCS}/droplets/#droplets_destroy` },
    listDropletSnapshots: {
        operationId: 'droplets_list_snapshots', method: 'GET', path: '/v2/droplets/{droplet_id}/snapshots', query: ['per_page', 'page'],
        docs: `${DOCS}/droplets/#droplets_list_snapshots`,
    },
    /** power_on, power_off, shutdown, reboot, snapshot: one at a time (a 422 "pending event" while another is in progress). */
    dropletAction: { operationId: 'dropletActions_post', method: 'POST', path: '/v2/droplets/{droplet_id}/actions', docs: `${DOCS}/droplet-actions/#dropletActions_post` },
    getAction: { operationId: 'actions_get', method: 'GET', path: '/v2/actions/{action_id}', docs: `${DOCS}/actions/#actions_get` },

    // ── Images ──
    /** The account's own with `private=true`. */
    listImages: { operationId: 'images_list', method: 'GET', path: '/v2/images', query: ['private', 'per_page', 'page'], docs: `${DOCS}/images/#images_list` },
    getImage: { operationId: 'images_get', method: 'GET', path: '/v2/images/{image_id}', docs: `${DOCS}/images/#images_get` },
    /** An image imported from a URL. */
    createCustomImage: { operationId: 'images_create_custom', method: 'POST', path: '/v2/images', docs: `${DOCS}/images/#images_create_custom` },
    deleteImage: { operationId: 'images_delete', method: 'DELETE', path: '/v2/images/{image_id}', docs: `${DOCS}/images/#images_delete` },
    /** `transfer`: a copy to another region. */
    imageAction: { operationId: 'imageActions_post', method: 'POST', path: '/v2/images/{image_id}/actions', docs: `${DOCS}/image-actions/#imageActions_post` },

    // ── Block Storage volumes ──
    listVolumes: { operationId: 'volumes_list', method: 'GET', path: '/v2/volumes', query: ['per_page', 'page'], docs: `${DOCS}/block-storage/#volumes_list` },
    createVolume: { operationId: 'volumes_create', method: 'POST', path: '/v2/volumes', docs: `${DOCS}/block-storage/#volumes_create` },
    getVolume: { operationId: 'volumes_get', method: 'GET', path: '/v2/volumes/{volume_id}', docs: `${DOCS}/block-storage/#volumes_get` },
    deleteVolume: { operationId: 'volumes_delete', method: 'DELETE', path: '/v2/volumes/{volume_id}', docs: `${DOCS}/block-storage/#volumes_delete` },
    /** attach, detach: an event of the droplet's, held to its one-at-a-time rule. */
    volumeAction: {
        operationId: 'volumeActions_post_byId', method: 'POST', path: '/v2/volumes/{volume_id}/actions', docs: `${DOCS}/block-storage-actions/#volumeActions_post_byId`,
    },

    // ── Network File Storage shares, and the VPCs they are in ──
    listShares: {
        operationId: 'nfs_list', method: 'GET', path: '/v2/nfs', query: ['per_page', 'page'], docs: `${DOCS}/nfs/#nfs_list`,
        unspecified: { query: ['per_page', 'page'], source: 'read in pages like every DigitalOcean list; the spec declares only region, and the live shares suite\'s reads were answered (DigitalOceanShares.live.spec.ts, 2026-10-06)' },
    },
    createShare: { operationId: 'nfs_create', method: 'POST', path: '/v2/nfs', docs: `${DOCS}/nfs/#nfs_create` },
    /** The share's region is required. */
    deleteShare: { operationId: 'nfs_delete', method: 'DELETE', path: '/v2/nfs/{nfs_id}', query: ['region'], docs: `${DOCS}/nfs/#nfs_delete` },
    listVpcs: { operationId: 'vpcs_list', method: 'GET', path: '/v2/vpcs', query: ['per_page', 'page'], docs: `${DOCS}/vpcs/#vpcs_list` },

    // ── SSH keys ──
    listSSHKeys: { operationId: 'sshKeys_list', method: 'GET', path: '/v2/account/keys', query: ['per_page', 'page'], docs: `${DOCS}/ssh-keys/#sshKeys_list` },
    createSSHKey: { operationId: 'sshKeys_create', method: 'POST', path: '/v2/account/keys', docs: `${DOCS}/ssh-keys/#sshKeys_create` },
    /** By id or fingerprint. */
    deleteSSHKey: { operationId: 'sshKeys_delete', method: 'DELETE', path: '/v2/account/keys/{ssh_key_identifier}', docs: `${DOCS}/ssh-keys/#sshKeys_delete` },
} as const satisfies Record<string, ApiEndpoint>;
