// A private container registry for the live suites, made in the Scaleway
// account (the user's own, empty but for this): a private namespace of
// Scaleway's Container Registry, a copy of a small public image in it (pushed
// with the account's key, from this machine only), and an IAM application whose
// API key can only pull from the Project's registries, expiring in hours: the
// login handed to RunPod, Vast and the VMs, never the account's own key.
// Everything is named after the run and recorded; `cleanup` deletes the API
// key, then the policy, then the application, then the namespace (and its
// images), and proves each gone by a fresh read. A secret is never logged.
// `sweepPrivateRegistries` deletes what earlier runs left, by name.

import { copyRegistryImage, http, HttpResult } from '../Core/utils';
import type { RegistryAuth } from '../types';
import { Log, RUN_PREFIX } from './live';

const API = 'https://api.scaleway.com';

export type PrivateRegistry = {
    /** The private image: `rg.<region>.scw.cloud/<namespace>/busybox:1.36`. */
    image: string,
    /** The IAM application's key: it can only pull (access 'pull', the default), or pull and push ('push'): what a provider is given. */
    pullAuth: RegistryAuth,
    /** The login that can push (the account's own key): only for this machine. */
    pushAuth: RegistryAuth,
    namespaceId: string,
    /** Deletes everything it made, each verified gone: what is still there ([] = all gone). */
    cleanup(): Promise<string[]>,
};

type Made = { apiKey?: string, policyId?: string, applicationId?: string, namespaceId?: string };

function scaleway(secretKey: string) {
    const call = async (method: string, path: string, json?: unknown): Promise<HttpResult> =>
        http(`${API}${path}`, { method, headers: { 'x-auth-token': secretKey }, ...(json !== undefined ? { json } : {}), retries: 2 });
    const ok = async (method: string, path: string, json?: unknown): Promise<any> => {
        const r = await call(method, path, json);
        if (r.status >= 300) throw new Error(`${method} ${path} -> ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`);
        return r.body;
    };
    return { call, ok };
}

/** Deletes `path` (a 404 is gone already) and proves it gone with a read: '' when gone, else what is left. */
async function deleteVerified(api: ReturnType<typeof scaleway>, what: string, path: string): Promise<string> {
    const del = await api.call('DELETE', path);
    if (del.status >= 300 && del.status !== 404) return `${what} (delete: ${del.status})`;
    for (let i = 0; i < 30; i++) {
        const r = await api.call('GET', path);
        if (r.status === 404) return '';
        // A namespace is `deleting` for a while.
        await new Promise((res) => setTimeout(res, 2000));
    }
    return `${what} (still there)`;
}

async function cleanupMade(secretKey: string, made: Made, region: string): Promise<string[]> {
    const api = scaleway(secretKey);
    const left: string[] = [];
    if (made.apiKey) left.push(await deleteVerified(api, `API key ${made.apiKey}`, `/iam/v1alpha1/api-keys/${made.apiKey}`));
    if (made.policyId) left.push(await deleteVerified(api, `policy ${made.policyId}`, `/iam/v1alpha1/policies/${made.policyId}`));
    if (made.applicationId) left.push(await deleteVerified(api, `application ${made.applicationId}`, `/iam/v1alpha1/applications/${made.applicationId}`));
    if (made.namespaceId) left.push(await deleteVerified(api, `namespace ${made.namespaceId}`, `/registry/v1/regions/${region}/namespaces/${made.namespaceId}`));
    return left.filter(Boolean);
}

export async function makePrivateRegistry(o: {
    runName: string, secretKey: string, projectId: string, region?: string, sourceImage?: string, log?: Log,
    /** What the IAM application's key may do: pull (default), or push too (for a provider that pushes images, as Vast's snapshots do). */
    access?: 'pull' | 'push',
}): Promise<PrivateRegistry> {
    const region = o.region ?? 'fr-par';
    const log = o.log ?? console.log;
    const api = scaleway(o.secretKey);
    const made: Made = {};
    try {
        const org = (await api.ok('GET', `/account/v3/projects/${o.projectId}`)).organization_id as string;
        const ns = await api.ok('POST', `/registry/v1/regions/${region}/namespaces`, { name: o.runName, project_id: o.projectId, is_public: false });
        made.namespaceId = ns.id;
        const host = `rg.${region}.scw.cloud`;
        const pushAuth: RegistryAuth = { username: 'nologin', password: o.secretKey, server: host };
        const image = `${host}/${o.runName}/busybox:1.36`;
        log(`private registry: copying ${o.sourceImage ?? 'busybox:1.36'} to ${image}`);
        await copyRegistryImage(o.sourceImage ?? 'busybox:1.36', image, { toAuth: pushAuth });
        const app = await api.ok('POST', '/iam/v1alpha1/applications', { name: o.runName, organization_id: org, description: 'asap-vps live run: pulls from its registry' });
        made.applicationId = app.id;
        const policy = await api.ok('POST', '/iam/v1alpha1/policies', {
            name: o.runName, organization_id: org, application_id: app.id,
            rules: [{ permission_set_names: [o.access === 'push' ? 'ContainerRegistryFullAccess' : 'ContainerRegistryReadOnly'], project_ids: [o.projectId] }],
        });
        made.policyId = policy.id;
        const key = await api.ok('POST', '/iam/v1alpha1/api-keys', {
            application_id: app.id, description: o.runName, expires_at: new Date(Date.now() + 3 * 3600_000).toISOString(),
        });
        made.apiKey = key.access_key;
        log(`private registry: ${image}, key ${key.access_key} (${o.access === 'push' ? 'pull and push' : 'pull-only'}, expires in 3 h)`);
        return {
            image,
            pullAuth: { username: 'nologin', password: key.secret_key, server: host },
            pushAuth,
            namespaceId: ns.id,
            cleanup: () => cleanupMade(o.secretKey, made, region),
        };
    } catch (e) {
        const left = await cleanupMade(o.secretKey, made, region).catch((x) => [`(cleanup failed: ${(x as Error).message})`]);
        throw new Error(`the private registry could not be made (${(e as Error).message})${left.length ? `; NOT deleted: ${left.join(', ')}` : ''}`);
    }
}

/** What earlier runs left of their registries (by RUN_PREFIX name), deleted and verified: what is still there. */
export async function sweepPrivateRegistries(o: { secretKey: string, projectId: string, region?: string }): Promise<string[]> {
    const region = o.region ?? 'fr-par';
    const api = scaleway(o.secretKey);
    const org = (await api.ok('GET', `/account/v3/projects/${o.projectId}`)).organization_id as string;
    const ours = (n: string) => typeof n === 'string' && n.startsWith(RUN_PREFIX);
    const apps = (await api.ok('GET', `/iam/v1alpha1/applications?organization_id=${org}&page_size=100`)).applications.filter((a: any) => ours(a.name));
    const left: string[] = [];
    for (const app of apps) {
        // An application's keys: its bearer's (the list needs the Organization).
        const keys = (await api.ok('GET', `/iam/v1alpha1/api-keys?organization_id=${org}&bearer_id=${app.id}&bearer_type=application&page_size=100`)).api_keys;
        const policies = (await api.ok('GET', `/iam/v1alpha1/policies?organization_id=${org}&application_ids=${app.id}&page_size=100`)).policies;
        for (const k of keys) left.push(await deleteVerified(api, `API key ${k.access_key}`, `/iam/v1alpha1/api-keys/${k.access_key}`));
        for (const p of policies) left.push(await deleteVerified(api, `policy ${p.id}`, `/iam/v1alpha1/policies/${p.id}`));
        left.push(await deleteVerified(api, `application ${app.id}`, `/iam/v1alpha1/applications/${app.id}`));
    }
    const namespaces = (await api.ok('GET', `/registry/v1/regions/${region}/namespaces?project_id=${o.projectId}&page_size=100`)).namespaces.filter((n: any) => ours(n.name));
    for (const n of namespaces) left.push(await deleteVerified(api, `namespace ${n.name}`, `/registry/v1/regions/${region}/namespaces/${n.id}`));
    return left.filter(Boolean);
}
