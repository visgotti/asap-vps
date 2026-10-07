// Every RunPod endpoint asap-vps calls (REST v2): its operation in RunPod's
// OpenAPI spec, the query parameters it is sent with, and its page in the API
// reference (<tag>/<summary>). RunPodApi refuses a request none of these
// describes. `npm run api:spec -- runpod` holds the table to the live spec and
// reference. Checked 2026-10-07 against
//   spec       https://api.runpod.io/v2/openapi.json (2.0.0)
//   reference  https://docs.runpod.io/api-reference-v2/overview
// Every request carries the key as `Authorization: Bearer`.

import type { ApiEndpoint } from '../../Core/utils';

const DOCS = 'https://docs.runpod.io/api-reference-v2';

export const RUNPOD_ENDPOINTS = {
    // ── Catalog: what can be rented, and where it is in stock ──
    /** Stock with include=AVAILABILITY, for the product (POD, SERVERLESS), cloud and GPU count asked, and a CUDA floor. */
    listGpuTypes: {
        operationId: 'listGpuTypes', method: 'GET', path: '/v2/catalog/gpus', query: ['include', 'product', 'cloud', 'count', 'minCudaVersion'],
        docs: `${DOCS}/catalog/list-gpu-types`,
    },
    /** Stock with include=AVAILABILITY, for the product and vCPU count asked. */
    listCpuTypes: { operationId: 'listCpuTypes', method: 'GET', path: '/v2/catalog/cpus', query: ['include', 'product', 'vcpuCount'], docs: `${DOCS}/catalog/list-cpu-types` },

    // ── Pods ──
    createPod: { operationId: 'createPod', method: 'POST', path: '/v2/pods', docs: `${DOCS}/pods/create-a-pod` },
    listPods: { operationId: 'listPods', method: 'GET', path: '/v2/pods', query: ['limit', 'cursor'], docs: `${DOCS}/pods/list-pods` },
    getPod: { operationId: 'getPod', method: 'GET', path: '/v2/pods/{id}', docs: `${DOCS}/pods/get-a-pod` },
    deletePod: { operationId: 'deletePod', method: 'DELETE', path: '/v2/pods/{id}', docs: `${DOCS}/pods/terminate-a-pod` },
    /** start, stop, restart. */
    podAction: { operationId: 'podAction', method: 'POST', path: '/v2/pods/{id}/action', docs: `${DOCS}/pods/trigger-a-pod-state-transition` },
    /** A Server-Sent Events stream: the backfill of the last `tail` lines of the `source` asked. */
    getPodLogs: { operationId: 'getPodLogs', method: 'GET', path: '/v2/pods/{id}/logs', query: ['source', 'tail'], docs: `${DOCS}/pods/stream-pod-logs` },

    // ── The account's SSH keys: one list, replaced whole ──
    getSshKeys: { operationId: 'getSshKeys', method: 'GET', path: '/v2/account/ssh-keys', docs: `${DOCS}/account/list-registered-ssh-public-keys` },
    updateSshKeys: { operationId: 'updateSshKeys', method: 'PUT', path: '/v2/account/ssh-keys', docs: `${DOCS}/account/replace-registered-ssh-public-keys` },

    // ── Network volumes ──
    listNetworkVolumes: { operationId: 'listNetworkVolumes', method: 'GET', path: '/v2/network-volumes', docs: `${DOCS}/network-volumes/list-network-volumes` },
    createNetworkVolume: { operationId: 'createNetworkVolume', method: 'POST', path: '/v2/network-volumes', docs: `${DOCS}/network-volumes/create-a-network-volume` },
    getNetworkVolume: { operationId: 'getNetworkVolume', method: 'GET', path: '/v2/network-volumes/{id}', docs: `${DOCS}/network-volumes/get-a-network-volume` },
    deleteNetworkVolume: { operationId: 'deleteNetworkVolume', method: 'DELETE', path: '/v2/network-volumes/{id}', docs: `${DOCS}/network-volumes/delete-a-network-volume` },

    // ── Stored registry logins (write-only credentials) ──
    listRegistries: { operationId: 'listRegistries', method: 'GET', path: '/v2/registries', docs: `${DOCS}/registries/list-container-registries` },
    createRegistry: { operationId: 'createRegistry', method: 'POST', path: '/v2/registries', docs: `${DOCS}/registries/create-a-container-registry-credential` },

    // ── Serverless endpoints (load-balancing) ──
    listEndpoints: { operationId: 'listEndpoints', method: 'GET', path: '/v2/serverless', query: ['limit', 'cursor'], docs: `${DOCS}/serverless/list-serverless-endpoints` },
    createEndpoint: { operationId: 'createEndpoint', method: 'POST', path: '/v2/serverless', docs: `${DOCS}/serverless/create-a-serverless-endpoint` },
    getEndpoint: { operationId: 'getEndpoint', method: 'GET', path: '/v2/serverless/{id}', docs: `${DOCS}/serverless/get-a-serverless-endpoint` },
    /** Scaled to no workers before it is deleted. */
    updateEndpoint: { operationId: 'updateEndpoint', method: 'PATCH', path: '/v2/serverless/{id}', docs: `${DOCS}/serverless/update-a-serverless-endpoint` },
    deleteEndpoint: { operationId: 'deleteEndpoint', method: 'DELETE', path: '/v2/serverless/{id}', docs: `${DOCS}/serverless/delete-a-serverless-endpoint` },
} as const satisfies Record<string, ApiEndpoint>;
