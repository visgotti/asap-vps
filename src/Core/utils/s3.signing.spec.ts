// SigV4's canonical request, rule by rule (S3 API reference, "Signature
// Calculations for the Authorization Header: Transferring Payload in a Single
// Chunk": the canonical URI, query string and headers). Each case writes its
// canonical request out by hand and signs it here by the reference's steps;
// that signing is itself held to the reference's worked examples, whose
// canonical requests AWS prints. Nothing here is checked against signS3's own
// reading of a request: the fake S3 of s3.spec.ts recomputes each signature
// with signS3, which shows a request is signed as it was sent, not that its
// canonical form is the one S3 makes.

import { createHash, createHmac } from 'crypto';
import { EMPTY_SHA256, signS3 } from './s3';

const AWS = { accessKey: 'AKIAIOSFODNN7EXAMPLE', secretKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' };
const NOW = new Date('2013-05-24T00:00:00Z');
const HOST = 'examplebucket.s3.amazonaws.com';

/** The signature of a canonical request, by the reference's steps: the string to sign, the signing key, their HMAC. */
function signatureOf(canonicalRequest: string): string {
    const hmac = (key: Buffer | string, data: string) => createHmac('sha256', key).update(data).digest();
    const toSign = ['AWS4-HMAC-SHA256', '20130524T000000Z', '20130524/us-east-1/s3/aws4_request', createHash('sha256').update(canonicalRequest).digest('hex')].join('\n');
    const key = hmac(hmac(hmac(hmac(`AWS4${AWS.secretKey}`, '20130524'), 'us-east-1'), 's3'), 'aws4_request');
    return createHmac('sha256', key).update(toSign).digest('hex');
}

/** A canonical GET with no body and only the headers every request signs: its URI and query string exactly as written. */
const canonicalGet = (uri: string, query: string) => [
    'GET', uri, query,
    `host:${HOST}`, `x-amz-content-sha256:${EMPTY_SHA256}`, 'x-amz-date:20130524T000000Z', '',
    'host;x-amz-content-sha256;x-amz-date', EMPTY_SHA256,
].join('\n');

/** What signS3 signs a GET of `pathAndQuery` with. */
const signed = (pathAndQuery: string, headers?: Record<string, string>) => /Signature=([0-9a-f]{64})$/.exec(
    signS3({ method: 'GET', url: new URL(`https://${HOST}${pathAndQuery}`), headers, payloadHash: EMPTY_SHA256, region: 'us-east-1', credentials: AWS, now: NOW }).authorization)?.[1];

describe('signS3: the canonical request S3 makes of a request', () => {
    it('the signing done here is the reference\'s: the canonical requests AWS prints for its examples give the signatures it prints', () => {
        // GET Object, with a Range header.
        expect(signatureOf([
            'GET', '/test.txt', '',
            `host:${HOST}`, 'range:bytes=0-9', `x-amz-content-sha256:${EMPTY_SHA256}`, 'x-amz-date:20130524T000000Z', '',
            'host;range;x-amz-content-sha256;x-amz-date', EMPTY_SHA256,
        ].join('\n'))).toBe('f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
        // GET Bucket lifecycle, and GET Bucket (list objects).
        expect(signatureOf(canonicalGet('/', 'lifecycle='))).toBe('fea454ca298b7da1c68078a5d1bdbfbbe0d65c699e0f91ac7a200a0136783543');
        expect(signatureOf(canonicalGet('/', 'max-keys=2&prefix=J'))).toBe('34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7');
    });

    it('the URI: each segment of the key percent-encoded once, every byte but A-Z a-z 0-9 - . _ ~, with the slashes between them kept', () => {
        const uri = '/photos/%C3%A9t%C3%A9%202013/a%2Bb%20%281%29~x_y-z.jpg';
        // A URL as typed, and the same one already encoded (as S3Client builds it): one canonical URI, never encoded twice.
        expect(signed('/photos/été 2013/a+b (1)~x_y-z.jpg')).toBe(signatureOf(canonicalGet(uri, '')));
        expect(signed(uri)).toBe(signatureOf(canonicalGet(uri, '')));
        // The characters encodeURIComponent leaves alone and SigV4 does not, and a percent sign of the key's own.
        expect(signed('/it\'s!*$&,;=:@.txt')).toBe(signatureOf(canonicalGet('/it%27s%21%2A%24%26%2C%3B%3D%3A%40.txt', '')));
        expect(signed('/100%25.txt')).toBe(signatureOf(canonicalGet('/100%25.txt', '')));
    });

    it('the query string: names and values percent-encoded, in the order of the names whatever order the URL has them in, a name without a value as `name=`', () => {
        // AWS's own list example with its parameters the other way round: the signature AWS prints.
        expect(signed('/?prefix=J&max-keys=2')).toBe('34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7');
        expect(signed('/?prefix=a/b c&marker=x%3Dy~z&n%20m=1&delimiter=/&max-keys=2'))
            .toBe(signatureOf(canonicalGet('/', 'delimiter=%2F&marker=x%3Dy~z&max-keys=2&n%20m=1&prefix=a%2Fb%20c')));
        // A continuation token is base64 (here `1ue/Gc+x/w==`): its +, / and = are bytes of the value.
        expect(signed('/?list-type=2&continuation-token=1ue%2FGc%2Bx%2Fw%3D%3D'))
            .toBe(signatureOf(canonicalGet('/', 'continuation-token=1ue%2FGc%2Bx%2Fw%3D%3D&list-type=2')));
        expect(signed('/key?uploads')).toBe(signatureOf(canonicalGet('/key', 'uploads=')));
    });

    it('the headers: names in lower case and in order, each value trimmed with its runs of spaces as one', () => {
        expect(signed('/test.txt', { 'X-Amz-Meta-Note': '  two   words ', Range: 'bytes=0-9' })).toBe(signatureOf([
            'GET', '/test.txt', '',
            `host:${HOST}`, 'range:bytes=0-9', `x-amz-content-sha256:${EMPTY_SHA256}`, 'x-amz-date:20130524T000000Z', 'x-amz-meta-note:two words', '',
            'host;range;x-amz-content-sha256;x-amz-date;x-amz-meta-note', EMPTY_SHA256,
        ].join('\n')));
    });
});
