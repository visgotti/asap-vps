// The RunPod REST v2 client (https://api.runpod.io): one reading of RunPod's
// errors onto src/errors.ts (toError), and the calls that need more than a
// request: a pod or network volume read that may find none, the account's key
// list (one list, replaced whole), and the log stream (Server-Sent Events that stay open).

import { ApiClient, errorText, HttpResult, RequestInfo } from '../../Core/utils';
import { AuthError, CapacityError, NotFoundError, nullIfNotFound, ProviderError, QuotaError } from '../../errors';
import { RUNPOD_ENDPOINTS } from './endpoints';
import { RUNPOD_ID } from './mappers';
import type { RunPodNetworkVolume, RunPodParams, RunPodPod } from './types';

export class RunPodApi extends ApiClient {
    static readonly BASE_URL = 'https://api.runpod.io';
    protected readonly endpoints = RUNPOD_ENDPOINTS;

    constructor(params: RunPodParams | string) {
        super(params, RunPodApi.BASE_URL, RUNPOD_ID);
    }

    /** A call whose failure throws its typed error; `idempotent` overrides the method's retry rule (the key list's PUT is not to be sent twice). */
    call<T = any>(method: string, path: string, json?: unknown, idempotent?: boolean): Promise<T> {
        return this.send<T>(method, path, { json, idempotent });
    }

    /** null when RunPod has no such pod. */
    getPod(id: string): Promise<RunPodPod | null> {
        return nullIfNotFound(this.call<RunPodPod>('GET', `/v2/pods/${encodeURIComponent(id)}`));
    }

    /** null when the account has no such network volume. */
    getNetworkVolume(id: string): Promise<RunPodNetworkVolume | null> {
        return nullIfNotFound(this.call<RunPodNetworkVolume>('GET', `/v2/network-volumes/${encodeURIComponent(id)}`));
    }

    /**
     * The account's key list, exactly as RunPod holds it. An answer that is not
     * a list of lines throws: writing the list back would replace the account's
     * keys with whatever was misread.
     */
    async keyLines(): Promise<string[]> {
        const body = await this.call<{ keys?: unknown }>('GET', '/v2/account/ssh-keys');
        const keys = body?.keys;
        if (!Array.isArray(keys) || keys.some((k) => typeof k !== 'string')) {
            throw new ProviderError(this.id, 'GET /v2/account/ssh-keys did not answer a list of keys: the account\'s keys are left as they are');
        }
        return keys;
    }

    /**
     * Replaces the account's whole key list (RunPod has no call for one key).
     * Not sent again as it is when its answer is lost or is a server error: it
     * may have taken, and the list may have changed since, which this one would
     * undo. That is for the caller to redo from a fresh read. Only a rate limit,
     * which did nothing, is waited out here.
     */
    async setKeyLines(keys: string[]): Promise<void> {
        await this.call('PUT', '/v2/account/ssh-keys', { keys }, false);
    }

    /**
     * What the pod's log stream sends within `windowMs` of answering: its
     * backfill of the last `tail` lines, as raw Server-Sent Events. The stream
     * stays open, so the window closing ends the read, not an error.
     */
    async logEvents(id: string, tail: number, windowMs: number): Promise<string> {
        const ctrl = new AbortController();
        let windowClosed = false;
        // The answer's headers get their own wait: the window is for the backfill, not for RunPod to answer.
        let timer = setTimeout(() => ctrl.abort(), 30_000);
        let text = '';
        const path = `/v2/pods/${encodeURIComponent(id)}/logs?source=container&tail=${tail}`;
        this.described('GET', path);
        try {
            const res = await (this.fetchImpl ?? fetch)(`${this.baseUrl}${path}`, {
                headers: { ...this.authHeaders(), accept: 'text/event-stream' },
                signal: ctrl.signal,
            });
            clearTimeout(timer);
            timer = setTimeout(() => {
                windowClosed = true;
                ctrl.abort();
            }, windowMs);
            if (!res.ok || !res.body) {
                const detail = await res.text().catch(() => '');
                const msg = `logs of pod ${id} -> ${res.status}${detail ? ` ${errorText(safeJson(detail))}` : ''}`;
                const e = { status: res.status };
                if (res.status === 401 || res.status === 403) throw new AuthError(this.id, msg, e);
                if (res.status === 404) throw new NotFoundError(this.id, msg, e);
                throw new ProviderError(this.id, msg, { ...e, retriable: res.status === 429 || res.status >= 500 });
            }
            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            for (;;) {
                const { value, done } = await reader.read();
                if (done) break;
                text += decoder.decode(value, { stream: true });
            }
        } catch (e) {
            if (e instanceof ProviderError) throw e;
            // The window closed the stream: what arrived is what there is.
            if (!windowClosed) throw new ProviderError(this.id, `logs of pod ${id}: ${(e as Error).message}`, { retriable: true, cause: e });
        } finally {
            clearTimeout(timer);
        }
        return text;
    }

    /** RunPod's answers as typed errors: what a create's 400 and 403 mean depends on the detail. */
    protected toError(r: HttpResult, req: RequestInfo): ProviderError {
        // A 422's reasons are in errors[] ("$.gpu.minCudaVersion: does not match pattern"), not detail.
        const reasons = Array.isArray(r.body?.errors) && r.body.errors.length ? ` (${r.body.errors.join('; ')})` : '';
        const msg = `${req.method} ${req.path} -> ${r.status} ${errorText(r.body)}${reasons}`;
        const o = { status: r.status };
        const creating = req.method === 'POST' && req.path === '/v2/pods';
        const acting = req.method === 'POST' && /^\/v2\/pods\/[^/]+\/action$/.test(req.path);
        if (r.status === 401) return new AuthError(this.id, msg, o);
        // Insufficient balance: no candidate will succeed.
        if (r.status === 402) return new QuotaError(this.id, msg, o);
        // At create, "your account cannot access the requested pool": skip the candidate. A
        // read-only key is refused the same way on every create, hence the code.
        if (r.status === 403) return creating ? new CapacityError(this.id, msg, { ...o, code: 'forbidden' }) : new AuthError(this.id, msg, o);
        if (r.status === 404) return new NotFoundError(this.id, msg, o);
        if (r.status === 429) return new ProviderError(this.id, msg, { ...o, retriable: true });
        // A create answers 400 both when the GPU / data center could not be placed
        // and when the body breaks a cross-field rule; only the detail tells them
        // apart. The spec's advice for a 400 is "try your next candidate". Something
        // the body names that is not there (a volume, a stored login deleted since)
        // is neither: no candidate has it, so it is not "no capacity".
        const detail = errorText(r.body);
        if (creating && r.status === 400 && /not found|does not exist|no such/i.test(detail)) return new NotFoundError(this.id, msg, o);
        if (creating && r.status === 400 && !/invalid|required|must|mutually exclusive|not allowed|unknown/i.test(detail)) {
            return new CapacityError(this.id, msg, o);
        }
        // A start or restart its host has no GPU free for: "not enough free GPUs on the host machine" (seen live 2026-10-05).
        if (acting && r.status === 400 && /not enough free gpus?|no (free|available) gpus?/i.test(msg)) return new CapacityError(this.id, msg, o);
        return new ProviderError(this.id, msg, { ...o, retriable: r.status >= 500 });
    }
}

function safeJson(text: string): unknown {
    try {
        return JSON.parse(text);
    } catch {
        return text;
    }
}
