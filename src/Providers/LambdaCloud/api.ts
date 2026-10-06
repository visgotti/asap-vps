// The Lambda Cloud API client (https://cloud.lambda.ai/api/v1): one reading of
// Lambda's errors onto src/errors.ts (toError), by the `code` its error body carries.

import { ApiClient, errorText, HttpResult, RequestInfo } from '../../Core/utils';
import { AuthError, CapacityError, NotFoundError, ProviderError, QuotaError } from '../../errors';
import type { ProviderParams } from '../../types';
import { LAMBDA_ID } from './mappers';
import type { LambdaErrorBody } from './types';

export class LambdaApi extends ApiClient {
    static readonly BASE_URL = 'https://cloud.lambda.ai';

    constructor(params: ProviderParams | string) {
        super(params, LambdaApi.BASE_URL, LAMBDA_ID);
    }

    /** A call whose failure throws its typed error; `idempotent` lets a POST that is harmless twice be retried. */
    call<T = any>(method: string, path: string, json?: unknown, idempotent?: boolean): Promise<T> {
        return this.send<T>(method, path, { json, idempotent });
    }

    protected toError(r: HttpResult, req: RequestInfo): ProviderError {
        const err = (r.body as LambdaErrorBody)?.error;
        const code = err?.code;
        const msg = `${req.method} ${req.path} -> ${r.status} ${code ?? ''} ${err?.message ?? errorText(r.body)}${err?.suggestion ? ` (${err.suggestion})` : ''}`;
        const o = { status: r.status, code };
        if (r.status === 401 || code === 'global/invalid-api-key') return new AuthError(this.id, msg, o);
        if (code === 'instance-operations/launch/insufficient-capacity') return new CapacityError(this.id, msg, o);
        if (code === 'global/quota-exceeded' || code === 'global/account-inactive' || code === 'global/invalid-address') return new QuotaError(this.id, msg, o);
        if (r.status === 403) return new AuthError(this.id, msg, o);
        if (r.status === 404 || code === 'global/object-does-not-exist' || code === 'global/not-found') return new NotFoundError(this.id, msg, o);
        return new ProviderError(this.id, msg, { ...o, retriable: r.status === 429 || r.status >= 500 });
    }
}
