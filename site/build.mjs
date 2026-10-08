// Builds the site into dist/ with esbuild:
//   main.js + main.css        the page (small: markdown and the router)
//   editor.js + editor.css    Monaco and the Run button, loaded on demand
//   ts.worker.js, editor.worker.js    Monaco's workers (the TypeScript language service runs in the first)
//   sandbox.worker.js         the library and its fakes, where snippets run
//   types.json                the library's declarations, for the editors
//   capabilities.json         what each provider declares, read from the code, for the overview table
//   heritage.json             each provider's base classes, interfaces and where each method comes from, read from the source, for the provider pages
//
//   node build.mjs              build once        node build.mjs --serve     rebuild on change and serve on http://localhost:8765

import { build, context } from 'esbuild';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, SITE, sandboxBuild } from './esbuild.shared.mjs';
import { buildHeritage } from './scripts/build-heritage.mjs';
import { buildTypes } from './scripts/build-types.mjs';

const serve = process.argv.includes('--serve');
const DIST = path.join(SITE, 'dist');
const BUILD_ID = Date.now().toString(36);
const common = { bundle: true, logLevel: 'warning', define: { BUILD_ID: JSON.stringify(BUILD_ID) }, minify: !serve, sourcemap: serve ? 'linked' : false };

// A second --serve would wipe dist/ and then fail to bind, leaving the first
// server's pages without their editors: stop before touching anything.
if (serve) {
    const busy = await new Promise((resolve) => {
        const probe = net.createServer().once('error', () => resolve(true)).once('listening', () => probe.close(() => resolve(false)));
        probe.listen(8765, '0.0.0.0');
    });
    if (busy) {
        console.error('port 8765 is already serving a site (another `build.mjs --serve`?); stop it first');
        process.exit(1);
    }
}

fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(DIST, { recursive: true });

// What the editors know of the library, and what each provider declares.
buildTypes();
fs.copyFileSync(path.join(SITE, '.cache/types.json'), path.join(DIST, 'types.json'));
await build({ entryPoints: [path.join(SITE, 'src/capabilities.ts')], bundle: true, platform: 'node', format: 'esm', packages: 'external', outfile: path.join(SITE, '.cache/capabilities.mjs'), logLevel: 'warning' });
const { default: capabilities } = await import(`${pathToFileURL(path.join(SITE, '.cache/capabilities.mjs')).href}?${BUILD_ID}`);
fs.writeFileSync(path.join(DIST, 'capabilities.json'), JSON.stringify(capabilities));
fs.writeFileSync(path.join(DIST, 'heritage.json'), JSON.stringify(buildHeritage(capabilities)));

fs.writeFileSync(path.join(DIST, 'index.html'), fs.readFileSync(path.join(SITE, 'src/index.html'), 'utf8').replaceAll('__BUILD_ID__', BUILD_ID));
fs.writeFileSync(path.join(DIST, '.nojekyll'), '');

const configs = [
    // the page
    { ...common, entryPoints: [path.join(SITE, 'src/main.ts')], outfile: path.join(DIST, 'main.js'), format: 'esm', target: 'es2022', loader: { '.md': 'text' }, external: ['./editor.js*'] },
    { ...common, entryPoints: [path.join(SITE, 'src/style.css')], outfile: path.join(DIST, 'main.css') },
    // the editor: Monaco's code, its stylesheet and its icon font
    { ...common, entryPoints: [path.join(SITE, 'src/editor.ts')], outfile: path.join(DIST, 'editor.js'), format: 'esm', target: 'es2022', loader: { '.ttf': 'file' }, assetNames: 'assets/[name]-[hash]' },
    // workers are classic scripts: they load wherever a module worker does not
    { ...common, entryPoints: [path.join(SITE, 'node_modules/monaco-editor/esm/vs/editor/editor.worker.js')], outfile: path.join(DIST, 'editor.worker.js'), format: 'iife' },
    { ...common, entryPoints: [path.join(SITE, 'node_modules/monaco-editor/esm/vs/language/typescript/ts.worker.js')], outfile: path.join(DIST, 'ts.worker.js'), format: 'iife' },
    // the sandbox: the library, its fakes and the runner
    sandboxBuild({ ...common, entryPoints: [path.join(SITE, 'src/sandbox/worker.ts')], outfile: path.join(DIST, 'sandbox.worker.js'), format: 'iife' }),
];

if (!serve) {
    await Promise.all(configs.map((c) => build(c)));
    const sizes = fs.readdirSync(DIST).filter((f) => fs.statSync(path.join(DIST, f)).isFile()).map((f) => `${f} ${(fs.statSync(path.join(DIST, f)).size / 1024).toFixed(0)} KB`);
    console.log(`site built into dist/ (${BUILD_ID}): ${sizes.join(', ')}`);
} else {
    const contexts = await Promise.all(configs.map((c) => context(c)));
    await Promise.all(contexts.map((c) => c.watch()));
    // esbuild serves one directory: the first context serves dist/ for all.
    const { port } = await contexts[0].serve({ servedir: DIST, port: 8765 });
    console.log(`serving the site on http://localhost:${port}/ (rebuilds on change; edit the pages in src/content, then reload)`);
}
