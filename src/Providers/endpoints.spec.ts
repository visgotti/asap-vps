// Each platform's endpoint table (src/Providers/<Platform>/endpoints.ts) names
// its endpoints by its API reference's own URL scheme, and claims each
// reference entry and each request once. These checks are offline; that each
// entry is the platform's (its operation in the live spec, and the reference
// page that documents it) is checked by `npm run api:spec`
// (scripts/api-spec-check.ts), which needs the network. A request no entry
// describes is refused by the platform's API client: every test that drives a
// provider holds its requests to its table.

import type { ApiEndpoint } from '../Core/utils';
import { DIGITALOCEAN_ENDPOINTS } from './DigitalOcean/endpoints';
import { RUNPOD_ENDPOINTS } from './RunPod/endpoints';

const TABLES: Array<{ name: string, table: Readonly<Record<string, ApiEndpoint>>, docs: RegExp, operationId: RegExp }> = [
    {
        name: 'digitalocean', table: DIGITALOCEAN_ENDPOINTS,
        docs: /^https:\/\/docs\.digitalocean\.com\/reference\/api\/reference\/[a-z0-9-]+\/#[A-Za-z]+_[A-Za-z_]+$/, operationId: /^[A-Za-z]+_[A-Za-z_]+$/,
    },
    { name: 'runpod', table: RUNPOD_ENDPOINTS, docs: /^https:\/\/docs\.runpod\.io\/api-reference-v2\/[a-z0-9-]+\/[a-z0-9-]+$/, operationId: /^[a-z][A-Za-z]+$/ },
];

describe.each(TABLES)('$name endpoint table', ({ table, docs, operationId }) => {
    const entries = Object.entries(table);

    it('documents each endpoint by the reference\'s URL scheme, and names its operation as the spec does', () => {
        expect(entries.length).toBeGreaterThan(0);
        for (const [name, e] of entries) {
            expect([name, e.docs]).toEqual([name, expect.stringMatching(docs)]);
            if (e.operationId !== undefined) expect([name, e.operationId]).toEqual([name, expect.stringMatching(operationId)]);
            // The reference anchors an operation by its id: the entry's.
            if (e.operationId !== undefined && e.docs.includes('#')) expect([name, e.docs.split('#')[1]]).toEqual([name, e.operationId]);
            expect([name, e.path]).toEqual([name, expect.stringMatching(/^\/[A-Za-z0-9_\-/{}.]*$/)]);
            // A departure from the spec says what it rests on.
            if (e.unspecified) expect([name, e.unspecified.source]).toEqual([name, expect.stringMatching(/\w.{20,}/)]);
        }
    });

    it('claims each request once, and each reference entry once', () => {
        expect(new Set(entries.map(([, e]) => `${e.method} ${e.path}`)).size).toBe(entries.length);
        expect(new Set(entries.map(([, e]) => e.docs)).size).toBe(entries.length);
    });
});
