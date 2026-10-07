// fetch with the two retry rules provider APIs need:
//   - idempotent requests (GET / PUT / DELETE / HEAD by default) are retried on
//     transport errors, 429 and 5xx;
//   - anything else is retried ONLY on 429 (the provider refused before doing
//     anything). A create that timed out may have made a machine, and a retry
//     could make a second billed one. A create sent as PUT (Vast rents a
//     machine with PUT) passes `idempotent: false`.
// Non-2xx responses are returned, not thrown: each initializer maps its
// provider's statuses onto the typed errors in src/errors.ts.

import { AuthError, NotFoundError, ProviderError, TransportError } from '../../errors';
import type { ProviderParams } from '../../types';
import { asyncTimeout, Sleep } from './async';
import { ApiEndpoint, endpointOf } from './endpoints';

export type FetchImpl = typeof fetch;

const IDEMPOTENT = new Set(['GET', 'HEAD', 'PUT', 'DELETE']);

export type HttpOptions = {
    method?: string,
    headers?: Record<string, string>,
    /** Sent as a JSON body. */
    json?: unknown,
    body?: string,
    /** Overrides the method's default retry rule. */
    idempotent?: boolean,
    /** Per attempt, default 30 s. */
    timeoutMs?: number,
    /** Default 3. */
    retries?: number,
    sleep?: Sleep,
    fetchImpl?: FetchImpl,
};

export type HttpResult = {
    status: number,
    /** Parsed JSON when the response says JSON, else its text. */
    body: any,
    headers: Headers,
};

export async function http(url: string, o: HttpOptions = {}): Promise<HttpResult> {
    const method = (o.method ?? 'GET').toUpperCase();
    const idempotent = o.idempotent ?? IDEMPOTENT.has(method);
    const retries = o.retries ?? 3;
    const sleep = o.sleep ?? asyncTimeout;
    const doFetch = o.fetchImpl ?? fetch;
    const headers: Record<string, string> = { accept: 'application/json', ...(o.headers ?? {}) };
    let body = o.body;
    if (o.json !== undefined) {
        body = JSON.stringify(o.json);
        headers['content-type'] ??= 'application/json';
    }
    for (let attempt = 0; ; attempt++) {
        let res: Response;
        try {
            res = await doFetch(url, { method, headers, body, signal: AbortSignal.timeout(o.timeoutMs ?? 30_000) });
        } catch (e) {
            if (idempotent && attempt < retries) {
                await sleep(backoff(attempt));
                continue;
            }
            throw new TransportError(`${method} ${redact(url)}: ${(e as Error).message}`, e, idempotent);
        }
        const retriable = res.status === 429 || (idempotent && res.status >= 500 && res.status !== 501);
        if (retriable && attempt < retries) {
            await res.body?.cancel().catch(() => {});
            await sleep(retryAfterMs(res.headers.get('retry-after')) ?? backoff(attempt));
            continue;
        }
        let text: string;
        try {
            text = await res.text();
        } catch (e) {
            // The answer was cut off (a reset or a timeout mid-body): no answer, as far as the caller can tell.
            if (idempotent && attempt < retries) {
                await sleep(backoff(attempt));
                continue;
            }
            throw new TransportError(`${method} ${redact(url)}: the answer (${res.status}) was cut off: ${(e as Error).message}`, e, idempotent);
        }
        let parsed: any = text;
        if (text && /json/i.test(res.headers.get('content-type') ?? '')) {
            try {
                parsed = JSON.parse(text);
            } catch {
                // A provider that labels HTML as JSON: keep the text.
            }
        }
        return { status: res.status, body: parsed, headers: res.headers };
    }
}

/** What ApiClient.request sends besides the method and path. */
export type RequestOptions = {
    /** Sent as a JSON body. */
    json?: unknown,
    /** Sent as it is, with its own `content-type` header (e.g. cloud-init user data as text/plain). */
    body?: string,
    /** Overrides the method's default retry rule. */
    idempotent?: boolean,
    headers?: Record<string, string>,
};

/** The request a failed answer was to: what an error says it was. */
export type RequestInfo = {
    method: string,
    path: string,
    /** Overrides the method's default (GET, HEAD, PUT and DELETE do no harm twice). */
    idempotent?: boolean,
};

/** Whether a request does no harm sent twice: its own say, else its method's. */
export function isIdempotent(req: Pick<RequestInfo, 'method' | 'idempotent'>): boolean {
    return req.idempotent ?? IDEMPOTENT.has(req.method.toUpperCase());
}

/**
 * One platform's REST API: its base URL and key, called with http()'s retry
 * rules. A call takes a path, never a URL, so the key only ever goes to the
 * API's own host. Each platform's client (DigitalOceanApi, RunPodApi, ...)
 * extends it with how it authenticates (authHeaders), what counts as a
 * success (succeeded), how its failures read as asap-vps's typed errors
 * (toError), and its raw endpoints.
 */
export class ApiClient {
    /** The provider id its errors carry. */
    readonly id: string;
    readonly apiKey: string;
    readonly baseUrl: string;
    readonly fetchImpl?: FetchImpl;
    readonly sleep: Sleep;
    /**
     * The endpoints this client calls (its platform's endpoints.ts), where it
     * has a table: a request none of them describes is refused before it is
     * sent, as a bug, never as the platform's answer.
     */
    protected readonly endpoints?: Readonly<Record<string, ApiEndpoint>>;

    constructor(params: ProviderParams | string, defaultBaseUrl: string, id = 'api') {
        const p = typeof params === 'string' ? { apiKey: params } : params;
        if (!p?.apiKey) throw new Error('an API key is required');
        this.id = id;
        this.apiKey = p.apiKey;
        this.baseUrl = (p.baseUrl ?? defaultBaseUrl).replace(/\/+$/, '');
        this.fetchImpl = p.fetchImpl;
        this.sleep = p.sleep ?? asyncTimeout;
    }

    /**
     * Non-2xx answers are returned, not thrown: the initializer maps them onto
     * src/errors.ts. `json` is sent as a JSON body; `body` as it is (with its
     * own `content-type` header, e.g. cloud-init user data as text/plain).
     */
    request(method: string, path: string, o: RequestOptions = {}): Promise<HttpResult> {
        if (!path.startsWith('/')) throw new Error(`"${path}" is not an API path of ${this.baseUrl}`);
        if (this.endpoints && endpointOf(this.endpoints, method, path) === undefined) {
            throw new Error(`${method} ${path} is no endpoint of ${this.id}'s table (its endpoints.ts): add it there, with its spec operation and reference page`);
        }
        return http(`${this.baseUrl}${path}`, {
            method,
            json: o.json,
            body: o.body,
            idempotent: o.idempotent,
            headers: { ...this.authHeaders(), ...(o.headers ?? {}) },
            fetchImpl: this.fetchImpl,
            sleep: this.sleep,
        });
    }

    authHeaders(): Record<string, string> {
        return { authorization: `Bearer ${this.apiKey}` };
    }

    /** A request whose answer must be a success: its body. Any other answer throws its typed error (toError). */
    protected async send<T = any>(method: string, path: string, o: RequestOptions = {}): Promise<T> {
        const r = await this.request(method, path, o);
        if (this.succeeded(r)) return r.body as T;
        throw this.failure(r, { method, path, idempotent: o.idempotent });
    }

    /**
     * A failed answer's typed error (toError), never marked retriable where a
     * request that may have done its work answered a server error: a create
     * that answered 5xx may have made a machine. A refusal (4xx: a 429, a
     * transient state) did nothing, and stays as toError says.
     */
    protected failure(r: HttpResult, req: RequestInfo): ProviderError {
        const e = this.toError(r, req);
        if (e.retriable && r.status >= 500 && !isIdempotent(req)) Object.defineProperty(e, 'retriable', { value: false });
        return e;
    }

    /** Whether an answer is a success (2xx; a platform that answers its failures with 200 says more). */
    protected succeeded(r: HttpResult): boolean {
        return r.status >= 200 && r.status < 300;
    }

    /**
     * A failed answer as a typed error (src/errors.ts): what each platform's
     * client translates from its own statuses, codes and wording. By default,
     * 401 and 403 are AuthError, 404 NotFoundError, and 429 and server errors
     * may be retried.
     */
    protected toError(r: HttpResult, req: RequestInfo): ProviderError {
        const msg = `${req.method} ${req.path} -> ${r.status} ${errorText(r.body)}`;
        const o = { status: r.status };
        if (r.status === 401 || r.status === 403) return new AuthError(this.id, msg, o);
        if (r.status === 404) return new NotFoundError(this.id, msg, o);
        return new ProviderError(this.id, msg, { ...o, retriable: r.status === 429 || r.status >= 500 });
    }
}

function backoff(attempt: number): number {
    return Math.min(30_000, 1000 * 2 ** attempt);
}

function retryAfterMs(v: string | null): number | undefined {
    if (!v) return undefined;
    const s = Number(v);
    if (Number.isFinite(s)) return Math.min(60_000, Math.max(0, s * 1000));
    const t = Date.parse(v);
    return Number.isFinite(t) ? Math.min(60_000, Math.max(0, t - Date.now())) : undefined;
}

/** Query strings can carry credentials (presigned URLs, ?api_key=): never log them. */
export function redact(url: string): string {
    return url.replace(/([?&](?:api_key|key|token|access_token|X-Amz-Signature)=)[^&]+/gi, '$1<redacted>');
}

/** A short, loggable description of an error body. */
export function errorText(body: any): string {
    if (body == null) return '';
    if (typeof body === 'string') return body.slice(0, 300);
    const m = body.detail ?? body.message ?? body.error?.message ?? body.error_description ?? body.msg ?? body.error ?? body.errors;
    return (typeof m === 'string' ? m : JSON.stringify(m ?? body)).slice(0, 300);
}
