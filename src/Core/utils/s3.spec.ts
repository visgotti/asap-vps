// The S3 client: SigV4 against AWS's own worked examples (S3 API reference,
// "Signature Calculations for the Authorization Header: Transferring Payload
// in a Single Chunk"), and each call against a fake S3 that checks the
// signature of every request it is sent.

import { createHash } from 'crypto';
import { mkdtempSync, readdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { fakeS3 } from '../../testing/fakes/s3';
import { ByteSource, EMPTY_SHA256, fileSource, S3Client, S3Error, signS3, stageDownload, UNSIGNED_PAYLOAD, urlSource } from './s3';

const AWS = { accessKey: 'AKIAIOSFODNN7EXAMPLE', secretKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' };
const NOW = new Date('2013-05-24T00:00:00Z');
const signatureOf = (h: Record<string, string>) => /Signature=([0-9a-f]{64})$/.exec(h.authorization)?.[1];
const signedOf = (h: Record<string, string>) => /SignedHeaders=([^,]+),/.exec(h.authorization)?.[1];

describe('signS3: AWS\'s worked examples', () => {
    it('GET Object, with a Range header', () => {
        const h = signS3({ method: 'GET', url: new URL('https://examplebucket.s3.amazonaws.com/test.txt'), headers: { Range: 'bytes=0-9' },
            payloadHash: EMPTY_SHA256, region: 'us-east-1', credentials: AWS, now: NOW });
        expect(signedOf(h)).toBe('host;range;x-amz-content-sha256;x-amz-date');
        expect(signatureOf(h)).toBe('f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
        expect(h.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE\/20130524\/us-east-1\/s3\/aws4_request, /);
        expect(h['x-amz-date']).toBe('20130524T000000Z');
    });

    it('PUT Object, a key with a $ and the body signed', () => {
        const body = 'Welcome to Amazon S3.';
        const h = signS3({ method: 'PUT', url: new URL('https://examplebucket.s3.amazonaws.com/test$file.text'),
            headers: { Date: 'Fri, 24 May 2013 00:00:00 GMT', 'x-amz-storage-class': 'REDUCED_REDUNDANCY' },
            payloadHash: createHash('sha256').update(body).digest('hex'), region: 'us-east-1', credentials: AWS, now: NOW });
        expect(signedOf(h)).toBe('date;host;x-amz-content-sha256;x-amz-date;x-amz-storage-class');
        expect(signatureOf(h)).toBe('98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd');
    });

    it('GET Bucket lifecycle: a subresource with no value', () => {
        const h = signS3({ method: 'GET', url: new URL('https://examplebucket.s3.amazonaws.com/?lifecycle'), payloadHash: EMPTY_SHA256, region: 'us-east-1', credentials: AWS, now: NOW });
        expect(signatureOf(h)).toBe('fea454ca298b7da1c68078a5d1bdbfbbe0d65c699e0f91ac7a200a0136783543');
    });

    it('GET Bucket (list objects): query parameters, sorted', () => {
        const h = signS3({ method: 'GET', url: new URL('https://examplebucket.s3.amazonaws.com/?max-keys=2&prefix=J'), payloadHash: EMPTY_SHA256, region: 'us-east-1', credentials: AWS, now: NOW });
        expect(signatureOf(h)).toBe('34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7');
    });
});

describe('S3Client, against a fake S3 that checks every signature', () => {
    const endpoint = 'https://s3.fr-par.scw.cloud';
    const make = (pageSize?: number) => {
        const s3 = fakeS3({ region: 'fr-par', credentials: { accessKey: 'SCWKEY', secretKey: 'secret' }, pageSize });
        return { s3, c: new S3Client({ endpoint, region: 'fr-par', credentials: { accessKey: 'SCWKEY', secretKey: 'secret' }, fetchImpl: s3.fetchImpl }) };
    };

    it('makes a bucket (again is no error), puts bytes and a stream of known size, reads, lists and deletes them', async () => {
        const { s3, c } = make(2);
        await c.createBucket('asap-vps-images');
        await c.createBucket('asap-vps-images');
        expect(await c.headBucket('asap-vps-images')).toBe(true);
        expect(await c.headBucket('nope')).toBe(false);
        await c.putObject('asap-vps-images', 'a/one file.qcow2', new Uint8Array([1, 2, 3]));
        const stream = new Response(new Uint8Array(1000).fill(7)).body!;
        await c.putObject('asap-vps-images', 'a/two.qcow2', stream, 1000);
        // The stream went unsigned, half-duplex; the bytes signed.
        expect(s3.calls.filter((x) => x.method === 'PUT' && x.path.includes('/a/')).map((x) => [x.payloadHash === UNSIGNED_PAYLOAD, x.duplex])).toEqual([[false, undefined], [true, 'half']]);
        await c.putObject('asap-vps-images', 'b/three', new Uint8Array([9]));
        expect(await c.headObject('asap-vps-images', 'a/two.qcow2')).toEqual({ key: 'a/two.qcow2', size: 1000, etag: `"${createHash('md5').update(new Uint8Array(1000).fill(7)).digest('hex')}"` });
        expect(await c.headObject('asap-vps-images', 'a/none')).toBeNull();
        expect(new Uint8Array(await (await c.getObject('asap-vps-images', 'a/one file.qcow2'))!.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
        expect(await c.getObject('asap-vps-images', 'a/none')).toBeNull();
        // Listed page by page (two a page here).
        expect((await c.listObjects('asap-vps-images')).map((x) => x.key)).toEqual(['a/one file.qcow2', 'a/two.qcow2', 'b/three']);
        // Every bucket, with when it was made (one S3 does not date has no date).
        const before = Date.now();
        await c.createBucket('asap-vps-other');
        s3.buckets.set('undated', new Map());
        const buckets = await c.listBuckets();
        expect(buckets.map((b) => b.name)).toEqual(['asap-vps-images', 'asap-vps-other', 'undated']);
        expect(buckets[1].createdAt).toBeGreaterThanOrEqual(before - 1000);
        expect(buckets[2]).toEqual({ name: 'undated' });
        await c.deleteBucket('asap-vps-other');
        await c.deleteBucket('undated');
        expect(await c.listObjects('asap-vps-images', 'a/')).toEqual([{ key: 'a/one file.qcow2', size: 3, etag: '"e"' }, { key: 'a/two.qcow2', size: 1000, etag: '"e"' }]);
        expect(await c.listObjects('nope')).toEqual([]);
        await expect(c.deleteBucket('asap-vps-images')).rejects.toMatchObject({ status: 409, code: 'BucketNotEmpty' });
        await c.emptyAndDeleteBucket('asap-vps-images');
        expect(s3.buckets.size).toBe(0);
        await c.deleteBucket('asap-vps-images');
        await c.deleteObject('asap-vps-images', 'a/one file.qcow2');
    });

    it('a stream of unknown size is refused before anything is sent; S3\'s errors carry its status and code', async () => {
        const { s3, c } = make();
        await expect(c.putObject('b', 'k', new Response('x').body!)).rejects.toThrow(/needs its size/);
        expect(s3.calls).toEqual([]);
        await expect(c.putObject('missing', 'k', new Uint8Array([1]))).rejects.toThrow(S3Error);
        await expect(c.putObject('missing', 'k', new Uint8Array([1]))).rejects.toMatchObject({ status: 404, code: 'NoSuchBucket', message: 'upload of missing/k: 404 NoSuchBucket NoSuchBucket & more' });
        const wrongKey = new S3Client({ endpoint, region: 'fr-par', credentials: { accessKey: 'SCWKEY', secretKey: 'other' }, fetchImpl: s3.fetchImpl });
        await expect(wrongKey.createBucket('b')).rejects.toMatchObject({ status: 403, code: 'SignatureDoesNotMatch' });
    });
});

describe('S3Client retries what the network or S3 fails', () => {
    const endpoint = 'https://s3.fr-par.scw.cloud';
    const credentials = { accessKey: 'SCWKEY', secretKey: 'secret' };
    /** What the network does to the next requests: 'drop' (a reset), a status S3 answers, or 'pass'; then every request passes. */
    const flaky = (plan: Array<'drop' | number | 'pass'>) => {
        const s3 = fakeS3({ region: 'fr-par', credentials });
        const slept: number[] = [];
        let sent = 0;
        const fetchImpl = (async (url: string, init: RequestInit) => {
            const step = plan[sent++] ?? 'pass';
            if (step === 'drop') {
                // A stream body is read before the connection drops: the next attempt must send it all again.
                if (init.body instanceof ReadableStream) await new Response(init.body).arrayBuffer();
                throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
            }
            if (typeof step === 'number') return new Response(`<Error><Code>SlowDown</Code></Error>`, { status: step });
            return s3.fetchImpl(url, init);
        }) as unknown as typeof fetch;
        const c = new S3Client({ endpoint, region: 'fr-par', credentials, fetchImpl, sleep: async (ms) => { slept.push(ms); } });
        return { s3, c, slept, sent: () => sent };
    };

    it('a request the network drops, or S3 answers 5xx or 429, is sent again, 1, 2 and 4 s apart; a 4xx is not', async () => {
        const { c, slept, sent } = flaky(['drop', 503, 'drop']);
        await c.createBucket('b');
        expect([sent(), slept]).toEqual([4, [1000, 2000, 4000]]);
        const once = flaky([429, 'pass']);
        await once.c.createBucket('b');
        expect(once.sent()).toBe(2);
        // Not there is an answer, not a failure.
        const missing = flaky([]);
        expect(await missing.c.headBucket('nope')).toBe(false);
        expect(missing.sent()).toBe(1);
    });

    it('four failures in a row: the last, with what the network said; S3\'s own answer stays an S3Error', async () => {
        await expect(flaky(['drop', 'drop', 'drop', 'drop']).c.createBucket('b')).rejects.toThrow('https://s3.fr-par.scw.cloud PUT /b: fetch failed (ECONNRESET)');
        await expect(flaky([500, 500, 500, 500]).c.createBucket('b')).rejects.toMatchObject({ status: 500, code: 'SlowDown' });
    });

    it('a staged file is uploaded again from its start, and a download made again, where the network breaks it', async () => {
        const { s3, c } = flaky([]);
        await c.createBucket('b');
        await c.putObject('b', 'image.qcow2', new Uint8Array(2048).fill(7));
        const { c: c2, sent: sent2 } = (() => {
            // The same S3, reached through a network that drops the next upload and the next download once.
            let n = 0;
            const plan: Array<'drop' | 'pass'> = ['drop', 'pass', 'drop'];
            const fetchImpl = (async (url: string, init: RequestInit) => {
                if (plan[n++] === 'drop') {
                    if (init.body instanceof ReadableStream) await new Response(init.body).arrayBuffer();
                    throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ETIMEDOUT' } });
                }
                return s3.fetchImpl(url, init);
            }) as unknown as typeof fetch;
            return { c: new S3Client({ endpoint, region: 'fr-par', credentials, fetchImpl, sleep: async () => {} }), sent: () => n };
        })();
        const staged = await c.stageObject('b', 'image.qcow2');
        try {
            await c2.putFile('b', 'copy.qcow2', staged);
            expect(sent2()).toBe(2);
            const again = await c2.stageObject('b', 'copy.qcow2');
            expect([sent2(), again.size, again.sha256]).toEqual([4, 2048, staged.sha256]);
            await again.remove();
        } finally {
            await staged.remove();
        }
    });
});

describe('stageDownload: a file downloaded to a temporary one, hashed on the way', () => {
    it('a download that breaks, or a disk that cannot take it, is thrown (not an end to the process), and leaves no file behind', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'asap-vps-stage-test-'));
        const answer = (body: () => BodyInit) => (async () => new Response(body())) as unknown as typeof fetch;
        try {
            const breaking = answer(() => new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(1024)); c.error(new Error('connection reset')); } }));
            await expect(stageDownload('https://files.example/disk.qcow2', breaking, { dir })).rejects.toThrow(/connection reset/);
            expect(readdirSync(dir)).toEqual([]);
            // A directory that is not there: the file cannot be written (as on a full disk), and the write stream's error is heard.
            await expect(stageDownload('https://files.example/disk.qcow2', answer(() => new Uint8Array(2048)), { dir: join(dir, 'missing') })).rejects.toMatchObject({ code: 'ENOENT' });
            const staged = await stageDownload('https://files.example/disk.qcow2', answer(() => new Uint8Array(2048).fill(3)), { dir });
            expect([staged.size, staged.sha256, readdirSync(dir).length]).toEqual([2048, createHash('sha256').update(new Uint8Array(2048).fill(3)).digest('hex'), 1]);
            await staged.remove();
            expect(readdirSync(dir)).toEqual([]);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    // Real files on a disk other jobs may be busy with: more than the default 5 s.
    }, 30_000);
});

describe('S3Client.upload: a source in parts, several at a time, never held whole', () => {
    const endpoint = 'https://s3.fr-par.scw.cloud';
    const credentials = { accessKey: 'SCWKEY', secretKey: 'secret' };
    const KiB = 1024;
    /** A fake S3 that takes 1 KiB parts, and a client that cuts 1 KiB parts, 2 at a time: a few KiB make several parts. */
    const make = (o: { maxParts?: number, memoryPart?: number, wrap?: (f: typeof fetch) => typeof fetch } = {}) => {
        const s3 = fakeS3({ region: 'fr-par', credentials, minPartSize: KiB, maxParts: o.maxParts });
        const fetchImpl = (o.wrap ?? ((f) => f))(s3.fetchImpl);
        const c = new S3Client({ endpoint, region: 'fr-par', credentials, fetchImpl, sleep: async () => {}, partSize: KiB, maxParts: o.maxParts, concurrency: 2, memoryPart: o.memoryPart });
        return { s3, c };
    };
    /** `data` in a file on disk, for `use`; the file removed after. */
    const onDisk = async (data: Uint8Array, use: (path: string) => Promise<void>) => {
        const dir = mkdtempSync(join(tmpdir(), 'asap-vps-upload-test-'));
        try {
            const path = join(dir, 'disk.qcow2');
            require('fs').writeFileSync(path, data);
            await use(path);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    };
    const bytes = (n: number) => Uint8Array.from({ length: n }, (_, i) => (i * 7 + 3) % 251);
    /** A source of `data`, which notes each range read and how many reads overlap. */
    const memory = (data: Uint8Array) => {
        const reads: string[] = [];
        let open = 0;
        let most = 0;
        const source: ByteSource = {
            size: data.byteLength, what: 'memory',
            range: async (start, end) => {
                reads.push(`${start}-${end}`);
                most = Math.max(most, ++open);
                const slice = data.subarray(start, end + 1);
                return new ReadableStream<Uint8Array>({ start(ctl) { ctl.enqueue(slice); ctl.close(); open--; } });
            },
        };
        return { source, reads, most: () => most };
    };
    const md5 = (b: Uint8Array) => createHash('md5').update(b).digest('hex');

    it('a source bigger than a part goes up in parts, two at a time; a part not on disk is read whole, once, and sent signed with its hash; the object is the source', async () => {
        const { s3, c } = make();
        await c.createBucket('b');
        const data = bytes(3 * KiB + 100);
        const m = memory(data);
        const etag = await c.upload('b', 'disk.qcow2', m.source);
        expect(Buffer.from(s3.buckets.get('b')!.get('disk.qcow2')!)).toEqual(Buffer.from(data));
        expect(etag).toMatch(/^"[0-9a-f]{32}-4"$/);
        expect(m.reads).toEqual(['0-1023', '1024-2047', '2048-3071', '3072-3171']);
        expect(m.most()).toBeLessThanOrEqual(2);
        const parts = s3.calls.filter((x) => x.method === 'PUT' && /partNumber=/.test(x.query));
        const hash = (start: number, end: number) => createHash('sha256').update(data.subarray(start, end)).digest('hex');
        expect(parts.map((x) => [/partNumber=(\d+)/.exec(x.query)![1], x.payloadHash, x.duplex]).sort()).toEqual([
            ['1', hash(0, 1024), undefined], ['2', hash(1024, 2048), undefined], ['3', hash(2048, 3072), undefined], ['4', hash(3072, 3172), undefined],
        ]);
        expect(s3.calls.filter((x) => x.method === 'POST').map((x) => x.query.replace(/=[0-9a-f]+/, '=<id>'))).toEqual(['?uploads=', '?uploadId=<id>']);
        expect(s3.uploads.size).toBe(0);
        // A source that fits in a part: one PUT, its ETag its MD5; nothing at all: an empty object.
        const small = bytes(500);
        expect(await c.upload('b', 'small', memory(small).source)).toBe(`"${md5(small)}"`);
        await c.upload('b', 'empty', { size: 0, what: 'nothing', range: async () => { throw new Error('not read'); } });
        expect(s3.buckets.get('b')!.get('empty')!.byteLength).toBe(0);
    });

    it('parts grow so that no upload has more than maxParts', async () => {
        const { s3, c } = make({ maxParts: 3 });
        await c.createBucket('b');
        const m = memory(bytes(10 * KiB));
        await c.upload('b', 'big', m.source);
        expect(m.reads).toEqual(['0-3413', '3414-6827', '6828-10239']);
        expect(s3.buckets.get('b')!.get('big')!.byteLength).toBe(10 * KiB);
    });

    it('a part the network drops, S3 fails or times out on, or S3 stores otherwise than sent is sent again (from memory: not read again); the object is still the source', async () => {
        let drops = 1;
        let fives = 1;
        const { s3, c } = make({
            wrap: (inner) => (async (url: string | URL | Request, init?: RequestInit) => {
                if (init?.method === 'PUT' && /partNumber=2/.test(String(url))) {
                    if (drops-- > 0) {
                        await new Response(init.body).arrayBuffer();
                        throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
                    }
                    if (fives-- > 0) return new Response('<Error><Code>SlowDown</Code></Error>', { status: 503 });
                    if (timeouts-- > 0) return new Response('<Error><Code>RequestTimeout</Code><Message>Client connection timeout or client closed it.</Message></Error>', { status: 408 });
                }
                return inner(url, init);
            }) as typeof fetch,
        });
        let timeouts = 1;
        await c.createBucket('b');
        const data = bytes(3 * KiB);
        const m = memory(data);
        s3.faults.corruptNextPart = true;
        await c.upload('b', 'disk', m.source);
        expect(Buffer.from(s3.buckets.get('b')!.get('disk')!)).toEqual(Buffer.from(data));
        // Each part read once: a part sent again goes from memory.
        expect(m.reads).toEqual(['0-1023', '1024-2047', '2048-3071']);
        // A part of a file on disk streams from it, and is read again for each attempt.
        drops = 1;
        await onDisk(data, async (path) => {
            await c.upload('b', 'streamed', fileSource(path, data.byteLength));
            expect(Buffer.from(s3.buckets.get('b')!.get('streamed')!)).toEqual(Buffer.from(data));
            const streamed = s3.calls.filter((x) => x.method === 'PUT' && /partNumber=/.test(x.query) && x.path.endsWith('/streamed'));
            expect(streamed.every((x) => x.payloadHash === UNSIGNED_PAYLOAD && x.duplex === 'half')).toBe(true);
        });
    });

    it('a part too big to hold in memory waits in a temporary file, and is sent from it', async () => {
        const { s3, c } = make({ memoryPart: 512 });
        await c.createBucket('b');
        const data = bytes(3 * KiB);
        await c.upload('b', 'disk', memory(data).source);
        expect(Buffer.from(s3.buckets.get('b')!.get('disk')!)).toEqual(Buffer.from(data));
        const parts = s3.calls.filter((x) => x.method === 'PUT' && /partNumber=/.test(x.query));
        expect(parts.every((x) => x.payloadHash === UNSIGNED_PAYLOAD && x.duplex === 'half')).toBe(true);
    });

    it('an upload that fails is aborted: S3 keeps no part of it; a completion S3 answers with an error in a 200 is a failure too', async () => {
        const refusing = make({ wrap: (inner) => (async (url: string | URL | Request, init?: RequestInit) => (init?.method === 'PUT' && /partNumber=3/.test(String(url))
            ? new Response('<Error><Code>AccessDenied</Code><Message>no</Message></Error>', { status: 403 }) : inner(url, init))) as typeof fetch });
        await refusing.c.createBucket('b');
        await expect(refusing.c.upload('b', 'disk', memory(bytes(4 * KiB)).source)).rejects.toMatchObject({ status: 403, code: 'AccessDenied' });
        expect([refusing.s3.uploads.size, refusing.s3.buckets.get('b')!.has('disk')]).toEqual([0, false]);
        // Aborted once no part is still on its way: the abort is the upload's last request.
        const ofUpload = refusing.s3.calls.filter((x) => /uploadId=/.test(x.query)).map((x) => x.method);
        expect([ofUpload.indexOf('DELETE'), ofUpload.filter((m) => m === 'DELETE').length]).toEqual([ofUpload.length - 1, 1]);
        const quirky = make({ wrap: (inner) => (async (url: string | URL | Request, init?: RequestInit) => (init?.method === 'POST' && /uploadId=/.test(String(url))
            ? new Response('<Error><Code>InternalError</Code><Message>try again</Message></Error>', { status: 200 }) : inner(url, init))) as typeof fetch });
        await quirky.c.createBucket('b');
        await expect(quirky.c.upload('b', 'disk', memory(bytes(2 * KiB + 1)).source)).rejects.toThrow(/completion of b\/disk: 200 InternalError try again/);
        expect(quirky.s3.uploads.size).toBe(0);
        const silent = make({ wrap: (inner) => (async (url: string | URL | Request, init?: RequestInit) => (init?.method === 'POST' && /uploads=/.test(String(url))
            ? new Response('<InitiateMultipartUploadResult></InitiateMultipartUploadResult>', { status: 200 }) : inner(url, init))) as typeof fetch });
        await silent.c.createBucket('b');
        await expect(silent.c.upload('b', 'disk', memory(bytes(2 * KiB + 1)).source)).rejects.toThrow(/S3 gave no UploadId/);
        // A bucket that is not there: S3's answer to the upload's start.
        await expect(refusing.c.upload('missing', 'disk', memory(bytes(2 * KiB + 1)).source)).rejects.toMatchObject({ status: 404, code: 'NoSuchBucket' });
    });

    it('copies an object across two S3s (regions) by its ranges, and uploads a file from disk by its ranges', async () => {
        const a = make();
        const b = make();
        await a.c.createBucket('from');
        await b.c.createBucket('to');
        const data = bytes(5 * KiB + 17);
        await a.c.putObject('from', 'export.qcow2', data);
        const source = (await a.c.objectSource('from', 'export.qcow2'))!;
        expect(source.size).toBe(data.byteLength);
        await b.c.upload('to', 'export.qcow2', source);
        expect(Buffer.from(b.s3.buckets.get('to')!.get('export.qcow2')!)).toEqual(Buffer.from(data));
        expect(a.s3.calls.filter((x) => x.method === 'GET').length).toBe(6);
        expect(await a.c.objectSource('from', 'none')).toBeNull();
        // A range S3 refuses is its error.
        await expect(source.range(10 * KiB, 11 * KiB)).rejects.toMatchObject({ status: 416 });
        await onDisk(data, async (path) => {
            await b.c.upload('to', 'from-disk', fileSource(path, data.byteLength));
            expect(Buffer.from(b.s3.buckets.get('to')!.get('from-disk')!)).toEqual(Buffer.from(data));
        });
    });

    it('urlSource: a file whose server says its size and serves ranges; none where it does not, or does not answer', async () => {
        const data = bytes(3000);
        const server = (o: { ranges?: boolean, head?: number, rangeStatus?: number } = {}) => (async (_url: string | URL | Request, init?: RequestInit) => {
            if (init?.method === 'HEAD') return new Response(null, { status: o.head ?? 200, headers: { 'content-length': String(data.byteLength), ...(o.ranges ? { 'accept-ranges': 'bytes' } : {}) } });
            const m = /^bytes=(\d+)-(\d+)$/.exec(new Headers(init?.headers).get('range') ?? '');
            if (m && o.rangeStatus === undefined) return new Response(Buffer.from(data.subarray(Number(m[1]), Number(m[2]) + 1)), { status: 206 });
            return new Response(Buffer.from(data), { status: o.rangeStatus ?? 200 });
        }) as unknown as typeof fetch;
        const source = (await urlSource('https://files.example/disk.qcow2', server({ ranges: true })))!;
        expect(source.size).toBe(3000);
        expect(Buffer.from(await new Response(await source.range(100, 199)).arrayBuffer())).toEqual(Buffer.from(data.subarray(100, 200)));
        expect(await urlSource('https://files.example/disk.qcow2', server())).toBeNull();
        expect(await urlSource('https://files.example/disk.qcow2', server({ ranges: true, head: 405 }))).toBeNull();
        expect(await urlSource('https://files.example/disk.qcow2', (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch)).toBeNull();
        // A server that stops serving ranges: an error, not the whole file read as a part.
        const fickle = (await urlSource('https://files.example/disk.qcow2', server({ ranges: true, rangeStatus: 200 })))!;
        await expect(fickle.range(0, 99)).rejects.toMatchObject({ status: 502, code: 'RangeRefused' });
        const busy = (await urlSource('https://files.example/disk.qcow2', server({ ranges: true, rangeStatus: 503 })))!;
        await expect(busy.range(0, 99)).rejects.toMatchObject({ status: 503 });
    });
});
