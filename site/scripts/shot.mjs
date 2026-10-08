// A headless-Chrome look at the site: node scripts/shot.mjs <hash route> [out.png] [--run] [--wait ms]
// Used to check the pages as a reader sees them: it loads the page, waits for the editors, optionally clicks every Run button, and prints what the console and the output panes say.
import { launch } from './chrome.mjs';

const args = process.argv.slice(2);
const route = args.find((a) => !a.startsWith('--') && !a.endsWith('.png')) ?? '#/overview';
const out = args.find((a) => a.endsWith('.png')) ?? '/tmp/site.png';
const doRun = args.includes('--run');
const dark = args.includes('--dark');
const base = process.env.SITE_URL ?? 'http://localhost:8765/';
const width = Number(args.find((a) => a.startsWith('--w='))?.slice(4) ?? 1360);

const browser = await launch();
const page = await browser.newPage();
await page.setViewport({ width, height: 900, deviceScaleFactor: 1 });
if (dark) await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
const problems = [];
page.on('console', (m) => { if (['error', 'warning'].includes(m.type())) problems.push(`[${m.type()}] ${m.text()}`); });
page.on('pageerror', (e) => problems.push(`[pageerror] ${e.message}`));
page.on('requestfailed', (r) => problems.push(`[requestfailed] ${r.url()}`));
await page.goto(`${base}${route}`, { waitUntil: 'networkidle2', timeout: 90000 });
await page.waitForSelector('.snippet.live', { timeout: 60000 }).catch(() => problems.push('[no live editor appeared]'));
await new Promise((r) => setTimeout(r, 2500));
if (doRun) {
    for (const btn of await page.$$('[data-act="run"]')) {
        await btn.evaluate((b) => b.scrollIntoView({ block: 'center' }));
        await btn.click();
        await page.waitForFunction((b) => !b.disabled, { timeout: 90000 }, btn);
        await new Promise((r) => setTimeout(r, 300));
    }
}
const report = await page.evaluate(() => ({
    title: document.title,
    live: document.querySelectorAll('.snippet.live').length,
    snippets: document.querySelectorAll('.snippet').length,
    problems: [...document.querySelectorAll('.snippet .problems:not([hidden])')].map((p) => p.textContent?.trim().slice(0, 240)),
    outputs: [...document.querySelectorAll('.snippet .output:not([hidden])')].map((o) => ({ status: o.querySelector('.status')?.textContent, out: o.querySelector('.pane-out')?.textContent?.slice(0, 600) })),
}));
await page.screenshot({ path: out, fullPage: args.includes('--full') });
console.log(JSON.stringify(report, null, 1));
if (problems.length) console.log('console:', problems.slice(0, 12).join('\n'));
await browser.close();
