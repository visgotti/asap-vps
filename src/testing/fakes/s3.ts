// A fetch() that answers like S3 (Scaleway's Object Storage speaks it) for the
// calls S3Client makes, holding buckets and objects in memory, and refusing
// any request whose SigV4 signature is not the one its fields make with the
// credentials it knows: buckets made (again: BucketAlreadyOwnedByYou), read,
// deleted (empty only); objects put (a streamed body unsigned or signed with
// its hash, its content-length exact; the ETag its MD5), read whole or by a
// `range` (206), listed page by page, deleted; and multipart uploads as S3
// has them: begun, parts put (numbered 1..maxParts, each ETag its MD5),
// completed (the parts in order, each but the last at least minPartSize,
// their ETags matching) or aborted.

import { createHash } from 'crypto';
import { signS3, UNSIGNED_PAYLOAD } from '../../Core/utils/s3';
import type { S3Credentials } from '../../Core/utils/s3';

export type FakeS3 = ReturnType<typeof fakeS3>;

export function fakeS3(o: {
    region: string, credentials: S3Credentials, pageSize?: number,
    /** S3's floor for a part but the last: 5 MiB (a test sets less). */
    minPartSize?: number,
    /** The most parts an upload takes: 1000, as Scaleway's. */
    maxParts?: number,
}) {
    const buckets = new Map<string, Map<string, Uint8Array>>();
    /** Multipart uploads begun and neither completed nor aborted, by id. */
    const uploads = new Map<string, { bucket: string, key: string, parts: Map<number, Uint8Array> }>();
    const md5 = (b: Uint8Array) => createHash('md5').update(b).digest('hex');
    /** Knobs: the next part put is stored other than sent (S3 answers its ETag: the client must see it differs). */
    const faults = { corruptNextPart: false };
    /** When each bucket was made (ISO 8601). */
    const created = new Map<string, string>();
    const calls: Array<{ method: string, path: string, query: string, payloadHash: string, duplex?: string, range?: string }> = [];
    const xml = (status: number, body: string) => new Response(`<?xml version="1.0" encoding="UTF-8"?>${body}`, { status, headers: { 'content-type': 'application/xml' } });
    const error = (status: number, code: string) => xml(status, `<Error><Code>${code}</Code><Message>${code} &amp; more</Message></Error>`);
    const fetchImpl = (async (input: string | URL | Request, init: RequestInit & { duplex?: string } = {}) => {
        const url = new URL(String(input));
        const method = init.method ?? 'GET';
        const headers = init.headers as Record<string, string>;
        const payloadHash = headers['x-amz-content-sha256'];
        calls.push({ method, path: url.pathname, query: url.search, payloadHash, duplex: init.duplex, ...(headers.range ? { range: headers.range } : {}) });
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
        // Multipart uploads.
        const uploadId = url.searchParams.get('uploadId');
        if (method === 'POST' && url.searchParams.has('uploads')) {
            const id = createHash('sha256').update(`${bucket}/${key}/${uploads.size}/${Math.random()}`).digest('hex').slice(0, 24);
            uploads.set(id, { bucket, key, parts: new Map() });
            return xml(200, `<InitiateMultipartUploadResult><Bucket>${bucket}</Bucket><Key>${key}</Key><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`);
        }
        if (uploadId !== null) {
            const upload = uploads.get(uploadId);
            if (!upload || upload.bucket !== bucket || upload.key !== key) return error(404, 'NoSuchUpload');
            if (method === 'PUT') {
                const n = Number(url.searchParams.get('partNumber'));
                if (!Number.isInteger(n) || n < 1 || n > (o.maxParts ?? 1000)) return error(400, 'InvalidArgument');
                const sent = body ?? new Uint8Array();
                const stored = faults.corruptNextPart ? Uint8Array.from(sent, (x, i) => (i === 0 ? x ^ 0xff : x)) : sent;
                faults.corruptNextPart = false;
                upload.parts.set(n, stored);
                return new Response(null, { status: 200, headers: { etag: `"${md5(stored)}"` } });
            }
            if (method === 'DELETE') {
                uploads.delete(uploadId);
                return new Response(null, { status: 204 });
            }
            if (method === 'POST') {
                const listed = [...new TextDecoder().decode(body).matchAll(/<Part><PartNumber>(\d+)<\/PartNumber><ETag>([^<]*)<\/ETag><\/Part>/g)].map((m) => ({ n: Number(m[1]), etag: m[2] }));
                if (!listed.length || listed.some((p, i) => i > 0 && p.n <= listed[i - 1].n)) return error(400, 'InvalidPartOrder');
                for (const [i, p] of listed.entries()) {
                    const part = upload.parts.get(p.n);
                    if (!part || p.etag !== `"${md5(part)}"`) return error(400, 'InvalidPart');
                    if (i < listed.length - 1 && part.byteLength < (o.minPartSize ?? 5 * 1024 * 1024)) return error(400, 'EntityTooSmall');
                }
                const whole = Buffer.concat(listed.map((p) => upload.parts.get(p.n)!));
                b.set(key, new Uint8Array(whole));
                uploads.delete(uploadId);
                const etag = `"${createHash('md5').update(Buffer.concat(listed.map((p) => Buffer.from(md5(upload.parts.get(p.n)!), 'hex')))).digest('hex')}-${listed.length}"`;
                return xml(200, `<CompleteMultipartUploadResult><Bucket>${bucket}</Bucket><Key>${key}</Key><ETag>${etag}</ETag></CompleteMultipartUploadResult>`);
            }
        }
        if (method === 'PUT') {
            b.set(key, body ?? new Uint8Array());
            return new Response(null, { status: 200, headers: { etag: `"${md5(body ?? new Uint8Array())}"` } });
        }
        const obj = b.get(key);
        if (method === 'DELETE') {
            b.delete(key);
            return new Response(null, { status: 204 });
        }
        if (!obj) return method === 'HEAD' ? new Response(null, { status: 404 }) : error(404, 'NoSuchKey');
        if (method === 'HEAD') return new Response(null, { status: 200, headers: { 'content-length': String(obj.byteLength), etag: `"${md5(obj)}"`, 'accept-ranges': 'bytes' } });
        // A range: bytes=<start>-<end> (both included), as S3 answers it.
        const range = /^bytes=(\d+)-(\d+)$/.exec(headers.range ?? '');
        if (range) {
            const [start, end] = [Number(range[1]), Math.min(Number(range[2]), obj.byteLength - 1)];
            if (start > end) return error(416, 'InvalidRange');
            return new Response(Buffer.from(obj.subarray(start, end + 1)), { status: 206, headers: { 'content-range': `bytes ${start}-${end}/${obj.byteLength}`, 'content-length': String(end - start + 1) } });
        }
        return new Response(Buffer.from(obj), { status: 200 });
    }) as typeof fetch;
    return { fetchImpl, buckets, calls, uploads, faults };
}
