// What the published package holds: the library as it is built, and nothing
// of its tests. `npm run build` empties dist and compiles tsconfig.build.json
// (the JavaScript, without comments), then tsconfig.types.json (the
// declarations, with the doc comments editors show); package.json ships dist
// alone (with what npm always adds: the README, the license, package.json).
// Checked on the build's own inputs, read as tsc reads them, so no build or
// `npm pack` is needed here.

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

/** The declaration a tsconfig emits for one source file, in memory. */
function declarationOf(config: string, file: string): string {
    const { options } = ts.parseJsonConfigFileContent(ts.readConfigFile(join(root, config), ts.sys.readFile).config, ts.sys, root);
    let out = '';
    // The file alone (noResolve): its comments are its own, whatever it imports.
    ts.createProgram([join(root, file)], { ...options, noResolve: true })
        .emit(undefined, (name, text) => { if (name.endsWith('.d.ts')) out = text; }, undefined, true);
    return out;
}

const docComments = (text: string) => text.match(/\/\*\*/g)?.length ?? 0;

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
        expect(pkg.scripts.build).toBe('rm -rf dist && tsc -p tsconfig.build.json --declaration false && tsc -p tsconfig.types.json && cp -R src/scripts dist/scripts');
        expect(pkg.scripts.prepublishOnly).toBe('npm run build');
    });

    it('ships the declarations with their doc comments, which editors show on hover, and the docs site reads the same ones', () => {
        // Of the same files as the JavaScript.
        expect(compiled('tsconfig.types.json')).toEqual(compiled('tsconfig.build.json'));
        const dts = declarationOf('tsconfig.types.json', 'src/capabilities.ts');
        expect(docComments(dts)).toBe(docComments(readFileSync(join(root, 'src/capabilities.ts'), 'utf8')));
        expect(dts).toContain("    /** null when the provider has no such server. */\n    getServer(id: string): Promise<Server<T['server']> | null>;");
        expect(readFileSync(join(root, 'site/scripts/build-types.mjs'), 'utf8')).toContain("'-p', 'tsconfig.types.json', '--outDir', DTS,");
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
