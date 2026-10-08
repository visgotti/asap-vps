// The library's type declarations, as the editors on the site see them.
//
// tsc emits the declarations of src/ (what `npm run build` ships in dist/), then a TypeScript program over the entry finds every .d.ts
// it reaches: the library's own and the third-party ones (Node's, node-ssh's, ssh2's). They go into .cache/types.json under the paths a
// real install would have (`/node_modules/asap-vps/...`, `/node_modules/@types/node/...`), so module resolution in the editor is the one in your project.

import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, SITE } from '../esbuild.shared.mjs';

const require = createRequire(path.join(ROOT, 'package.json'));
const ts = require('typescript');
export const DTS = path.join(SITE, '.cache/dts');
export const TYPES_JSON = path.join(SITE, '.cache/types.json');

export function buildTypes({ quiet = false } = {}) {
    fs.rmSync(DTS, { recursive: true, force: true });
    const tsc = spawnSync(process.execPath, [require.resolve('typescript/bin/tsc'), '-p', 'tsconfig.build.json', '--emitDeclarationOnly', '--declaration', '--outDir', DTS, '--incremental', 'false', '--sourceMap', 'false'], {
        cwd: ROOT, encoding: 'utf8',
    });
    if (tsc.status !== 0) throw new Error(`tsc could not emit the declarations:\n${tsc.stdout}${tsc.stderr}`);

    const options = {
        target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
        strict: true, skipLibCheck: true, noEmit: true, types: ['node'], typeRoots: [path.join(ROOT, 'node_modules/@types')],
        lib: ['lib.es2022.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'],
    };
    const program = ts.createProgram([path.join(DTS, 'index.d.ts')], options);
    const files = {};
    const packageRoots = new Set();
    for (const sf of program.getSourceFiles()) {
        const name = sf.fileName;
        if (!name.endsWith('.d.ts') || path.basename(name).startsWith('lib.') && name.includes(`${path.sep}typescript${path.sep}lib${path.sep}`)) continue;
        let virtual;
        if (name.startsWith(DTS + path.sep)) virtual = `/node_modules/asap-vps/${path.relative(DTS, name)}`;
        else if (name.includes(`${path.sep}node_modules${path.sep}`)) {
            virtual = `/node_modules/${name.split(`${path.sep}node_modules${path.sep}`).pop()}`;
            const m = /^(\/node_modules\/(?:@[^/]+\/)?[^/]+)\//.exec(virtual);
            if (m) packageRoots.add(m[1]);
        } else continue;
        files[virtual] = sf.text;
    }
    // The package.json of each third-party package, so that `types`/`typings`/`exports` resolve as they do on disk.
    for (const root of packageRoots) {
        const p = path.join(ROOT, root.replace(/^\//, ''), 'package.json');
        if (fs.existsSync(p)) files[`${root}/package.json`] = fs.readFileSync(p, 'utf8');
    }
    files['/node_modules/asap-vps/package.json'] = JSON.stringify({ name: 'asap-vps', types: './index.d.ts' });
    fs.mkdirSync(path.dirname(TYPES_JSON), { recursive: true });
    fs.writeFileSync(TYPES_JSON, JSON.stringify(files));
    const bytes = Buffer.byteLength(JSON.stringify(files));
    if (!quiet) console.log(`types: ${Object.keys(files).length} files, ${(bytes / 1e6).toFixed(1)} MB (${Object.keys(files).filter((f) => f.startsWith('/node_modules/asap-vps/')).length} the library's)`);
    return files;
}

if (import.meta.url === `file://${process.argv[1]}`) buildTypes();
