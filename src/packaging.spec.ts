// What the published package holds: the library as it is built, and nothing
// of its tests. `npm run build` empties dist and compiles tsconfig.build.json;
// package.json ships dist alone (with what npm always adds: the README, the
// license, package.json). Checked on the build's own inputs, read as tsc reads
// them, so no build or `npm pack` is needed here.

import { existsSync, readFileSync } from 'fs';
import { join, relative } from 'path';
import * as ts from 'typescript';
import { MACHINE_TYPES, SETUP_SCRIPTS } from './constants';

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
        expect(pkg.scripts.build).toBe('rm -rf dist && tsc -d -p tsconfig.build.json && cp -R src/scripts dist/scripts');
        expect(pkg.scripts.prepublishOnly).toBe('npm run build');
    });

    it('ships the setup scripts SSHService uploads: every one it can ask for, where the built code looks for it', () => {
        // SSHService.sshSetupScript reads <its own directory>/../scripts/setup/<machine>/<script>.sh: src/scripts here,
        // dist/scripts once built. tsc copies no .sh file, so the build does.
        expect(pkg.scripts.build).toMatch(/ && cp -R src\/scripts dist\/scripts$/);
        for (const machine of Object.values(MACHINE_TYPES)) {
            for (const script of Object.values(SETUP_SCRIPTS)) expect(existsSync(join(root, 'src', 'scripts', 'setup', machine, `${script}.sh`))).toBe(true);
        }
    });
});
