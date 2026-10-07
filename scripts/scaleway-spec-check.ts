// Holds the Scaleway provider's typings and endpoint table to Scaleway's own
// OpenAPI specs, first-hand, and fails when they drift:
//
//   npm run scaleway:spec                 reads the six specs from scaleway.com
//   npm run scaleway:spec -- --specs DIR  reads instance.yml, iam.yml, block.yml, marketplace.yml, containers.yml, file.yml from DIR
//   npm run scaleway:spec -- --live       also reads the public catalog answers of the live API
//   npm run scaleway:spec -- --suggest    names, for a type without one, the reference pages that document it
//   npm run scaleway:spec -- --no-docs    does not read the reference pages
//
// What it checks (src/Providers/Scaleway/endpoints.ts and types.ts):
//   - every endpoint exists in its spec with that method, path and operationId,
//     sends only query parameters the operation has, and its `docs` URL is the
//     one the API reference gives the operation (`<api>/<tag>#<summary>`): the
//     page is read, and must be there and have that anchor;
//   - every enum type has the members of its spec enum, and every enum-valued
//     field the members of its field's enum;
//   - every field of every object type is a field of its spec schema, of the
//     same kind (string, number, boolean, array, map, object, enum) and, where
//     it names another type, of the schema that field has; a field the spec does
//     not list must be named in LIVE_ONLY below (seen in the live API: --live
//     checks that it still is), and a field the spec requires must be required;
//   - every type's doc comment cites a reference page, and that page documents
//     the type (an operation of it takes or returns the type's schema);
//   - the zones are the spec's `zone` parameter's.
// A spec field the types do not model is listed (not failed): leaving a field
// out is a choice, but it should be a visible one.

import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import * as yaml from 'js-yaml';
import { SCALEWAY_ENDPOINTS } from '../src/Providers/Scaleway/endpoints';
import type { ScalewayEndpoint } from '../src/Providers/Scaleway/endpoints';
import { SCALEWAY_ZONES } from '../src/Providers/Scaleway/types';

type Api = 'instance' | 'iam' | 'block' | 'marketplace' | 'containers' | 'file';
type Node = any;

const DOCS = 'https://www.scaleway.com/en/developers/api';
/** Each API's spec, and where its pages are in the API reference. */
const APIS: Record<Api, { spec: string, page: string, file: string }> = {
    instance: { spec: 'instance/v1', page: 'instance/v1', file: 'instance.yml' },
    iam: { spec: 'iam/v1alpha1', page: 'iam', file: 'iam.yml' },
    block: { spec: 'block/v1', page: 'block/v1', file: 'block.yml' },
    marketplace: { spec: 'marketplace/v2', page: 'marketplace', file: 'marketplace.yml' },
    // Serverless Containers: its paths are /containers/v1/..., its schemas scaleway.containers.v1.*.
    containers: { spec: 'serverless-containers/v1', page: 'serverless-containers/v1', file: 'containers.yml' },
    // File Storage: its paths are /file/v1alpha1/..., its schemas scaleway.file.v1alpha1.*.
    // Its pages have no version in their path: /file-storage/<tag>, not /file-storage/v1alpha1/<tag> (a 404).
    file: { spec: 'file-storage/v1alpha1', page: 'file-storage', file: 'file.yml' },
};

/** A TypeScript enum type and the spec enum it must have the members of. */
const ENUMS: Record<string, [Api, string]> = {
    ScalewayArch: ['instance', 'Arch'],
    ScalewayBootType: ['instance', 'BootType'],
    ScalewayServerState: ['instance', 'Server.State'],
    ScalewayServerAction: ['instance', 'Server.Action'],
    ScalewayServerTypesAvailability: ['instance', 'ServerTypesAvailability'],
    ScalewayVolumeType: ['instance', 'Volume.VolumeType'],
    ScalewayServerVolumeType: ['instance', 'VolumeServer.VolumeType'],
    ScalewayVolumeState: ['instance', 'Volume.State'],
    ScalewayImageState: ['instance', 'Image.State'],
    ScalewayInstanceSnapshotState: ['instance', 'Snapshot.State'],
    ScalewaySnapshotVolumeType: ['instance', 'Snapshot.VolumeType'],
    ScalewayIpFamily: ['instance', 'Server.Ip.IpFamily'],
    ScalewayIpState: ['instance', 'Server.Ip.State'],
    ScalewayIpProvisioningMode: ['instance', 'Server.Ip.ProvisioningMode'],
    ScalewayTaskStatus: ['instance', 'Task.Status'],
    ScalewayBlockVolumeStatus: ['block', 'Volume.Status'],
    ScalewayAttachVolumeType: ['instance', 'AttachServerVolumeRequest.VolumeType'],
    ScalewayBlockReferenceType: ['block', 'Reference.Type'],
    ScalewayBlockReferenceStatus: ['block', 'Reference.Status'],
    ScalewayContainerStatus: ['containers', 'Container.Status'],
    ScalewayContainerNamespaceStatus: ['containers', 'Namespace.Status'],
    ScalewayContainerPrivacy: ['containers', 'Container.Privacy'],
    ScalewayContainerProtocol: ['containers', 'Container.Protocol'],
    ScalewayContainerSandbox: ['containers', 'Container.Sandbox'],
    ScalewayFileSystemStatus: ['file', 'FileSystem.Status'],
    ScalewayBlockSnapshotStatus: ['block', 'Snapshot.Status'],
    ScalewayServerFileSystemState: ['instance', 'Server.Filesystem.State'],
};

/**
 * A TypeScript object type and the spec schema it is: a schema's name, or, for
 * a request body the spec defines inline, `request:<endpoint>`.
 */
const OBJECTS: Record<string, [Api, string]> = {
    ScalewayVolumeConstraintSizes: ['instance', 'ServerType.VolumeConstraintSizes'],
    ScalewayGpuInfo: ['instance', 'ServerType.GPUInfo'],
    ScalewayServerTypeCapabilities: ['instance', 'ServerType.Capabilities'],
    ScalewayServerTypeNetwork: ['instance', 'ServerType.Network'],
    ScalewayServerType: ['instance', 'ServerType'],
    ScalewayServerIp: ['instance', 'Server.Ip'],
    ScalewayServerIpv6: ['instance', 'Server.Ipv6'],
    ScalewayServerVolume: ['instance', 'VolumeServer'],
    ScalewayServerSummary: ['instance', 'ServerSummary'],
    ScalewayServer: ['instance', 'Server'],
    ScalewayVolumeTemplate: ['instance', 'VolumeServerTemplate'],
    ScalewayCreateServerBody: ['instance', 'request:createServer'],
    ScalewayFileSystem: ['file', 'FileSystem'],
    ScalewayBlockSnapshot: ['block', 'Snapshot'],
    ScalewayInstanceSnapshot: ['instance', 'Snapshot'],
    ScalewayImportBlockSnapshotBody: ['block', 'request:importBlockSnapshot'],
    ScalewayExportBlockSnapshotBody: ['block', 'request:exportBlockSnapshot'],
    ScalewayCreateImageBody: ['instance', 'request:createImage'],
    ScalewayCreateFileSystemBody: ['file', 'request:createFileSystem'],
    ScalewayServerFileSystem: ['instance', 'Server.Filesystem'],
    ScalewayServerFileSystemBody: ['instance', 'request:attachServerFileSystem'],
    ScalewayContainer: ['containers', 'Container'],
    ScalewayContainerNamespace: ['containers', 'Namespace'],
    ScalewayCreateContainerBody: ['containers', 'request:createContainer'],
    ScalewayCreateContainerNamespaceBody: ['containers', 'request:createContainerNamespace'],
    ScalewayServerActionBody: ['instance', 'request:serverAction'],
    ScalewayAttachServerVolumeBody: ['instance', 'request:attachServerVolume'],
    ScalewayDetachServerVolumeBody: ['instance', 'request:detachServerVolume'],
    ScalewayUpdateServerBody: ['instance', 'request:updateServer'],
    ScalewayTask: ['instance', 'Task'],
    ScalewayVolumeSummary: ['instance', 'VolumeSummary'],
    ScalewayVolume: ['instance', 'Volume'],
    ScalewayImage: ['instance', 'Image'],
    ScalewayBlockReference: ['block', 'Reference'],
    ScalewayBlockVolume: ['block', 'Volume'],
    ScalewayBlockVolumeFromEmpty: ['block', 'CreateVolumeRequest.FromEmpty'],
    ScalewayCreateBlockVolumeBody: ['block', 'request:createBlockVolume'],
    ScalewayCreateSSHKeyBody: ['iam', 'request:createSSHKey'],
    ScalewaySSHKey: ['iam', 'SSHKey'],
    ScalewayMarketplaceImage: ['marketplace', 'Image'],
};

/**
 * Fields compared with their spec schema by nothing: by `Type.field`, and why. A field of no one kind on
 * either side (a union of kinds, an intersection the check cannot read) fails unless it is named here.
 */
const UNCOMPARED: Record<string, string> = {
    'ScalewayUpdateServerBody.tags[]': 'the spec gives the array no items schema (`type: [array, null]` only); a server\'s tags are strings (Server.tags is string[])',
};

/** Fields the live API sends that its spec does not list, by TypeScript type: --live checks they are still sent. */
const LIVE_ONLY: Record<string, string[]> = {
    ScalewayServerType: ['mig_profile'],
    ScalewayServerTypeCapabilities: ['placement_groups', 'hot_snapshots_local_volume', 'private_network'],
};

/** The public catalog answers --live reads (no key needed), the type each answer's entries are, and where they are. */
const LIVE_CATALOG: Array<{ type: string, url: string, entries: (body: any) => any[] }> = [
    { type: 'ScalewayServerType', url: 'https://api.scaleway.com/instance/v1/zones/fr-par-1/products/servers?per_page=100', entries: (b) => Object.values(b.servers) },
    { type: 'ScalewayMarketplaceImage', url: 'https://api.scaleway.com/marketplace/v2/images?page_size=100', entries: (b) => b.images },
];

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const option = (name: string) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : undefined);

let failures = 0;
const fail = (message: string) => {
    failures++;
    console.log(`  FAIL ${message}`);
};
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** Each reference page read once (a network failure tried again, twice): undefined where it is not there. */
const pages = new Map<string, Promise<string | undefined>>();
async function read(url: string): Promise<string | undefined> {
    for (let attempt = 1; ; attempt++) {
        try {
            const r = await fetch(url);
            return r.ok ? await r.text() : undefined;
        } catch (e) {
            if (attempt >= 3) return undefined;
            await new Promise((done) => setTimeout(done, 2000 * attempt));
        }
    }
}
/** Whether the reference has the page, with the anchor: what a URL derived from the spec cannot say of itself. */
async function onPage(url: string): Promise<boolean> {
    if (flag('no-docs')) return true;
    const [base, anchor] = url.split('#');
    if (!pages.has(base)) pages.set(base, read(base));
    const html = await pages.get(base)!;
    return !!html && (!anchor || html.includes(anchor));
}

// ── the specs ────────────────────────────────────────────────────────────

class Spec {
    readonly paths: Record<string, Record<string, Node>>;
    readonly schemas: Record<string, Node>;
    readonly prefix: string;

    constructor(readonly api: Api, doc: Node) {
        this.paths = doc.paths;
        this.schemas = doc.components.schemas;
        // The API's own schemas are `scaleway.<api>.<version>.<Name>` (the standard ones, `scaleway.std.Money`, are shared).
        this.prefix = Object.keys(this.schemas).map((k) => new RegExp(`^(scaleway\\.${api}\\.[a-z0-9]+\\.)`).exec(k)?.[1]).find(Boolean)!;
    }

    key(name: string) {
        return `${this.prefix}${name}`;
    }

    schema(name: string): Node | undefined {
        return this.schemas[this.key(name)];
    }

    /** A schema node with a `$ref`, or an `allOf` of one, replaced by what it names; `ref` is the name of the schema it was. */
    norm(node: Node): { node: Node, ref?: string } {
        if (node?.allOf?.length === 1) return this.norm(node.allOf[0]);
        if (node?.$ref) {
            const key = String(node.$ref).split('/').pop()!;
            return { node: this.schemas[key], ref: key.slice(this.prefix.length) };
        }
        return { node };
    }

    operation(method: string, p: string): Node | undefined {
        return this.paths[p]?.[method.toLowerCase()];
    }

    /** The schema of an operation's JSON request body. */
    requestSchema(op: Node): Node | undefined {
        return op.requestBody?.content?.['application/json']?.schema;
    }

    /** Every schema (by name) an operation takes or returns, however deep. */
    reach(op: Node): Set<string> {
        const seen = new Set<string>();
        const walk = (node: Node): void => {
            if (!node || typeof node !== 'object') return;
            if (node.$ref) {
                const key = String(node.$ref).split('/').pop()!;
                if (seen.has(key)) return;
                seen.add(key);
                return walk(this.schemas[key]);
            }
            for (const k of ['properties', 'additionalProperties', 'items', 'allOf', 'oneOf', 'anyOf']) {
                const v = node[k];
                if (Array.isArray(v)) v.forEach(walk);
                else if (k === 'properties' && v) Object.values(v).forEach(walk);
                else walk(v);
            }
        };
        walk(this.requestSchema(op));
        for (const [status, r] of Object.entries<Node>(op.responses ?? {})) if (status.startsWith('2')) walk(r.content?.['application/json']?.schema);
        return new Set([...seen].map((k) => k.slice(this.prefix.length)));
    }

    /** The reference page of an operation: the page of its tag, at its summary. */
    docs(op: Node): string {
        return op.tags?.length ? `${DOCS}/${APIS[this.api].page}/${slug(op.tags[0])}#${slug(op.summary)}` : '';
    }

    operations(): Array<{ method: string, path: string, op: Node }> {
        return Object.entries(this.paths).flatMap(([p, ops]) => Object.entries(ops).filter(([m]) => /^(get|post|put|patch|delete)$/.test(m)).map(([method, op]) => ({ method, path: p, op })));
    }
}

async function loadSpec(api: Api): Promise<Spec> {
    const dir = option('specs');
    const text = dir
        ? fs.readFileSync(path.join(dir, APIS[api].file), 'utf8')
        : await (await fetch(`${DOCS}/${APIS[api].spec}/schema.yml`)).text();
    return new Spec(api, yaml.load(text));
}

// ── the types ────────────────────────────────────────────────────────────

type TsKind =
    | { kind: 'string' | 'number' | 'boolean' | 'unknown' }
    | { kind: 'enum', values: string[], alias?: string }
    | { kind: 'array', element: ts.Type }
    | { kind: 'map', element: ts.Type }
    | { kind: 'object', type: ts.Type, alias?: string };

class Types {
    readonly program: ts.Program;
    readonly checker: ts.TypeChecker;
    readonly file: ts.SourceFile;
    readonly declarations = new Map<string, ts.TypeAliasDeclaration>();

    constructor(fileName: string) {
        this.program = ts.createProgram([fileName], { strict: true, target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, skipLibCheck: true, noEmit: true });
        this.checker = this.program.getTypeChecker();
        this.file = this.program.getSourceFile(fileName)!;
        this.file.forEachChild((n) => {
            if (ts.isTypeAliasDeclaration(n)) this.declarations.set(n.name.text, n);
        });
    }

    type(name: string): ts.Type {
        return this.checker.getTypeAtLocation(this.declarations.get(name)!);
    }

    /** The doc comment (`/** ... *\/`) of a declaration. */
    doc(name: string): string {
        const node = this.declarations.get(name)!;
        const ranges = ts.getLeadingCommentRanges(this.file.text, node.getFullStart()) ?? [];
        const last = ranges[ranges.length - 1];
        return last && this.file.text.slice(last.pos, last.end).startsWith('/**') ? this.file.text.slice(last.pos, last.end) : '';
    }

    /** A property's type without its `null` and `undefined`. */
    stripped(t: ts.Type): ts.Type {
        if (!t.isUnion()) return t;
        const rest = t.types.filter((x) => !(x.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined)));
        return rest.length === 1 ? rest[0] : t;
    }

    classify(original: ts.Type): TsKind {
        const t = this.stripped(original);
        const alias = t.aliasSymbol?.name;
        const f = t.flags;
        if (f & ts.TypeFlags.BooleanLike) return { kind: 'boolean' };
        if (f & ts.TypeFlags.NumberLike) return { kind: 'number' };
        if (f & ts.TypeFlags.StringLike && !t.isUnion()) return { kind: f & ts.TypeFlags.StringLiteral ? 'enum' : 'string', ...(f & ts.TypeFlags.StringLiteral ? { values: [String((t as ts.StringLiteralType).value)] } : {}) } as TsKind;
        if (t.isUnion()) {
            const rest = t.types.filter((x) => !(x.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined)));
            if (rest.every((x) => x.flags & ts.TypeFlags.StringLiteral)) return { kind: 'enum', values: rest.map((x) => String((x as ts.StringLiteralType).value)), alias };
            if (rest.every((x) => x.flags & ts.TypeFlags.BooleanLiteral)) return { kind: 'boolean' };
            return { kind: 'unknown' };
        }
        if (this.checker.isArrayType(t)) return { kind: 'array', element: this.checker.getTypeArguments(t as ts.TypeReference)[0] };
        if (alias === 'Record') return { kind: 'map', element: t.aliasTypeArguments![1] };
        if (f & ts.TypeFlags.Object) return { kind: 'object', type: t, alias };
        // An intersection of object types is an object of all their fields.
        if (t.isIntersection() && t.types.every((x) => x.flags & ts.TypeFlags.Object)) return { kind: 'object', type: t, alias };
        return { kind: 'unknown' };
    }

    properties(t: ts.Type, at: ts.Node): Array<{ name: string, type: ts.Type, optional: boolean }> {
        return this.checker.getPropertiesOfType(t).map((p) => ({
            name: p.name, type: this.checker.getTypeOfSymbolAtLocation(p, at), optional: !!(p.flags & ts.SymbolFlags.Optional),
        }));
    }
}

// ── comparing a type to a schema ─────────────────────────────────────────

const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));

/** A spec schema as the kind of value it describes. */
function specKind(spec: Spec, original: Node): { kind: string, node: Node, ref?: string, values?: string[], element?: Node } {
    const { node, ref } = spec.norm(original);
    if (!node) return { kind: 'unknown', node };
    // A nullable schema written as a choice of it and null is that schema.
    const choice = node.oneOf ?? node.anyOf;
    if (Array.isArray(choice)) {
        const rest = choice.filter((x: Node) => !(x?.type === 'null' || (Array.isArray(x?.type) && x.type.length === 1 && x.type[0] === 'null')));
        return rest.length === 1 ? specKind(spec, rest[0]) : { kind: 'unknown', node, ref };
    }
    if (node.enum) return { kind: 'enum', node, ref, values: node.enum.map(String) };
    const t = (Array.isArray(node.type) ? node.type.filter((x: string) => x !== 'null')[0] : node.type) as string | undefined;
    if (t === 'integer' || t === 'number') return { kind: 'number', node, ref };
    if (t === 'string' || t === 'boolean') return { kind: t, node, ref };
    if (t === 'array') return { kind: 'array', node, ref, element: node.items };
    if (t === 'object' || node.properties) {
        // The spec writes a map as `properties: { '<volumeKey>': <the value> }`.
        const keys = Object.keys(node.properties ?? {});
        if (keys.length === 1 && /^<.+Key>$/.test(keys[0])) return { kind: 'map', node, ref, element: node.properties[keys[0]] };
        if (node.additionalProperties && typeof node.additionalProperties === 'object' && !keys.length) return { kind: 'map', node, ref, element: node.additionalProperties };
        return { kind: 'object', node, ref };
    }
    return { kind: 'unknown', node, ref };
}

class Checker {
    /** Spec fields no type models, by `Type`: listed at the end. */
    readonly unmodeled: Record<string, string[]> = {};
    readonly liveOnlyUsed = new Set<string>();

    constructor(readonly types: Types, readonly specs: Record<Api, Spec>) {}

    /** The schema a TypeScript object type stands for, by its alias name. */
    schemaOf(alias: string): { spec: Spec, node: Node, name: string } {
        const [api, name] = OBJECTS[alias];
        const spec = this.specs[api];
        if (name.startsWith('request:')) {
            const endpoint = name.slice('request:'.length) as keyof typeof SCALEWAY_ENDPOINTS;
            const e = SCALEWAY_ENDPOINTS[endpoint];
            return { spec, node: spec.requestSchema(spec.operation(e.method, e.path)!), name: `the request of ${e.operationId}` };
        }
        return { spec, node: spec.schema(name), name };
    }

    /** `where`'s type against a schema node: false (after failing) when they cannot be the same thing. */
    compare(where: string, original: ts.Type, schema: Node, spec: Spec, at: ts.Node): void {
        const ts_ = this.types.classify(original);
        const sp = specKind(spec, schema);
        if (sp.kind === 'unknown' || ts_.kind === 'unknown') {
            if (UNCOMPARED[where] !== undefined) return;
            const side = ts_.kind === 'unknown' ? `the type (${this.types.checker.typeToString(original)})` : 'the spec\'s schema';
            return fail(`${where}: ${side} is no one kind (a union of kinds, an intersection, a choice of schemas), so nothing compares it: make it one, or name it in UNCOMPARED with why`);
        }
        if (sp.kind === 'enum') {
            if (ts_.kind !== 'enum') return fail(`${where}: the spec has an enum (${sp.values!.join('|')}) and the type is ${ts_.kind}`);
            if (!sameSet(ts_.values, sp.values!)) return fail(`${where}: members ${ts_.values.join('|')} but the spec's ${sp.ref ?? 'enum'} has ${sp.values!.join('|')}`);
            return;
        }
        if (ts_.kind === 'enum') {
            // A string the spec does not enumerate, narrowed (zones).
            if (sp.kind !== 'string') fail(`${where}: the type is an enum and the spec says ${sp.kind}`);
            return;
        }
        if (ts_.kind !== sp.kind) return fail(`${where}: the type is ${ts_.kind} and the spec says ${sp.kind}`);
        if (ts_.kind === 'array') return this.compare(`${where}[]`, ts_.element, sp.element!, spec, at);
        if (ts_.kind === 'map') return this.compare(`${where}{}`, ts_.element, sp.element!, spec, at);
        if (ts_.kind === 'object') {
            if (ts_.alias && OBJECTS[ts_.alias]) {
                const [api, name] = OBJECTS[ts_.alias];
                // A type that is the spec's schema under another name must be named as it.
                if (sp.ref && !name.startsWith('request:') && (api !== spec.api || name !== sp.ref)) fail(`${where}: the type is ${ts_.alias} (${name}) but the spec's field is ${sp.ref}`);
                return;
            }
            this.object(where, ts_.type, sp.node, spec, at, []);
        }
    }

    /** An object type's fields against a schema's; `sent`: a body asap-vps sends, which must have every field the spec requires. */
    object(name: string, t: ts.Type, schema: Node, spec: Spec, at: ts.Node, liveOnly: string[], sent = false): void {
        const fields = this.types.properties(t, at);
        const specFields: Record<string, Node> = spec.norm(schema).node?.properties ?? {};
        for (const f of fields) {
            const where = `${name}.${f.name}`;
            if (!(f.name in specFields)) {
                if (liveOnly.includes(f.name)) {
                    this.liveOnlyUsed.add(where);
                    continue;
                }
                fail(`${where}: not a field of the spec's schema (if the live API sends it, name it in LIVE_ONLY)`);
                continue;
            }
            if (liveOnly.includes(f.name)) fail(`${where}: is in the spec now: take it off LIVE_ONLY`);
            this.compare(where, f.type, specFields[f.name], spec, at);
        }
        for (const required of spec.norm(schema).node?.required ?? []) {
            const f = fields.find((x) => x.name === required);
            if (f && f.optional) fail(`${name}.${required}: the spec requires it and the type makes it optional`);
            if (!f && sent) fail(`${name}.${required}: the spec requires it in the body, and the type has no such field`);
        }
        const missing = Object.entries<Node>(specFields).filter(([k, v]) => !fields.some((f) => f.name === k) && !v.deprecated).map(([k]) => k);
        if (missing.length) this.unmodeled[name] = missing;
    }

    enums(): void {
        console.log('== enums');
        for (const [alias, [api, name]] of Object.entries(ENUMS)) {
            const decl = this.types.declarations.get(alias);
            const schema = this.specs[api].schema(name);
            if (!decl) {
                fail(`${alias}: not declared in types.ts`);
                continue;
            }
            if (!schema?.enum) {
                fail(`${alias}: the ${api} spec has no enum ${name}`);
                continue;
            }
            const t = this.types.classify(this.types.type(alias));
            if (t.kind !== 'enum') fail(`${alias}: is not a union of string literals`);
            else if (!sameSet(t.values, schema.enum.map(String))) fail(`${alias}: members ${[...t.values].sort().join('|')} but the spec's ${name} has ${[...schema.enum].sort().join('|')}`);
            else console.log(`  ok   ${alias} = ${name}`);
        }
    }

    objects(): void {
        console.log('== object types');
        for (const alias of Object.keys(OBJECTS)) {
            const decl = this.types.declarations.get(alias);
            if (!decl) {
                fail(`${alias}: not declared in types.ts`);
                continue;
            }
            const { spec, node, name } = this.schemaOf(alias);
            if (!node) {
                fail(`${alias}: the ${spec.api} spec has no ${name}`);
                continue;
            }
            const before = failures;
            this.object(alias, this.types.type(alias), node, spec, decl, LIVE_ONLY[alias] ?? [], OBJECTS[alias][1].startsWith('request:'));
            if (failures === before) console.log(`  ok   ${alias} = ${name}`);
        }
    }

    /** Every type cites a reference page, and one that documents it. */
    async references(): Promise<void> {
        console.log('== reference pages');
        for (const [alias, [api, name]] of [...Object.entries(ENUMS), ...Object.entries(OBJECTS)]) {
            const spec = this.specs[api];
            const documenting = spec.operations().filter(({ op }) => spec.reach(op).has(name) || (name.startsWith('request:') && this.requestOf(name) === op));
            const urls = [...this.types.doc(alias).matchAll(/https:\/\/www\.scaleway\.com\/en\/developers\/api\/[^\s)`'"*]+/g)].map((m) => m[0].replace(/[.,;:]+$/, ''));
            if (!urls.length) {
                fail(`${alias}: cites no reference page${flag('suggest') ? ` (pages that document it: ${documenting.slice(0, 4).map(({ op }) => spec.docs(op)).join(' ')})` : ''}`);
                continue;
            }
            for (const url of urls) {
                const hit = spec.operations().find(({ op }) => spec.docs(op) === url);
                if (!hit) fail(`${alias}: ${url} is not a page of the ${api} reference`);
                else if (!documenting.some(({ op }) => op === hit.op)) fail(`${alias}: ${url} (${hit.op.summary}) does not take or return ${name}`);
                else if (!await onPage(url)) fail(`${alias}: ${url} is not on the reference (the page is not there, or has no such anchor)`);
            }
        }
    }

    requestOf(name: string): Node {
        const e = SCALEWAY_ENDPOINTS[name.slice('request:'.length) as keyof typeof SCALEWAY_ENDPOINTS];
        return this.specs[apiOf(e.path)].operation(e.method, e.path);
    }
}

/** The API a path is of, by its first segment (Serverless Containers' is /containers). */
const apiOf = (p: string): Api => {
    const first = p.split('/')[1];
    return first === 'instance' || first === 'iam' || first === 'block' || first === 'containers' || first === 'file' ? first : 'marketplace';
};

// ── the endpoint table ───────────────────────────────────────────────────

async function checkEndpoints(specs: Record<Api, Spec>): Promise<void> {
    console.log('== endpoint table');
    for (const [name, e] of Object.entries(SCALEWAY_ENDPOINTS) as Array<[string, ScalewayEndpoint]>) {
        const spec = specs[apiOf(e.path)];
        const op = spec.operation(e.method, e.path);
        const before = failures;
        if (!op) {
            fail(`${name}: no ${e.method} ${e.path} in the ${spec.api} spec`);
            continue;
        }
        if (op.operationId !== e.operationId) fail(`${name}: operationId ${e.operationId}, the spec says ${op.operationId}`);
        if (e.docs !== spec.docs(op)) fail(`${name}: docs ${e.docs}, the reference's page for "${op.summary}" is ${spec.docs(op)}`);
        else if (!await onPage(e.docs)) fail(`${name}: docs ${e.docs} is not on the reference (the page is not there, or has no such anchor)`);
        const params = new Set<string>((op.parameters ?? []).filter((p: Node) => p.in === 'query').map((p: Node) => p.name));
        for (const q of e.query ?? []) if (!params.has(q)) fail(`${name}: sends query parameter "${q}", which the operation does not have (it has: ${[...params].join(', ')})`);
        // One the operation requires is sent: listed here, and the client sends it on every call (its specs hold it to that).
        for (const p of (op.parameters ?? []).filter((x: Node) => x.in === 'query' && x.required)) {
            if (!(e.query ?? []).includes(p.name)) fail(`${name}: the operation requires query parameter "${p.name}", and it is not sent`);
        }
        const placeholders = [...e.path.matchAll(/\{([a-z_]+)\}/g)].map((m) => m[1]);
        const declared = (op.parameters ?? []).filter((p: Node) => p.in === 'path').map((p: Node) => p.name);
        if (!sameSet(placeholders, declared)) fail(`${name}: path placeholders ${placeholders.join(', ')}, the spec's path parameters ${declared.join(', ')}`);
        if (failures === before) console.log(`  ok   ${name.padEnd(26)} ${e.method.padEnd(6)} ${e.path}  (${op.summary})`);
    }
}

function checkZones(specs: Record<Api, Spec>): void {
    console.log('== zones');
    const op = specs.instance.operation('get', '/instance/v1/zones/{zone}/servers')!;
    const zones: string[] = op.parameters.find((p: Node) => p.name === 'zone').schema.enum;
    if (!sameSet([...SCALEWAY_ZONES], zones)) fail(`SCALEWAY_ZONES is ${[...SCALEWAY_ZONES].join(', ')}, the spec's zone parameter has ${zones.join(', ')}`);
    else console.log(`  ok   ${zones.length} zones`);
}

/** The live API's public catalog answers: a field the types call live-only must still be sent, and a field nobody typed is news. */
async function checkLive(checker: Checker): Promise<void> {
    console.log('== live catalog (public endpoints, no key)');
    for (const { type, url, entries } of LIVE_CATALOG) {
        const answer = await (await fetch(url)).json();
        const items = entries(answer);
        const sent = new Set(items.flatMap((i: object) => Object.keys(i)));
        const typed = new Set(checker.types.properties(checker.types.type(type), checker.types.declarations.get(type)!).map((p) => p.name));
        for (const field of LIVE_ONLY[type] ?? []) {
            // Nested live-only fields are checked on the object that holds them.
            if (!sent.has(field) && typed.has(field) && !items.some((i: any) => Object.values(i).some((v: any) => v && typeof v === 'object' && field in v))) fail(`${type}.${field}: no longer sent by the live API (${items.length} entries): take it out`);
        }
        const unknown = [...sent].filter((k) => !typed.has(k));
        console.log(`  ${type}: ${items.length} entries read; fields not typed: ${unknown.length ? unknown.join(', ') : 'none'}`);
    }
}

async function main(): Promise<void> {
    const specs = Object.fromEntries(await Promise.all((Object.keys(APIS) as Api[]).map(async (api) => [api, await loadSpec(api)]))) as Record<Api, Spec>;
    const types = new Types(path.join(__dirname, '../src/Providers/Scaleway/types.ts'));
    const checker = new Checker(types, specs);
    await checkEndpoints(specs);
    checkZones(specs);
    checker.enums();
    checker.objects();
    await checker.references();
    if (flag('live')) await checkLive(checker);
    const modeled = Object.entries(checker.unmodeled);
    if (modeled.length) {
        console.log('\nspec fields the types leave out (a choice, listed so it is a visible one):');
        for (const [t, fields] of modeled) console.log(`  ${t}: ${fields.join(', ')}`);
    }
    console.log(failures ? `\n${failures} FAILURE(S)` : '\nevery endpoint, enum, field and reference page agrees with the spec');
    process.exit(failures ? 1 : 0);
}

main().catch((e) => {
    console.error(e);
    process.exit(2);
});
