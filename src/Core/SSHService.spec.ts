// SSHService's keys (generated in-process: on disk only when asked) and its two
// ways to connect: positional (root on port 22) and options (any endpoint).

import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'fs';
import { NodeSSH } from 'node-ssh';
import { tmpdir } from 'os';
import { join } from 'path';
import { SSHService } from './SSHService';
import { decrypt, parseSSHPublicKey } from './utils';

describe('SSHService keys', () => {
    let dir: string;
    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'asap-vps-ssh-'));
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it('makes an RSA pair in memory: nothing is written unless asked', async () => {
        const keys = await SSHService.createKeys(join(dir, 'keys'), 'x');
        expect(keys.privateKey).toMatch(/^-----BEGIN RSA PRIVATE KEY-----/);
        expect(parseSSHPublicKey(keys.publicKey).type).toBe('ssh-rsa');
        expect(existsSync(join(dir, 'keys'))).toBe(false);
    });

    it('with deleteAfter false writes id_rsa_<id> (0600) and its .pub, as ssh-keygen did, and never over a key', async () => {
        const keys = await SSHService.createKeys(dir, 'ssh', false);
        const key = join(dir, 'id_rsa_ssh');
        expect(readFileSync(key, 'utf8')).toBe(keys.privateKey);
        expect(readFileSync(`${key}.pub`, 'utf8')).toBe(`${keys.publicKey}\n`);
        expect(statSync(key).mode & 0o777).toBe(0o600);
        await expect(SSHService.createKeys(dir, 'ssh', false)).rejects.toThrow(/already exists/);
        expect(readFileSync(key, 'utf8')).toBe(keys.privateKey);
        expect(await SSHService.generateSSHKeyPair(dir, 'g')).toBe(join(dir, 'id_rsa_g'));
        expect(existsSync(join(dir, 'id_rsa_g.pub'))).toBe(true);
    });

    it('initKeys encrypts the private key when given a key to encrypt it with', async () => {
        const data = await SSHService.initKeys({ id: 7, encryptionKey: 'secret', username: 'deploy' });
        expect(data).toMatchObject({ id: 7, isEncrypted: true, username: 'deploy' });
        expect(decrypt(data.privateKey, 'secret')).toMatch(/^-----BEGIN RSA PRIVATE KEY-----/);
    });
});

describe('SSHService.connect', () => {
    let connect: jest.SpyInstance;
    beforeEach(() => {
        connect = jest.spyOn(NodeSSH.prototype, 'connect').mockImplementation(async function (this: NodeSSH) {
            return this;
        });
        jest.spyOn(console, 'error').mockImplementation(() => {});
    });
    afterEach(() => jest.restoreAllMocks());

    it('the options form reaches any login on any port: a server\'s ssh endpoint spreads straight in', async () => {
        const endpoint = { host: '203.0.113.7', port: 40022, username: 'ubuntu' };
        expect(await SSHService.connect({ ...endpoint, privateKey: 'PEM' })).toBeInstanceOf(NodeSSH);
        expect(connect).toHaveBeenCalledWith(expect.objectContaining({ ...endpoint, privateKey: 'PEM' }));
    });

    it('defaults to root on port 22, as the positional form always logs in', async () => {
        await SSHService.connect({ host: 'h1', privateKey: 'PEM' });
        await SSHService.connect('h2', 'PEM');
        expect(connect.mock.calls.map(([c]) => [c.host, c.port, c.username, c.privateKey])).toEqual([['h1', 22, 'root', 'PEM'], ['h2', 22, 'root', 'PEM']]);
    });

    it('dispose() closes the connection, whichever form opened it (an open one keeps the process alive)', async () => {
        const closed: string[] = [];
        const { EventEmitter } = await import('events');
        connect.mockImplementation(async function (this: NodeSSH, c: { host: string }) {
            this.connection = Object.assign(new EventEmitter(), { end: () => closed.push(c.host) }) as unknown as NodeSSH['connection'];
            return this;
        });
        (await SSHService.connect({ host: 'h1', privateKey: 'PEM' })).dispose();
        await (await SSHService.connect('h2', 'PEM')).dispose();
        expect(closed).toEqual(['h1', 'h2']);
    });

    it('a connection that drops once it is up ends the session, whichever form opened it: never an uncaught error that ends the process', async () => {
        const { EventEmitter } = await import('events');
        const connections: Array<InstanceType<typeof EventEmitter> & { ended: number }> = [];
        connect.mockImplementation(async function (this: NodeSSH) {
            // As node-ssh leaves it once it is ready: no listener for its errors.
            const c = Object.assign(new EventEmitter(), { ended: 0, end() { c.ended++; } });
            connections.push(c);
            this.connection = c as unknown as NodeSSH['connection'];
            return this;
        });
        const sessions = [await SSHService.connect({ host: 'h1', privateKey: 'PEM' }), await SSHService.connect('h2', 'PEM')];
        for (const [i, ssh] of sessions.entries()) {
            const c = connections[i];
            expect(() => c.emit('error', Object.assign(new Error('read ETIMEDOUT'), { code: 'ETIMEDOUT' }))).not.toThrow();
            expect(c.ended).toBe(1);
            expect(ssh.isConnected()).toBe(false);
            // Once more, after it was ended: still nothing thrown, nothing ended twice.
            expect(() => c.emit('error', new Error('read ECONNRESET'))).not.toThrow();
            expect(c.ended).toBe(1);
        }
        expect(console.error).toHaveBeenCalledWith('[SSHService] The connection to h1 dropped: read ETIMEDOUT');
    });

    it('decrypts a stored key, and tries as often as asked before it gives up', async () => {
        const { privateKey } = await SSHService.initKeys({ encryptionKey: 'secret' });
        connect.mockRejectedValueOnce(new Error('refused')).mockRejectedValueOnce(new Error('refused'));
        await SSHService.connect({ host: 'h', privateKey, decryptionKey: 'secret', retry: { maxRetries: 3, retryTimeout: 0 } });
        expect(connect).toHaveBeenCalledTimes(3);
        expect(connect.mock.calls[2][0].privateKey).toMatch(/^-----BEGIN RSA PRIVATE KEY-----/);

        connect.mockReset().mockRejectedValue(new Error('refused'));
        await expect(SSHService.connect({ host: 'h', privateKey: 'PEM', retry: { maxRetries: 2, retryTimeout: 0 } })).rejects.toThrow(/refused/);
        expect(connect).toHaveBeenCalledTimes(2);
    });
});
