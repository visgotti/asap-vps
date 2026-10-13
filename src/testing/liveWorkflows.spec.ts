// The workflows that run the live suites from GitHub
// (.github/workflows/live-<provider>.yml, and live.yml which they call) held
// to the suites there are: every *.live.spec.ts is reached by exactly one
// option of its provider's workflow, so a suite added without one, or a
// pattern that takes in a second file, fails here and not in a paid run. And
// to their guards: by hand only, nothing rented unless asked, every key the
// suites read handed on.

import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { LIVE_TARGETS } from './live';

const ROOT = join(__dirname, '..', '..');
const workflow = (name: string) => readFileSync(join(ROOT, '.github', 'workflows', name), 'utf8');
/** A provider's id, and the folder its class and its suites are in. */
const FOLDERS = { digitalocean: 'DigitalOcean', scaleway: 'Scaleway', lambda: 'LambdaCloud', runpod: 'RunPod', vast: 'VastAI' };
/** Every live suite there is, by its path from the repository's root. */
const SUITES = Object.values(FOLDERS).flatMap((folder) => readdirSync(join(ROOT, 'src', 'Providers', folder))
    .filter((f) => f.endsWith('.live.spec.ts')).map((f) => `src/Providers/${folder}/${f}`));
/** The files a pattern runs, as jest reads one: a regular expression, matched anywhere in the path, in either case. */
const run = (pattern: string) => SUITES.filter((f) => new RegExp(pattern, 'i').test(join(ROOT, f)));
/** What starts a workflow, in the order it says them. */
const triggers = (text: string) => [...text.matchAll(/^ {2}(workflow_dispatch|workflow_call|push|pull_request|pull_request_target|schedule|workflow_run|release):/gm)].map((m) => m[1]);

describe('the live suites, run from GitHub', () => {
    it('there are suites to hold the workflows to, in every provider\'s folder', () => {
        expect(SUITES.length).toBeGreaterThanOrEqual(30);
        for (const folder of Object.values(FOLDERS)) expect(SUITES.filter((f) => f.startsWith(`src/Providers/${folder}/`)).length).toBeGreaterThanOrEqual(4);
    });

    describe.each(Object.entries(FOLDERS))('live-%s.yml', (provider, folder) => {
        const text = workflow(`live-${provider}.yml`);
        const patterns = JSON.parse(/^ {6}pattern: \$\{\{ fromJSON\('(\{.*\})'\)\[inputs\.suite\] \}\}$/m.exec(text)![1]) as Record<string, string>;
        const own = SUITES.filter((f) => f.startsWith(`src/Providers/${folder}/`));

        it('offers exactly the suites it has a pattern for, "all" among them', () => {
            const options = /^ {8}options:\n((?: {10}- \S+\n)+)/m.exec(text)![1].trim().split('\n').map((l) => l.trim().slice(2));
            expect(options).toEqual(Object.keys(patterns));
            expect(options[0]).toBe('all');
            expect(new Set(options).size).toBe(options.length);
            // What is run when nobody chooses is one of them, and not all of them at once.
            const preset = /^ {8}default: (\S+)\n {8}options:/m.exec(text)![1];
            expect([options.includes(preset), preset === 'all']).toEqual([true, false]);
        });

        it('reaches every suite of the provider by one option each, and no suite of another provider', () => {
            const { all, ...each } = patterns;
            expect(run(all).sort()).toEqual([...own].sort());
            const reached = Object.entries(each).map(([option, pattern]) => [option, run(pattern)] as const);
            // Each option runs one file, of this provider; and between them, every file it has, none twice.
            expect(reached.filter(([, files]) => files.length !== 1 || !own.includes(files[0])).map(([option]) => option)).toEqual([]);
            expect(reached.map(([, files]) => files[0]).sort()).toEqual([...own].sort());
        });

        it('asks for every target its suites are gated on: the provider\'s own, and no other\'s', () => {
            const targets = /^ {6}targets: (\S+)$/m.exec(text)![1].split(',');
            expect(targets).toEqual(LIVE_TARGETS.filter((t) => t === provider || t.startsWith(`${provider}-`)));
            expect(/^ {6}provider: (\S+)$/m.exec(text)![1]).toBe(provider);
            // Every target a suite of the provider names in its own file is one of them.
            const named = own.flatMap((f) => [...readFileSync(join(ROOT, f), 'utf8').matchAll(/(?:liveRequested\(|target: )'([a-z-]+)'/g)].map((m) => m[1]));
            expect(named.filter((t) => !targets.includes(t))).toEqual([]);
        });

        it('is run by hand and by nothing else, rents nothing unless asked, and hands its keys to live.yml', () => {
            expect(triggers(text)).toEqual(['workflow_dispatch']);
            expect(text).toMatch(/^ {6}rent:\n {8}description: [^\n]+\n {8}type: boolean\n {8}default: false$/m);
            expect(text).toMatch(/^ {4}uses: \.\/\.github\/workflows\/live\.yml\n {4}secrets: inherit$/m);
            expect(text).toMatch(/^ {6}rent: \$\{\{ inputs\.rent \}\}$/m);
            expect(text).toMatch(/^ {6}max_price: \$\{\{ inputs\.max_price \}\}$/m);
            expect(text).toMatch(/^permissions:\n {2}contents: read$/m);
        });
    });

    describe('live.yml', () => {
        const text = workflow('live.yml');

        it('is only ever called: no push, pull request or schedule starts a live run', () => {
            expect(triggers(text)).toEqual(['workflow_call']);
            for (const name of ['ci.yml', 'docs.yml']) expect(workflow(name)).not.toMatch(/live\.yml|jest\.live\.config|ASAP_VPS_LIVE/);
        });

        it('hands the suites every key .env.template names, each from a secret, and the one setting that is none from a variable', () => {
            const names = [...readFileSync(join(ROOT, '.env.template'), 'utf8').matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]);
            expect(names.length).toBeGreaterThanOrEqual(8);
            const env = Object.fromEntries([...text.matchAll(/^ {6}([A-Z][A-Z0-9_]*): \$\{\{ (secrets|vars)\.([A-Z][A-Z0-9_]*) \}\}$/gm)].map((m) => [m[1], `${m[2]}.${m[3]}`]));
            expect(env).toEqual(Object.fromEntries(names.map((n) => [n, n === 'SCW_ZONES' ? `vars.${n}` : `secrets.${n}`])));
        });

        it('rents nothing unless `rent` is on, and queues the runs of one provider', () => {
            expect(text).toMatch(/^ {6}ASAP_VPS_LIVE: \$\{\{ inputs\.targets \}\}$/m);
            expect(text).toMatch(/^ {6}ASAP_VPS_LIVE_FREE: \$\{\{ inputs\.rent && '0' \|\| '1' \}\}$/m);
            expect(text).toMatch(/^ {6}ASAP_VPS_LIVE_MAX_PRICE: \$\{\{ inputs\.max_price \}\}$/m);
            expect(text).toMatch(/^ {6}ASAP_VPS_LIVE_IMAGES: \$\{\{ inputs\.images && '1' \|\| '0' \}\}$/m);
            expect(text).toMatch(/^ {4}concurrency:\n {6}group: live-\$\{\{ inputs\.provider \}\}\n {6}cancel-in-progress: false$/m);
        });

        it('runs the one pattern it is given, as a word and never as script, and sweeps the provider\'s account after a renting run whatever happened to it', () => {
            expect(text).toMatch(/^ {8}env:\n {10}PATTERN: \$\{\{ inputs\.pattern \}\}\n {8}run: npx jest --config jest\.live\.config\.js "\$PATTERN"$/m);
            expect(text).toMatch(/^ {8}if: \$\{\{ always\(\) && inputs\.rent \}\}\n {8}env:\n {10}PROVIDER: \$\{\{ inputs\.provider \}\}\n {8}run: npm run -s gpu:smoke -- "\$PROVIDER" --sweep$/m);
            // No input is pasted into a script: each reaches one through the environment.
            const scripts = [...text.matchAll(/^ {8}run: (.*)$/gm)].map((m) => m[1]);
            expect(scripts.filter((s) => s.includes('${{'))).toEqual([]);
        });
    });
});
