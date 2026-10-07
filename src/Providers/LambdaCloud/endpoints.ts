// Every Lambda Cloud endpoint asap-vps calls: its operation in Lambda's OpenAPI
// spec, and its entry in the API reference (one page, an operation at
// #<operationId>). LambdaApi refuses a request none of these describes.
// `npm run api:spec -- lambda` holds the table to the live spec and reference.
// Checked 2026-10-07 against
//   spec       https://cloud.lambda.ai/api/v1/openapi.json (1.10.0)
//   reference  https://docs.lambda.ai/api/cloud
// Every request carries the key as `Authorization: Bearer`; every answer is in `data`.

import type { ApiEndpoint } from '../../Core/utils';

const DOCS = 'https://docs.lambda.ai/api/cloud';

export const LAMBDA_ENDPOINTS = {
    // ── Instances ──
    /** Each type with the regions that have capacity for it now. */
    listInstanceTypes: { operationId: 'listInstanceTypes', method: 'GET', path: '/api/v1/instance-types', docs: `${DOCS}#listInstanceTypes` },
    /** Exactly one SSH key, by name; filesystems by name or with a mount point. */
    launchInstance: { operationId: 'launchInstance', method: 'POST', path: '/api/v1/instance-operations/launch', docs: `${DOCS}#launchInstance` },
    /** Every instance, at once (pagination is the caller's to ask for). */
    listInstances: { operationId: 'listInstances', method: 'GET', path: '/api/v1/instances', docs: `${DOCS}#listInstances` },
    getInstance: { operationId: 'getInstance', method: 'GET', path: '/api/v1/instances/{id}', docs: `${DOCS}#getInstance` },
    terminateInstance: { operationId: 'terminateInstance', method: 'POST', path: '/api/v1/instance-operations/terminate', docs: `${DOCS}#terminateInstance` },
    restartInstance: { operationId: 'restartInstance', method: 'POST', path: '/api/v1/instance-operations/restart', docs: `${DOCS}#restartInstance` },

    // ── SSH keys ──
    listSSHKeys: { operationId: 'listSSHKeys', method: 'GET', path: '/api/v1/ssh-keys', docs: `${DOCS}#listSSHKeys` },
    addSSHKey: { operationId: 'addSSHKey', method: 'POST', path: '/api/v1/ssh-keys', docs: `${DOCS}#addSSHKey` },
    deleteSSHKey: { operationId: 'deleteSSHKey', method: 'DELETE', path: '/api/v1/ssh-keys/{id}', docs: `${DOCS}#deleteSSHKey` },

    // ── Filesystems: read only as a list ──
    listFilesystems: { operationId: 'listFilesystems', method: 'GET', path: '/api/v1/filesystems', docs: `${DOCS}#listFilesystems` },
    createFilesystem: { operationId: 'createFilesystem', method: 'POST', path: '/api/v1/filesystems', docs: `${DOCS}#createFilesystem` },
    /** One in use (by an instance, or not let go of yet) is refused. */
    filesystemDelete: { operationId: 'filesystemDelete', method: 'DELETE', path: '/api/v1/filesystems/{id}', docs: `${DOCS}#filesystemDelete` },
} as const satisfies Record<string, ApiEndpoint>;
