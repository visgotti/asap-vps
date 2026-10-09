// The site: a hash-routed set of markdown pages. Code blocks are shown as plain code at once and become Monaco editors as they scroll into
// view (editor.ts is loaded on demand: it is the heavy part, and a page reads fine without it).

import { Marked } from 'marked';
import { Fence, fencesOf, kindOf } from './fences';
import { PAGES, bySlug, Page } from './nav';

declare const BUILD_ID: string;

type Caps = Record<string, { name: string, capabilities: Record<string, any> }>;

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const slugify = (s: string) => s.toLowerCase().replace(/<[^>]+>/g, '').replace(/&[a-z]+;/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// ── theme ───────────────────────────────────────────────────────────────────
const stored = (() => { try { return localStorage.getItem('asap-theme'); } catch { return null; } })();
let dark = stored ? stored === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
const applyTheme = () => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    void editorModule?.then((m) => m.setTheme(dark));
};

// ── the editor module, on demand ───────────────────────────────────────────
type EditorModule = typeof import('./editor');
let editorModule: Promise<EditorModule> | undefined;
const loadEditor = (): Promise<EditorModule> => {
    editorModule ??= import(/* esbuild: external */ `./editor.js?v=${BUILD_ID}` as string) as Promise<EditorModule>;
    return editorModule;
};

// ── capabilities: generated from the code at build time ────────────────────
let capsPromise: Promise<Caps> | undefined;
const loadCaps = () => (capsPromise ??= fetch(`capabilities.json?v=${BUILD_ID}`).then((r) => r.json() as Promise<Caps>));

const CAP_ROWS: Array<[string, string, (t: any) => string]> = [
    ['compute', 'Servers', (t) => `${t.kind === 'vm' ? 'VMs' : 'containers'}: ${[t.gpu && 'GPU', t.cpu && 'CPU'].filter(Boolean).join(' + ')}`],
    ['power', 'Stop / start', (t) => `stopped bills ${t.stoppedBilling === 'full' ? 'in full' : 'storage only'}`],
    ['restart', 'Restart', () => 'yes'],
    ['logs', 'Container logs', () => 'yes'],
    ['sshKeys', 'SSH keys', (t) => (t.appliedAtBoot ? 'applied at every boot' : 'yes')],
    ['images', 'Images', (t) => (t.scope === 'region' ? 'per region' : 'boot anywhere')],
    ['imageCopy', 'Copy an image', () => 'yes'],
    ['imageImport', 'Import a disk image', (t) => `${t.formats.join(', ')}, up to ${t.maxGb} GB`],
    ['volumes', 'Volumes', (t) => [t.block && `block (${t.block.mount})`, t.shared && `shared (${t.shared.mount})`].filter(Boolean).join(' + ')],
    ['volumeAttach', 'Attach to a running server', () => 'yes'],
    ['serverless', 'Serverless', (t) => [t.gpu && 'GPU', t.cpu && 'CPU'].filter(Boolean).join(' + ')],
];

async function renderCaps(host: HTMLElement) {
    const caps = await loadCaps();
    const ids = Object.keys(caps);
    host.innerHTML = `<table class="caps-table"><thead><tr><th></th>${ids.map((id) => `<th>${esc(caps[id].name)}</th>`).join('')}</tr></thead><tbody>${
        CAP_ROWS.map(([key, label, fmt]) => `<tr><th scope="row"><code>${key}</code> ${esc(label)}</th>${ids.map((id) => {
            const t = caps[id].capabilities[key];
            return t === undefined ? '<td class="no">—</td>' : `<td class="yes"><span class="tick">✓</span> ${esc(fmt(t))}</td>`;
        }).join('')}</tr>`).join('')
    }</tbody></table>`;
}

// ── inheritance: generated from the source at build time ───────────────────
type Heritage = Record<string, {
    class: string, file: string,
    chain: Array<{ name: string, abstract: boolean, file: string, summary: string, typeParams: string[], extends: string | null, implements: string[] }>,
    capabilities: Array<{ name: string, interface: string, methods: Array<{ name: string, from: string, own: boolean, abstract: boolean, summary: string }> }>,
    inherited: Array<{ name: string, abstract: boolean, members: Array<{ name: string, kind: string, abstract: boolean, protected: boolean, overridden: boolean }> }>,
    api: Array<{ name: string, extends: string | null, file: string, summary: string }>,
}>;
let heritagePromise: Promise<Heritage> | undefined;
const loadHeritage = () => (heritagePromise ??= fetch(`heritage.json?v=${BUILD_ID}`).then((r) => r.json() as Promise<Heritage>));

async function renderHeritage(host: HTMLElement, id: string) {
    const h = (await loadHeritage())[id];
    if (!h) { host.textContent = `no inheritance data for "${id}"`; return; }
    const chain = h.chain.map((c, i) => `<li class="her-node${i === 0 ? ' self' : ''}">
        <div class="her-head"><code class="her-name">${esc(c.name)}${c.typeParams.length ? esc(`<${c.typeParams.map((t) => t.split(' ')[0]).join(', ')}>`) : ''}</code><span class="her-tag">${c.abstract ? 'abstract class' : 'class'}</span>${c.extends ? `<span class="her-ext">extends <code>${esc(c.extends)}</code></span>` : ''}</div>
        ${c.implements.length ? `<div class="her-impl">implements ${c.implements.map((x) => `<code>${esc(x)}</code>`).join(' ')}</div>` : ''}
        ${c.summary ? `<p class="her-sum">${esc(c.summary)}</p>` : ''}
        <div class="her-file">${esc(c.file)}</div></li>`).join('');
    const api = h.api.map((c) => `<code>${esc(c.name)}</code>`).join(' extends ');
    const caps = h.capabilities.map((c) => `<tr><th scope="row"><code>${esc(c.name)}</code></th><td><code>${esc(c.interface)}</code></td><td class="her-methods">${c.methods.map((m) => {
        const where = m.own ? `implemented by ${h.class}` : `implemented once, in ${m.from}, for every provider`;
        return `<code class="her-m${m.own ? '' : ' inh'}" title="${esc(where)}">${esc(m.name)}</code>`;
    }).join(' ')}</td></tr>`).join('');
    const inherited = h.inherited.map((b) => `<details class="her-inh"><summary><code>${esc(b.name)}</code> gives ${esc(h.class)} ${b.members.filter((m) => !m.protected).length} public members${b.members.some((m) => m.overridden) ? `, of which ${esc(h.class)} writes ${b.members.filter((m) => m.overridden).length} itself` : ''}</summary><p>${b.members.map((m) => `<code class="her-m${m.overridden ? ' ovr' : ' inh'}" title="${esc(`${m.abstract ? 'abstract, ' : ''}${m.protected ? 'protected ' : ''}${m.kind}${m.overridden ? `, declared again in ${h.class}` : ''}`)}">${esc(m.name)}${m.abstract ? ' ⟂' : ''}</code>`).join(' ')}</p></details>`).join('');
    host.innerHTML = `<div class="her-box">
        <div class="her-title">Class chain</div><ol class="her-chain">${chain}</ol>
        <div class="her-title">API client</div><p class="her-api">${api}. <code>${esc(h.class)}</code> holds one as <code>provider.api</code>: <code>provider.api.request('GET', '/path')</code> reaches any endpoint the capabilities do not cover.</p>
        <div class="her-title">Capability interfaces it implements</div>
        <div class="table-wrap"><table><thead><tr><th>Capability</th><th>Interface</th><th>Methods</th></tr></thead><tbody>${caps}</tbody></table></div>
        <p class="her-legend"><code class="her-m">name</code> is written in <code>${esc(h.class)}</code>; <code class="her-m inh">name</code> is written once in <code>ComputeProvider</code> and shared by all providers.</p>
        <div class="her-title">What the base classes give it</div>${inherited}
        <p class="her-legend">⟂ marks an abstract member: each provider must write it.</p>
    </div>`;
}

// ── markdown ────────────────────────────────────────────────────────────────
function render(page: Page): { html: string, fences: Fence[], toc: Array<{ id: string, text: string, depth: number }> } {
    const fences = fencesOf(page.slug, page.md);
    const toc: Array<{ id: string, text: string, depth: number }> = [];
    let n = 0;
    const marked = new Marked({
        renderer: {
            code({ text }) {
                const f = fences[n++];
                if (!f) return `<pre><code>${esc(text)}</code></pre>`;
                if (f.lang === 'capabilities') return '<div class="caps" data-caps></div>';
                if (f.lang === 'heritage') return `<div class="heritage" data-heritage="${esc(f.code.trim())}"></div>`;
                return `<div class="snippet" data-n="${n - 1}"><pre class="plain"><code>${esc(f.code)}</code></pre></div>`;
            },
            heading({ tokens, depth }) {
                const inner = this.parser.parseInline(tokens);
                const id = slugify(inner);
                if (depth === 2 || depth === 3) toc.push({ id, text: inner.replace(/<[^>]+>/g, ''), depth });
                const anchor = depth === 2 || depth === 3 ? `<a class="anchor" href="#/${page.slug}/${id}" aria-label="Link to this section">#</a>` : '';
                return `<h${depth} id="${id}">${anchor}${inner}</h${depth}>`;
            },
            link({ href, tokens }) {
                const inner = this.parser.parseInline(tokens);
                return /^https?:/.test(href) ? `<a href="${esc(href)}" target="_blank" rel="noopener">${inner}</a>` : `<a href="${esc(href)}">${inner}</a>`;
            },
            table(token) {
                const head = token.header.map((c) => `<th>${this.parser.parseInline(c.tokens)}</th>`).join('');
                const rows = token.rows.map((r) => `<tr>${r.map((c) => `<td>${this.parser.parseInline(c.tokens)}</td>`).join('')}</tr>`).join('');
                return `<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div>`;
            },
        },
    });
    return { html: marked.parse(page.md) as string, fences, toc };
}

// ── pages ───────────────────────────────────────────────────────────────────
let observer: IntersectionObserver | undefined;

async function show(slug: string, anchor?: string) {
    const page = bySlug(slug) ?? PAGES[0];
    document.title = `${page.title} · asap-vps`;
    const { html, fences, toc } = render(page);
    const article = $('#article');
    article.innerHTML = `<header class="page-head"><div class="eyebrow">${esc(page.group)}</div></header>${html}${pager(page)}`;
    $('#toc').innerHTML = toc.length ? `<div class="toc-title">On this page</div>${toc.map((t) => `<a class="d${t.depth}" href="#/${page.slug}/${t.id}">${esc(t.text)}</a>`).join('')}` : '';
    document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('on', a.getAttribute('href') === `#/${page.slug}`));
    document.body.classList.remove('nav-open');

    article.querySelectorAll<HTMLElement>('[data-caps]').forEach((el) => void renderCaps(el));
    article.querySelectorAll<HTMLElement>('[data-heritage]').forEach((el) => void renderHeritage(el, el.dataset.heritage!));

    // Editors appear as their blocks come near the viewport.
    observer?.disconnect();
    observer = new IntersectionObserver((entries) => {
        for (const e of entries) {
            if (!e.isIntersecting) continue;
            const host = e.target as HTMLElement;
            observer!.unobserve(host);
            const f = fences[Number(host.dataset.n)];
            const kind = kindOf(f);
            if (kind === 'static') { host.classList.add('static'); void colorize(host, f); continue; }
            void loadEditor().then((m) => m.mount(host, f, kind, dark)).catch((err) => console.error('the editor could not load', err));
        }
    }, { rootMargin: '700px 0px' });
    article.querySelectorAll<HTMLElement>('.snippet').forEach((el) => observer!.observe(el));

    if (anchor) document.getElementById(anchor)?.scrollIntoView();
    else window.scrollTo(0, 0);
}

async function colorize(host: HTMLElement, f: Fence) {
    const label = f.attrs.title ? `<div class="snippet-bar"><span class="snippet-title">${esc(f.attrs.title)}</span></div>` : '';
    try {
        const m = await loadEditor();
        const lang = f.lang === 'ts' ? 'typescript' : f.lang === 'bash' ? 'shell' : f.lang;
        host.innerHTML = `${label}<pre class="static-code"><code>${await m.colorize(f.code, lang)}</code></pre>`;
    } catch {
        host.innerHTML = `${label}<pre class="static-code"><code>${esc(f.code)}</code></pre>`;
    }
}

function pager(page: Page): string {
    const i = PAGES.indexOf(page);
    const prev = PAGES[i - 1];
    const next = PAGES[i + 1];
    return `<nav class="pager">${prev ? `<a href="#/${prev.slug}"><small>Previous</small>${esc(prev.title)}</a>` : '<span></span>'}${next ? `<a class="next" href="#/${next.slug}"><small>Next</small>${esc(next.title)}</a>` : '<span></span>'}</nav>`;
}

function buildNav() {
    const groups = [...new Set(PAGES.map((p) => p.group))];
    $('#nav').innerHTML = groups.map((g) => `<div class="nav-group">${esc(g)}</div>${PAGES.filter((p) => p.group === g).map((p) => `<a href="#/${p.slug}">${esc(p.title)}</a>`).join('')}`).join('');
}

function route() {
    const [, slug = PAGES[0].slug, anchor] = location.hash.split('/');
    void show(slug, anchor);
}

buildNav();
applyTheme();
$('#theme').addEventListener('click', () => {
    dark = !dark;
    try { localStorage.setItem('asap-theme', dark ? 'dark' : 'light'); } catch { /* private mode: it lasts this visit */ }
    applyTheme();
});
$('#menu').addEventListener('click', () => document.body.classList.toggle('nav-open'));
addEventListener('hashchange', route);
route();
