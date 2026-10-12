import { ProviderError } from '../../errors';
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

/** A wait that is the rest of a longer one: `budgetMs` is the whole of it, which a timeout reports (not the rest that ran out). */
export type Deadline = WaitOptions & { budgetMs?: number };

/**
 * A caller's wait options over `defaults`, and nothing else of `o`: a
 * timeoutMs or intervalMs that is absent is the default's, and so is one
 * given as `undefined` (which a spread would let through, as a deadline of
 * NaN that never comes). One that is not a number of milliseconds from 0 up
 * (NaN, a negative, a string; an interval without end) throws, as a wait
 * nobody asked for would be read from it. No timeout at all is Infinity.
 */
export function waitOf<D extends WaitOptions>(o: Deadline | undefined, defaults: D): Deadline & D {
    const out: Deadline = { ...defaults };
    for (const k of ['timeoutMs', 'intervalMs', 'budgetMs'] as const) {
        if (o?.[k] !== undefined) out[k] = milliseconds(k, o[k]);
    }
    return out as Deadline & D;
}

/** `v` as a number of milliseconds from 0 up, or the error that says it is not one; an interval is finite. */
function milliseconds(k: string, v: unknown): number {
    if (typeof v !== 'number' || !(v >= 0) || (k === 'intervalMs' && v === Infinity)) {
        throw new ProviderError('asap-vps', `bad ${k} ${typeof v === 'number' ? String(v) : JSON.stringify(v)}: use a number of milliseconds, 0 or more`);
    }
    return v;
}

/**
 * The wait options of a run of waits under one deadline: each call gives the
 * time left of `o.timeoutMs` (counted from this call), and the whole of it as
 * `budgetMs`, for a timeout to report. Without a timeoutMs, `o` as it is:
 * each wait keeps its own default.
 */
export function timeLeft<O extends WaitOptions>(o: O): () => O & Deadline {
    if (o.timeoutMs === undefined) return () => o;
    const end = Date.now() + o.timeoutMs;
    const budgetMs = (o as Deadline).budgetMs ?? o.timeoutMs;
    return () => ({ ...o, timeoutMs: Math.max(0, end - Date.now()), budgetMs });
}

/**
 * What tells a restart is over, read by read: `back(running)` is true once
 * the server reads as running after it was seen not to. One that never reads
 * otherwise is taken to be back on its `settleReads`-th read: a platform
 * whose status shows no reboot, or shows it late, is given that long to show
 * one, so the first "running" after the request (the status of before it,
 * still) does not pass for the end of a reboot that has yet to begin.
 */
export function restartWatch(settleReads: number): (running: boolean) => boolean {
    let reads = 0;
    let left = false;
    return (running) => {
        reads++;
        if (!running) left = true;
        return running && (left || reads >= settleReads);
    };
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
 * throws. The time waited is the clock's, or the pauses taken when they add
 * up to more: a `sleep` that returns early (a test's) cannot make a wait
 * spin through all of its real time. A timeout or interval that is not a
 * number from 0 up throws (waitOf) before anything is read.
 */
export async function pollUntil<T>(read: () => Promise<T>, done: (v: T) => boolean, o: PollOptions<T>): Promise<T> {
    const [timeoutMs, intervalMs] = [milliseconds('timeoutMs', o.timeoutMs), milliseconds('intervalMs', o.intervalMs)];
    const sleep = o.sleep ?? asyncTimeout;
    const end = Date.now() + timeoutMs;
    let paused = 0;
    let last: PollLastRead<T> = { seen: false };
    for (;;) {
        try {
            const value = await read();
            last = { seen: true, value };
            if (done(value)) return value;
        } catch (e) {
            if (!o.retryOn?.(e)) throw e;
        }
        if (Date.now() >= end || paused >= timeoutMs) throw o.timeoutError(last);
        await sleep(intervalMs);
        paused += intervalMs;
    }
}
