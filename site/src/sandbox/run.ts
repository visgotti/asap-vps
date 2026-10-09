// Runs a snippet the way the docs say it runs: the library's real code, against in-browser fakes of the providers' APIs.
//
// The snippet is TypeScript compiled to an ES module; its `import ... from 'asap-vps'` becomes the library bundled here, `process.env` holds
// keys the fakes accept, and `fetch` routes each provider's real host to its fake (src/testing/fakes), so the code is what you would write for the
// real API. Time is virtual: a wait of 10 s is a few milliseconds, but Date.now() has moved 10 s, so costs, billing and timeouts add up as they
// would. Nothing leaves the page (or the Node process that checks the docs).

import * as lib from './lib';
import { fakeDigitalOcean } from '../../../src/testing/fakes/digitalocean';
import { fakeLambda } from '../../../src/testing/fakes/lambda';
import { fakeRunPod } from '../../../src/testing/fakes/runpod';
import { fakeScaleway, FAKE_SCALEWAY_PROJECT } from '../../../src/testing/fakes/scaleway';
import { fakeVast } from '../../../src/testing/fakes/vast';
import { format } from './inspect';

export type SandboxIO = {
    log(level: 'log' | 'info' | 'warn' | 'error', text: string): void;
    /** One HTTP request the snippet's code made, once answered. */
    request?(r: { method: string, url: string, status: number }): void;
};

/** The environment a snippet reads: a key each fake accepts (the real names, so `process.env.X!` snippets are the real ones). */
export const SANDBOX_ENV: Readonly<Record<string, string>> = Object.freeze({
    DIGITAL_OCEAN_API_KEY: 'do-test',
    RUNPOD_API_KEY: 'rp-test',
    VAST_API_KEY: 'vast-test',
    LAMBDA_API_KEY: 'lambda-test',
    SCW_SECRET_KEY: 'scw-test',
    SCW_DEFAULT_PROJECT_ID: FAKE_SCALEWAY_PROJECT,
    SCW_ACCESS_KEY: 'SCWFAKEACCESSKEY0000',
});

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (...args: string[]) => (...a: unknown[]) => Promise<unknown>;

/** `import { A, B as C } from 'asap-vps'` and `import * as x from 'asap-vps'`, as the ES module TypeScript emits them, as reads of the library. */
export function bindImports(js: string): string {
    // `export {}` only makes the file a module (so top-level await type-checks); there is nothing to export from a snippet.
    return js.replace(/^export\s*\{\s*\};?[ \t]*$/gm, '').replace(/^import\s+(?:\{([^}]*)\}|\*\s+as\s+(\w+))\s+from\s+['"]asap-vps['"];?[ \t]*$/gm, (_m, names: string | undefined, ns: string | undefined) => {
        if (ns) return `const ${ns} = __lib;`;
        const pairs = names!.split(',').map((s) => s.trim()).filter(Boolean).map((s) => s.replace(/\s+as\s+/, ': '));
        return `const { ${pairs.join(', ')} } = __lib;`;
    });
}

/** Runs compiled snippet code (an ES module, top-level await allowed) in a fresh world of fakes. Resolves when it finishes; rejects with what it threw. */
export async function runSnippet(js: string, io: SandboxIO): Promise<void> {
    const fakes = {
        digitalocean: fakeDigitalOcean(),
        runpod: fakeRunPod(),
        lambda: fakeLambda(),
        vast: fakeVast(),
        scaleway: fakeScaleway({ accessKey: SANDBOX_ENV.SCW_ACCESS_KEY }),
    };
    const fakeFor = (host: string) => {
        if (host === 'api.digitalocean.com') return fakes.digitalocean;
        if (host === 'api.runpod.io' || host.endsWith('.api.runpod.ai')) return fakes.runpod;
        if (host === 'cloud.lambda.ai') return fakes.lambda;
        if (host === 'console.vast.ai' || host === 'logs.fake' || host.endsWith('registry.fake')) return fakes.vast;
        if (host === 'api.scaleway.com' || host.endsWith('.scw.cloud') || host.endsWith('.scw.cloud:443')) return fakes.scaleway;
        return undefined;
    };

    const g = globalThis as unknown as Record<string, any>;
    const saved = { fetch: g.fetch, Date: g.Date, setTimeout: g.setTimeout, console: g.console, process: g.process };
    let skew = 0;
    const RealDate = Date;
    class SandboxDate extends RealDate {
        constructor(...args: unknown[]) {
            if (args.length === 0) super(RealDate.now() + skew);
            else super(...(args as [number]));
        }
        static now(): number {
            return RealDate.now() + skew;
        }
    }
    const realSetTimeout = saved.setTimeout as typeof setTimeout;
    try {
        g.Date = SandboxDate;
        // A wait of `ms` takes a moment and moves the clock `ms`: polls converge at once, and what depends on time still adds up.
        g.setTimeout = (fn: (...a: unknown[]) => void, ms = 0, ...rest: unknown[]) => realSetTimeout(() => {
            skew += Math.max(0, Number(ms) || 0);
            fn(...rest);
        }, 1);
        g.process = { env: { ...SANDBOX_ENV }, platform: 'sandbox', versions: {}, argv: [], cwd: () => '/', nextTick: (f: () => void) => queueMicrotask(f), on: () => undefined };
        g.fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
            const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url);
            const fake = fakeFor(url.host);
            if (!fake) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND', message: `${url.host}: the sandbox reaches only its fake provider APIs` } });
            const res = await fake.fetchImpl(input, init);
            io.request?.({ method: (init?.method ?? 'GET').toUpperCase(), url: `${url.host}${url.pathname}${url.search}`, status: res.status });
            return res;
        };
        const write = (level: 'log' | 'info' | 'warn' | 'error') => (...args: unknown[]) => io.log(level, format(args));
        g.console = { log: write('log'), info: write('info'), warn: write('warn'), error: write('error'), debug: write('log'), table: write('log'), dir: write('log') };
        await new AsyncFunction('__lib', bindImports(js))(lib);
    } finally {
        Object.assign(g, saved);
    }
}
