// The endpoint table (endpoints.ts) holds each Scaleway endpoint with its
// reference page. These checks are offline: that every entry follows the URL
// scheme of Scaleway's API reference (https://www.scaleway.com/en/developers/api),
// that no two entries claim one page, and how paths and queries are built. That
// each entry is Scaleway's (its method, path, operationId, query parameters and
// the page its summary gives it) is checked against the live OpenAPI specs by
// `npm run scaleway:spec` (scripts/scaleway-spec-check.ts), which needs the network.

import { fillPath, queryString, SCALEWAY_ENDPOINTS } from './endpoints';

describe('Scaleway endpoint table', () => {
    const entries = Object.entries(SCALEWAY_ENDPOINTS);

    it('documents every endpoint by the reference\'s own URL scheme: <api>/<page>#<summary slug>', () => {
        expect(entries.length).toBeGreaterThanOrEqual(18);
        for (const [name, e] of entries) {
            expect([name, e.docs]).toEqual([name, expect.stringMatching(
                /^https:\/\/www\.scaleway\.com\/en\/developers\/api\/(instance\/v1\/[a-z-]+|iam\/ssh-keys|block\/v1\/[a-z-]+|marketplace\/marketplace-[a-z-]+|serverless-containers\/v1\/[a-z-]+|file-storage\/v1alpha1\/[a-z-]+)#[a-z0-9]+(-[a-z0-9]+)*$/)]);
            expect([name, e.operationId]).toEqual([name, expect.stringMatching(/^[A-Z][A-Za-z]+$/)]);
            expect(['GET', 'POST', 'PATCH', 'DELETE']).toContain(e.method);
        }
    });

    it('puts each endpoint under its API\'s path: zonal for Instance and Block Storage, regional for Serverless Containers, global for IAM and the Marketplace', () => {
        const pages: Record<string, string> = {
            instance: 'instance/v1', block: 'block/v1', iam: 'iam', marketplace: 'marketplace', containers: 'serverless-containers/v1', file: 'file-storage/v1alpha1',
        };
        for (const [name, e] of entries) {
            const zonal = /^\/(instance\/v1|block\/v1)\/zones\/\{zone\}\//.test(e.path);
            const regional = /^\/(containers\/v1|file\/v1alpha1)\/regions\/\{region\}\//.test(e.path);
            const global = /^\/(iam\/v1alpha1|marketplace\/v2)\//.test(e.path);
            expect([name, [zonal, regional, global].filter(Boolean).length]).toEqual([name, 1]);
            // The page an endpoint is documented on is its API's.
            // An Instance endpoint of a filesystem is documented with the Instance API.
            expect([name, e.docs.includes(`/api/${pages[e.path.split('/')[1]]}/`)]).toEqual([name, true]);
        }
    });

    it('claims each reference entry once, and each (method, path) once', () => {
        expect(new Set(entries.map(([, e]) => e.docs)).size).toBe(entries.length);
        expect(new Set(entries.map(([, e]) => `${e.method} ${e.path}`)).size).toBe(entries.length);
    });

    it('names the calls that matter: a server is created, started by an action, and its user data is PATCHed', () => {
        expect(SCALEWAY_ENDPOINTS.createServer).toMatchObject({ method: 'POST', path: '/instance/v1/zones/{zone}/servers' });
        expect(SCALEWAY_ENDPOINTS.serverAction).toMatchObject({ method: 'POST', path: '/instance/v1/zones/{zone}/servers/{server_id}/action' });
        // Not PUT: Scaleway's spec has PATCH.
        expect(SCALEWAY_ENDPOINTS.setServerUserData).toMatchObject({ method: 'PATCH', path: '/instance/v1/zones/{zone}/servers/{server_id}/user_data/{key}' });
        expect(SCALEWAY_ENDPOINTS.createSSHKey.path).toBe('/iam/v1alpha1/ssh-keys');
        expect(SCALEWAY_ENDPOINTS.deleteBlockVolume.docs).toMatch(/#delete-a-detached-volume$/);
    });
});

describe('fillPath and queryString', () => {
    it('fills a path\'s placeholders, URL-encoded, and refuses one left unfilled', () => {
        expect(fillPath(SCALEWAY_ENDPOINTS.getServer.path, { zone: 'fr-par-2', server_id: '0000-1' })).toBe('/instance/v1/zones/fr-par-2/servers/0000-1');
        expect(fillPath('/x/{key}', { key: 'a b/c' })).toBe('/x/a%20b%2Fc');
        expect(() => fillPath(SCALEWAY_ENDPOINTS.getServer.path, { zone: 'fr-par-2' })).toThrow(/needs "server_id"/);
        expect(() => fillPath('/x/{zone}', { zone: '' })).toThrow(/needs "zone"/);
        expect(fillPath('/iam/v1alpha1/ssh-keys')).toBe('/iam/v1alpha1/ssh-keys');
    });

    it('builds a query from the values that are set (arrays comma-separated, false kept)', () => {
        expect(queryString({})).toBe('');
        expect(queryString({ page: 2, per_page: 100, public: false, name: undefined, tags: [] })).toBe('?page=2&per_page=100&public=false');
        expect(queryString({ tags: ['a', 'b'], name: 'x y' })).toBe('?tags=a%2Cb&name=x%20y');
    });
});
