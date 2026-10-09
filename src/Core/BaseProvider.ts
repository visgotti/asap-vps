// What every provider shares, whatever it can do: its id, its capabilities,
// and the platform's API client its capabilities are built on. A provider that
// rents servers extends ComputeProvider (this, plus the compute capability's
// shared logic); one with no servers at all (an object store, a DNS host)
// would extend this directly and implement its own capabilities.

import type { CapabilityDescriptor, CapabilityName, Capable, With } from '../capabilities';
import { isRetriable, ProviderError } from '../errors';
import type { WaitOptions } from '../types';
import { ApiClient, pollUntil, Sleep } from './utils';

export abstract class BaseProvider<TApi extends ApiClient = ApiClient> implements Capable {
    /** The provider's id: what its records and errors report. */
    abstract readonly id: string;
    /** What it can do and how (src/capabilities.ts): each key a capability whose interface the class implements. */
    abstract readonly capabilities: CapabilityDescriptor;
    /**
     * The platform's REST API, for an endpoint the capabilities do not cover:
     * `api.request('GET', '/path')` sends the key and returns the raw answer.
     */
    readonly api: TApi;

    constructor(api: TApi) {
        this.api = api;
    }

    get apiKey(): string {
        return this.api.apiKey;
    }

    /** Whether it has capability `c`; when it does, it is typed with that capability's methods and traits. */
    supports<C extends CapabilityName>(c: C): this is With<this, C> {
        return this.capabilities[c] !== undefined;
    }

    protected get sleep(): Sleep {
        return this.api.sleep;
    }

    /**
     * Read until `done` accepts what was read. A failed read that may be
     * transient is polled through; any other throws. On timeout the error says
     * what was last seen.
     */
    protected async poll<T>(read: () => Promise<T>, done: (v: T) => boolean,
        o: WaitOptions & { what: string, describe?: (v: T) => string }): Promise<T> {
        const timeoutMs = o.timeoutMs ?? 15 * 60_000;
        return pollUntil(read, done, {
            timeoutMs,
            intervalMs: o.intervalMs ?? 10_000,
            sleep: this.sleep,
            retryOn: isRetriable,
            timeoutError: (last) => new ProviderError(this.id, `timed out after ${Math.round(timeoutMs / 1000)} s waiting for ${o.what}: ${
                !last.seen ? 'never read' : o.describe ? o.describe(last.value) : String(last.value)}`, { code: 'timeout' }),
        });
    }
}
