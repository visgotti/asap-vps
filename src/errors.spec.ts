// What asap-vps throws: each error named for its class, so a caller (or a log)
// can tell them apart, and which of them are worth trying again.

import { AuthError, CapacityError, isRetriable, NotFoundError, NotSupportedError, ProviderError, QuotaError, quotedMessage, RemoteCommandError, TransportError } from './errors';

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

    it('a RemoteCommandError says who ran what where and how it ended, and ends on the command\'s own last three lines: of what it wrote as errors, else of what it wrote', () => {
        const failed = new RemoteCommandError('root@203.0.113.7', 'apt-get install -y nginx', { code: 100, stdout: 'Reading package lists...\n', stderr: 'W: one\nE: two\nE: three\nE: four\n' });
        expect([failed.name, failed.message, failed instanceof Error, failed instanceof ProviderError]).toEqual([
            'RemoteCommandError', 'root@203.0.113.7: `apt-get install -y nginx` exited 100: E: two\nE: three\nE: four', true, false]);
        expect([failed.login, failed.command, failed.code, failed.stdout, failed.stderr, 'signal' in failed]).toEqual([
            'root@203.0.113.7', 'apt-get install -y nginx', 100, 'Reading package lists...\n', 'W: one\nE: two\nE: three\nE: four\n', false]);
        // Nothing on stderr: the end of what it wrote; nothing at all: how it ended alone.
        expect(new RemoteCommandError('ubuntu@h', 'test -f x', { code: 1, stdout: 'a\nb\nc\nd\ne', stderr: '  \n' }).message).toBe('ubuntu@h: `test -f x` exited 1: c\nd\ne');
        expect(new RemoteCommandError('ubuntu@h', 'false', { code: 1, stdout: '', stderr: '' }).message).toBe('ubuntu@h: `false` exited 1');
        expect(new RemoteCommandError('ubuntu@h', 'exit 0', { code: 0, stdout: '', stderr: '' }).message).toBe('ubuntu@h: `exit 0` exited 0');
        // Ended by a signal: no status, and the signal where the session named it.
        const killed = new RemoteCommandError('root@h', 'train', { code: null, signal: 'SIGKILL', stdout: '', stderr: 'Killed' });
        expect([killed.message, killed.code, killed.signal]).toEqual(['root@h: `train` was ended by SIGKILL: Killed', null, 'SIGKILL']);
        for (const signal of [null, undefined, '']) {
            const unnamed = new RemoteCommandError('root@h', 'train', { code: null, signal, stdout: '', stderr: '' });
            expect([unnamed.message, 'signal' in unnamed]).toEqual(['root@h: `train` was ended by a signal', false]);
        }
    });

    it('isRetriable: only a ProviderError or TransportError that says so, nothing else whatever it carries', () => {
        expect([
            isRetriable(new ProviderError('acme', '503', { retriable: true })), isRetriable(new ProviderError('acme', '400')),
            isRetriable(new TransportError('reset')), isRetriable(new TransportError('lost', undefined, false)),
            isRetriable(Object.assign(new Error('reset'), { retriable: true })), isRetriable({ retriable: true }), isRetriable(undefined), isRetriable(null),
        ]).toEqual([true, false, true, false, false, false, false, false]);
    });
});
