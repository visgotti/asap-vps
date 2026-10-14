// The types as a package user gets them: the declarations `npm run build`
// emits (tsconfig.types.json), not the source typing.spec.ts compiles. A type
// made from a value can come out of a .d.ts less precise than it went in (a
// table's computed enum keys did: TypesOf<DigitalOcean> came out as the
// defaults, and every region passed), and a doc comment can be left out of it
// (an editor then explains nothing). So the declarations are emitted here, in
// memory, and a program that imports 'asap-vps' is compiled against them alone:
// each provider's places are the ones its run-time table and data have, a
// region it has not is a compile error, and a country's name is on its hover.

import * as path from 'path';
import * as ts from 'typescript';
import { DIGITALOCEAN_ENUMS } from './Providers/DigitalOcean/mappers';
import { DIGITALOCEAN_DATACENTERS } from './Providers/DigitalOcean/places';
import { LAMBDA_ENUMS } from './Providers/LambdaCloud/mappers';
import { LAMBDA_REGIONS } from './Providers/LambdaCloud/places';
import { RUNPOD_ENUMS } from './Providers/RunPod/mappers';
import { RUNPOD_DATA_CENTERS } from './Providers/RunPod/places';
import { SCALEWAY_ENUMS } from './Providers/Scaleway/mappers';
import { SCALEWAY_PLACES } from './Providers/Scaleway/places';

const ROOT = path.join(__dirname, '..');
/** Where the package and its user are, in memory: nothing is written there. */
const USER = path.join(ROOT, '.published-types');
const PACKAGE = path.join(USER, 'node_modules', 'asap-vps');
const CONSUMER = path.join(USER, 'consumer.ts');

/** The declarations the build emits, by path, with the package.json that points a user at them. */
function emitDeclarations(): Map<string, string> {
    const read = ts.readConfigFile(path.join(ROOT, 'tsconfig.types.json'), ts.sys.readFile);
    const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, ROOT);
    // As the build has it, but into memory: only where it is written changes.
    const options = { ...parsed.options, outDir: PACKAGE, incremental: false, sourceMap: false, declarationMap: false };
    const files = new Map<string, string>();
    const emitted = ts.createProgram(parsed.fileNames, options).emit(undefined, (name, text) => files.set(path.resolve(name), text));
    expect([emitted.emitSkipped, emitted.diagnostics.map((d) => ts.flattenDiagnosticMessageText(d.messageText, ' '))]).toEqual([false, []]);
    files.set(path.join(PACKAGE, 'package.json'), JSON.stringify({ name: 'asap-vps', types: './index.d.ts' }));
    return files;
}

/** A user's program of one file, `code`, over the emitted declarations (its other imports from the repository's node_modules), compiled strict. */
function userProgram(files: ReadonlyMap<string, string>, code: string): ts.LanguageService {
    const all = new Map(files).set(CONSUMER, code);
    const dirs = new Set([...all.keys()].flatMap((f) => {
        const up: string[] = [];
        for (let d = path.dirname(f); d.startsWith(USER); d = path.dirname(d)) up.push(d);
        return up;
    }));
    const options: ts.CompilerOptions = { strict: true, target: ts.ScriptTarget.ES2021, module: ts.ModuleKind.CommonJS, moduleResolution: ts.ModuleResolutionKind.Node10, noEmit: true, skipLibCheck: false, types: ['node'] };
    return ts.createLanguageService({
        getScriptFileNames: () => [CONSUMER],
        getScriptVersion: () => '1',
        getScriptSnapshot: (f) => {
            const text = all.get(f) ?? ts.sys.readFile(f);
            return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);
        },
        getCurrentDirectory: () => USER,
        getCompilationSettings: () => options,
        getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
        fileExists: (f) => all.has(f) || ts.sys.fileExists(f),
        readFile: (f) => all.get(f) ?? ts.sys.readFile(f),
        directoryExists: (d) => dirs.has(d) || ts.sys.directoryExists(d),
        getDirectories: ts.sys.getDirectories,
        readDirectory: ts.sys.readDirectory,
    });
}

/** A list of names as a union type's source: `"a" | "b"`, or never. */
const union = (names: readonly string[]) => [...new Set(names)].map((n) => JSON.stringify(n)).join(' | ') || 'never';

describe('the published types: the declarations the build emits, as a package user compiles against them', () => {
    let files: Map<string, string>;
    beforeAll(() => {
        files = emitDeclarations();
    }, 180_000);

    it('keep each provider\'s places, refuse a region it has not, and keep a doc comment on its hover', () => {
        const code = `
import { COUNTRY_TYPES, REGION_TYPES, supports } from 'asap-vps';
import type { AnyProvider, DigitalOcean, LambdaCloud, PlatformTypes, RunPod, Scaleway, TypesOf, VastAI } from 'asap-vps';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
declare function isTrue<T extends true>(): void;
declare const base: { name: string, offer: string };
declare const digitalOcean: DigitalOcean, scaleway: Scaleway, runPod: RunPod, lambda: LambdaCloud, vast: VastAI, any: AnyProvider;

// Each provider's places: the regions its run-time table translates, its places' own names, their countries.
isTrue<Equal<\`\${TypesOf<DigitalOcean>['region']}\`, ${union(Object.keys(DIGITALOCEAN_ENUMS.regions))}>>();
isTrue<Equal<TypesOf<DigitalOcean>['regionName'], ${union(DIGITALOCEAN_DATACENTERS.map((d) => d.slug))}>>();
isTrue<Equal<\`\${TypesOf<DigitalOcean>['country']}\`, ${union(DIGITALOCEAN_DATACENTERS.map((d) => d.country))}>>();
isTrue<Equal<\`\${TypesOf<Scaleway>['region']}\`, ${union(Object.keys(SCALEWAY_ENUMS.regions))}>>();
isTrue<Equal<TypesOf<Scaleway>['regionName'], ${union(SCALEWAY_PLACES.map((p) => p.name))}>>();
isTrue<Equal<\`\${TypesOf<Scaleway>['country']}\`, ${union(SCALEWAY_PLACES.map((p) => p.country))}>>();
isTrue<Equal<\`\${TypesOf<RunPod>['region']}\`, ${union(Object.keys(RUNPOD_ENUMS.regions))}>>();
isTrue<Equal<TypesOf<RunPod>['regionName'], ${union(RUNPOD_DATA_CENTERS.map((d) => d.id))}>>();
isTrue<Equal<\`\${TypesOf<LambdaCloud>['region']}\`, ${union(Object.keys(LAMBDA_ENUMS.regions))}>>();
isTrue<Equal<TypesOf<LambdaCloud>['regionName'], ${union(LAMBDA_REGIONS.map((r) => r.name))}>>();
isTrue<Equal<TypesOf<VastAI>['region'], never>>();
isTrue<Equal<TypesOf<VastAI>['country'], COUNTRY_TYPES>>();
isTrue<Equal<Equal<TypesOf<DigitalOcean>, PlatformTypes>, false>>();

// A region a provider has passes, by the library's name or its own; one it has not is a compile error.
digitalOcean.createServer({ ...base, region: REGION_TYPES.CANADA_TORONTO });
digitalOcean.createServer({ ...base, region: 'tor1' });
scaleway.createVolume({ name: 'v', sizeGb: 10, region: REGION_TYPES.FRANCE_PARIS_2 });
runPod.createServer({ ...base, region: REGION_TYPES.US_TEXAS_3 });
lambda.createVolume({ name: 'v', region: REGION_TYPES.JAPAN_OSAKA });
// @ts-expect-error DigitalOcean has no Paris
digitalOcean.createServer({ ...base, region: REGION_TYPES.FRANCE_PARIS });
// @ts-expect-error a datacenter DigitalOcean does not have
digitalOcean.createServer({ ...base, region: 'nyc9' });
// @ts-expect-error Scaleway has no New York
scaleway.createVolume({ name: 'v', sizeGb: 10, region: REGION_TYPES.US_NEW_YORK_1 });
// @ts-expect-error RunPod has no Toronto (its Canada is Montreal)
runPod.createServer({ ...base, region: REGION_TYPES.CANADA_TORONTO });
// @ts-expect-error Vast has no region of the library's: a machine is where it is
vast.createServer({ ...base, region: REGION_TYPES.POLAND_WARSAW });
// A union narrowed by a capability: each of its providers keeps its own places.
if (supports(any, 'imageCopy')) {
    // @ts-expect-error Scaleway, among those that copy images, has no New York
    any.copyImage('id', [REGION_TYPES.US_NEW_YORK_1]);
}
// A place read from a record goes back in typed.
export async function rentWhereOffered() {
    const [offer] = await digitalOcean.listOffers();
    return digitalOcean.createServer({ ...base, offer, region: offer.regions[0] });
}

// Countries are ISO's codes, the same on every provider.
digitalOcean.listOffers({ countries: [COUNTRY_TYPES.GB, 'KR'] });
// @ts-expect-error the United Kingdom's code is GB
vast.listOffers({ countries: ['UK'] });
export const korea = COUNTRY_TYPES.KR;
`;
        const user = userProgram(files, code);
        const errors = [...user.getSyntacticDiagnostics(CONSUMER), ...user.getSemanticDiagnostics(CONSUMER)].map((d) => {
            const at = d.file && d.start !== undefined ? d.file.getLineAndCharacterOfPosition(d.start).line + 1 : 0;
            return `${at}: ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`;
        });
        expect(errors).toEqual([]);
        // What an editor shows on a country: its name, from the declarations' doc comments.
        const hover = user.getQuickInfoAtPosition(CONSUMER, code.lastIndexOf('KR'));
        expect([ts.displayPartsToString(hover?.displayParts), ts.displayPartsToString(hover?.documentation)]).toEqual(['(enum member) COUNTRY_TYPES.KR = "KR"', 'South Korea']);
    }, 120_000);

    it('a region a provider has not still passes where the declarations lost its places: the check above would fail', () => {
        // The check is only as good as its refusals: against the defaults (what a lost table comes out as), they do not hold.
        const user = userProgram(files, `
import { REGION_TYPES } from 'asap-vps';
import type { CreateServerOptions } from 'asap-vps';
export const o: CreateServerOptions = { name: 'n', offer: 'o', region: REGION_TYPES.FRANCE_PARIS };
// @ts-expect-error
export const p: CreateServerOptions = { name: 'n', offer: 'o', region: 'nyc9' };
`);
        expect(user.getSemanticDiagnostics(CONSUMER).map((d) => ts.flattenDiagnosticMessageText(d.messageText, ' '))).toEqual(['Unused \'@ts-expect-error\' directive.']);
    }, 120_000);
});
