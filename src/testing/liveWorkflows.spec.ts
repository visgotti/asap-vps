// The workflows that run the live suites from GitHub
// (.github/workflows/live-<provider>.yml, and live.yml which each calls once
// for each of its suites) held to the suites there are: every *.live.spec.ts
// is run by exactly one workflow of its provider, so a suite added with none
// fails here and not after a release nobody tested. And to what makes them
// one click: nothing to fill in, nothing but a hand to start them, one suite
// at a time on an account, every key the suites read handed on.

import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { LIVE_TARGETS } from './live';

const ROOT = join(__dirname, '..', '..');
const DIR = join(ROOT, '.github', 'workflows');
const workflow = (name: string) => readFileSync(join(DIR, name), 'utf8');
/** A provider's id, and the folder its class and its suites are in. */
const FOLDERS: Record<string, string> = { digitalocean: 'DigitalOcean', scaleway: 'Scaleway', lambda: 'LambdaCloud', runpod: 'RunPod', vast: 'VastAI' };
/** Every live suite there is, by its path from the repository's root. */
const SUITES = Object.values(FOLDERS).flatMap((folder) => readdirSync(join(ROOT, 'src', 'Providers', folder))
    .filter((f) => f.endsWith('.live.spec.ts')).map((f) => `src/Providers/${folder}/${f}`));
/** The files a pattern runs, as jest reads one: a regular expression, matched anywhere in the path, in either case. */
const run = (pattern: string) => SUITES.filter((f) => new RegExp(pattern, 'i').test(join(ROOT, f)));
/** What starts a workflow, in the order it says them. */
const triggers = (text: string) => [...text.matchAll(/^ {2}(workflow_dispatch|workflow_call|push|pull_request|pull_request_target|schedule|workflow_run|release):/gm)].map((m) => m[1]);
/** The workflows a person starts: every live-*.yml. */
const STARTED = readdirSync(DIR).filter((f) => /^live-.+\.yml$/.test(f)).sort();
/** One of them, read: whose account it runs on, the suites it runs, and the pattern each is run by. */
const read = (file: string) => {
    const text = workflow(file);
    const provider = /^ {6}provider: (\S+)$/m.exec(text)![1];
    const suites = /^ {6}matrix:\n {8}suite:\n((?: {10}- \S+\n)+)/m.exec(text)![1].trim().split('\n').map((l) => l.trim().slice(2));
    const pattern = /^ {6}pattern: (.+)$/m.exec(text)![1];
    return { file, text, provider, suites, patterns: suites.map((s) => pattern.replace('${{ matrix.suite }}', s)), pattern };
};

describe('the live suites, run from GitHub', () => {
    it('there are suites to hold the workflows to in every provider\'s folder, and a workflow or more for every provider', () => {
        expect(SUITES.length).toBeGreaterThanOrEqual(30);
        for (const folder of Object.values(FOLDERS)) expect(SUITES.filter((f) => f.startsWith(`src/Providers/${folder}/`)).length).toBeGreaterThanOrEqual(4);
        expect(STARTED).toEqual(['live-digitalocean-gpu.yml', 'live-digitalocean.yml', 'live-lambda.yml', 'live-runpod.yml', 'live-scaleway-gpu.yml', 'live-scaleway.yml', 'live-vast.yml']);
        expect([...new Set(STARTED.map((f) => read(f).provider))].sort()).toEqual(Object.keys(FOLDERS).sort());
    });

    it.each(Object.entries(FOLDERS))('every suite of %s is run by exactly one of its workflows, each by a pattern that runs that file alone', (provider, folder) => {
        const own = SUITES.filter((f) => f.startsWith(`src/Providers/${folder}/`));
        const theirs = STARTED.map(read).filter((w) => w.provider === provider);
        const ran = theirs.flatMap((w) => w.patterns.map((p) => [p, run(p)] as const));
        // A pattern runs one file, of this provider; and between them, every file it has, none twice.
        expect(ran.filter(([, files]) => files.length !== 1 || !own.includes(files[0])).map(([p]) => p)).toEqual([]);
        expect(ran.map(([, files]) => files[0]).sort()).toEqual([...own].sort());
        for (const w of theirs) expect(w.pattern).toBe(`src/Providers/${folder}/\${{ matrix.suite }}.live.spec`);
    });

    it('the lifecycle on a GPU VM, which costs dollars where the rest cost cents, is a workflow of its own on DigitalOcean and Scaleway', () => {
        expect(read('live-digitalocean-gpu.yml').suites).toEqual(['DigitalOcean']);
        expect(read('live-scaleway-gpu.yml').suites).toEqual(['Scaleway']);
        expect([read('live-digitalocean.yml').suites.includes('DigitalOcean'), read('live-scaleway.yml').suites.includes('Scaleway')]).toEqual([false, false]);
    });

    describe.each(STARTED)('%s', (file) => {
        const { text, provider, suites } = read(file);

        it('is one click: started by hand and by nothing else, with nothing to fill in', () => {
            expect(triggers(text)).toEqual(['workflow_dispatch']);
            // No inputs: the line after the trigger is blank, and nothing in the file reads one.
            expect(text).toMatch(/^on:\n {2}workflow_dispatch:\n\npermissions:\n {2}contents: read$/m);
            expect(text).not.toMatch(/inputs/);
        });

        it('runs its suites one at a time, each a job of its own that does not stop the others, and waits for another run on the same account', () => {
            expect(text).toMatch(/^ {4}strategy:\n {6}fail-fast: false\n {6}max-parallel: 1\n {6}matrix:\n {8}suite:$/m);
            expect(new Set(suites).size).toBe(suites.length);
            expect(text).toMatch(new RegExp(`^concurrency:\\n {2}group: live-${provider}\\n {2}cancel-in-progress: false$`, 'm'));
            expect(text).toMatch(/^ {4}name: \$\{\{ matrix\.suite \}\}$/m);
        });

        it('hands live.yml its keys, its provider and every target its suites are gated on', () => {
            expect(text).toMatch(/^ {4}uses: \.\/\.github\/workflows\/live\.yml\n {4}secrets: inherit$/m);
            const targets = /^ {6}targets: (\S+)$/m.exec(text)![1].split(',');
            expect(targets).toEqual(LIVE_TARGETS.filter((t) => t === provider || t.startsWith(`${provider}-`)));
            const named = suites.flatMap((s) => [...readFileSync(join(ROOT, 'src', 'Providers', FOLDERS[provider], `${s}.live.spec.ts`), 'utf8')
                .matchAll(/(?:liveRequested\(|target: )'([a-z-]+)'/g)].map((m) => m[1]));
            expect(named.filter((t) => !targets.includes(t))).toEqual([]);
        });
    });

    it('a rented GPU costs at most $1 an hour, but on Lambda, whose cheapest costs more: $1.50', () => {
        const caps = Object.fromEntries(STARTED.map((f) => [f, /^ {6}max_price: '([^']+)'$/m.exec(workflow(f))?.[1] ?? 'the default']));
        expect(caps).toEqual({ ...Object.fromEntries(STARTED.map((f) => [f, 'the default'])), 'live-lambda.yml': '1.5' });
        expect(workflow('live.yml')).toMatch(/^ {6}max_price:\n {8}description: [^\n]+\n {8}type: string\n {8}default: '1'$/m);
    });

    describe('live.yml', () => {
        const text = workflow('live.yml');

        it('is only ever called: no push, pull request or schedule starts a live run', () => {
            expect(triggers(text)).toEqual(['workflow_call']);
            for (const name of ['ci.yml', 'docs.yml']) expect(workflow(name)).not.toMatch(/live\.yml|jest\.live\.config|ASAP_VPS_LIVE/);
        });

        it('hands the suite every key .env.template names, each from a secret, and the one setting that is none from a variable', () => {
            const names = [...readFileSync(join(ROOT, '.env.template'), 'utf8').matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]);
            expect(names.length).toBeGreaterThanOrEqual(8);
            const env = Object.fromEntries([...text.matchAll(/^ {6}([A-Z][A-Z0-9_]*): \$\{\{ (secrets|vars)\.([A-Z][A-Z0-9_]*) \}\}$/gm)].map((m) => [m[1], `${m[2]}.${m[3]}`]));
            expect(env).toEqual(Object.fromEntries(names.map((n) => [n, n === 'SCW_ZONES' ? `vars.${n}` : `secrets.${n}`])));
        });

        it('runs the whole suite, what rents included, for the targets and under the price it is given', () => {
            expect(text).toMatch(/^ {6}ASAP_VPS_LIVE: \$\{\{ inputs\.targets \}\}$/m);
            expect(text).toMatch(/^ {6}ASAP_VPS_LIVE_MAX_PRICE: \$\{\{ inputs\.max_price \}\}$/m);
            // Nothing holds a suite to its free checks, or leaves its image phase out: a click is the whole of it.
            expect(text).not.toMatch(/ASAP_VPS_LIVE_FREE|ASAP_VPS_LIVE_IMAGES/);
        });

        it('runs the one pattern it is given, as a word and never as script, and sweeps the provider\'s account afterwards whatever happened to the suite', () => {
            expect(text).toMatch(/^ {8}env:\n {10}PATTERN: \$\{\{ inputs\.pattern \}\}\n {8}run: npx jest --config jest\.live\.config\.js "\$PATTERN"$/m);
            expect(text).toMatch(/^ {8}if: \$\{\{ always\(\) \}\}\n {8}env:\n {10}PROVIDER: \$\{\{ inputs\.provider \}\}\n {8}run: npm run -s gpu:smoke -- "\$PROVIDER" --sweep$/m);
            // No input is pasted into a script: each reaches one through the environment.
            const scripts = [...text.matchAll(/^ {8}run: (.*)$/gm)].map((m) => m[1]);
            expect(scripts.filter((s) => s.includes('${{'))).toEqual([]);
        });
    });
});
