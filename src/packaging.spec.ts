// What the published package holds: the library as it is built, and nothing
// of its tests. `npm run build` empties dist and compiles tsconfig.build.json;
// package.json ships dist alone (with what npm always adds: the README, the
// license, package.json). Checked on the build's own inputs, read as tsc reads
// them, so no build or `npm pack` is needed here.

import { readFileSync } from 'fs';
import { join, relative } from 'path';
import * as ts from 'typescript';

const root = join(__dirname, '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

/** The source files a tsconfig compiles, as paths from the repository root. */
function compiled(config: string): string[] {
    const read = ts.readConfigFile(join(root, config), ts.sys.readFile);
    expect(read.error).toBeUndefined();
    const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, root);
    return parsed.fileNames.map((f) => relative(root, f).split('\\').join('/')).sort();
}

describe('the published package', () => {
    it('is built from the library alone: no spec, no fake, no live harness', () => {
        const built = compiled('tsconfig.build.json');
        const all = compiled('tsconfig.json');
        const tests = (f: string) => /\.spec\.ts$/.test(f) || f.startsWith('src/testing/');
        expect(built.filter(tests)).toEqual([]);
        // Everything else of src is built: the library is whole.
        expect(built).toEqual(all.filter((f) => !tests(f)));
        expect(built).toContain('src/index.ts');
        expect(all.filter(tests).length).toBeGreaterThan(50);
    });

    it('ships dist alone, built clean before every publish: nothing a past build left, no coverage report', () => {
        expect(pkg.files).toEqual(['dist']);
        expect(pkg.main).toBe('dist/index.js');
        expect(pkg.scripts.build).toBe('rm -rf dist && tsc -d -p tsconfig.build.json');
        expect(pkg.scripts.prepublishOnly).toBe('npm run build');
    });
});
