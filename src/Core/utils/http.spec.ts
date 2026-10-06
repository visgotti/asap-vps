// The HTTP retry rules every initializer's API calls follow, and ApiClient,
// which holds a provider's base URL and key.

import { TransportError } from '../../errors';
import { ApiClient, errorText, http, redact } from './http';

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

    it('takes a bare key, defaults the rest, and refuses no key', () => {
        const api = new ApiClient('k2', 'https://default.example.com');
        expect([api.apiKey, api.baseUrl, api.fetchImpl]).toEqual(['k2', 'https://default.example.com', undefined]);
        expect(() => new ApiClient('', 'https://default.example.com')).toThrow(/API key is required/);
    });
});
