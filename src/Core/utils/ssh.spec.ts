// SSH key formats, in-process: what SSHService generates and how every
// initializer reads and fingerprints a provider's keys, checked against ssh-keygen
// where it is installed.

import { execFileSync } from 'child_process';
import { createPrivateKey, createPublicKey, generateKeyPairSync } from 'crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { testPublicKey } from '../../testing/fakes/util';
import { createSSHKeyPair, findSSHKey, parseSSHPublicKey, sshKeyFingerprint, toOpenSSHPublicKey } from './ssh';

/** What ssh-keygen prints for `args` over `files` (written to a temp dir, mode 0600); null where it is not installed. */
function keygen(files: Record<string, string>, args: (dir: string) => string[]): string | null {
    const dir = mkdtempSync(join(tmpdir(), 'asap-vps-key-'));
    try {
        for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text, { mode: 0o600 });
        return execFileSync('ssh-keygen', args(dir), { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
    } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw e;
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

describe('SSH keys', () => {
    it('parses a key line and fingerprints it as ssh-keygen does: SHA256, and the MD5 form DigitalOcean shows', () => {
        const line = testPublicKey('me@host');
        expect(parseSSHPublicKey(line)).toMatchObject({ type: 'ssh-ed25519', comment: 'me@host' });
        expect(() => parseSSHPublicKey('not a key')).toThrow(/not an OpenSSH public key/);
        expect(sshKeyFingerprint(line)).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
        expect(sshKeyFingerprint(line, 'md5')).toMatch(/^([0-9a-f]{2}:){15}[0-9a-f]{2}$/);
        const sha = keygen({ 'k.pub': `${line}\n` }, (d) => ['-lf', join(d, 'k.pub')]);
        const md5 = keygen({ 'k.pub': `${line}\n` }, (d) => ['-E', 'md5', '-lf', join(d, 'k.pub')]);
        if (sha === null || md5 === null) return; // no ssh-keygen here: the formats above still hold
        expect(sha.split(' ')[1]).toBe(sshKeyFingerprint(line));
        expect(md5.split(' ')[1]).toBe(`MD5:${sshKeyFingerprint(line, 'md5')}`);
    });

    it('makes the RSA pair SSHService has always made (ssh-keygen -m PEM -t rsa -b 2048), in-process', async () => {
        const { publicKey, privateKey } = await createSSHKeyPair('me@host');
        expect(privateKey).toMatch(/^-----BEGIN RSA PRIVATE KEY-----\n[\s\S]+\n-----END RSA PRIVATE KEY-----\n?$/);
        expect(createPrivateKey(privateKey).asymmetricKeyDetails?.modulusLength).toBe(2048);
        expect(parseSSHPublicKey(publicKey)).toMatchObject({ type: 'ssh-rsa', comment: 'me@host' });
        // The line is the private key's own public key.
        expect(toOpenSSHPublicKey(createPublicKey(privateKey), 'me@host')).toBe(publicKey);
        // And ssh-keygen derives the same line from the private key.
        const derived = keygen({ id: privateKey }, (d) => ['-y', '-f', join(d, 'id')]);
        if (derived !== null) expect(derived.trim().split(' ').slice(0, 2)).toEqual(publicKey.split(' ').slice(0, 2));
        // Every pair is new.
        expect((await createSSHKeyPair()).publicKey).not.toBe(publicKey);
    });

    it('writes an Ed25519 line as OpenSSH does, and refuses a key type it has no line for', () => {
        const line = toOpenSSHPublicKey(generateKeyPairSync('ed25519').publicKey);
        expect(parseSSHPublicKey(line)).toMatchObject({ type: 'ssh-ed25519', comment: '' });
        // string "ssh-ed25519", then string(the 32-byte key).
        expect(Buffer.from(parseSSHPublicKey(line).blob, 'base64')).toHaveLength(4 + 11 + 4 + 32);
        expect(() => toOpenSSHPublicKey(generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey)).toThrow(/no OpenSSH public key form/);
    });

    it('finds an account\'s registration of a key by fingerprint, whatever its name or comment', () => {
        const line = testPublicKey('laptop');
        const keys = [{ id: 1, fingerprint: sshKeyFingerprint(testPublicKey()) }, { id: 2, fingerprint: sshKeyFingerprint(line) }];
        expect(findSSHKey(keys, line.replace('laptop', 'renamed'))?.id).toBe(2);
        expect(findSSHKey(keys, testPublicKey())).toBeUndefined();
    });
});
