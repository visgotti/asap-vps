import type { WaitOptions } from '../../types';

/** How a wait waits: real time by default, a no-op in tests. */
export type Sleep = (ms: number) => Promise<unknown>;

export const asyncTimeout = async (ts: number) => {
    return new Promise((resolve) => {
        setTimeout(() => {
            resolve(true);
        }, ts);
    });
};

export const retryInvoke = async (fn: () => Promise<any>, timeBetween: number, maxTries: number): Promise<any> => {
    let i = 0;
    let lastErr;
    while (i < maxTries) {
        try {
            const c = await fn();
            return c;
        } catch (err) {
            lastErr = err.message;
            if (i + 1 < maxTries) {
                await asyncTimeout(timeBetween);
            }
        }
        i++;
    }
    throw new Error(lastErr as string || `Can not invoke without failing.`);
};

/**
 * The wait options of a run of waits under one deadline: each call gives the
 * time left of `o.timeoutMs` (counted from this call). Without a timeoutMs,
 * `o` as it is: each wait keeps its own default.
 */
export function timeLeft<O extends WaitOptions>(o: O): () => O {
    if (o.timeoutMs === undefined) return () => o;
    const end = Date.now() + o.timeoutMs;
    return () => ({ ...o, timeoutMs: Math.max(0, end - Date.now()) });
}

/** What a poll read last before it timed out. */
export type PollLastRead<T> = { seen: false } | { seen: true, value: T };

export type PollOptions<T> = {
    timeoutMs: number,
    intervalMs: number,
    sleep?: Sleep,
    /** A failed read worth reading again (default: none: a failed read throws). */
    retryOn?: (e: unknown) => boolean,
    /** The error a timeout throws, made from what was read last. */
    timeoutError: (last: PollLastRead<T>) => Error,
};

/**
 * Read until `done` accepts what was read, every `intervalMs`, for at most
 * `timeoutMs`. A failed read that `retryOn` accepts is read again; any other
 * throws.
 */
export async function pollUntil<T>(read: () => Promise<T>, done: (v: T) => boolean, o: PollOptions<T>): Promise<T> {
    const sleep = o.sleep ?? asyncTimeout;
    const end = Date.now() + o.timeoutMs;
    let last: PollLastRead<T> = { seen: false };
    for (;;) {
        try {
            const value = await read();
            last = { seen: true, value };
            if (done(value)) return value;
        } catch (e) {
            if (!o.retryOn?.(e)) throw e;
        }
        if (Date.now() >= end) throw o.timeoutError(last);
        await sleep(o.intervalMs);
    }
}
