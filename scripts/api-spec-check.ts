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
import * as ts from 'typescript';
import * as yaml from 'js-yaml';
import type { ApiEndpoint } from '../src/Core/utils';
import { DIGITALOCEAN_ENDPOINTS } from '../src/Providers/DigitalOcean/endpoints';
import { LAMBDA_ENDPOINTS } from '../src/Providers/LambdaCloud/endpoints';
import { RUNPOD_ENDPOINTS } from '../src/Providers/RunPod/endpoints';
import { VAST_ENDPOINTS } from '../src/Providers/VastAI/endpoints';

type Op = { method: string, path: string, operationId?: string, summary?: string, tags: string[], query: Set<string> };
type Platform = {
    /** The spec's URL, and the file name --specs reads it from. */
    spec: string,
    file: string,
    table: Readonly<Record<string, ApiEndpoint>>,
    /** false: a path's trailing slash is not significant to the platform (it documents both), so it is not compared. */
    trailingSlash?: false,
    /** The reference URL the platform gives an operation; undefined where its scheme cannot name it. */
    docs(op: Op): string | undefined,
    /** Whether the reference page at `url` documents `op` (its text read once per page). */
    documents(url: string, op: Op | undefined, page: (u: string) => Promise<string | undefined>): Promise<boolean>,
    /**
     * The wire types held to the spec: each type of `file` and the spec schema it is. Each field
     * must be one of the schema's, of its kind (an array's elements too), and allow null where the
     * spec does. Required-ness is not compared: the platform marks few answer fields required.
     */
    types?: { file: string, schemas: Readonly<Record<string, string>> },
};

/** "List registered SSH public keys" -> "list-registered-ssh-public-keys". */
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

const PLATFORMS: Record<string, Platform> = {
    digitalocean: {
        spec: 'https://api-engineering.nyc3.cdn.digitaloceanspaces.com/spec-ci/DigitalOcean-public.v2.yaml',
        file: 'digitalocean.yaml',
        table: DIGITALOCEAN_ENDPOINTS,
        types: {
            file: 'src/Providers/DigitalOcean/types.ts',
            schemas: {
                DigitalOceanDropletData: 'droplet', DigitalOceanSizeData: 'size', DigitalOceanGpuInfo: 'gpu_info', DigitalOceanImageData: 'image',
                DigitalOceanNetworkData: 'network_v4', DigitalOceanVolumeData: 'volume_full', DigitalOceanSSHData: 'sshKeys', DigitalOceanAction: 'action',
                DigitalOceanNfsShare: 'nfs_response', DigitalOceanVpc: 'vpc',
            },
        },
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
    lambda: {
        spec: 'https://cloud.lambda.ai/api/v1/openapi.json',
        file: 'lambda.json',
        table: LAMBDA_ENDPOINTS,
        // One page; an operation at #<operationId> (the page links each so).
        docs: (op) => (op.operationId ? `https://docs.lambda.ai/api/cloud#${op.operationId}` : undefined),
        documents: async (url, op, page) => {
            const [base, anchor] = url.split('#');
            const text = await page(base);
            return !!text && !!anchor && text.includes(`"#${anchor}"`) && (!op?.operationId || anchor === op.operationId);
        },
    },
    vast: {
        // The spec the reference is built from (Vast's openapi.json differs from it only by trailing slashes, and has fewer paths).
        spec: 'https://docs.vast.ai/api-reference/openapi.yaml',
        file: 'vast.yaml',
        table: VAST_ENDPOINTS,
        trailingSlash: false,
        // A page per operation: <tag>/<summary>, its markdown at .md.
        docs: (op) => (op.tags[0] && op.summary ? `https://docs.vast.ai/api-reference/${slug(op.tags[0])}/${slug(op.summary)}` : undefined),
        documents: mintlifyPage,
    },
};

/** A page (a GitHub file read raw) that has the path's last fixed segment: what documents a call the spec does not have. */
async function sourceHas(url: string, apiPath: string, page: (u: string) => Promise<string | undefined>): Promise<boolean> {
    const raw = url.replace(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/blob\//, 'https://raw.githubusercontent.com/$1/');
    const text = await page(raw.split('#')[0]);
    const fixed = apiPath.split('/').filter((s) => s && !s.startsWith('{')).pop();
    return !!text && !!fixed && text.includes(fixed);
}

/** A Mintlify reference page: its markdown (at .md) names the operation's method and path. */
async function mintlifyPage(url: string, op: Op | undefined, page: (u: string) => Promise<string | undefined>): Promise<boolean> {
    const text = await page(`${url}.md`);
    return !!text && (!op || text.includes(`${op.method.toLowerCase()} ${op.path}`) || text.includes(`${op.method} ${op.path}`));
}

/** A page's text (undefined for an answer that is not a success): a network failure is tried again, twice. */
async function get(url: string): Promise<string | undefined> {
    for (let attempt = 1; ; attempt++) {
        try {
            const r = await fetch(url);
            return r.ok ? await r.text() : undefined;
        } catch (e) {
            if (attempt >= 3) throw new Error(`${url}: ${(e as Error).message}`);
            await new Promise((done) => setTimeout(done, 2000 * attempt));
        }
    }
}

async function load(p: Platform, dir: string | undefined): Promise<any> {
    const parse = (text: string, name: string) => (name.endsWith('.json') ? JSON.parse(text) : yaml.load(text));
    if (dir) return parse(fs.readFileSync(path.join(dir, p.file), 'utf8'), p.file);
    const text = await get(p.spec);
    if (text === undefined) throw new Error(`${p.spec} could not be read`);
    return parse(text, p.spec);
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

async function check(name: string, p: Platform, dir: string | undefined, readDocs: boolean): Promise<string[]> {
    /** A path with its placeholders unnamed ('/v2/droplets/{}'), and no trailing slash where that is not significant. */
    const shape = (x: string) => {
        const unnamed = x.replace(/\{[^}]+\}/g, '{}');
        return p.trailingSlash === false ? unnamed.replace(/\/$/, '') : unnamed;
    };
    const failures: string[] = [];
    const spec = await load(p, dir);
    const ops = operations(spec);

    const pages = new Map<string, Promise<string | undefined>>();
    const page = (u: string) => {
        if (!pages.has(u)) pages.set(u, get(u).catch(() => undefined));
        return pages.get(u)!;
    };
    console.log(`\n${name}: ${Object.keys(p.table).length} endpoints${p.types ? ` and ${Object.keys(p.types.schemas).length} wire types` : ''}, against ${dir ? path.join(dir, p.file) : p.spec} (${spec.info?.title} ${spec.info?.version})`);
    failures.push(...checkTypes(name, p, spec));
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
        const documented = op ? await p.documents(e.docs, op, page) : await sourceHas(e.docs, e.path, page);
        if (readDocs && !documented) fail(`docs ${e.docs} does not document it (the page is missing, or does not have it)`);
    }
    return failures;
}

/** Each wire type's fields against its spec schema: there, of its kind, and nullable where the spec is. */
function checkTypes(name: string, p: Platform, spec: any): string[] {
    if (!p.types) return [];
    const failures: string[] = [];
    const deref = (n: any): any => (n?.$ref ? deref(n.$ref.split('/').slice(1).reduce((o: any, k: string) => o?.[k], spec)) : n);
    /** A schema's fields, its allOf parts' included. */
    const fields = (n: any): Record<string, any> => {
        n = deref(n);
        return Object.assign({}, n?.properties ?? {}, ...(n?.allOf ?? []).map(fields));
    };
    const nullable = (n: any): boolean => {
        n = deref(n);
        return !!(n?.nullable || (Array.isArray(n?.type) && n.type.includes('null')) || (n?.allOf ?? []).some(nullable));
    };
    const specKind = (n: any): string | undefined => {
        n = deref(n);
        if (!n) return undefined;
        if (n.allOf) return n.allOf.map(specKind).find(Boolean);
        if (n.oneOf || n.anyOf) return undefined;
        const t = Array.isArray(n.type) ? n.type.find((x: string) => x !== 'null') : n.type;
        if (t === 'integer') return 'number';
        return t ?? (n.properties ? 'object' : n.enum ? 'string' : undefined);
    };
    const program = ts.createProgram([p.types.file], { strict: true, skipLibCheck: true, noEmit: true });
    const checker = program.getTypeChecker();
    const decls = new Map<string, ts.TypeAliasDeclaration>();
    program.getSourceFile(p.types.file)!.forEachChild((n) => {
        if (ts.isTypeAliasDeclaration(n)) decls.set(n.name.text, n);
    });
    const tsKind = (t: ts.Type): string | undefined => {
        const rest = t.isUnion() ? t.types.filter((x) => !(x.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined))) : [t];
        if (rest.length && rest.every((x) => x.flags & ts.TypeFlags.StringLike)) return 'string';
        if (rest.length && rest.every((x) => x.flags & ts.TypeFlags.NumberLike)) return 'number';
        if (rest.length && rest.every((x) => x.flags & ts.TypeFlags.BooleanLike)) return 'boolean';
        if (rest.length !== 1) return undefined;
        if (checker.isArrayType(rest[0]) || checker.isTupleType(rest[0])) return 'array';
        return rest[0].flags & ts.TypeFlags.Object ? 'object' : undefined;
    };
    const element = (t: ts.Type): ts.Type | undefined => {
        const rest = t.isUnion() ? t.types.filter((x) => !(x.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined))) : [t];
        return rest[0] && checker.isArrayType(rest[0]) ? checker.getTypeArguments(rest[0] as ts.TypeReference)[0] : undefined;
    };
    for (const [alias, schema] of Object.entries(p.types.schemas)) {
        const fail = (why: string) => failures.push(`${name} types: ${alias}${why}`);
        const decl = decls.get(alias);
        if (!decl) {
            fail(`: not declared in ${p.types.file}`);
            continue;
        }
        if (!spec.components?.schemas?.[schema]) {
            fail(`: the spec has no schema ${schema}`);
            continue;
        }
        const specFields = fields(spec.components.schemas[schema]);
        for (const prop of checker.getPropertiesOfType(checker.getTypeAtLocation(decl))) {
            const t = checker.getTypeOfSymbolAtLocation(prop, decl);
            const s = specFields[prop.name];
            if (!s) {
                fail(`.${prop.name}: not a field of the spec's ${schema}`);
                continue;
            }
            const tk = tsKind(t);
            const sk = specKind(s);
            if (tk && sk && tk !== sk) fail(`.${prop.name}: typed ${tk} (${checker.typeToString(t)}), the spec's is ${sk}`);
            if (tk === 'array' && sk === 'array') {
                const te = element(t);
                const ek = te && tsKind(te);
                const sek = specKind(deref(s).items ?? deref(s).allOf?.map(deref).find((x: any) => x?.items)?.items);
                if (ek && sek && ek !== sek) fail(`.${prop.name}[]: typed ${ek}, the spec's is ${sek}`);
            }
            const tsNull = t.isUnion() && t.types.some((x) => x.flags & ts.TypeFlags.Null);
            if (nullable(s) && !tsNull) fail(`.${prop.name}: the spec allows null, and the type (${checker.typeToString(t)}) does not`);
        }
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
