// A fetch() that answers like S3 (Scaleway's Object Storage speaks it) for the
// calls S3Client makes, holding buckets and objects in memory, and refusing
// any request whose SigV4 signature is not the one its fields make with the
// credentials it knows: buckets made (again: BucketAlreadyOwnedByYou), read,
// deleted (empty only); objects put (a streamed body unsigned or signed with
// its hash, its content-length exact), read, listed page by page, deleted.

import { createHash } from 'crypto';
import { signS3, UNSIGNED_PAYLOAD } from '../../Core/utils/s3';
import type { S3Credentials } from '../../Core/utils/s3';

export type FakeS3 = ReturnType<typeof fakeS3>;

export function fakeS3(o: { region: string, credentials: S3Credentials, pageSize?: number }) {
    const buckets = new Map<string, Map<string, Uint8Array>>();
    /** When each bucket was made (ISO 8601). */
    const created = new Map<string, string>();
    const calls: Array<{ method: string, path: string, payloadHash: string, duplex?: string }> = [];
    const xml = (status: number, body: string) => new Response(`<?xml version="1.0" encoding="UTF-8"?>${body}`, { status, headers: { 'content-type': 'application/xml' } });
    const error = (status: number, code: string) => xml(status, `<Error><Code>${code}</Code><Message>${code} &amp; more</Message></Error>`);
    const fetchImpl = (async (input: string | URL | Request, init: RequestInit & { duplex?: string } = {}) => {
        const url = new URL(String(input));
        const method = init.method ?? 'GET';
        const headers = init.headers as Record<string, string>;
        const payloadHash = headers['x-amz-content-sha256'];
        calls.push({ method, path: url.pathname, payloadHash, duplex: init.duplex });
        // The signature, recomputed from what was sent.
        const unsigned = Object.fromEntries(Object.entries(headers).filter(([k]) => !['authorization', 'x-amz-date', 'x-amz-content-sha256'].includes(k)));
        const amz = headers['x-amz-date'] ?? '';
        const now = new Date(`${amz.slice(0, 4)}-${amz.slice(4, 6)}-${amz.slice(6, 8)}T${amz.slice(9, 11)}:${amz.slice(11, 13)}:${amz.slice(13, 15)}Z`);
        const expected = signS3({ method, url, headers: unsigned, payloadHash, region: o.region, credentials: o.credentials, now });
        if (expected.authorization !== headers.authorization) return error(403, 'SignatureDoesNotMatch');
        let body: Uint8Array | undefined;
        if (init.body instanceof ReadableStream) {
            body = new Uint8Array(await new Response(init.body).arrayBuffer());
            if (init.duplex !== 'half') return error(400, 'BadStream');
            if (payloadHash !== UNSIGNED_PAYLOAD && createHash('sha256').update(body).digest('hex') !== payloadHash) return error(400, 'XAmzContentSHA256Mismatch');
        } else if (init.body !== undefined) {
            body = new Uint8Array(init.body as Buffer);
            if (createHash('sha256').update(body).digest('hex') !== payloadHash) return error(400, 'XAmzContentSHA256Mismatch');
        }
        if (body && Number(headers['content-length']) !== body.byteLength) return error(400, 'IncompleteBody');
        const [, bucket, ...rest] = url.pathname.split('/');
        const key = rest.length ? rest.map(decodeURIComponent).join('/') : undefined;
        if (!bucket && method === 'GET') {
            return xml(200, `<ListAllMyBucketsResult><Buckets>${[...buckets.keys()].sort().map((n) => `<Bucket><Name>${n}</Name>${created.has(n) ? `<CreationDate>${created.get(n)}</CreationDate>` : ''}</Bucket>`).join('')}</Buckets></ListAllMyBucketsResult>`);
        }
        const b = buckets.get(bucket);
        if (key === undefined) {
            if (method === 'PUT') {
                if (b) return error(409, 'BucketAlreadyOwnedByYou');
                buckets.set(bucket, new Map());
                created.set(bucket, new Date().toISOString());
                return new Response(null, { status: 200 });
            }
            if (!b) return error(404, 'NoSuchBucket');
            if (method === 'HEAD') return new Response(null, { status: 200 });
            if (method === 'DELETE') {
                if (b.size) return error(409, 'BucketNotEmpty');
                buckets.delete(bucket);
                return new Response(null, { status: 204 });
            }
            const keys = [...b.keys()].filter((k) => k.startsWith(url.searchParams.get('prefix') ?? '')).sort();
            const start = Number(url.searchParams.get('continuation-token') ?? 0);
            const page = keys.slice(start, start + (o.pageSize ?? 1000));
            const more = start + page.length < keys.length;
            return xml(200, `<ListBucketResult><IsTruncated>${more}</IsTruncated>${page.map((k) => `<Contents><Key>${k.replace(/&/g, '&amp;')}</Key><Size>${b.get(k)!.byteLength}</Size><ETag>"e"</ETag></Contents>`).join('')}${more ? `<NextContinuationToken>${start + page.length}</NextContinuationToken>` : ''}</ListBucketResult>`);
        }
        if (!b) return error(404, 'NoSuchBucket');
        if (method === 'PUT') {
            b.set(key, body ?? new Uint8Array());
            return new Response(null, { status: 200, headers: { etag: '"abc"' } });
        }
        const obj = b.get(key);
        if (method === 'DELETE') {
            b.delete(key);
            return new Response(null, { status: 204 });
        }
        if (!obj) return method === 'HEAD' ? new Response(null, { status: 404 }) : error(404, 'NoSuchKey');
        if (method === 'HEAD') return new Response(null, { status: 200, headers: { 'content-length': String(obj.byteLength), etag: '"abc"' } });
        return new Response(Buffer.from(obj), { status: 200 });
    }) as typeof fetch;
    return { fetchImpl, buckets, calls };
}
