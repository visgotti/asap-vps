import { ApiClient } from './http';
import { ApiEndpoint, endpointOf } from './endpoints';

const TABLE = {
    list: { method: 'GET', path: '/v2/things', query: ['page', 'per_page'], docs: 'https://docs.example.com/things#list' },
    get: { method: 'GET', path: '/v2/things/{thing_id}', docs: 'https://docs.example.com/things#get' },
    act: { method: 'POST', path: '/v2/things/{thing_id}/actions', docs: 'https://docs.example.com/things#act' },
    slash: { method: 'PUT', path: '/api/v0/asks/{id}/', docs: 'https://docs.example.com/asks#rent' },
} as const satisfies Record<string, ApiEndpoint>;

describe('endpointOf', () => {
    it('names the entry by method, path (each placeholder one segment) and query parameters (each the entry\'s)', () => {
        expect(endpointOf(TABLE, 'GET', '/v2/things')).toBe('list');
        expect(endpointOf(TABLE, 'get', '/v2/things?per_page=200&page=2')).toBe('list');
        expect(endpointOf(TABLE, 'GET', '/v2/things/42')).toBe('get');
        expect(endpointOf(TABLE, 'POST', '/v2/things/abc-1/actions')).toBe('act');
        expect(endpointOf(TABLE, 'PUT', '/api/v0/asks/7/')).toBe('slash');
    });

    it('describes no other request: another method, path or query parameter, a placeholder spanning segments, a trailing slash', () => {
        expect(endpointOf(TABLE, 'DELETE', '/v2/things/42')).toBeUndefined();
        expect(endpointOf(TABLE, 'GET', '/v2/thing')).toBeUndefined();
        expect(endpointOf(TABLE, 'GET', '/v2/things?mine=true')).toBeUndefined();
        expect(endpointOf(TABLE, 'GET', '/v2/things/42?page=1')).toBeUndefined();
        expect(endpointOf(TABLE, 'GET', '/v2/things/4/2')).toBeUndefined();
        expect(endpointOf(TABLE, 'GET', '/v2/things/')).toBeUndefined();
        expect(endpointOf(TABLE, 'PUT', '/api/v0/asks/7')).toBeUndefined();
    });
});

describe('an ApiClient with an endpoint table', () => {
    class Client extends ApiClient {
        protected readonly endpoints = TABLE;
    }

    it('sends what the table describes, and refuses anything else before it is sent', async () => {
        const sent: string[] = [];
        const fetchImpl = (async (url: string) => {
            sent.push(String(url));
            return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
        }) as typeof fetch;
        const c = new Client({ apiKey: 'k', fetchImpl }, 'https://api.example.com', 'example');
        await expect(c.request('GET', '/v2/things/1')).resolves.toMatchObject({ status: 200 });
        expect(() => c.request('GET', '/v2/widgets')).toThrow(/GET \/v2\/widgets is no endpoint of example's table/);
        expect(() => c.request('GET', '/v2/things?mine=true')).toThrow(/is no endpoint of example's table/);
        expect(sent).toEqual(['https://api.example.com/v2/things/1']);
    });
});
