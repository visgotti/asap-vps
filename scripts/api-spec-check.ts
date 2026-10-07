// Holds the endpoint tables of DigitalOcean, RunPod, Vast.ai and Lambda
// (src/Providers/<Platform>/endpoints.ts) to each platform's own OpenAPI spec
// and API reference, first-hand, and fails when they drift:
//
//   npm run api:spec                              every platform, specs and reference pages read live
//   npm run api:spec -- runpod lambda             those platforms only
//   npm run api:spec -- --specs DIR               reads <platform>.json / .yaml from DIR instead of the spec URL
//   npm run api:spec -- --no-docs                 does not read the reference pages
//
// What it checks, for every entry:
//   - the spec has the operation (its method, and its path with the
//     placeholders where the entry has them), with the entry's operationId;
//   - every query parameter sent is one the operation declares;
//   - the `docs` URL is the one the reference gives the operation (each
//     platform's scheme below), and that page documents it (reads it);
//   - a departure the entry records (`unspecified`: an operation the spec does
//     not have, its path in the spec, or query parameters it does not declare)
//     still departs: it is listed, not failed, but one the spec has caught up
//     with fails, to be written as the spec has it.
// Scaleway's table has its own, deeper check: npm run scaleway:spec.

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import type { ApiEndpoint } from '../src/Core/utils';
import { DIGITALOCEAN_ENDPOINTS } from '../src/Providers/DigitalOcean/endpoints';
import { RUNPOD_ENDPOINTS } from '../src/Providers/RunPod/endpoints';

type Op = { method: string, path: string, operationId?: string, summary?: string, tags: string[], query: Set<string> };
type Platform = {
    /** The spec's URL, and the file name --specs reads it from. */
    spec: string,
    file: string,
    table: Readonly<Record<string, ApiEndpoint>>,
    /** The reference URL the platform gives an operation; undefined where its scheme cannot name it. */
    docs(op: Op): string | undefined,
    /** Whether the reference page at `url` documents `op` (its text read once per page). */
    documents(url: string, op: Op | undefined, page: (u: string) => Promise<string | undefined>): Promise<boolean>,
};

/** "List registered SSH public keys" -> "list-registered-ssh-public-keys". */
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

const PLATFORMS: Record<string, Platform> = {
    digitalocean: {
        spec: 'https://api-engineering.nyc3.cdn.digitaloceanspaces.com/spec-ci/DigitalOcean-public.v2.yaml',
        file: 'digitalocean.yaml',
        table: DIGITALOCEAN_ENDPOINTS,
        // A page per tag; an operation at #<operationId> (the page's markdown links each so).
        docs: (op) => (op.tags[0] && op.operationId ? `https://docs.digitalocean.com/reference/api/reference/${slug(op.tags[0])}/#${op.operationId}` : undefined),
        documents: async (url, op, page) => {
            const [base, anchor] = url.split('#');
            const text = await page(`${base}index.html.md`);
            return !!text && (!anchor || text.includes(`(#${anchor})`)) && (!op?.operationId || anchor === op.operationId);
        },
    },
    runpod: {
        spec: 'https://api.runpod.io/v2/openapi.json',
        file: 'runpod.json',
        table: RUNPOD_ENDPOINTS,
        // A page per operation: <tag>/<summary>, its markdown at .md (the operation's method and path in it).
        docs: (op) => (op.tags[0] && op.summary ? `https://docs.runpod.io/api-reference-v2/${slug(op.tags[0])}/${slug(op.summary)}` : undefined),
        documents: mintlifyPage,
    },
};

/** A Mintlify reference page: its markdown (at .md) names the operation's method and path. */
async function mintlifyPage(url: string, op: Op | undefined, page: (u: string) => Promise<string | undefined>): Promise<boolean> {
    const text = await page(`${url}.md`);
    return !!text && (!op || text.includes(`${op.method.toLowerCase()} ${op.path}`) || text.includes(`${op.method} ${op.path}`));
}

function load(p: Platform, dir: string | undefined): Promise<any> {
    const parse = (text: string, name: string) => (name.endsWith('.json') ? JSON.parse(text) : yaml.load(text));
    if (dir) return Promise.resolve(parse(fs.readFileSync(path.join(dir, p.file), 'utf8'), p.file));
    return fetch(p.spec).then(async (r) => {
        if (!r.ok) throw new Error(`${p.spec} -> ${r.status}`);
        return parse(await r.text(), p.spec);
    });
}

/** Every operation of a spec, with the query parameters it declares (its own and its path's, $refs followed). */
function operations(spec: any): Op[] {
    const param = (x: any) => (x?.$ref ? x.$ref.split('/').slice(1).reduce((o: any, k: string) => o?.[k], spec) : x);
    const out: Op[] = [];
    for (const [p, item] of Object.entries<any>(spec.paths ?? {})) {
        for (const m of ['get', 'post', 'put', 'patch', 'delete']) {
            const op = item[m];
            if (!op) continue;
            const query = new Set<string>([...(item.parameters ?? []), ...(op.parameters ?? [])].map(param).filter((x) => x?.in === 'query').map((x) => x.name));
            out.push({ method: m.toUpperCase(), path: p, operationId: op.operationId, summary: op.summary, tags: op.tags ?? [], query });
        }
    }
    return out;
}

/** A path with its placeholders unnamed: '/v2/droplets/{}'. */
const shape = (p: string) => p.replace(/\{[^}]+\}/g, '{}');

async function check(name: string, p: Platform, dir: string | undefined, readDocs: boolean): Promise<string[]> {
    const failures: string[] = [];
    const spec = await load(p, dir);
    const ops = operations(spec);
    const pages = new Map<string, Promise<string | undefined>>();
    const page = (u: string) => {
        if (!pages.has(u)) pages.set(u, fetch(u).then((r) => (r.ok ? r.text() : undefined), () => undefined));
        return pages.get(u)!;
    };
    console.log(`\n${name}: ${Object.keys(p.table).length} endpoints, against ${dir ? path.join(dir, p.file) : p.spec} (${spec.info?.title} ${spec.info?.version})`);
    for (const [key, e] of Object.entries(p.table)) {
        const fail = (why: string) => failures.push(`${name}.${key}: ${why}`);
        const departs = e.unspecified;
        const specPath = departs && 'path' in departs ? departs.path : e.path;
        const op = specPath === null ? undefined : ops.find((o) => o.method === e.method && shape(o.path) === shape(specPath ?? e.path));
        if (specPath === null) {
            const now = ops.find((o) => o.method === e.method && shape(o.path) === shape(e.path));
            if (now) fail(`the spec has ${e.method} ${now.path} now (${now.operationId ?? now.summary}): write it as the spec has it`);
            else console.log(`  ~ ${key}: ${e.method} ${e.path} is not in the spec (${departs!.source})`);
        } else if (!op) {
            fail(`the spec has no ${e.method} ${specPath}`);
            continue;
        } else {
            if (departs?.path) {
                if (shape(op.path) === shape(e.path)) fail(`its path in the spec is the one it is sent with: drop unspecified.path`);
                else console.log(`  ~ ${key}: sent as ${e.path}, the spec's ${op.path} (${departs.source})`);
            }
            if ((e.operationId ?? undefined) !== op.operationId) fail(`operationId ${e.operationId ?? '(none)'}: the spec's is ${op.operationId ?? '(none)'}`);
            for (const q of e.query ?? []) {
                const declared = op.query.has(q);
                const recorded = departs?.query?.includes(q);
                if (!declared && !recorded) fail(`query parameter "${q}" is not the operation's (it has: ${[...op.query].join(', ') || 'none'})`);
                if (declared && recorded) fail(`query parameter "${q}" is the operation's now: drop it from unspecified.query`);
                if (!declared && recorded) console.log(`  ~ ${key}: sends "${q}", which the spec does not declare (${departs!.source})`);
            }
            const want = p.docs(op);
            if (want && e.docs !== want) fail(`docs ${e.docs}: the reference gives it ${want}`);
        }
        if (readDocs && !await p.documents(e.docs, op, page)) fail(`docs ${e.docs} does not document it (the page is missing, or does not have it)`);
    }
    return failures;
}

async function main(): Promise<void> {
    const args = process.argv.slice(2);
    const at = args.indexOf('--specs');
    const dir = at >= 0 ? args[at + 1] : undefined;
    const readDocs = !args.includes('--no-docs');
    const names = args.filter((a, i) => !a.startsWith('--') && (at < 0 || i !== at + 1));
    for (const n of names) if (!PLATFORMS[n]) throw new Error(`no platform "${n}" (there are: ${Object.keys(PLATFORMS).join(', ')})`);
    const failures: string[] = [];
    for (const n of names.length ? names : Object.keys(PLATFORMS)) failures.push(...await check(n, PLATFORMS[n], dir, readDocs));
    if (failures.length) {
        console.error(`\n${failures.length} drift(s):\n${failures.map((f) => `  ✗ ${f}`).join('\n')}`);
        process.exit(1);
    }
    console.log('\nevery endpoint is its platform\'s, as its reference documents it');
}

main().catch((e) => {
    console.error(e);
    process.exit(2);
});
