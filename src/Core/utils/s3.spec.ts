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

    /** The fake S3, but for the requests `answer` answers itself. */
    const answering = (answer: (method: string, path: string, init?: RequestInit) => Response | undefined) => {
        const credentials = { accessKey: 'SCWKEY', secretKey: 'secret' };
        const s3 = fakeS3({ region: 'fr-par', credentials });
        const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => answer(init?.method ?? 'GET', new URL(String(input)).pathname, init) ?? s3.fetchImpl(input, init)) as typeof fetch;
        return { s3, c: new S3Client({ endpoint, region: 'fr-par', credentials, fetchImpl, sleep: async () => {} }) };
    };
    /** What a call was refused with: its S3Error's status, code and message (any other failure as it is). */
    const refusal = (p: Promise<unknown>) => p.then(() => 'not refused', (e: Error) => (e instanceof S3Error ? [e.status, e.code, e.message] : e));
    /** An answer whose body breaks before it is read (a reset mid-body). */
    const broken = (status: number) => new Response(new ReadableStream({ start(ctl) { ctl.error(new TypeError('terminated')); } }), { status });
    const accessDenied = () => new Response('<Error><Code>AccessDenied</Code><Message>Access Denied</Message></Error>', { status: 403 });

    it('each call S3 refuses is an S3Error that names the call', async () => {
        // A HEAD's answer has no body: its status says it all.
        const { c } = answering((method) => (method === 'HEAD' ? new Response(null, { status: 403 }) : accessDenied()));
        expect(await Promise.all([
            refusal(c.headBucket('b')), refusal(c.headObject('b', 'k')), refusal(c.getObject('b', 'k')), refusal(c.deleteObject('b', 'k')),
            refusal(c.listBuckets()), refusal(c.listObjects('b')), refusal(c.deleteBucket('b')), refusal(c.putObject('b', 'k', new Uint8Array([1]))),
        ])).toEqual([
            [403, undefined, 'bucket b: 403'], [403, undefined, 'b/k: 403'], [403, 'AccessDenied', 'b/k: 403 AccessDenied Access Denied'],
            [403, 'AccessDenied', 'delete of b/k: 403 AccessDenied Access Denied'], [403, 'AccessDenied', 'the buckets: 403 AccessDenied Access Denied'],
            [403, 'AccessDenied', 'objects of b: 403 AccessDenied Access Denied'], [403, 'AccessDenied', 'delete of bucket b: 403 AccessDenied Access Denied'],
            [403, 'AccessDenied', 'upload of b/k: 403 AccessDenied Access Denied'],
        ]);
    });

    it('a bucket name another account has is refused, not taken for ours; a refusal not in S3\'s XML is its first 200 characters, one that cannot be read its status', async () => {
        const taken = answering((method) => (method === 'PUT'
            ? new Response('<Error><Code>BucketAlreadyExists</Code><Message>The requested bucket name is not available.</Message></Error>', { status: 409 }) : undefined));
        expect(await refusal(taken.c.createBucket('b'))).toEqual([409, 'BucketAlreadyExists', 'bucket b: 409 BucketAlreadyExists The requested bucket name is not available.']);
        const page = 'x'.repeat(300);
        const proxy = answering(() => new Response(page, { status: 403 }));
        expect(await refusal(proxy.c.putObject('b', 'k', new Uint8Array([1])))).toEqual([403, undefined, `upload of b/k: 403  ${page.slice(0, 200)}`]);
        const cut = answering(() => broken(409));
        expect(await refusal(cut.c.createBucket('b'))).toEqual([409, undefined, 'bucket b: 409']);
        expect(await refusal(cut.c.deleteBucket('b'))).toEqual([409, undefined, 'delete of bucket b: 409']);
    });

    it('asks whether a bucket is there with a HEAD', async () => {
        const { s3, c } = answering(() => undefined);
        await c.createBucket('b');
        expect([await c.headBucket('b'), await c.headBucket('nope')]).toEqual([true, false]);
        expect(s3.calls.map((x) => `${x.method} ${x.path}`)).toEqual(['PUT /b', 'HEAD /b', 'HEAD /nope']);
    });

    it('a listing that never ends is refused after 1000 pages', async () => {
        let pages = 0;
        const { c } = answering(() => {
            pages++;
            return new Response('<ListBucketResult><IsTruncated>true</IsTruncated><NextContinuationToken>next</NextContinuationToken></ListBucketResult>', { status: 200 });
        });
        await expect(c.listObjects('b')).rejects.toThrow(new Error('the bucket b lists more than 1000 pages'));
        expect(pages).toBe(1000);
    });

    it('stageObject: an object not there is NoSuchKey at once; one sent without a body, or whose download breaks every time, an error that says so', async () => {
        const { s3, c } = answering(() => undefined);
        await c.createBucket('b');
        expect(await refusal(c.stageObject('b', 'none'))).toEqual([404, 'NoSuchKey', 'b/none: no such object']);
        expect(s3.calls.filter((x) => x.method === 'GET').map((x) => x.path)).toEqual(['/b/none']);
        const empty = answering((method) => (method === 'GET' ? new Response(null, { status: 200 }) : undefined));
        await expect(empty.c.stageObject('b', 'k')).rejects.toThrow(new Error('b/k: no body'));
        const cut = answering((method) => (method === 'GET' ? new Response(new ReadableStream({
            start(ctl) {
                ctl.enqueue(new Uint8Array(8));
                ctl.error(Object.assign(new TypeError('terminated'), { cause: { code: 'UND_ERR_SOCKET' } }));
            },
        }), { status: 200 }) : undefined));
        await expect(cut.c.stageObject('b', 'k')).rejects.toThrow(new Error(`${endpoint} GET /b/k: terminated (UND_ERR_SOCKET)`));
    });

    it('objectSource: a range answered whole (200) is taken only when it is the whole object; any other answer but 206 is refused', async () => {
        const text = '0123456789'.repeat(10);
        let answer: (() => Response) | undefined;
        const { c } = answering((method, _path, init) => ((init?.headers as Record<string, string> | undefined)?.range && answer ? answer() : undefined));
        await c.createBucket('b');
        await c.putObject('b', 'k', new TextEncoder().encode(text));
        const source = (await c.objectSource('b', 'k'))!;
        const read = async (start: number, end: number) => new TextDecoder().decode(await new Response(await source.range(start, end)).arrayBuffer());
        expect(await read(10, 19)).toBe('0123456789');
        // A server that ignores the range: the whole object, which is what was asked for only as 0-99.
        answer = () => new Response(text, { status: 200 });
        expect(await read(0, 99)).toBe(text);
        expect(await refusal(read(0, 49))).toEqual([200, undefined, `b/k bytes 0-49: 200  ${text}`]);
        expect(await refusal(read(50, 99))).toEqual([200, undefined, `b/k bytes 50-99: 200  ${text}`]);
        answer = accessDenied;
        expect(await refusal(read(0, 99))).toEqual([403, 'AccessDenied', 'b/k bytes 0-99: 403 AccessDenied Access Denied']);
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

    it('without a sleep of its own, waits a real second before sending again', async () => {
        jest.useFakeTimers();
        try {
            const s3 = fakeS3({ region: 'fr-par', credentials });
            let sent = 0;
            const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => (sent++ === 0 ? new Response(null, { status: 503 }) : s3.fetchImpl(url, init))) as typeof fetch;
            const made = new S3Client({ endpoint, region: 'fr-par', credentials, fetchImpl }).createBucket('b');
            await jest.advanceTimersByTimeAsync(999);
            expect(sent).toBe(1);
            await jest.advanceTimersByTimeAsync(1);
            await made;
            expect([sent, s3.buckets.has('b')]).toEqual([2, true]);
        } finally {
            jest.useRealTimers();
        }
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
            // A refusal: its status (and its status text, when the server gives one).
            await expect(stageDownload('https://files.example/disk.qcow2', (async () => new Response('gone', { status: 404 })) as unknown as typeof fetch, { dir }))
                .rejects.toThrow(new Error('https://files.example/disk.qcow2: 404'));
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

    it('a part too big to hold in memory waits in a temporary file, read once, sent from it, and removed once sent', async () => {
        // The temporary files go where os.tmpdir() says: a directory of this test's own, looked into at each part's PUT.
        const dir = mkdtempSync(join(tmpdir(), 'asap-vps-parts-test-'));
        jest.spyOn(require('os') as typeof import('os'), 'tmpdir').mockReturnValue(dir);
        const seen = new Set<string>();
        try {
            const { s3, c } = make({ memoryPart: 512, wrap: (inner) => (async (url: string | URL | Request, init?: RequestInit) => {
                if (init?.method === 'PUT' && /partNumber=/.test(String(url))) for (const f of readdirSync(dir)) seen.add(f);
                return inner(url, init);
            }) as typeof fetch });
            await c.createBucket('b');
            const data = bytes(3 * KiB);
            const m = memory(data);
            await c.upload('b', 'disk', m.source);
            expect(Buffer.from(s3.buckets.get('b')!.get('disk')!)).toEqual(Buffer.from(data));
            const parts = s3.calls.filter((x) => x.method === 'PUT' && /partNumber=/.test(x.query));
            expect(parts.every((x) => x.payloadHash === UNSIGNED_PAYLOAD && x.duplex === 'half')).toBe(true);
            // Each part read once, into a file of its own, which is gone once the part is sent.
            expect(m.reads).toEqual(['0-1023', '1024-2047', '2048-3071']);
            expect([seen.size, readdirSync(dir)]).toEqual([3, []]);
        } finally {
            jest.restoreAllMocks();
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('an upload that fails is aborted: S3 keeps no part of it; a completion S3 answers with an error in a 200 is a failure too', async () => {
        const refusing = make({ wrap: (inner) => (async (url: string | URL | Request, init?: RequestInit) => (init?.method === 'PUT' && /partNumber=3/.test(String(url))
            ? new Response('<Error><Code>AccessDenied</Code><Message>no</Message></Error>', { status: 403 }) : inner(url, init))) as typeof fetch });
        await refusing.c.createBucket('b');
        await expect(refusing.c.upload('b', 'disk', memory(bytes(4 * KiB)).source)).rejects.toMatchObject({ status: 403, code: 'AccessDenied', message: 'upload of b/disk part 3 (memory): 403 AccessDenied no' });
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
        await expect(refusing.c.upload('missing', 'disk', memory(bytes(2 * KiB + 1)).source))
            .rejects.toMatchObject({ status: 404, code: 'NoSuchBucket', message: 'multipart upload of missing/disk: 404 NoSuchBucket NoSuchBucket & more' });
    });

    it('an object goes up with its content type: a single PUT carries it, a multipart upload gives it at its start and completes in XML', async () => {
        const { s3, c } = make();
        await c.createBucket('b');
        await c.putObject('b', 'raw', new Uint8Array([1]));
        await c.upload('b', 'default', memory(bytes(10)).source);
        await c.upload('b', 'small', memory(bytes(500)).source, 'application/x-qemu-disk');
        await onDisk(bytes(500), async (path) => {
            await c.upload('b', 'local', fileSource(path, 500), 'application/x-qemu-disk');
        });
        await c.upload('b', 'big', memory(bytes(2 * KiB + 1)).source, 'application/x-qemu-disk');
        const of = (key: string) => s3.calls.filter((x) => x.path === `/b/${key}`).map((x) => [x.method, x.query.replace(/=[0-9a-f]{24}/, '=<id>'), x.contentType]);
        expect([of('raw'), of('default'), of('small'), of('local')]).toEqual([
            [['PUT', '', 'application/octet-stream']], [['PUT', '', 'application/octet-stream']], [['PUT', '', 'application/x-qemu-disk']], [['PUT', '', 'application/x-qemu-disk']],
        ]);
        const big = of('big');
        expect([big[0], big[big.length - 1]]).toEqual([['POST', '?uploads=', 'application/x-qemu-disk'], ['POST', '?uploadId=<id>', 'application/xml']]);
        expect(big.slice(1, -1).sort()).toEqual([
            ['PUT', '?partNumber=1&uploadId=<id>', undefined], ['PUT', '?partNumber=2&uploadId=<id>', undefined], ['PUT', '?partNumber=3&uploadId=<id>', undefined],
        ]);
    });

    it('parts go up `concurrency` at a time, and once one fails no worker takes another', async () => {
        let inFlight = 0;
        let most = 0;
        /** Holds each part a turn of the event loop (the parts sent together are in flight together), and refuses part `refuse`. */
        const held = (refuse?: number) => (inner: typeof fetch) => (async (url: string | URL | Request, init?: RequestInit) => {
            const part = /partNumber=(\d+)/.exec(String(url))?.[1];
            if (init?.method !== 'PUT' || !part) return inner(url, init);
            if (Number(part) === refuse) return new Response('<Error><Code>AccessDenied</Code><Message>no</Message></Error>', { status: 403 });
            most = Math.max(most, ++inFlight);
            await new Promise((r) => setImmediate(r));
            inFlight--;
            return inner(url, init);
        }) as typeof fetch;
        const all = make({ wrap: held() });
        await all.c.createBucket('b');
        await all.c.upload('b', 'disk', memory(bytes(6 * KiB)).source);
        expect(most).toBe(2);
        const refusing = make({ wrap: held(1) });
        await refusing.c.createBucket('b');
        const m = memory(bytes(6 * KiB));
        await expect(refusing.c.upload('b', 'disk', m.source)).rejects.toMatchObject({ status: 403, code: 'AccessDenied' });
        // The part on its way when the first was refused is let finish; no other is read.
        expect(m.reads).toEqual(['0-1023', '1024-2047']);
    });

    it('a completion S3 refuses is an S3Error with its status, code and message: S3\'s XML, else its first 200 characters, else its status alone', async () => {
        let completion = () => new Response(null, { status: 200 });
        const { c } = make({ wrap: (inner) => (async (url: string | URL | Request, init?: RequestInit) => (init?.method === 'POST' && /uploadId=/.test(String(url))
            ? completion() : inner(url, init))) as typeof fetch });
        await c.createBucket('b');
        const upload = () => c.upload('b', 'disk', memory(bytes(2 * KiB + 1)).source).then(() => 'completed', (e: S3Error) => [e.status, e.code, e.message]);
        completion = () => new Response('<Error><Code>InternalError</Code><Message>try again</Message></Error>', { status: 200 });
        expect(await upload()).toEqual([500, 'InternalError', 'completion of b/disk: 200 InternalError try again']);
        completion = () => new Response('x'.repeat(300), { status: 400 });
        expect(await upload()).toEqual([400, undefined, `completion of b/disk: 400  ${'x'.repeat(200)}`]);
        completion = () => new Response(null, { status: 400 });
        expect(await upload()).toEqual([400, undefined, 'completion of b/disk: 400']);
    });

    it('the answer to an abort is let go of, whatever S3 says in it', async () => {
        let released = false;
        const { c } = make({ wrap: (inner) => (async (url: string | URL | Request, init?: RequestInit) => {
            if (init?.method === 'PUT' && /partNumber=2/.test(String(url))) return new Response('<Error><Code>AccessDenied</Code><Message>no</Message></Error>', { status: 403 });
            // An upload S3 no longer has: its abort answered 404 NoSuchUpload, with a body.
            if (init?.method === 'DELETE' && /uploadId=/.test(String(url))) return new Response(new ReadableStream({ cancel() { released = true; } }), { status: 404 });
            return inner(url, init);
        }) as typeof fetch });
        await c.createBucket('b');
        await expect(c.upload('b', 'disk', memory(bytes(2 * KiB + 1)).source)).rejects.toMatchObject({ status: 403, code: 'AccessDenied' });
        expect(released).toBe(true);
    });

    it('a part streamed from disk is closed with its PUT: one the network drops four times is the network\'s error, one S3 refuses S3\'s', async () => {
        const closed: number[] = [];
        let opened = 0;
        /** A file on disk that gives a first chunk, then nothing until its reader lets it go: whether it was let go shows. */
        const disk: ByteSource = {
            size: 500, what: 'disk.qcow2', local: true,
            range: async () => {
                const n = ++opened;
                return new ReadableStream<Uint8Array>({ start(ctl) { ctl.enqueue(new Uint8Array(100)); }, pull: () => new Promise(() => {}), cancel() { closed.push(n); } });
            },
        };
        const dropping = make({ wrap: (inner) => (async (url: string | URL | Request, init?: RequestInit) => {
            if (init?.method === 'PUT' && new URL(String(url)).pathname === '/b/disk') throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
            return inner(url, init);
        }) as typeof fetch });
        await dropping.c.createBucket('b');
        await expect(dropping.c.upload('b', 'disk', disk)).rejects.toThrow(new Error(`${endpoint} PUT /b/disk: fetch failed (ECONNRESET)`));
        await new Promise((r) => setImmediate(r));
        expect(closed).toEqual([1, 2, 3, 4]);
        const refusing = make({ wrap: (inner) => (async (url: string | URL | Request, init?: RequestInit) => (init?.method === 'PUT' && new URL(String(url)).pathname === '/b/disk'
            ? new Response('<Error><Code>AccessDenied</Code><Message>no</Message></Error>', { status: 403 }) : inner(url, init))) as typeof fetch });
        await refusing.c.createBucket('b');
        await onDisk(bytes(500), async (path) => {
            expect(await refusing.c.upload('b', 'disk', fileSource(path, 500)).then(() => 'stored', (e: S3Error) => [e.status, e.code, e.message]))
                .toEqual([403, 'AccessDenied', `upload of b/disk (${path}): 403 AccessDenied no`]);
        });
    });

    it('a PUT S3 answers without an ETag is taken as the MD5 sent; one whose ETag is another MD5 is sent again, then is BadDigest', async () => {
        const etagless = make({ wrap: (inner) => (async (url: string | URL | Request, init?: RequestInit) => {
            const r = await inner(url, init);
            return init?.method === 'PUT' ? new Response(r.body, { status: r.status }) : r;
        }) as typeof fetch });
        await etagless.c.createBucket('b');
        const small = bytes(500);
        expect(await etagless.c.upload('b', 'small', memory(small).source)).toBe(`"${md5(small)}"`);
        // Each part's ETag in the completion is the MD5 sent, which S3 checks.
        const big = bytes(3 * KiB);
        await etagless.c.upload('b', 'big', memory(big).source);
        expect(Buffer.from(etagless.s3.buckets.get('b')!.get('big')!)).toEqual(Buffer.from(big));
        const zeros = `"${'0'.repeat(32)}"`;
        const lying = make({ wrap: (inner) => (async (url: string | URL | Request, init?: RequestInit) => {
            const r = await inner(url, init);
            return init?.method === 'PUT' ? new Response(r.body, { status: r.status, headers: { etag: zeros } }) : r;
        }) as typeof fetch });
        await lying.c.createBucket('b');
        expect(await lying.c.upload('b', 'small', memory(small).source).then(() => 'stored', (e: S3Error) => [e.status, e.code, e.message]))
            .toEqual([500, 'BadDigest', `upload of b/small (memory): S3 stored other bytes (ETag ${zeros}, MD5 sent ${md5(small)})`]);
        expect(lying.s3.calls.filter((x) => x.path === '/b/small').length).toBe(4);
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
        await expect(fickle.range(0, 99)).rejects.toMatchObject({ status: 502, code: 'RangeRefused', message: 'https://files.example/disk.qcow2: bytes 0-99: 200' });
        const busy = (await urlSource('https://files.example/disk.qcow2', server({ ranges: true, rangeStatus: 503 })))!;
        await expect(busy.range(0, 99)).rejects.toMatchObject({ status: 503 });
        const failing = (await urlSource('https://files.example/disk.qcow2', server({ ranges: true, rangeStatus: 500 })))!;
        await expect(failing.range(0, 99)).rejects.toMatchObject({ status: 500, code: 'RangeRefused' });
        // One that answers a range with no body at all: the same refusal.
        const bodiless = (await urlSource('https://files.example/disk.qcow2', (async (_url: string | URL | Request, init?: RequestInit) => (init?.method === 'HEAD'
            ? new Response(null, { status: 200, headers: { 'content-length': '3000', 'accept-ranges': 'bytes' } }) : new Response(null, { status: 416 }))) as unknown as typeof fetch))!;
        const e = await bodiless.range(0, 99).catch((x) => x);
        expect([e instanceof S3Error, e.status, e.code, e.message]).toEqual([true, 502, 'RangeRefused', 'https://files.example/disk.qcow2: bytes 0-99: 416']);
    });
});
