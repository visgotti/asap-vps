// The HTTP retry rules every initializer's API calls follow, and ApiClient,
// which holds a provider's base URL and key.

import { isRetriable, ProviderError, TransportError } from '../../errors';
import { ApiClient, errorText, http, redact, RequestOptions } from './http';

/** A fetch that answers from a list of statuses ('net' = a transport failure), recording calls. */
function scripted(statuses: Array<number | 'net'>) {
    const calls: Array<{ url: string, method?: string }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
        calls.push({ url, method: init.method });
        const s = statuses[Math.min(calls.length - 1, statuses.length - 1)];
        if (s === 'net') throw new TypeError('fetch failed');
        return new Response(JSON.stringify({ ok: s < 300 }), { status: s, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    return { calls, fetchImpl };
}

describe('http', () => {
    const sleep = async () => {};

    it('retries idempotent requests on transport errors and 5xx', async () => {
        const s = scripted(['net', 503, 200]);
        expect((await http('https://x/a', { fetchImpl: s.fetchImpl, sleep })).status).toBe(200);
        expect(s.calls).toHaveLength(3);
    });

    it('never retries a create on a server error: it may have made a machine', async () => {
        let s = scripted([503, 200]);
        expect((await http('https://x/a', { method: 'POST', json: {}, fetchImpl: s.fetchImpl, sleep })).status).toBe(503);
        expect(s.calls).toHaveLength(1);
        s = scripted([503, 200]);
        expect((await http('https://x/a', { method: 'PUT', json: {}, idempotent: false, fetchImpl: s.fetchImpl, sleep })).status).toBe(503);
        expect(s.calls).toHaveLength(1);
        s = scripted([429, 202]);
        expect((await http('https://x/a', { method: 'POST', json: {}, fetchImpl: s.fetchImpl, sleep })).status).toBe(202);
    });

    it('never sends a create again after its answer was lost (it may have made a machine), and does not call that retriable', async () => {
        let s = scripted(['net', 200]);
        const lost = await http('https://x/a', { method: 'POST', json: {}, fetchImpl: s.fetchImpl, sleep }).catch((x) => x);
        expect(s.calls).toHaveLength(1);
        expect(lost).toBeInstanceOf(TransportError);
        expect([lost.retriable, isRetriable(lost)]).toEqual([false, false]);
        s = scripted(['net', 200]);
        await expect(http('https://x/a', { method: 'PUT', json: {}, idempotent: false, fetchImpl: s.fetchImpl, sleep })).rejects.toMatchObject({ retriable: false });
        expect(s.calls).toHaveLength(1);
        // A read that never got an answer is retried, and still is when it gives up.
        s = scripted(['net']);
        const read = await http('https://x/a', { fetchImpl: s.fetchImpl, sleep }).catch((x) => x);
        expect(s.calls).toHaveLength(4);
        expect(isRetriable(read)).toBe(true);
    });

    it('an answer cut off mid-body is no answer: a read tries again, a create says so without trying again', async () => {
        let n = 0;
        const cutOnce = (async () => (n++ === 0
            ? new Response(new ReadableStream({ start(c) { c.error(new TypeError('terminated')); } }), { status: 200, headers: { 'content-type': 'application/json' } })
            : new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } }))) as unknown as typeof fetch;
        expect((await http('https://x/a', { fetchImpl: cutOnce, sleep })).body).toEqual({ ok: true });
        expect(n).toBe(2);
        n = 0;
        const e = await http('https://x/a', { method: 'POST', json: {}, fetchImpl: cutOnce, sleep }).catch((x) => x);
        expect(n).toBe(1);
        expect(e).toBeInstanceOf(TransportError);
        expect(e).toMatchObject({ retriable: false, message: expect.stringMatching(/POST https:\/\/x\/a: the answer \(200\) was cut off: terminated/) });
    });

    it('waits as long as a refusal\'s Retry-After says, in seconds or as a date, never past a minute; else 1 s, then 2, then 4', async () => {
        /** What http slept before its next try, the first answer a 429 (or a read\'s 503) with this Retry-After. */
        const waited = async (retryAfter?: string, status = 429) => {
            const slept: number[] = [];
            let n = 0;
            const fetchImpl = (async () => (n++ === 0
                ? new Response(null, { status, headers: retryAfter === undefined ? {} : { 'retry-after': retryAfter } })
                : new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }))) as unknown as typeof fetch;
            await http('https://x/a', { fetchImpl, sleep: async (ms) => { slept.push(ms); } });
            return slept;
        };
        expect([await waited('3'), await waited('0.5', 503), await waited('600'), await waited(), await waited('soon')]).toEqual([[3000], [500], [60_000], [1000], [1000]]);
        // An HTTP date: the time from now until then.
        jest.spyOn(Date, 'now').mockReturnValue(Date.parse('Fri, 09 Oct 2026 12:00:00 GMT'));
        try {
            expect([await waited('Fri, 09 Oct 2026 12:00:10 GMT'), await waited('Fri, 09 Oct 2026 11:59:00 GMT'), await waited('Fri, 09 Oct 2026 13:00:00 GMT')])
                .toEqual([[10_000], [0], [60_000]]);
        } finally {
            jest.restoreAllMocks();
        }
    });

    it('a failed request names no credential', async () => {
        const s = scripted(['net']);
        const e = await http('https://x/a?api_key=SECRET', { method: 'POST', fetchImpl: s.fetchImpl, sleep }).catch((x) => x);
        expect(e).toBeInstanceOf(TransportError);
        expect(e.message).not.toContain('SECRET');
        expect(redact('https://x/?a=1&api_key=abc&b=2')).toBe('https://x/?a=1&api_key=<redacted>&b=2');
    });

    it('reads each provider\'s error body', () => {
        expect(errorText({ title: 'Bad Request', status: 400, detail: 'no capacity' })).toBe('no capacity');
        expect(errorText({ id: 'unprocessable_entity', message: 'Size is not available in this region.' })).toBe('Size is not available in this region.');
        expect(errorText({ error: { code: 'global/quota-exceeded', message: 'Quota exceeded.' } })).toBe('Quota exceeded.');
        expect(errorText({ success: false, error: 'no_such_ask', msg: 'error 410/3907' })).toBe('error 410/3907');
        expect([errorText(null), errorText(undefined), errorText('')]).toEqual(['', '', '']);
    });
});

describe('ApiClient', () => {
    it('calls paths under its base URL with the key as a bearer token, and nothing else', async () => {
        const s = scripted([200]);
        const auth: string[] = [];
        const fetchImpl = (async (url: string, init: RequestInit) => {
            auth.push((init.headers as Record<string, string>).authorization);
            return s.fetchImpl(url, init);
        }) as unknown as typeof fetch;
        const api = new ApiClient({ apiKey: 'k1', baseUrl: 'https://api.example.com//', fetchImpl, sleep: async () => {} }, 'https://default.example.com');
        expect(api.baseUrl).toBe('https://api.example.com');
        expect((await api.request('GET', '/v1/things')).status).toBe(200);
        expect(s.calls).toEqual([{ url: 'https://api.example.com/v1/things', method: 'GET' }]);
        expect(auth).toEqual(['Bearer k1']);
        // A URL instead of a path would send the key to another host.
        expect(() => api.request('GET', 'https://elsewhere.example.com/x')).toThrow(/not an API path/);
        expect(s.calls).toHaveLength(1);
    });

    it('sends a raw body as it is, under the content type the caller gives it (not as JSON)', async () => {
        const sent: Array<{ body?: unknown, headers: Record<string, string> }> = [];
        const fetchImpl = (async (_url: string, init: RequestInit) => {
            sent.push({ body: init.body, headers: init.headers as Record<string, string> });
            return new Response(null, { status: 204 });
        }) as unknown as typeof fetch;
        const api = new ApiClient({ apiKey: 'k', fetchImpl, sleep: async () => {} }, 'https://api.example.com');
        const userData = '#cloud-config\nruncmd: ["true"]\n';
        await api.request('PATCH', '/user_data/cloud-init', { body: userData, headers: { 'content-type': 'text/plain' }, idempotent: true });
        await api.request('POST', '/things', { json: { a: 1 } });
        expect(sent[0]).toMatchObject({ body: userData, headers: { 'content-type': 'text/plain' } });
        expect(sent[1]).toMatchObject({ body: '{"a":1}', headers: { 'content-type': 'application/json' } });
    });

    it('marks a failed answer retriable as is safe: a read\'s server error is, a create\'s is not; a refusal (429) is either way', async () => {
        class Probe extends ApiClient {
            call(method: string, path: string, o: RequestOptions = {}) {
                return this.send(method, path, o);
            }
        }
        const probe = (statuses: Array<number | 'net'>) => new Probe({ apiKey: 'k', fetchImpl: scripted(statuses).fetchImpl, sleep: async () => {} }, 'https://api.example.com');
        const failed = (p: Promise<unknown>) => p.then(() => { throw new Error('did not fail'); }, (e: ProviderError) => [e.status, e.retriable, isRetriable(e)]);
        expect(await failed(probe([503]).call('GET', '/things'))).toEqual([503, true, true]);
        expect(await failed(probe([503]).call('POST', '/things', { json: {} }))).toEqual([503, false, false]);
        expect(await failed(probe([503]).call('PUT', '/asks/1', { json: {}, idempotent: false }))).toEqual([503, false, false]);
        expect(await failed(probe([503]).call('POST', '/terminate', { json: {}, idempotent: true }))).toEqual([503, true, true]);
        expect(await failed(probe([429]).call('POST', '/things', { json: {} }))).toEqual([429, true, true]);
    });

    it('takes a bare key, defaults the rest, and refuses no key', () => {
        const api = new ApiClient('k2', 'https://default.example.com');
        expect([api.apiKey, api.baseUrl, api.fetchImpl]).toEqual(['k2', 'https://default.example.com', undefined]);
        expect(() => new ApiClient('', 'https://default.example.com')).toThrow(/API key is required/);
    });
});
