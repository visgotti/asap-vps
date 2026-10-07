// SSH key formats, in-process: what SSHService generates and how every
// provider's keys are read and fingerprinted. Held by answers recorded from
// ssh-keygen and by the wire format itself, so the suite proves them without
// ssh-keygen; where it is installed, it is asked too.

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

/**
 * Public keys and what ssh-keygen (OpenSSH 9.6) says of each, recorded: its
 * key line (`ssh-keygen -i -m PKCS8`; the Ed25519 one is ssh-keygen's own key)
 * and its fingerprints (`-lf`, `-E md5 -lf`). The RSA modulus has its top bit
 * set, as every 2048-bit one has: its mpint is led by a zero byte.
 */
const RECORDED = [
    {
        type: 'ssh-rsa',
        spki: [
            '-----BEGIN PUBLIC KEY-----',
            'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAy0uLIZhLtJVxWbDmwxRx',
            'FgdGzSh5dub7aZUoD0L5Tm30SXsyCZtbohuutNfBlT2bg5Fryuf6bZlAg8SN8nDt',
            'wW7BT3bRtrNnyM9/Z+VdyQoX2EkrJjtIgb6bjWCwu3XNINAwB4g96u608wLNxvx6',
            'r6Q3drEjsKAifAED1hqvZ/pySJS3nmvHLb920Pq++vGCAHUFEiYrbysNHhXkn7jt',
            'iX49je/LgWMOxcv9KrM9Skm/24sx3JhWpW5gnWrhV9TAqH9Ra5h2AqfJdNA8pQRq',
            'b7c/hw/wmYHL5eMa2gY0IzvVnWtQaGZ/2yISnWYNo49yAW0epHz0jify2sPKgYmd',
            'qwIDAQAB',
            '-----END PUBLIC KEY-----',
        ].join('\n'),
        line: 'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQDLS4shmEu0lXFZsObDFHEWB0bNKHl25vtplSgPQvlObfRJezIJm1uiG66018GVPZuDkWvK5/ptmUCDxI3ycO3BbsFPdtG2s2fIz39n5V3JChfYSSsmO0iBvpuNYLC7dc0g0DAHiD3q7rTzAs3G/HqvpDd2sSOwoCJ8AQPWGq9n+nJIlLeea8ctv3bQ+r768YIAdQUSJitvKw0eFeSfuO2Jfj2N78uBYw7Fy/0qsz1KSb/bizHcmFalbmCdauFX1MCof1FrmHYCp8l00DylBGpvtz+HD/CZgcvl4xraBjQjO9Wda1BoZn/bIhKdZg2jj3IBbR6kfPSOJ/Law8qBiZ2r',
        sha256: 'SHA256:rvamp22GSwtrULePfV7/r1eYqVUe38GDjfLY1dvSKZM',
        md5: '32:36:6f:a6:3f:44:19:e7:5f:42:5a:1f:1f:4f:67:c1',
    },
    {
        type: 'ssh-ed25519',
        spki: ['-----BEGIN PUBLIC KEY-----', 'MCowBQYDK2VwAyEA8Q/ClC9WMgyTaRimFdsAaGKIw53d7OpK4Ch2K7ULoSo=', '-----END PUBLIC KEY-----'].join('\n'),
        line: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPEPwpQvVjIMk2kYphXbAGhiiMOd3ezqSuAodiu1C6Eq',
        sha256: 'SHA256:RwFhXYP0Izk5bjP4Tmcsp4o/mryr8SkNFyKzssPmnQI',
        md5: 'c2:87:fd:ae:4b:22:b7:e0:97:c4:e4:af:87:b0:75:ba',
    },
];

/** The fields of an SSH wire blob (RFC 4251 strings: a uint32 length, then the bytes), in hex. */
function wireFields(blob: Buffer): string[] {
    const fields: string[] = [];
    for (let at = 0; at < blob.length;) {
        const length = blob.readUInt32BE(at);
        fields.push(blob.subarray(at + 4, at + 4 + length).toString('hex'));
        at += 4 + length;
    }
    return fields;
}

describe('SSH keys', () => {
    it('writes a public key\'s line, and fingerprints it, as ssh-keygen does: its recorded answers, with no ssh-keygen here', () => {
        for (const k of RECORDED) {
            expect([k.type, toOpenSSHPublicKey(createPublicKey(k.spki))]).toEqual([k.type, k.line]);
            expect([k.type, sshKeyFingerprint(k.line)]).toEqual([k.type, k.sha256]);
            expect([k.type, sshKeyFingerprint(k.line, 'md5')]).toEqual([k.type, k.md5]);
            expect(parseSSHPublicKey(`${k.line} me@host`)).toMatchObject({ type: k.type, comment: 'me@host' });
        }
    });

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
        // On the wire: the type, then the key's own exponent and modulus as mpints (the modulus led by a zero byte: its top bit is set).
        const modulus = Buffer.from(createPublicKey(privateKey).export({ format: 'jwk' }).n as string, 'base64url');
        expect(modulus[0] & 0x80).toBe(0x80);
        expect(wireFields(Buffer.from(publicKey.split(' ')[1], 'base64'))).toEqual([Buffer.from('ssh-rsa').toString('hex'), '010001', `00${modulus.toString('hex')}`]);
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
