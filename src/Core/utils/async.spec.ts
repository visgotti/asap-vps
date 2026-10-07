import { pollUntil, timeLeft } from './async';

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
