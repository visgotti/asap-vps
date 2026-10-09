// SSH keys in OpenSSH's formats, in-process (no ssh-keygen): what SSHService
// generates, and how every initializer reads and fingerprints the keys a
// provider holds.

import { createHash, generateKeyPair, KeyObject } from 'crypto';
import { promisify } from 'util';
import { NotFoundError } from '../../errors';
import type { InitializedSSHKeyData, SSHKeyData } from '../../types';

export type ParsedSSHPublicKey = { type: string, blob: string, comment: string };

/**
 * `<type> <base64 blob> [comment]`, the authorized_keys line format. Types
 * include OpenSSH's certificate and security-key names
 * (`ssh-ed25519-cert-v01@openssh.com`, `sk-ssh-ed25519@openssh.com`).
 */
export function parseSSHPublicKey(line: string): ParsedSSHPublicKey {
    const m = /^(ssh-[a-z0-9@.-]+|ecdsa-sha2-[a-z0-9@.-]+|sk-[a-z0-9@.-]+)\s+([A-Za-z0-9+/]+=*)(?:\s+(.*))?$/.exec(line.trim());
    if (!m) throw new Error('not an OpenSSH public key line');
    return { type: m[1], blob: m[2], comment: (m[3] ?? '').trim() };
}

/**
 * The key's fingerprint as ssh-keygen prints it: `SHA256:...` (`ssh-keygen -lf`,
 * the form asap-vps reports), or with 'md5' the colon-separated hex that
 * DigitalOcean shows (`ssh-keygen -E md5 -lf`, without its `MD5:` prefix).
 */
export function sshKeyFingerprint(line: string, hash: 'sha256' | 'md5' = 'sha256'): string {
    const blob = Buffer.from(parseSSHPublicKey(line).blob, 'base64');
    if (hash === 'md5') return createHash('md5').update(blob).digest('hex').replace(/(..)(?!$)/g, '$1:');
    return `SHA256:${createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}`;
}

/** The entry in `keys` that holds the same key as `publicKey` (by fingerprint, whatever its name). */
export function findSSHKey<K extends { fingerprint?: string }>(keys: K[], publicKey: string): K | undefined {
    const fingerprint = sshKeyFingerprint(publicKey);
    return keys.find((k) => k.fingerprint === fingerprint);
}

/**
 * Whether `ref` names `key`: its id, its name, its fingerprint (SHA256, or the
 * MD5 one DigitalOcean shows), or its public key line, whatever its comment.
 */
export function sshKeyMatches(key: InitializedSSHKeyData, ref: string | number): boolean {
    const r = String(ref).trim();
    if (String(key.id) === r || key.name === r || (!!key.fingerprint && key.fingerprint === r)) return true;
    try {
        if (sshKeyFingerprint(key.publicKey, 'md5') === r) return true;
        return /\s/.test(r) && sshKeyFingerprint(key.publicKey) === sshKeyFingerprint(r);
    } catch {
        // A key or a reference this parser does not read names nothing more.
        return false;
    }
}

/**
 * The account keys `refs` name (sshKeyMatches), in their order: a reference
 * the account does not hold is a NotFoundError, so nothing is created that
 * nobody can log in to.
 */
export function pickSSHKeys(keys: InitializedSSHKeyData[], refs: Array<string | number>, provider: string): InitializedSSHKeyData[] {
    return refs.map((ref) => {
        const k = keys.find((x) => sshKeyMatches(x, ref));
        if (!k) throw new NotFoundError(provider, `no SSH key "${ref}" on the account (addSSHKey adds one)`);
        return k;
    });
}

/** A public key as an authorized_keys line: `ssh-rsa AAAA... comment` (RSA or Ed25519). */
export function toOpenSSHPublicKey(key: KeyObject, comment = ''): string {
    const jwk = key.export({ format: 'jwk' });
    const b64url = (s?: string) => Buffer.from(s ?? '', 'base64url');
    let type: string;
    let fields: Buffer[];
    if (jwk.kty === 'RSA') {
        type = 'ssh-rsa';
        fields = [mpint(b64url(jwk.e)), mpint(b64url(jwk.n))];
    } else if (jwk.kty === 'OKP' && jwk.crv === 'Ed25519') {
        type = 'ssh-ed25519';
        fields = [b64url(jwk.x)];
    } else {
        throw new Error(`no OpenSSH public key form for a ${jwk.kty}${jwk.crv ? ` ${jwk.crv}` : ''} key`);
    }
    const blob = Buffer.concat([Buffer.from(type), ...fields].map(sshString));
    return `${type} ${blob.toString('base64')}${comment ? ` ${comment}` : ''}`;
}

/**
 * A new key pair: an RSA 2048 private key in PEM (PKCS#1, what
 * `ssh-keygen -m PEM -t rsa -b 2048` writes, read by ssh, node-ssh and every
 * provider) and its authorized_keys line.
 */
export async function createSSHKeyPair(comment = ''): Promise<SSHKeyData> {
    const { publicKey, privateKey } = await promisify(generateKeyPair)('rsa', { modulusLength: 2048 });
    return {
        publicKey: toOpenSSHPublicKey(publicKey, comment),
        privateKey: privateKey.export({ type: 'pkcs1', format: 'pem' }) as string,
    };
}

/** RFC 4251 string: a uint32 length, then the bytes. */
function sshString(b: Buffer): Buffer {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(b.length);
    return Buffer.concat([length, b]);
}

/** RFC 4251 mpint of a non-negative big-endian integer: no leading zeros, but a 0 byte where the top bit is set. */
function mpint(b: Buffer): Buffer {
    let i = 0;
    while (i < b.length - 1 && b[i] === 0) i++;
    const v = b.subarray(i);
    return v[0] & 0x80 ? Buffer.concat([Buffer.from([0]), v]) : v;
}
