// The docs are tested: every ts block of every page is type-checked against the library's declarations (the ones the editors use), every
// `run` block is executed in the sandbox, every `error` block must fail to compile. A page that shows code that does not compile, or a run
// that throws, fails here, so the docs cannot drift from the library.
//
//   node scripts/check-snippets.mjs [--verbose] [pageSlug...]

import { build } from 'esbuild';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, SITE, sandboxBuild } from '../esbuild.shared.mjs';
import { buildTypes, DTS } from './build-types.mjs';

const require = createRequire(path.join(ROOT, 'package.json'));
const ts = require('typescript');
const verbose = process.argv.includes('--verbose');
const only = process.argv.slice(2).filter((a) => !a.startsWith('--'));
// --md=file.md: one more markdown file to check as a page (the README's new examples are checked this way before they go in).
const extra = process.argv.find((a) => a.startsWith('--md='))?.slice(5);
const CACHE = path.join(SITE, '.cache');
// The sandbox swaps in a virtual-clock setTimeout while a snippet runs; this script's own deadlines use the real one.
const realSetTimeout = globalThis.setTimeout;

await build({ entryPoints: [path.join(SITE, 'src/nav.ts')], bundle: true, platform: 'node', format: 'esm', outfile: path.join(CACHE, 'pages.mjs'), loader: { '.md': 'text' }, logLevel: 'warning' });
await build(sandboxBuild({ entryPoints: [path.join(SITE, 'src/sandbox/run.ts')], outfile: path.join(CACHE, 'run.mjs'), format: 'esm' }));
buildTypes({ quiet: true });
const { PAGES } = await import(`${pathToFileURL(path.join(CACHE, 'pages.mjs')).href}?${Date.now()}`);
const { fencesOf, kindOf } = await import(pathToFileURL(path.join(CACHE, 'fences.mjs')).href).catch(async () => {
    await build({ entryPoints: [path.join(SITE, 'src/fences.ts')], bundle: true, platform: 'node', format: 'esm', outfile: path.join(CACHE, 'fences.mjs'), logLevel: 'warning' });
    return import(pathToFileURL(path.join(CACHE, 'fences.mjs')).href);
});
const { runSnippet } = await import(`${pathToFileURL(path.join(CACHE, 'run.mjs')).href}?${Date.now()}`);

if (extra) PAGES.push({ slug: 'extra', title: 'extra', group: '', summary: '', md: fs.readFileSync(extra, 'utf8') });
const snippets = PAGES.filter((p) => !only.length || only.includes(p.slug)).flatMap((p) =>
    fencesOf(p.slug, p.md).map((f) => ({ ...f, kind: kindOf(f), file: path.join(CACHE, 'snippets', `${f.id.replace('#', '-')}.ts`) })).filter((f) => f.lang === 'ts' || f.lang === 'typescript'));

// ── type-check ─────────────────────────────────────────────────────────────
const options = {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, strict: true, skipLibCheck: true, noEmit: true,
    types: ['node'], typeRoots: [path.join(ROOT, 'node_modules/@types')], baseUrl: SITE, paths: { 'asap-vps': [path.join(DTS, 'index.d.ts')] },
    lib: ['lib.es2022.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'],
};
const virtual = new Map(snippets.filter((s) => s.kind !== 'static').map((s) => [s.file, s.code]));
const host = ts.createCompilerHost(options);
const { fileExists, readFile, getSourceFile } = host;
host.fileExists = (f) => virtual.has(f) || fileExists(f);
host.readFile = (f) => virtual.get(f) ?? readFile(f);
host.getSourceFile = (f, lang, ...rest) => (virtual.has(f) ? ts.createSourceFile(f, virtual.get(f), lang, true) : getSourceFile(f, lang, ...rest));
const program = ts.createProgram([...virtual.keys()], options, host);
const errorsOf = (file) => {
    const sf = program.getSourceFile(file);
    return [...program.getSyntacticDiagnostics(sf), ...program.getSemanticDiagnostics(sf)].map((d) => {
        const { line } = sf.getLineAndCharacterOfPosition(d.start ?? 0);
        return `line ${line + 1}: ${ts.flattenDiagnosticMessageText(d.messageText, '\n  ')}`;
    });
};

let failed = 0;
const fail = (s, why) => {
    failed++;
    console.log(`✗ ${s.id} (${s.attrs.title ?? s.kind})\n${why.split('\n').map((l) => `    ${l}`).join('\n')}`);
};

for (const s of snippets) {
    if (s.kind === 'static') continue;
    const errors = errorsOf(s.file);
    if (s.kind === 'error') {
        if (errors.length) { if (verbose) console.log(`✓ ${s.id} fails to compile, as shown: ${errors[0]}`); } else fail(s, 'is marked `error` but compiles');
        continue;
    }
    if (errors.length) { fail(s, errors.join('\n')); continue; }
    if (s.kind !== 'run') { if (verbose) console.log(`✓ ${s.id} compiles`); continue; }

    // ── run ────────────────────────────────────────────────────────────────
    const js = ts.transpileModule(s.code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
    const out = console.log.bind(console);
    const lines = [];
    let requests = 0;
    const started = Date.now();
    try {
        await Promise.race([
            runSnippet(js, { log: (_l, t) => lines.push(t), request: () => { requests++; } }),
            new Promise((_, rej) => realSetTimeout(() => rej(new Error('did not finish in 60 s')), 60_000)),
        ]);
        out(`✓ ${s.id} ran: ${lines.length} output line(s), ${requests} request(s), ${Date.now() - started} ms${s.attrs.title ? ` (${s.attrs.title})` : ''}`);
        if (verbose) out(lines.map((l) => `    ${l.replace(/\n/g, '\n    ')}`).join('\n'));
    } catch (e) {
        fail(s, `threw ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}\n${lines.slice(-5).join('\n')}`);
    }
}

console.log(`\n${snippets.length} code block(s) on ${PAGES.length} page(s): ${failed ? `${failed} FAILED` : 'all pass'}`);
process.exit(failed ? 1 : 0);
