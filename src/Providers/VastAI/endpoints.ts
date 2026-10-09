// Every Vast.ai endpoint asap-vps calls: its operation in Vast's OpenAPI spec,
// the query parameters it is sent with, and its page in the API reference
// (<tag>/<summary>). VastApi refuses a request none of these describes. Where
// a call departs from the spec, it is sent as Vast's own CLI sends it
// (vast-ai/vast-cli, vast.py), and the entry says so. `npm run api:spec -- vast`
// holds the table to the live spec and reference. Checked 2026-10-07 against
//   spec       https://docs.vast.ai/api-reference/openapi.yaml (1.0.0: the one the reference is built from)
//   reference  https://docs.vast.ai/api-reference/introduction
// Vast publishes a second spec, openapi.json, with a trailing slash on most
// paths where openapi.yaml has none: the slash is not significant to Vast, and
// paths are sent as the CLI sends them (most with it). Every request carries
// the key as `Authorization: Bearer`.

import type { ApiEndpoint } from '../../Core/utils';

const DOCS = 'https://docs.vast.ai/api-reference';
/** Vast's CLI: what it sends is how the calls the spec leaves out are made. */
const CLI = 'https://github.com/vast-ai/vast-cli/blob/master/vast.py';

export const VAST_ENDPOINTS = {
    // ── Offers ──
    /** The offer search (on-demand or bid asks), filters and ordering in the body. */
    searchOffers: { operationId: 'searchOffers', method: 'POST', path: '/api/v0/bundles/', docs: `${DOCS}/search/search-offers` },

    // ── Instances ──
    /** Rents an ask: the instance is made. */
    createInstance: { operationId: 'createInstance', method: 'PUT', path: '/api/v0/asks/{id}/', docs: `${DOCS}/instances/create-instance` },
    /** The account's instances, in pages of at most 25 (`after_token`), filtered by `select_filters`. */
    listInstances: { operationId: 'showInstances', method: 'GET', path: '/api/v1/instances/', query: ['select_filters', 'limit', 'after_token'], docs: `${DOCS}/instances/show-instances` },
    getInstance: { operationId: 'showInstance', method: 'GET', path: '/api/v0/instances/{id}/', docs: `${DOCS}/instances/show-instance` },
    /** `state`: running or stopped. */
    manageInstance: { operationId: 'manageInstance', method: 'PUT', path: '/api/v0/instances/{id}/', docs: `${DOCS}/instances/manage-instance` },
    destroyInstance: { operationId: 'destroyInstance', method: 'DELETE', path: '/api/v0/instances/{id}/', docs: `${DOCS}/instances/destroy-instance` },
    rebootInstance: { operationId: 'rebootInstance', method: 'PUT', path: '/api/v0/instances/reboot/{id}/', docs: `${DOCS}/instances/reboot-instance` },
    /** Uploads the log and answers the URL it will be at (on another host, read without the key). */
    requestLogs: { operationId: 'showLogs', method: 'PUT', path: '/api/v0/instances/request_logs/{id}/', docs: `${DOCS}/instances/show-logs` },
    /** Commits the container and pushes it to the registry the body names. */
    takeSnapshot: {
        method: 'POST', path: '/api/v0/instances/take_snapshot/{id}/', docs: CLI,
        unspecified: { path: null, source: 'the CLI\'s take__snapshot (`vastai take snapshot`) sends it so, and it was seen to push the snapshot live (2026-10-06)' },
    },

    // ── SSH keys ──
    listSSHKeys: { operationId: 'getSshKeysUser', method: 'GET', path: '/api/v0/ssh/', docs: `${DOCS}/accounts/show-ssh-keys` },
    createSSHKey: { operationId: 'createSshKey', method: 'POST', path: '/api/v0/ssh/', docs: `${DOCS}/accounts/create-ssh-key` },
    deleteSSHKey: { operationId: 'deleteSshKey', method: 'DELETE', path: '/api/v0/ssh/{id}/', docs: `${DOCS}/accounts/delete-ssh-key` },

    // ── Volumes: local to one machine ──
    /** The account's volumes (`owner=me`, `type=all_volume`). */
    listVolumes: {
        operationId: 'listVolumes', method: 'GET', path: '/api/v0/volumes', query: ['owner', 'type'], docs: `${DOCS}/volumes/list-volumes`,
        unspecified: { query: ['owner', 'type'], source: 'owner=me and type, which the spec does not declare, as the CLI\'s show__volumes sends them (seen live 2026-10-06)' },
    },
    /** Rents a volume offer: the volume is made. */
    rentVolume: { operationId: 'rentVolume', method: 'PUT', path: '/api/v0/volumes/', docs: `${DOCS}/volumes/rent-volume` },
    deleteVolume: {
        operationId: 'deleteVolume', method: 'DELETE', path: '/api/v0/volumes/', query: ['id'], docs: `${DOCS}/volumes/delete-volume`,
        unspecified: { query: ['id'], source: 'the volume\'s id as a query parameter, as the CLI\'s delete__volume sends it (seen live 2026-10-06)' },
    },
    searchVolumes: { operationId: 'searchVolumes', method: 'POST', path: '/api/v0/volumes/search/', docs: `${DOCS}/volumes/search-volumes` },
} as const satisfies Record<string, ApiEndpoint>;
