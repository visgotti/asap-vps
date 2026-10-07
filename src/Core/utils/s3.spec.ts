// The S3 client: SigV4 against AWS's own worked examples (S3 API reference,
// "Signature Calculations for the Authorization Header: Transferring Payload
// in a Single Chunk"), and each call against a fake S3 that checks the
// signature of every request it is sent.

import { createHash } from 'crypto';
import { fakeS3 } from '../../testing/fakes/s3';
import { EMPTY_SHA256, S3Client, S3Error, signS3, UNSIGNED_PAYLOAD } from './s3';

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
        expect(await c.headObject('asap-vps-images', 'a/two.qcow2')).toEqual({ key: 'a/two.qcow2', size: 1000, etag: '"abc"' });
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
