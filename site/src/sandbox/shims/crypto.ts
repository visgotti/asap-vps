// node:crypto for the sandbox: the hashes, HMAC and randomness the library and its fakes use, synchronously, from @noble/hashes and Web Crypto.
// Key generation and ciphers are not here (they need Node), and say so.

import { Buffer } from 'buffer';
import { hmac } from '@noble/hashes/hmac.js';
import { md5, sha1 } from '@noble/hashes/legacy.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { NotInSandbox, unavailable } from './unavailable';

type Data = string | Uint8Array;
type Encoding = 'hex' | 'base64' | 'base64url' | 'latin1' | 'utf8';

const HASHES = { sha256, md5, sha1 } as const;
const bytes = (d: Data, enc?: string): Uint8Array => (typeof d === 'string' ? Buffer.from(d, enc as BufferEncoding | undefined) : d);
const out = (digest: Uint8Array, enc?: Encoding): Buffer | string => {
    const b = Buffer.from(digest);
    return enc ? b.toString(enc) : b;
};
function hashOf(algorithm: string) {
    const h = HASHES[algorithm.toLowerCase() as keyof typeof HASHES];
    if (!h) throw new NotInSandbox(`the ${algorithm} hash`);
    return h;
}

class Hash {
    private chunks: Uint8Array[] = [];
    constructor(private readonly algorithm: string, private readonly key?: Data) {
        hashOf(algorithm);
    }
    update(data: Data, enc?: string): this {
        this.chunks.push(bytes(data, enc));
        return this;
    }
    digest(): Buffer;
    digest(enc: Encoding): string;
    digest(enc?: Encoding): Buffer | string {
        const all = Buffer.concat(this.chunks);
        const h = hashOf(this.algorithm);
        return out(this.key === undefined ? h(all) : hmac(h, bytes(this.key), all), enc);
    }
}

export const createHash = (algorithm: string) => new Hash(algorithm);
export const createHmac = (algorithm: string, key: Data) => new Hash(algorithm, key);
export const randomBytes = (n: number): Buffer => Buffer.from(globalThis.crypto.getRandomValues(new Uint8Array(n)));
export const randomUUID = (): string => globalThis.crypto.randomUUID();

export class KeyObject {}
export const generateKeyPair = unavailable('crypto.generateKeyPair');
export const generateKeyPairSync = unavailable('crypto.generateKeyPairSync');
export const createPublicKey = unavailable('crypto.createPublicKey');
export const createPrivateKey = unavailable('crypto.createPrivateKey');
export const createCipheriv = unavailable('crypto.createCipheriv');
export const createDecipheriv = unavailable('crypto.createDecipheriv');
