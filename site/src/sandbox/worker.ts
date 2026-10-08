// The Web Worker a snippet runs in: a fresh world of fakes per run (the page starts a new worker each time), its output posted back.

import { runSnippet } from './run';

export type ToWorker = { js: string };
export type FromWorker =
    | { type: 'log', level: 'log' | 'info' | 'warn' | 'error', text: string }
    | { type: 'request', method: string, url: string, status: number }
    | { type: 'done' }
    | { type: 'error', name: string, message: string };

const post = (m: FromWorker) => (self as unknown as Worker).postMessage(m);

self.onmessage = async (e: MessageEvent<ToWorker>) => {
    try {
        await runSnippet(e.data.js, { log: (level, text) => post({ type: 'log', level, text }), request: (r) => post({ type: 'request', ...r }) });
        post({ type: 'done' });
    } catch (err) {
        const x = err as Error;
        // The error as the library throws it: its class, its message, and the extra fields a ProviderError carries.
        const extra = Object.entries(err as object).filter(([k]) => ['code', 'status'].includes(k)).map(([k, v]) => `${k}=${String(v)}`).join(' ');
        post({ type: 'error', name: x?.name ?? 'Error', message: `${x?.message ?? String(err)}${extra ? `  (${extra})` : ''}` });
    }
};
