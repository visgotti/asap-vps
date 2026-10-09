// The esbuild settings both the docs site and its snippet check share: the library (src/) bundled for a browser, with Node's built-ins
// replaced by the small shims in src/sandbox/shims, so the code a snippet runs is the library's own.

import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const SITE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(SITE, '..');
const shim = (name) => path.join(SITE, 'src/sandbox/shims', `${name}.ts`);

/** Node built-ins by what they become in the sandbox. */
const SHIMS = {
    crypto: shim('crypto'),
    fs: shim('fs'),
    'fs/promises': shim('fs'),
    os: shim('os'),
    stream: shim('stream'),
    'stream/promises': shim('stream'),
    util: shim('util'),
    'node-ssh': shim('node-ssh'),
    path: path.join(SITE, 'node_modules/path-browserify/index.js'),
};

export const nodeShims = {
    name: 'node-shims',
    setup(build) {
        build.onResolve({ filter: /^(node:)?(crypto|fs|fs\/promises|os|path|stream|stream\/promises|util)$|^node-ssh$/ }, (args) => ({ path: SHIMS[args.path.replace(/^node:/, '')] }));
    },
};

/** Options for a bundle that runs the library in a browser (or a worker, or Node pretending to be one). */
export const sandboxBuild = (extra = {}) => ({
    bundle: true,
    platform: 'browser',
    target: 'es2022',
    plugins: [nodeShims],
    inject: [shim('globals')],
    logLevel: 'warning',
    ...extra,
    define: { __dirname: '"/"', global: 'globalThis', ...extra.define },
});
