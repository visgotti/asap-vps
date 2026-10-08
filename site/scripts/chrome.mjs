// Launches headless Chrome for the browser scripts (e2e, shot, complete): CHROME_PATH, or the usual places.
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';

const CANDIDATES = [
    process.env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
].filter(Boolean);

export async function launch() {
    const executablePath = CANDIDATES.find((p) => fs.existsSync(p));
    if (!executablePath) throw new Error(`no Chrome found: set CHROME_PATH (tried ${CANDIDATES.join(', ')})`);
    return puppeteer.launch({ executablePath, headless: true, timeout: 120000, args: ['--no-sandbox', '--disable-gpu', '--no-first-run', '--no-default-browser-check'] });
}
