// The site, as a reader meets it, in headless Chrome: every page is opened, scrolled so each editor mounts, and every Run button pressed.
// Fails if an editor shows a type error where the check says there is none (or none where an `error` block should have one), if a run
// does not finish, or if the console has an error. Needs Chrome, and the site served (npm run dev) or SITE_URL.
//
//   node scripts/e2e.mjs [slug ...] [--shots=dir]

import { launch } from './chrome.mjs';
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { SITE } from '../esbuild.shared.mjs';

const base = process.env.SITE_URL ?? 'http://localhost:8765/';
const only = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const shots = process.argv.find((a) => a.startsWith('--shots='))?.slice(8);
const CACHE = path.join(SITE, '.cache');
await build({ entryPoints: [path.join(SITE, 'src/nav.ts')], bundle: true, platform: 'node', format: 'esm', outfile: path.join(CACHE, 'pages-e2e.mjs'), loader: { '.md': 'text' }, logLevel: 'warning' });
const { PAGES } = await import(`${pathToFileURL(path.join(CACHE, 'pages-e2e.mjs')).href}?${Date.now()}`);
if (shots) fs.mkdirSync(shots, { recursive: true });

const browser = await launch();
let failures = 0;
const fail = (page, msg) => { failures++; console.log(`  ✗ ${page}: ${msg}`); };

for (const p of PAGES.filter((x) => !only.length || only.includes(x.slug))) {
    const page = await browser.newPage();
    await page.setViewport({ width: 1360, height: 900 });
    const problems = [];
    page.on('console', (m) => { if (m.type() === 'error') problems.push(m.text()); });
    page.on('pageerror', (e) => problems.push(e.message));
    await page.goto(`${base}#/${p.slug}`, { waitUntil: 'networkidle2', timeout: 90000 });
    const total = await page.$$eval('.snippet', (els) => els.length);
    // Scroll down in steps so every block comes within the observer's margin.
    for (let y = 0; y < 60; y++) { await page.evaluate(() => window.scrollBy(0, 700)); await new Promise((r) => setTimeout(r, 120)); }
    await page.waitForFunction((n) => document.querySelectorAll('.snippet.live, .snippet.static').length >= n, { timeout: 90000 }, total).catch(() => fail(p.slug, 'not every block became an editor'));
    await new Promise((r) => setTimeout(r, 5000)); // the TypeScript service checks every model
    const info = await page.$$eval('.snippet', (els) => els.map((el) => ({
        kind: ['run', 'edit', 'error', 'static'].find((k) => el.classList.contains(`kind-${k}`)) ?? (el.classList.contains('static') ? 'static' : 'plain'),
        errors: [...el.querySelectorAll('.problem')].map((x) => x.textContent?.trim().slice(0, 200)),
    })));
    // An editor that mounted with nothing in it is a broken page, not a pass.
    const empty = await page.$$eval('.snippet.live', (els) => els.map((el, i) => (el.querySelectorAll('.view-line').length ? -1 : i)).filter((i) => i >= 0));
    if (empty.length) fail(p.slug, `${empty.length} editor(s) are empty (blocks ${empty.map((i) => i + 1).join(', ')})`);
    const heritage = await page.$$eval('[data-heritage]', (els) => els.map((el) => el.querySelectorAll('.her-node').length));
    heritage.forEach((n) => { if (n < 3) fail(p.slug, `the class hierarchy shows ${n} class(es), expected the provider, ComputeProvider and BaseProvider`); });
    let ran = 0;
    for (const [i, s] of info.entries()) {
        if (s.kind === 'error' && !s.errors.length) fail(p.slug, `block ${i + 1} should show a type error and shows none`);
        if ((s.kind === 'run' || s.kind === 'edit') && s.errors.length) fail(p.slug, `block ${i + 1} shows type errors: ${s.errors.join(' | ')}`);
    }
    for (const btn of await page.$$('[data-act="run"]')) {
        await btn.evaluate((b) => b.scrollIntoView({ block: 'center' }));
        await btn.click();
        await page.waitForFunction((b) => !b.disabled, { timeout: 120000 }, btn).catch(() => fail(p.slug, 'a run did not finish in 120 s'));
        ran++;
    }
    const outcomes = await page.$$eval('.snippet .output:not([hidden]) .status', (els) => els.map((e) => e.textContent ?? ''));
    outcomes.forEach((o, i) => { if (!o.startsWith('finished')) fail(p.slug, `run ${i + 1} ended "${o}"`); });
    if (shots) { await page.evaluate(() => window.scrollTo(0, 0)); await page.screenshot({ path: path.join(shots, `${p.slug}.png`) }); }
    for (const msg of problems) fail(p.slug, `console error: ${msg.slice(0, 200)}`);
    console.log(`${problems.length || outcomes.some((o) => !o.startsWith('finished')) ? '✗' : '✓'} ${p.slug}: ${total} block(s), ${info.filter((s) => s.kind === 'error').length} intended error(s), ${ran} run(s) ${outcomes.length ? `[${[...new Set(outcomes.map((o) => o.split(' ')[0]))].join(', ')}]` : ''}`);
    await page.close();
}
await browser.close();
console.log(failures ? `\n${failures} problem(s)` : '\nevery page, every editor and every run behaves as the check says');
process.exit(failures ? 1 : 0);
