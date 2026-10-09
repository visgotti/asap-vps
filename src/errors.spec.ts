// What asap-vps throws: each error named for its class, so a caller (or a log)
// can tell them apart, and which of them are worth trying again.

import { AuthError, CapacityError, isRetriable, NotFoundError, NotSupportedError, ProviderError, QuotaError, quotedMessage, TransportError } from './errors';

describe('errors', () => {
    it('quotedMessage quotes an error of the same provider without its prefix, which the quoting error says once already; any other as it is', () => {
        expect(quotedMessage(new ProviderError('scaleway', 'DELETE /x -> 403 denied'), 'scaleway')).toBe('DELETE /x -> 403 denied');
        expect(quotedMessage(new ProviderError('runpod', 'gone'), 'scaleway')).toBe('runpod: gone');
        expect(quotedMessage(new TypeError('fetch failed'), 'scaleway')).toBe('fetch failed');
        expect(quotedMessage('scaleway: said as a string', 'scaleway')).toBe('said as a string');
    });

    it('each is named for its class and is a ProviderError whose message begins with the provider', () => {
        const errors = [
            new ProviderError('acme', 'boom'), new CapacityError('acme', 'no L4 left'), new QuotaError('acme', 'GPU quota is 0'),
            new AuthError('acme', 'bad key'), new NotFoundError('acme', 'no server s1'), new NotSupportedError('acme', 'createServer option "env"'),
        ];
        expect(errors.map((e) => [e.name, e.message, e instanceof ProviderError])).toEqual([
            ['ProviderError', 'acme: boom', true], ['CapacityError', 'acme: no L4 left', true], ['QuotaError', 'acme: GPU quota is 0', true],
            ['AuthError', 'acme: bad key', true], ['NotFoundError', 'acme: no server s1', true], ['NotSupportedError', 'acme: createServer option "env" is not supported', true],
        ]);
    });

    it('a TransportError keeps the cause it was given, and has none, as an Error has none, when it was given none', () => {
        const cause = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
        const e = new TransportError('GET https://api.example.com/x: fetch failed', cause);
        expect([e.name, e.message, e.cause, e.retriable]).toEqual(['TransportError', 'GET https://api.example.com/x: fetch failed', cause, true]);
        const bare = new TransportError('POST https://api.example.com/x: fetch failed', undefined, false);
        expect(['cause' in bare, bare.retriable]).toEqual([false, false]);
    });

    it('isRetriable: only a ProviderError or TransportError that says so, nothing else whatever it carries', () => {
        expect([
            isRetriable(new ProviderError('acme', '503', { retriable: true })), isRetriable(new ProviderError('acme', '400')),
            isRetriable(new TransportError('reset')), isRetriable(new TransportError('lost', undefined, false)),
            isRetriable(Object.assign(new Error('reset'), { retriable: true })), isRetriable({ retriable: true }), isRetriable(undefined), isRetriable(null),
        ]).toEqual([true, false, true, false, false, false, false, false]);
    });
});
