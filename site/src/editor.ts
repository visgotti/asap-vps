// The interactive part of the site, loaded on demand: Monaco with the library's real declarations (so completions, hovers, signature help and
// errors are the ones your editor gives you), and a Run button that executes a snippet in a Web Worker against the library's fakes.

import * as monaco from 'monaco-editor';
import type { Fence, SnippetKind } from './fences';
import type { FromWorker, ToWorker } from './sandbox/worker';

declare const BUILD_ID: string;

const HERE = new URL('.', import.meta.url);
const asset = (name: string) => new URL(`${name}?v=${BUILD_ID}`, HERE);

(self as unknown as { MonacoEnvironment: monaco.Environment }).MonacoEnvironment = {
    getWorker: (_id, label) => new Worker(asset(label === 'typescript' || label === 'javascript' ? 'ts.worker.js' : 'editor.worker.js')),
};

const ts = monaco.typescript;

/** Monaco's TypeScript service, set up like a project that has installed asap-vps and @types/node. */
let ready: Promise<void> | undefined;
function setup(): Promise<void> {
    ready ??= (async () => {
        const options = {
            target: ts.ScriptTarget.ESNext,
            module: ts.ModuleKind.ESNext,
            moduleResolution: ts.ModuleResolutionKind.NodeJs,
            strict: true,
            esModuleInterop: true,
            allowSyntheticDefaultImports: true,
            allowNonTsExtensions: true,
            skipLibCheck: true,
            lib: ['es2022', 'dom', 'dom.iterable'],
            noEmit: false,
        };
        ts.typescriptDefaults.setCompilerOptions(options);
        ts.typescriptDefaults.setEagerModelSync(true);
        ts.typescriptDefaults.setDiagnosticsOptions({ noSemanticValidation: false, noSyntaxValidation: false });
        const files = (await (await fetch(asset('types.json'))).json()) as Record<string, string>;
        ts.typescriptDefaults.setExtraLibs(Object.entries(files).map(([path, content]) => ({ content, filePath: `file://${path}` })));
    })();
    return ready;
}

/** `code` as highlighted HTML, for the blocks that are shown but not edited. */
export function colorize(code: string, lang: string): Promise<string> {
    return monaco.editor.colorize(code, lang, { tabSize: 2 });
}

export function setTheme(dark: boolean): void {
    monaco.editor.setTheme(dark ? 'vs-dark' : 'vs');
}

const BADGES: Record<SnippetKind, string> = { run: 'Simulated: runs against a fake', edit: 'Editable · type-checked', error: 'A type error, on purpose', static: '' };
const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);

/** Replaces the placeholder `host` with a live editor for `fence`. */
export async function mount(host: HTMLElement, fence: Fence, kind: SnippetKind, dark: boolean): Promise<void> {
    await setup();
    host.classList.add('live', `kind-${kind}`);
    host.innerHTML = `
      <div class="snippet-bar">
        <span class="snippet-title">${esc(fence.attrs.title ?? '')}</span>
        <span class="badge badge-${kind}">${BADGES[kind]}</span>
        <span class="spacer"></span>
        <button class="btn btn-ghost" data-act="copy" title="Copy the code">Copy</button>
        <button class="btn btn-ghost" data-act="reset" title="Back to the original code">Reset</button>
        ${kind === 'run' ? '<button class="btn btn-run" data-act="run" title="Run it against a fake of the provider: nothing is rented (Ctrl/Cmd+Enter)">▶ Run</button>' : ''}
      </div>
      <div class="editor-frame"></div>
      <div class="problems" hidden></div>
      <div class="output" hidden>
        <div class="output-tabs"><button data-tab="out" class="on">Output</button><button data-tab="net">Requests <span class="count">0</span></button><span class="status"></span></div>
        <div class="sim-note">Simulated: the real library, against an in-memory fake of the provider's API. Nothing is rented, and time runs ahead. <a href="#/sandbox">How it works</a></div>
        <div class="pane pane-out"></div>
        <div class="pane pane-net" hidden></div>
      </div>`;
    const frame = host.querySelector<HTMLElement>('.editor-frame')!;
    const model = monaco.editor.createModel(fence.code, 'typescript', monaco.Uri.parse(`file:///docs/${fence.id.replace('#', '-')}.ts`));
    const editor = monaco.editor.create(frame, {
        model,
        theme: dark ? 'vs-dark' : 'vs',
        minimap: { enabled: false },
        automaticLayout: true,
        scrollBeyondLastLine: false,
        scrollbar: { alwaysConsumeMouseWheel: false, vertical: 'auto', horizontal: 'auto' },
        fontSize: 13.5,
        lineHeight: 21,
        padding: { top: 10, bottom: 10 },
        tabSize: 2,
        renderLineHighlight: 'none',
        overviewRulerLanes: 0,
        fixedOverflowWidgets: true,
        quickSuggestions: { other: true, comments: false, strings: true },
        suggest: { showStatusBar: true, preview: true },
        parameterHints: { enabled: true },
        'semanticHighlighting.enabled': true,
        fontFamily: 'ui-monospace, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
        fontLigatures: false,
        wordWrap: 'on',
        wrappingIndent: 'indent',
    });
    const fit = () => {
        frame.style.height = `${Math.min(Math.max(editor.getContentHeight(), 64), 560)}px`;
        editor.layout();
    };
    editor.onDidContentSizeChange(fit);
    fit();

    // ── problems: the compiler's errors for this snippet, as text (a squiggle is easy to miss) ──
    const problems = host.querySelector<HTMLElement>('.problems')!;
    const showProblems = () => {
        const marks = monaco.editor.getModelMarkers({ resource: model.uri }).filter((m) => m.severity >= monaco.MarkerSeverity.Warning);
        problems.hidden = marks.length === 0;
        problems.innerHTML = marks.map((m) => `<div class="problem"><span class="where">line ${m.startLineNumber}</span> <span class="msg">${esc(m.message)}</span> <span class="code">TS${typeof m.code === 'object' ? m.code?.value : m.code ?? ''}</span></div>`).join('');
        host.classList.toggle('has-errors', marks.length > 0);
    };
    monaco.editor.onDidChangeMarkers((uris) => {
        if (uris.some((u) => u.toString() === model.uri.toString())) showProblems();
    });
    showProblems();

    // ── buttons ──
    host.addEventListener('click', (e) => {
        const act = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act;
        if (act === 'reset') model.setValue(fence.code);
        if (act === 'copy') void navigator.clipboard?.writeText(model.getValue());
        if (act === 'run') void run();
    });
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => void run());

    // ── running ──
    const output = host.querySelector<HTMLElement>('.output')!;
    const out = host.querySelector<HTMLElement>('.pane-out')!;
    const net = host.querySelector<HTMLElement>('.pane-net')!;
    const status = host.querySelector<HTMLElement>('.status')!;
    const count = host.querySelector<HTMLElement>('.count')!;
    output.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach((b) => b.addEventListener('click', () => {
        output.querySelectorAll('[data-tab]').forEach((x) => x.classList.toggle('on', x === b));
        out.hidden = b.dataset.tab !== 'out';
        net.hidden = b.dataset.tab !== 'net';
    }));
    let worker: Worker | undefined;
    async function run(): Promise<void> {
        if (kind !== 'run') return;
        worker?.terminate();
        const btn = host.querySelector<HTMLButtonElement>('[data-act="run"]')!;
        btn.disabled = true;
        output.hidden = false;
        out.innerHTML = '';
        net.innerHTML = '';
        count.textContent = '0';
        status.textContent = 'running…';
        status.className = 'status';
        const started = performance.now();
        let requests = 0;
        const append = (cls: string, text: string) => {
            const line = document.createElement('div');
            line.className = `line ${cls}`;
            line.textContent = text;
            out.appendChild(line);
        };
        try {
            const tsWorker = await (await ts.getTypeScriptWorker())(model.uri);
            const emitted = await tsWorker.getEmitOutput(model.uri.toString());
            const js = emitted.outputFiles.find((f: { name: string }) => f.name.endsWith('.js'))?.text;
            if (!js) throw new Error('the editor could not compile this snippet');
            const errors = monaco.editor.getModelMarkers({ resource: model.uri }).filter((m) => m.severity === monaco.MarkerSeverity.Error).length;
            if (errors) append('warn', `(${errors} type error${errors === 1 ? '' : 's'}: running it anyway)`);
            worker = new Worker(asset('sandbox.worker.js'));
            const w = worker;
            const timer = setTimeout(() => {
                w.terminate();
                append('error', 'Stopped: it ran for more than 60 s.');
                finish('stopped', 'bad');
            }, 60_000);
            const finish = (text: string, cls: string) => {
                clearTimeout(timer);
                status.textContent = `${text} · ${Math.round(performance.now() - started)} ms`;
                status.className = `status ${cls}`;
                btn.disabled = false;
            };
            w.onmessage = (m: MessageEvent<FromWorker>) => {
                const d = m.data;
                if (d.type === 'log') append(d.level, d.text);
                if (d.type === 'request') {
                    requests++;
                    count.textContent = String(requests);
                    const row = document.createElement('div');
                    row.className = 'req';
                    row.innerHTML = `<span class="m m-${d.method}">${d.method}</span> <span class="u">${esc(d.url)}</span> <span class="s ${d.status < 400 ? 'ok' : 'bad'}">${d.status}</span>`;
                    net.appendChild(row);
                }
                if (d.type === 'done') { w.terminate(); finish('finished', 'ok'); }
                if (d.type === 'error') { append('error', `${d.name}: ${d.message}`); w.terminate(); finish('threw', 'bad'); }
            };
            w.onerror = (ev) => { append('error', ev.message); finish('failed', 'bad'); };
            w.postMessage({ js } satisfies ToWorker);
        } catch (err) {
            append('error', String((err as Error).message ?? err));
            status.textContent = 'failed';
            status.className = 'status bad';
            btn.disabled = false;
        }
    }
}
