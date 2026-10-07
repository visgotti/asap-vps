// A minimal S3 client (Signature Version 4), for the object storage a
// provider's image import and export go through (Scaleway's Object Storage:
// https://s3.<region>.scw.cloud): buckets made and deleted, objects put (in
// one request, streamed: up to 5 GB), read, listed and deleted. Path-style
// addressing; a body is signed with its SHA-256 (given for a stream: a file
// staged on disk has its hash), a stream without one sent unsigned
// (UNSIGNED-PAYLOAD). stageDownload puts a URL's file on disk, hashed, for that.

import { createHash, createHmac, randomBytes } from 'crypto';
import { createReadStream, createWriteStream } from 'fs';
import { unlink } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { Readable } from 'stream';
import type { FetchImpl } from './http';

export type S3Credentials = { accessKey: string, secretKey: string };

export type S3Options = {
    /** The service's URL, e.g. https://s3.fr-par.scw.cloud. */
    endpoint: string,
    /** The signing region, e.g. fr-par. */
    region: string,
    credentials: S3Credentials,
    fetchImpl?: FetchImpl,
    /** How a retry waits (default: a timer). */
    sleep?: (ms: number) => Promise<unknown>,
};

export type S3Object = { key: string, size: number, etag?: string };

/** A bucket: its name, and when it was made (epoch ms; undefined where S3 does not say). */
export type S3Bucket = { name: string, createdAt?: number };

/** The SHA-256 of nothing: the payload hash of a request without a body. */
export const EMPTY_SHA256 = createHash('sha256').update('').digest('hex');
/** The payload hash of a body that is not signed (streamed). */
export const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';

/** RFC 3986 encoding, as SigV4 wants it: every byte but A-Z a-z 0-9 - _ . ~ as %XX. */
function encode(s: string): string {
    return encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

const hmac = (key: Buffer | string, data: string) => createHmac('sha256', key).update(data).digest();

/**
 * The headers that sign one request (SigV4): `authorization`, `x-amz-date`
 * and `x-amz-content-sha256`, over `headers`, the URL's host, path and query.
 * `payloadHash` is the body's SHA-256 (hex), EMPTY_SHA256, or UNSIGNED_PAYLOAD.
 */
export function signS3(o: {
    method: string, url: URL, headers?: Record<string, string>, payloadHash: string, region: string, credentials: S3Credentials, now?: Date, service?: string,
}): Record<string, string> {
    const service = o.service ?? 's3';
    const amzDate = (o.now ?? new Date()).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
    const date = amzDate.slice(0, 8);
    const signed: Record<string, string> = { host: o.url.host, 'x-amz-content-sha256': o.payloadHash, 'x-amz-date': amzDate };
    for (const [k, v] of Object.entries(o.headers ?? {})) signed[k.toLowerCase()] = v;
    const names = Object.keys(signed).sort();
    const canonicalHeaders = names.map((n) => `${n}:${signed[n].trim().replace(/\s+/g, ' ')}\n`).join('');
    const path = o.url.pathname.split('/').map((seg) => encode(decodeURIComponent(seg))).join('/');
    const query = [...o.url.searchParams.entries()].map(([k, v]) => `${encode(k)}=${encode(v)}`).sort().join('&');
    const canonical = [o.method, path, query, canonicalHeaders, names.join(';'), o.payloadHash].join('\n');
    const scope = `${date}/${o.region}/${service}/aws4_request`;
    const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, createHash('sha256').update(canonical).digest('hex')].join('\n');
    const key = hmac(hmac(hmac(hmac(`AWS4${o.credentials.secretKey}`, date), o.region), service), 'aws4_request');
    const signature = createHmac('sha256', key).update(toSign).digest('hex');
    return {
        'x-amz-date': amzDate,
        'x-amz-content-sha256': o.payloadHash,
        authorization: `AWS4-HMAC-SHA256 Credential=${o.credentials.accessKey}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`,
    };
}

/** The text of an XML element (the first, or each), unescaped: enough for S3's answers. */
function xmlText(xml: string, tag: string): string | undefined {
    return xmlAll(xml, tag)[0];
}
function xmlAll(xml: string, tag: string): string[] {
    const unescape = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
    return [...xml.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g'))].map((m) => unescape(m[1]));
}

/** An S3 error: its HTTP status, S3's code (NoSuchBucket, AccessDenied...) and message. */
export class S3Error extends Error {
    constructor(readonly status: number, readonly code: string | undefined, message: string) {
        super(message);
        this.name = 'S3Error';
    }
}

export class S3Client {
    private readonly fetchImpl: FetchImpl;
    private readonly sleep: (ms: number) => Promise<unknown>;

    constructor(private readonly o: S3Options) {
        this.fetchImpl = o.fetchImpl ?? fetch;
        this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    }

    /**
     * One signed request to `/<bucket>[/<key>]`. One that fails on the way (a
     * reset, a connect timeout) or that S3 fails (5xx, 429) is sent again
     * (retried) when its body can be: none, or bytes. A stream goes once:
     * putFile sends its file again itself.
     */
    async request(method: string, bucket: string, key?: string, r: {
        query?: Record<string, string>, headers?: Record<string, string>, body?: Uint8Array | ReadableStream<Uint8Array>, size?: number, payloadHash?: string,
    } = {}): Promise<Response> {
        const url = new URL(`${this.o.endpoint.replace(/\/$/, '')}/${encode(bucket)}${key !== undefined ? `/${key.split('/').map(encode).join('/')}` : ''}`);
        for (const [k, v] of Object.entries(r.query ?? {})) url.searchParams.set(k, v);
        const stream = r.body !== undefined && !(r.body instanceof Uint8Array);
        if (stream && r.size === undefined) throw new Error(`a streamed upload to ${bucket}/${key} needs its size (S3 takes no body of unknown length)`);
        const payloadHash = r.body === undefined ? EMPTY_SHA256 : stream ? r.payloadHash ?? UNSIGNED_PAYLOAD : createHash('sha256').update(r.body as Uint8Array).digest('hex');
        const headers: Record<string, string> = {
            ...r.headers,
            ...(r.body !== undefined ? { 'content-length': String(stream ? r.size : (r.body as Uint8Array).byteLength) } : {}),
        };
        const auth = signS3({ method, url, headers, payloadHash, region: this.o.region, credentials: this.o.credentials });
        const send = () => this.fetchImpl(url, {
            method,
            headers: { ...headers, ...auth },
            ...(r.body !== undefined ? { body: stream ? r.body : Buffer.from(r.body as Uint8Array) } : {}),
            ...(stream ? { duplex: 'half' } : {}),
        } as RequestInit);
        return stream ? send() : this.retried(`${method} ${url.pathname}`, send);
    }

    /**
     * `send` again where the network fails it or S3 answers 5xx or 429: up to
     * 4 times in all, 1, 2 and 4 s apart. The last answer, or the last failure,
     * with what the network said (`fetch failed` alone names nothing).
     */
    private async retried<T>(what: string, send: () => Promise<T>, failed: (r: T) => boolean = (r) => (r as Response).status >= 500 || (r as Response).status === 429): Promise<T> {
        for (let attempt = 1; ; attempt++) {
            try {
                const r = await send();
                if (!failed(r) || attempt === 4) return r;
                await (r as Response).body?.cancel().catch(() => undefined);
            } catch (e) {
                const retriable = !(e instanceof S3Error) || e.status >= 500 || e.status === 429;
                if (!retriable || attempt === 4) {
                    const cause = (e as { cause?: { code?: string, message?: string } }).cause;
                    throw e instanceof S3Error || !cause ? e : new Error(`${this.o.endpoint} ${what}: ${(e as Error).message} (${cause.code ?? cause.message})`);
                }
            }
            await this.sleep(1000 * 2 ** (attempt - 1));
        }
    }

    private static async fail(r: Response, what: string): Promise<never> {
        const text = await r.text().catch(() => '');
        throw new S3Error(r.status, xmlText(text, 'Code'), `${what}: ${r.status} ${xmlText(text, 'Code') ?? ''} ${xmlText(text, 'Message') ?? text.slice(0, 200)}`.trim());
    }

    /** Makes the bucket; one the account has already is no error. */
    async createBucket(bucket: string): Promise<void> {
        const r = await this.request('PUT', bucket);
        if (r.ok) return;
        const text = await r.clone().text().catch(() => '');
        if (r.status === 409 && xmlText(text, 'Code') === 'BucketAlreadyOwnedByYou') return;
        return S3Client.fail(r, `bucket ${bucket}`);
    }

    /** Deletes the bucket (it must be empty); one that is gone already is no error. */
    async deleteBucket(bucket: string): Promise<void> {
        const r = await this.request('DELETE', bucket);
        if (r.ok || r.status === 404) return;
        return S3Client.fail(r, `delete of bucket ${bucket}`);
    }

    /** Whether the bucket exists (and the key may read it). */
    async headBucket(bucket: string): Promise<boolean> {
        const r = await this.request('HEAD', bucket);
        if (r.status === 404) return false;
        if (!r.ok) return S3Client.fail(r, `bucket ${bucket}`);
        return true;
    }

    /** Puts an object in one request: bytes, or a stream of `size` bytes (up to 5 GB), signed with its SHA-256 when given (`payloadHash`). Its ETag. */
    async putObject(bucket: string, key: string, body: Uint8Array | ReadableStream<Uint8Array>, size?: number, contentType = 'application/octet-stream', payloadHash?: string): Promise<string | undefined> {
        const r = await this.request('PUT', bucket, key, { body, size, payloadHash, headers: { 'content-type': contentType } });
        if (!r.ok) return S3Client.fail(r, `upload of ${bucket}/${key}`);
        return r.headers.get('etag') ?? undefined;
    }

    /** The object's body, as a response to read or stream; null when there is none. */
    async getObject(bucket: string, key: string): Promise<Response | null> {
        const r = await this.request('GET', bucket, key);
        if (r.status === 404) return null;
        if (!r.ok) return S3Client.fail(r, `${bucket}/${key}`);
        return r;
    }

    /** The object's size and ETag; null when there is none. */
    async headObject(bucket: string, key: string): Promise<S3Object | null> {
        const r = await this.request('HEAD', bucket, key);
        if (r.status === 404) return null;
        if (!r.ok) return S3Client.fail(r, `${bucket}/${key}`);
        return { key, size: Number(r.headers.get('content-length') ?? 0), etag: r.headers.get('etag') ?? undefined };
    }

    /** Deletes the object; one that is gone already is no error. */
    async deleteObject(bucket: string, key: string): Promise<void> {
        const r = await this.request('DELETE', bucket, key);
        if (r.ok || r.status === 404) return;
        return S3Client.fail(r, `delete of ${bucket}/${key}`);
    }

    /** Every object of the bucket (under `prefix`), page by page; [] for a bucket that does not exist. */
    /** The buckets the credentials own (on Scaleway: the Project's, in the endpoint's region). */
    async listBuckets(): Promise<S3Bucket[]> {
        const r = await this.request('GET', '');
        if (!r.ok) return S3Client.fail(r, 'the buckets');
        return xmlAll(await r.text(), 'Bucket').map((b) => {
            const created = Date.parse(xmlText(b, 'CreationDate') ?? '');
            return { name: xmlText(b, 'Name')!, ...(Number.isNaN(created) ? {} : { createdAt: created }) };
        });
    }

    async listObjects(bucket: string, prefix?: string): Promise<S3Object[]> {
        const out: S3Object[] = [];
        let token: string | undefined;
        for (let page = 0; page < 1000; page++) {
            const r = await this.request('GET', bucket, undefined, { query: { 'list-type': '2', ...(prefix ? { prefix } : {}), ...(token ? { 'continuation-token': token } : {}) } });
            if (r.status === 404) return out;
            if (!r.ok) return S3Client.fail(r, `objects of ${bucket}`);
            const xml = await r.text();
            for (const c of xmlAll(xml, 'Contents')) out.push({ key: xmlText(c, 'Key')!, size: Number(xmlText(c, 'Size') ?? 0), etag: xmlText(c, 'ETag') });
            token = xmlText(xml, 'IsTruncated') === 'true' ? xmlText(xml, 'NextContinuationToken') : undefined;
            if (!token) return out;
        }
        throw new Error(`the bucket ${bucket} lists more than 1000 pages`);
    }

    /** Deletes every object of the bucket, then the bucket. */
    async emptyAndDeleteBucket(bucket: string): Promise<void> {
        for (const obj of await this.listObjects(bucket)) await this.deleteObject(bucket, obj.key);
        await this.deleteBucket(bucket);
    }

    /** An object, downloaded to a temporary file and hashed (stageBody): what a put to another bucket signs. A download the network breaks is made again. */
    async stageObject(bucket: string, key: string): Promise<StagedFile> {
        return this.retried(`GET /${bucket}/${key}`, async () => {
            const r = await this.getObject(bucket, key);
            if (!r) throw new S3Error(404, 'NoSuchKey', `${bucket}/${key}: no such object`);
            return stageBody(r, `${bucket}/${key}`);
        }, () => false);
    }

    /** Puts a file staged on disk (stageDownload), streamed and signed with its hash; sent again, from its start, where the network or S3 fails it. Its ETag. */
    async putFile(bucket: string, key: string, file: StagedFile): Promise<string | undefined> {
        return this.retried(`PUT /${bucket}/${key}`, () => this.putObject(bucket, key, Readable.toWeb(createReadStream(file.path)) as ReadableStream<Uint8Array>,
            file.size, 'application/octet-stream', file.sha256), () => false);
    }
}

/** A file on disk, as stageDownload left it: its size and SHA-256 (hex), and how to remove it. */
export type StagedFile = { path: string, size: number, sha256: string, remove(): Promise<void> };

/**
 * The file at `url`, downloaded to a temporary file (streamed: nothing big is
 * held in memory) and hashed on the way: what an upload signs. A download
 * that fails leaves nothing behind.
 */
export async function stageDownload(url: string, fetchImpl: FetchImpl = fetch): Promise<StagedFile> {
    const r = await fetchImpl(url);
    if (!r.ok || !r.body) throw new Error(`${url}: ${r.status} ${r.statusText}`.trim());
    return stageBody(r, url);
}

/** A response's body, written to a temporary file and hashed on the way; one that fails leaves nothing behind. */
async function stageBody(r: Response, what: string): Promise<StagedFile> {
    if (!r.body) throw new Error(`${what}: no body`);
    const path = join(tmpdir(), `asap-vps-${randomBytes(8).toString('hex')}`);
    const remove = () => unlink(path).catch(() => undefined);
    const hash = createHash('sha256');
    let size = 0;
    const out = createWriteStream(path);
    try {
        for await (const chunk of r.body as unknown as AsyncIterable<Uint8Array>) {
            hash.update(chunk);
            size += chunk.byteLength;
            if (!out.write(chunk)) await new Promise<void>((res) => out.once('drain', () => res()));
        }
        await new Promise<void>((res, rej) => out.end((e?: Error | null) => (e ? rej(e) : res())));
    } catch (e) {
        out.destroy();
        await remove();
        throw e;
    }
    return { path, size, sha256: hash.digest('hex'), remove };
}
