import { asyncTimeout, pollUntil, restartWatch, retryInvoke, timeLeft, waitOf } from './async';

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

describe('pollUntil: how long it waits', () => {
    it('counts the pauses it took when they add up to more than the clock says: a sleep that returns early cannot make it spin', async () => {
        // A sleep that takes no time, as a test's does: two seconds of pauses are over in five reads, not in two real seconds of reading.
        let reads = 0;
        const slept: number[] = [];
        const started = Date.now();
        await expect(pollUntil(async () => ++reads, () => false, {
            timeoutMs: 2000, intervalMs: 500, sleep: async (ms) => { slept.push(ms); }, timeoutError: (last) => new Error(`still ${last.seen && last.value}`),
        })).rejects.toThrow(new Error('still 5'));
        expect(slept).toEqual([500, 500, 500, 500]);
        expect(Date.now() - started).toBeLessThan(1500);
        // Ten minutes read every five seconds, the same way: 121 reads.
        reads = 0;
        await expect(pollUntil(async () => ++reads, () => false, { timeoutMs: 10 * 60_000, intervalMs: 5000, sleep: async () => {}, timeoutError: () => new Error('timeout') })).rejects.toThrow('timeout');
        expect(reads).toBe(121);
    });

    it('reads once when there is no time, and until done when there is no limit', async () => {
        let reads = 0;
        await expect(pollUntil(async () => ++reads, () => false, { timeoutMs: 0, intervalMs: 1000, sleep: async () => {}, timeoutError: () => new Error('timeout') })).rejects.toThrow('timeout');
        expect(reads).toBe(1);
        reads = 0;
        expect(await pollUntil(async () => ++reads, (n) => n === 5000, { timeoutMs: Infinity, intervalMs: 60_000, sleep: async () => {}, timeoutError: () => new Error('timeout') })).toBe(5000);
    });

    it('a timeout or interval that is no number of milliseconds is refused before anything is read: never a deadline of NaN, which does not come', async () => {
        let reads = 0;
        // A poll that got past its options would read on without end: this one gives up, by another name, after a few reads.
        const read = async () => {
            if (++reads > 20) throw new Error('reading without end');
            return reads;
        };
        const poll = (o: object) => pollUntil(read, () => false, { timeoutMs: 1000, intervalMs: 0, sleep: async () => {}, timeoutError: () => new Error('timeout'), ...o });
        for (const [o, message] of [
            [{ timeoutMs: undefined }, 'asap-vps: bad timeoutMs undefined: use a number of milliseconds, 0 or more'],
            [{ timeoutMs: NaN }, 'asap-vps: bad timeoutMs NaN: use a number of milliseconds, 0 or more'],
            [{ timeoutMs: -1 }, 'asap-vps: bad timeoutMs -1: use a number of milliseconds, 0 or more'],
            [{ timeoutMs: '1000' }, 'asap-vps: bad timeoutMs "1000": use a number of milliseconds, 0 or more'],
            [{ intervalMs: undefined }, 'asap-vps: bad intervalMs undefined: use a number of milliseconds, 0 or more'],
            [{ intervalMs: Infinity }, 'asap-vps: bad intervalMs Infinity: use a number of milliseconds, 0 or more'],
            [{ intervalMs: null }, 'asap-vps: bad intervalMs null: use a number of milliseconds, 0 or more'],
        ] as const) {
            await expect(poll(o)).rejects.toMatchObject({ name: 'ProviderError', message });
        }
        expect(reads).toBe(0);
    });
});

describe('waitOf: a caller\'s wait options over the defaults', () => {
    const defaults = { timeoutMs: 600_000, intervalMs: 5000 };

    it('what is absent, or given as undefined, is the default\'s; what is given is the caller\'s; nothing else of the caller\'s comes along', () => {
        expect(waitOf(undefined, defaults)).toEqual(defaults);
        expect(waitOf({}, defaults)).toEqual(defaults);
        // A spread would let these through as the deadline NaN.
        expect(waitOf({ timeoutMs: undefined, intervalMs: undefined }, defaults)).toEqual(defaults);
        expect(waitOf({ timeoutMs: 0, intervalMs: 0 }, defaults)).toEqual({ timeoutMs: 0, intervalMs: 0 });
        expect(waitOf({ timeoutMs: Infinity }, defaults)).toEqual({ timeoutMs: Infinity, intervalMs: 5000 });
        const more = { timeoutMs: 30, name: 'an image', url: 'https://example.com' };
        expect(waitOf(more, defaults)).toEqual({ timeoutMs: 30, intervalMs: 5000 });
        // The defaults are not touched, and may leave a key to whoever waits.
        expect(defaults).toEqual({ timeoutMs: 600_000, intervalMs: 5000 });
        expect(waitOf({ intervalMs: 7 }, { timeoutMs: 100 })).toEqual({ timeoutMs: 100, intervalMs: 7 });
        expect(waitOf({}, { timeoutMs: 100 })).toEqual({ timeoutMs: 100 });
    });

    it('the whole of a longer wait comes along, for a timeout to report', () => {
        expect(waitOf({ timeoutMs: 10, budgetMs: 60_000 }, defaults)).toEqual({ timeoutMs: 10, intervalMs: 5000, budgetMs: 60_000 });
    });

    it('a value that is no number of milliseconds from 0 up is refused, by name', () => {
        for (const [o, message] of [
            [{ timeoutMs: NaN }, 'asap-vps: bad timeoutMs NaN: use a number of milliseconds, 0 or more'],
            [{ timeoutMs: -5 }, 'asap-vps: bad timeoutMs -5: use a number of milliseconds, 0 or more'],
            [{ timeoutMs: '30s' }, 'asap-vps: bad timeoutMs "30s": use a number of milliseconds, 0 or more'],
            [{ timeoutMs: null }, 'asap-vps: bad timeoutMs null: use a number of milliseconds, 0 or more'],
            [{ intervalMs: -1 }, 'asap-vps: bad intervalMs -1: use a number of milliseconds, 0 or more'],
            [{ intervalMs: Infinity }, 'asap-vps: bad intervalMs Infinity: use a number of milliseconds, 0 or more'],
            [{ budgetMs: NaN }, 'asap-vps: bad budgetMs NaN: use a number of milliseconds, 0 or more'],
        ] as const) {
            expect(() => waitOf(o as never, defaults)).toThrow(expect.objectContaining({ name: 'ProviderError', message }));
        }
    });
});

describe('timeLeft', () => {
    it('gives each wait of a run what is left of one deadline, and the whole of it to report; without a timeout, the options as they are', async () => {
        const left = timeLeft({ timeoutMs: 1000, intervalMs: 5 });
        expect(left()).toMatchObject({ intervalMs: 5, budgetMs: 1000 });
        expect(left().timeoutMs).toBeLessThanOrEqual(1000);
        await new Promise((r) => setTimeout(r, 30));
        expect(left().timeoutMs).toBeLessThanOrEqual(975);
        expect(left().budgetMs).toBe(1000);
        expect(timeLeft({ timeoutMs: 0 })()).toEqual({ timeoutMs: 0, budgetMs: 0 });
        const none = { intervalMs: 7 };
        expect(timeLeft(none)()).toBe(none);
    });

    it('the rest of a wait that is itself the rest of a longer one still reports the longest', () => {
        const outer = timeLeft({ timeoutMs: 60_000 });
        const inner = timeLeft({ ...outer(), timeoutMs: 1000 });
        expect(inner()).toMatchObject({ budgetMs: 60_000 });
        expect(inner().timeoutMs).toBeLessThanOrEqual(1000);
    });
});

describe('restartWatch: what tells a restart is over', () => {
    it('running after it was seen not to be, however soon', () => {
        const back = restartWatch(4);
        expect([false, false, true].map(back)).toEqual([false, false, true]);
        // And at once, where the first read already shows it down.
        const quick = restartWatch(4);
        expect([false, true].map(quick)).toEqual([false, true]);
    });

    it('the first reads as running do not pass for its end: the status of before the reboot, still; then one that shows it does', () => {
        const back = restartWatch(4);
        expect([true, true, false, false, true].map(back)).toEqual([false, false, false, false, true]);
    });

    it('never seen otherwise, it is taken to be back on the read it was told to settle at, and not before', () => {
        expect([true, true, true, true, true].map(restartWatch(4))).toEqual([false, false, false, true, true]);
        expect([true, true].map(restartWatch(1))).toEqual([true, true]);
        expect([true, true, true].map(restartWatch(3))).toEqual([false, false, true]);
    });
});
