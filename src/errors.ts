// What asap-vps throws. Every initializer maps its provider's failures onto
// ProviderError and its subclasses, so a caller can tell "try another offer or
// region" (CapacityError) from "this account cannot create anything right now"
// (QuotaError) from "the key is wrong" (AuthError), whatever the provider.

export type ProviderErrorOptions = { status?: number, code?: string, retriable?: boolean, cause?: unknown };

export class ProviderError extends Error {
    /** The provider's id ('digitalocean', 'runpod', ...). */
    readonly provider: string;
    /** The HTTP status, when the provider answered. */
    readonly status?: number;
    /** The provider's own error code, when it has one. */
    readonly code?: string;
    /** Worth trying again as it is: a rate limit or a server error. */
    readonly retriable: boolean;
    readonly cause?: unknown;

    constructor(provider: string, message: string, o: ProviderErrorOptions = {}) {
        super(`${provider}: ${message}`);
        this.name = 'ProviderError';
        this.provider = provider;
        this.status = o.status;
        this.code = o.code;
        this.retriable = o.retriable ?? false;
        if (o.cause !== undefined) this.cause = o.cause;
    }
}

/** This offer or region has no capacity right now: try another. */
export class CapacityError extends ProviderError {
    constructor(provider: string, message: string, o: Omit<ProviderErrorOptions, 'retriable'> = {}) {
        super(provider, message, o);
        this.name = 'CapacityError';
    }
}

/** An account limit (server cap, GPU quota, balance): nothing will be created until it changes. */
export class QuotaError extends ProviderError {
    constructor(provider: string, message: string, o: Omit<ProviderErrorOptions, 'retriable'> = {}) {
        super(provider, message, o);
        this.name = 'QuotaError';
    }
}

export class AuthError extends ProviderError {
    constructor(provider: string, message: string, o: Omit<ProviderErrorOptions, 'retriable'> = {}) {
        super(provider, message, o);
        this.name = 'AuthError';
    }
}

export class NotFoundError extends ProviderError {
    constructor(provider: string, message: string, o: Omit<ProviderErrorOptions, 'retriable'> = {}) {
        super(provider, message, o);
        this.name = 'NotFoundError';
    }
}

/** The provider has no such operation, or cannot honor an option. */
export class NotSupportedError extends ProviderError {
    constructor(provider: string, what: string) {
        super(provider, `${what} is not supported`);
        this.name = 'NotSupportedError';
    }
}

/** A request that got no answer (refused, reset, timed out): what it did is unknown. */
export class TransportError extends Error {
    readonly cause?: unknown;

    constructor(message: string, cause?: unknown) {
        super(message);
        this.name = 'TransportError';
        if (cause !== undefined) this.cause = cause;
    }
}

/** A failure worth trying again: no answer at all, or one the provider marks temporary. */
export function isRetriable(e: unknown): boolean {
    return e instanceof TransportError || (e instanceof ProviderError && e.retriable);
}

/** What `work` resolved to, or null when it failed with NotFoundError: a read of something that may not exist. */
export async function nullIfNotFound<T>(work: Promise<T>): Promise<T | null> {
    try {
        return await work;
    } catch (e) {
        if (e instanceof NotFoundError) return null;
        throw e;
    }
}

/** true once `work` is done, false when it failed with NotFoundError: an idempotent delete of something that may be gone already. */
export async function falseIfNotFound(work: Promise<unknown>): Promise<boolean> {
    try {
        await work;
        return true;
    } catch (e) {
        if (e instanceof NotFoundError) return false;
        throw e;
    }
}
