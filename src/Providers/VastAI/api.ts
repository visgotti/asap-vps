// The Vast.ai API client (https://console.vast.ai): one reading of Vast's
// errors onto src/errors.ts (toError). Vast answers some failures with a 200
// whose body says `success: false`, so a success is a 2xx that does not.

import { ApiClient, errorText, HttpResult, RequestInfo } from '../../Core/utils';
import { AuthError, CapacityError, NotFoundError, ProviderError, QuotaError } from '../../errors';
import { VAST_ID } from './mappers';
import type { VastAIParams } from './types';

export class VastApi extends ApiClient {
    static readonly BASE_URL = 'https://console.vast.ai';

    constructor(params: VastAIParams | string) {
        super(params, VastApi.BASE_URL, VAST_ID);
    }

    /** A call whose failure throws its typed error; `idempotent` overrides the method's retry rule (a search is a read, a rental never is). */
    call<T = any>(method: string, path: string, json?: unknown, idempotent?: boolean): Promise<T> {
        return this.send<T>(method, path, { json, idempotent });
    }

    protected succeeded(r: HttpResult): boolean {
        return super.succeeded(r) && r.body?.success !== false;
    }

    protected toError(r: HttpResult, req: RequestInfo): ProviderError {
        const msg = `${req.method} ${req.path} -> ${r.status} ${errorText(r.body)}`;
        const code = typeof r.body?.error === 'string' ? r.body.error : undefined;
        const o = { status: r.status, code };
        // Vast answers a bad key with 404 {error: "auth_error", msg: "Invalid user key"} (observed 2026-09-29).
        if (r.status === 401 || code === 'auth_error') return new AuthError(this.id, msg, o);
        // The machine was rented by someone else (or is gone): try another offer.
        if (r.status === 410 || code === 'no_such_ask' || /no_such_ask/.test(msg)) return new CapacityError(this.id, msg, o);
        if (/balance|credit|insufficient funds/i.test(msg)) return new QuotaError(this.id, msg, o);
        if (r.status === 403) return new AuthError(this.id, msg, o);
        if (r.status === 404) return new NotFoundError(this.id, msg, o);
        if (r.status === 429) return new ProviderError(this.id, msg, { ...o, retriable: true });
        return new ProviderError(this.id, msg, { ...o, retriable: r.status >= 500 });
    }
}
