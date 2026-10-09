// SSHService's keys (generated in-process: on disk only when asked), its two
// ways to connect: positional (root on port 22, with a key or a stored key
// entity) and options (any endpoint), and its helpers on an open session.

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'fs';
import { NodeSSH } from 'node-ssh';
import { tmpdir } from 'os';
import { join } from 'path';
import type { EncryptedSSHData, UnencryptedSSHData } from '../types';
import { SSHService } from './SSHService';
import { decrypt, encrypt, parseSSHPublicKey } from './utils';

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

    it('initKeys without one keeps the key as it is; an id of 0 is an id; nothing asked is nothing added', async () => {
        const zero = await SSHService.initKeys({ id: 0 });
        expect(zero).toMatchObject({ id: 0, isEncrypted: false });
        expect(zero.privateKey).toMatch(/^-----BEGIN RSA PRIVATE KEY-----/);
        expect(Object.keys(await SSHService.initKeys()).sort()).toEqual(['isEncrypted', 'privateKey', 'publicKey']);
    });

    it('written to disk with no id, the pair is named by a random one', async () => {
        await SSHService.createKeys(dir, undefined, false);
        const names = readdirSync(dir).sort();
        expect(names).toHaveLength(2);
        expect(names[0]).toMatch(/^id_rsa_[A-Za-z0-9]{10}$/);
        expect(names[1]).toBe(`${names[0]}.pub`);
    });

    it('a service made with a directory keeps its keys there; one made without uses a temporary one', () => {
        expect(new SSHService('/keys')).toMatchObject({ sshPath: '/keys', useTempSSHDirectory: false });
        expect(new SSHService()).toMatchObject({ useTempSSHDirectory: true });
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

    it('a late error from a connection the session has since replaced leaves the new connection up', async () => {
        const { EventEmitter } = await import('events');
        const connections: Array<InstanceType<typeof EventEmitter> & { ended: number }> = [];
        connect.mockImplementation(async function (this: NodeSSH) {
            const c = Object.assign(new EventEmitter(), { ended: 0, end() { c.ended++; } });
            connections.push(c);
            this.connection = c as unknown as NodeSSH['connection'];
            return this;
        });
        const ssh = await SSHService.connect({ host: 'h1', privateKey: 'PEM' });
        // The caller reconnects the same client: node-ssh's own connect replaces the first connection.
        await ssh.connect({ host: 'h1', username: 'root', privateKey: 'PEM' });
        connections[0].emit('error', new Error('read ECONNRESET'));
        expect(connections.map((c) => c.ended)).toEqual([0, 0]);
        expect(ssh.isConnected()).toBe(true);
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
        expect(console.error).toHaveBeenCalledWith('[SSHService] Failed to connect to h after 2 retries:', 'refused');
    });
});

describe('SSHService.connect with a key or a stored key entity (positional: root on port 22)', () => {
    let connect: jest.SpyInstance;
    beforeEach(() => {
        connect = jest.spyOn(NodeSSH.prototype, 'connect').mockImplementation(async function (this: NodeSSH) {
            return this;
        });
        jest.spyOn(console, 'error').mockImplementation(() => {});
    });
    afterEach(() => jest.restoreAllMocks());
    const keysUsed = () => connect.mock.calls.map(([c]) => c.privateKey);
    const entity = (publicKey: string, privateKey: string, isEncrypted?: boolean) => ({ publicKey, privateKey, ...(isEncrypted === undefined ? {} : { isEncrypted }) });

    it('refuses before it dials: no key, an entity without its private key, an encrypted one without the key to decrypt it', async () => {
        await expect(SSHService.connect('h', undefined as unknown as string)).rejects.toThrow('No private key given to connect to h');
        await expect(SSHService.connect('h', entity('ssh-rsa AAAA', '') as UnencryptedSSHData)).rejects.toThrow(/^There is no private key on the ssh entity/);
        await expect(SSHService.connect('h', entity('ssh-rsa AAAA', 'x', true) as EncryptedSSHData, undefined as unknown as string))
            .rejects.toThrow('SSH Entity is encrypted but no decryption key was provided');
        expect(connect).not.toHaveBeenCalled();
    });

    it('decrypts an entity marked encrypted, or one that does not say, when given the key; uses one marked plain as it is; and a bare key likewise', async () => {
        const sealed = encrypt('PEM', 'secret');
        await SSHService.connect('h1', entity('a', sealed, true) as EncryptedSSHData, 'secret');
        await SSHService.connect('h2', entity('b', sealed) as EncryptedSSHData, 'secret');
        await SSHService.connect('h3', entity('c', 'PEM', false) as unknown as EncryptedSSHData, 'secret');
        await SSHService.connect('h4', sealed, 'secret');
        await SSHService.connect('h5', 'PEM');
        expect(keysUsed()).toEqual(['PEM', 'PEM', 'PEM', 'PEM', 'PEM']);
        expect(connect.mock.calls.map(([c]) => [c.host, c.port, c.username])).toEqual(['h1', 'h2', 'h3', 'h4', 'h5'].map((h) => [h, 22, 'root']));
    });

    it('offers keyboard-interactive and answers its prompt with nothing: the key is the only way in', async () => {
        await SSHService.connect('h', 'PEM');
        expect(connect.mock.calls[0][0].tryKeyboard).toBe(true);
        const finish = jest.fn();
        connect.mock.calls[0][0].onKeyboardInteractive('', '', '', [{ prompt: 'Password: ', echo: false }], finish);
        expect(finish).toHaveBeenCalledWith([]);
    });

    it('tries as often as it is told before it gives up, saying so', async () => {
        connect.mockRejectedValue(new Error('refused'));
        await expect(SSHService.connect('h', 'PEM', undefined, { maxRetries: 2, retryTimeout: 0 })).rejects.toThrow('refused');
        expect(connect).toHaveBeenCalledTimes(2);
        expect(console.error).toHaveBeenCalledWith('[SSHService] Failed to connect to h after 2 retries:', 'refused');
    });

    it('sessions opened with entities close with dispose(), each once (a second dispose does nothing); a failed one leaves the entity free to connect again', async () => {
        const s = new SSHService();
        const once = { maxRetries: 1, retryTimeout: 0 };
        const [a, b] = [entity('ssh-rsa A', 'PEM-A', false), entity('ssh-rsa B', 'PEM-B', false)] as UnencryptedSSHData[];
        const sa = await s.connect('h', a);
        const sb = await s.connect('h', b);
        await sa.dispose();
        await sb.dispose();
        await expect(sb.dispose()).resolves.toBeUndefined();
        connect.mockRejectedValueOnce(new Error('refused'));
        await expect(s.connect('h', a as unknown as string, undefined, once)).rejects.toThrow('refused');
        await expect(s.connect('h', a)).resolves.toBeInstanceOf(NodeSSH);
        expect(keysUsed()).toEqual(['PEM-A', 'PEM-B', 'PEM-A', 'PEM-A']);
    });
});

describe('SSHService helpers, on an open session', () => {
    const session = (o: { stdout?: string, put?: (from: string, to: string) => Promise<void> } = {}) => {
        const sent: string[] = [];
        const uploads: Array<{ from: string, to: string, text: string }> = [];
        const ssh = {
            execCommand: jest.fn(async (command: string) => {
                sent.push(command);
                return { stdout: o.stdout ?? '', stderr: '', code: 0, signal: null };
            }),
            putFile: jest.fn(async (from: string, to: string) => {
                uploads.push({ from, to, text: readFileSync(from, 'utf8') });
                await o.put?.(from, to);
            }),
        } as unknown as NodeSSH;
        return { ssh, sent, uploads };
    };
    beforeEach(() => jest.spyOn(console, 'error').mockImplementation(() => {}));
    afterEach(() => jest.restoreAllMocks());

    it('installNodeModule: npm install, under sudo and with -g as asked', async () => {
        const { ssh, sent } = session();
        await SSHService.installNodeModule(ssh, { module: 'pm2', sudo: true, global: true });
        await SSHService.installNodeModule(ssh, { module: 'left-pad', sudo: false, global: false });
        expect(sent).toEqual(['sudo npm install pm2 -g', 'npm install left-pad']);
    });

    it('sshGetFileText: cats the file and gives its text, trimmed; an empty or missing file, or a session that answers nothing, is null; sshEnsureFileTextExists compares it', async () => {
        const node = session({ stdout: '  v20.11.1\n' });
        expect(await SSHService.sshGetFileText(node.ssh, '/etc/node-version')).toBe('v20.11.1');
        expect(node.sent).toEqual(['cat /etc/node-version']);
        expect(await SSHService.sshGetFileText(session().ssh, '/nope')).toBeNull();
        const answering = (result: unknown) => ({ execCommand: async () => result }) as unknown as NodeSSH;
        expect(await SSHService.sshGetFileText(answering(undefined), '/f')).toBeNull();
        expect(await SSHService.sshGetFileText(answering({ code: 0 }), '/f')).toBeNull();
        expect(await SSHService.sshEnsureFileTextExists(session({ stdout: 'ok\n' }).ssh, '/f', 'ok')).toBe(true);
        expect(await SSHService.sshEnsureFileTextExists(session({ stdout: 'no' }).ssh, '/f', 'ok')).toBe(false);
    });

    it('installNode: uploads the nvm script the package ships for the machine, runs it and removes it, then installs and uses the version asked (--lts unless said)', async () => {
        const { ssh, sent, uploads } = session();
        await SSHService.installNode(ssh);
        expect(uploads).toHaveLength(1);
        const { from, to, text } = uploads[0];
        expect(from).toBe(join(__dirname, '..', 'scripts', 'setup', 'ubuntu22', 'nvm.sh'));
        expect(text).toMatch(/nvm/);
        expect(to).toMatch(/^~\/tempsetup_[A-Za-z0-9]{10}\.sh$/);
        expect(sent).toEqual([`chmod 700 ${to}`, `sed -i -e 's/\\r$//' ${to}`, to, `rm -rf ${to}`, 'source ~/.profile', 'nvm install --lts', 'nvm use --lts']);
        const v18 = session();
        await SSHService.installNode(v18.ssh, '18');
        expect(v18.sent.slice(-2)).toEqual(['nvm install 18', 'nvm use 18']);
    });

    it('a setup script that cannot be uploaded is thrown, and nothing of it is run', async () => {
        const { ssh, sent } = session({ put: async () => { throw new Error('No such file'); } });
        await expect(SSHService.installNvm(ssh)).rejects.toThrow('No such file');
        expect(sent).toEqual([]);
        expect(console.error).toHaveBeenCalledWith('Error in sshExecFile: No such file');
        expect(console.error).toHaveBeenCalledWith('Error in sshSetupScript: No such file');
    });

    it('writeJsonFile uploads the JSON from a temporary file, which is removed afterwards, also when the upload fails (that is not thrown)', async () => {
        const ok = session();
        await SSHService.writeJsonFile(ok.ssh, { a: 1 }, '/srv/app.json');
        expect(ok.uploads.map((u) => [u.to, JSON.parse(u.text)])).toEqual([['/srv/app.json', { a: 1 }]]);
        expect(existsSync(ok.uploads[0].from)).toBe(false);
        const failing = session({ put: async () => { throw new Error('denied'); } });
        await expect(SSHService.writeJsonFile(failing.ssh, { b: 2 }, '/srv/b.json')).resolves.toBeUndefined();
        expect(existsSync(failing.uploads[0].from)).toBe(false);
    });

    it('sshPutTextFile writes the text into the file with echo', async () => {
        const { ssh, sent } = session();
        await SSHService.sshPutTextFile(ssh, 'hello', '/tmp/x');
        expect(sent).toEqual(['echo "hello" > /tmp/x']);
    });
});
