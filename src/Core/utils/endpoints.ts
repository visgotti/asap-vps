// The endpoints a provider's API client calls, each with its operation in the
// platform's OpenAPI spec and its page in the platform's API reference: one
// table per platform (src/Providers/<Platform>/endpoints.ts). An ApiClient
// given its table refuses a request no entry describes, before it is sent, so
// what the provider calls and what is documented cannot drift apart; and
// `npm run api:spec` (scripts/api-spec-check.ts) holds each table to the live
// spec and reference.

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export type ApiEndpoint = {
    /** The operation's id in the platform's OpenAPI spec; absent where the spec gives the operation none. */
    operationId?: string,
    method: HttpMethod,
    /** The path as it is sent, with `{placeholders}` (named as in the spec) for its variable parts. */
    path: string,
    /** The query parameters it is sent with, when any. */
    query?: readonly string[],
    /** This operation's page (and anchor) in the platform's API reference. */
    docs: string,
    /**
     * Where the call departs from the spec, and on what authority: `path`, the
     * spec's own path for it, or null where the spec has no such operation;
     * `query`, parameters the spec does not declare. The platform's own client
     * sends it so, or it was seen live (`source` says which, and where). The
     * spec check reports these; it does not fail on them.
     */
    unspecified?: { path?: string | null, query?: readonly string[], source: string },
};

const patterns = new WeakMap<ApiEndpoint, RegExp>();

/** The path's pattern: each `{placeholder}` one non-empty segment. */
function pattern(e: ApiEndpoint): RegExp {
    let re = patterns.get(e);
    if (!re) {
        re = new RegExp(`^${e.path.split(/\{[^}]+\}/).map((part) => part.replace(/[.*+?^$()|[\]\\]/g, '\\$&')).join('[^/?#]+')}$`);
        patterns.set(e, re);
    }
    return re;
}

/**
 * The name of `table`'s entry that describes a request: its method, its path
 * (placeholders filled), and query parameters all among the entry's. Undefined
 * when there is none.
 */
export function endpointOf<T extends Readonly<Record<string, ApiEndpoint>>>(table: T, method: string, pathAndQuery: string): keyof T | undefined {
    const [path, search = ''] = pathAndQuery.split('?', 2);
    const query = [...new URLSearchParams(search).keys()];
    return (Object.keys(table) as Array<keyof T>).find((name) => {
        const e = table[name];
        return e.method === method.toUpperCase() && pattern(e).test(path) && query.every((q) => e.query?.includes(q));
    });
}
