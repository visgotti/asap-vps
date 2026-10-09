import { asyncTimeout, pollUntil, retryInvoke, timeLeft } from './async';

describe('asyncTimeout and retryInvoke: real waits, on a fake clock', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it('asyncTimeout resolves true once its time has passed, and not before', async () => {
        let resolved: unknown = 'pending';
        void asyncTimeout(1000).then((v) => { resolved = v; });
        await jest.advanceTimersByTimeAsync(999);
        expect(resolved).toBe('pending');
        await jest.advanceTimersByTimeAsync(1);
        expect(resolved).toBe(true);
    });

    it('retryInvoke tries again timeBetween apart, and fails at once after its last try, with that try\'s error', async () => {
        const start = Date.now();
        const tries: number[] = [];
        let outcome: unknown = 'pending';
        void retryInvoke(async () => {
            tries.push(Date.now() - start);
            throw new Error(`refused ${tries.length}`);
        }, 1000, 3).then((v) => { outcome = v; }, (e: Error) => { outcome = e.message; });
        await jest.advanceTimersByTimeAsync(2000);
        // No wait after the last try: it has failed by the time the third try is made.
        expect([tries, outcome]).toEqual([[0, 1000, 2000], 'refused 3']);
    });

    it('retryInvoke answers with the first try that succeeds', async () => {
        let n = 0;
        const answer = retryInvoke(async () => {
            if (++n < 2) throw new Error('not yet');
            return 'connected';
        }, 500, 3);
        await jest.advanceTimersByTimeAsync(500);
        await expect(answer).resolves.toBe('connected');
        expect(n).toBe(2);
    });

    it('retryInvoke with no tries, or tries whose failures say nothing, says it could not invoke', async () => {
        await expect(retryInvoke(async () => 'never called', 1000, 0)).rejects.toThrow(new Error('Can not invoke without failing.'));
        await expect(retryInvoke(async () => { throw new Error(''); }, 0, 1)).rejects.toThrow(new Error('Can not invoke without failing.'));
    });
});

describe('pollUntil', () => {
    const noSleep = async () => {};

    it('reads until done, reading again through the failures retryOn accepts', async () => {
        const reads = ['a', new Error('blip'), 'b', 'c'];
        let i = 0;
        const v = await pollUntil(async () => {
            const r = reads[i++];
            if (r instanceof Error) throw r;
            return r;
        }, (x) => x === 'c', { timeoutMs: 1000, intervalMs: 0, sleep: noSleep, retryOn: (e) => (e as Error).message === 'blip', timeoutError: () => new Error('timeout') });
        expect([v, i]).toEqual(['c', 4]);
    });

    it('throws any other failure at once', async () => {
        for (const retryOn of [undefined, (e: unknown) => (e as Error).message === 'blip']) {
            let reads = 0;
            await expect(pollUntil(async () => {
                reads++;
                throw new Error('bad key');
            }, () => true, { timeoutMs: 1000, intervalMs: 0, sleep: noSleep, retryOn, timeoutError: () => new Error('timeout') })).rejects.toThrow(/bad key/);
            expect(reads).toBe(1);
        }
    });

    it('times out with what it read last, or that it never read anything', async () => {
        await expect(pollUntil(async () => 'pending', () => false, {
            timeoutMs: 5, intervalMs: 1, timeoutError: (last) => new Error(last.seen ? `still ${last.value}` : 'never read'),
        })).rejects.toThrow(/still pending/);
        await expect(pollUntil(async () => {
            throw new Error('blip');
        }, () => true, { timeoutMs: 5, intervalMs: 1, retryOn: () => true, timeoutError: (last) => new Error(last.seen ? 'seen' : 'never read') }))
            .rejects.toThrow(/never read/);
    });
});

describe('timeLeft', () => {
    it('gives each wait of a run what is left of one deadline; without a timeout, the options as they are', async () => {
        const left = timeLeft({ timeoutMs: 1000, intervalMs: 5 });
        expect(left()).toMatchObject({ intervalMs: 5 });
        expect(left().timeoutMs).toBeLessThanOrEqual(1000);
        await new Promise((r) => setTimeout(r, 30));
        expect(left().timeoutMs).toBeLessThanOrEqual(975);
        expect(timeLeft({ timeoutMs: 0 })().timeoutMs).toBe(0);
        const none = { intervalMs: 7 };
        expect(timeLeft(none)()).toBe(none);
    });
});
