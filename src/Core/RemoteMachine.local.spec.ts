// The SSH layer end to end, with nothing rented: a real session (node-ssh)
// to a real sshd, this machine's own, started for the test with a host key, a
// key list and a port of its own, on 127.0.0.1 only, and stopped after it. It
// costs nothing and touches no account, but it starts a program, so it runs
// only when asked for:
//   npm run test:ssh        (ASAP_VPS_LOCAL=sshd jest RemoteMachine.local)
// It logs in as whoever runs the test, so it proves what needs no root:
// logins, commands, their input and failures, files, SFTP. What needs root
// (users, sudo, a container's SSH server) is run for real against stand-in
// tools in utils/sshd.spec.ts, and on rented machines by the *Ssh.live suites.

import { ChildProcess, execFileSync, spawn } from 'child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { createServer } from 'net';
import { tmpdir, userInfo } from 'os';
import { join } from 'path';
import { RemoteCommandError } from '../errors';
import type { SSHEndpoint, SSHKeyData } from '../types';
import { RemoteMachine } from './RemoteMachine';
import { createSSHKeyPair } from './utils';

const wanted = (process.env.ASAP_VPS_LOCAL ?? '').split(',').map((s) => s.trim()).includes('sshd');

(wanted ? describe : describe.skip)(`RemoteMachine over a real session: a throwaway sshd of this machine${wanted ? '' : ' (npm run test:ssh runs it)'}`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'asap-vps-local-sshd-'));
    let sshd: ChildProcess;
    let endpoint: SSHEndpoint;
    let key: SSHKeyData;
    let machine: RemoteMachine;
    const log: string[] = [];

    beforeAll(async () => {
        key = await createSSHKeyPair('asap-vps-local');
        const port = await new Promise<number>((resolve) => {
            const probe = createServer().listen(0, '127.0.0.1', () => {
                const { port: free } = probe.address() as { port: number };
                probe.close(() => resolve(free));
            });
        });
        execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', join(dir, 'host_key')]);
        writeFileSync(join(dir, 'authorized_keys'), `${key.publicKey}\n`, { mode: 0o600 });
        // Its own host key, its own list of keys, this machine's loopback alone, and nothing but keys: nobody else's way in.
        writeFileSync(join(dir, 'sshd_config'), [
            `Port ${port}`, 'ListenAddress 127.0.0.1', `HostKey ${join(dir, 'host_key')}`, `PidFile ${join(dir, 'sshd.pid')}`,
            `AuthorizedKeysFile ${join(dir, 'authorized_keys')}`, 'PubkeyAuthentication yes', 'PasswordAuthentication no', 'KbdInteractiveAuthentication no',
            'UsePAM no', 'StrictModes no', 'Subsystem sftp internal-sftp', '',
        ].join('\n'));
        sshd = spawn('/usr/sbin/sshd', ['-D', '-e', '-f', join(dir, 'sshd_config')], { stdio: ['ignore', 'ignore', 'pipe'] });
        sshd.stderr!.on('data', (d) => log.push(String(d)));
        endpoint = { host: '127.0.0.1', port, username: userInfo().username };
        machine = await RemoteMachine.connect(endpoint, { privateKey: key.privateKey, retry: { maxRetries: 40, retryTimeout: 250 } }).catch((e) => {
            throw new Error(`no session to the local sshd: ${e.message}\n${log.join('')}`);
        });
    }, 120_000);

    afterAll(async () => {
        await machine?.close();
        sshd?.kill();
        rmSync(dir, { recursive: true, force: true });
    });

    it('logs in as the endpoint says, and runs a command in a directory, with an environment and an input, whatever is in them', async () => {
        expect([machine.endpoint, machine.login]).toEqual([endpoint, `${endpoint.username}@127.0.0.1`]);
        expect((await machine.run('id -un')).stdout).toBe(endpoint.username);
        const env = { GREETING: "it's $HOME; `id` \"quoted\"", EMPTY: '' };
        const r = await machine.run('pwd -P; printf "%s|%s|" "$GREETING" "$EMPTY"; cat; echo to-stderr >&2', { cwd: dir, env, stdin: 'from stdin' });
        expect(r).toEqual({ stdout: `${execFileSync('/bin/sh', ['-c', 'cd "$1" && pwd -P', 'sh', dir], { encoding: 'utf8' }).trim()}\nit's $HOME; \`id\` "quoted"||from stdin`, stderr: 'to-stderr', code: 0 });
    });

    it('a command that fails throws what it wrote and how it ended; one a signal ended has no status', async () => {
        const failed: RemoteCommandError = await machine.run('echo out; echo "why it failed" >&2; exit 42').catch((e) => e);
        expect(failed).toBeInstanceOf(RemoteCommandError);
        expect([failed.code, failed.stdout, failed.stderr, failed.message]).toEqual([42, 'out', 'why it failed', `${machine.login}: \`echo out; echo "why it failed" >&2; exit 42\` exited 42: why it failed`]);
        expect(await machine.run('exit 7', { check: false })).toEqual({ stdout: '', stderr: '', code: 7 });
        const killed: RemoteCommandError = await machine.run('kill -9 $$').catch((e) => e);
        expect([killed instanceof RemoteCommandError, killed.code, killed.signal]).toEqual([true, null, expect.stringMatching(/KILL/)]);
        expect(killed.message).toMatch(/was ended by (SIG)?KILL$/);
    });

    it('writes any text to a file as it is, with its mode, and reads it back to its last line break', async () => {
        const text = `KEY='it''s'\n$HOME \`id\` "x" \\n \ttab\n\n  spaced  \n\n`;
        const path = join(dir, "written file's.env");
        await machine.writeFile(path, text, { mode: '640' });
        expect([readFileSync(path, 'utf8'), (statSync(path).mode & 0o777).toString(8), await machine.readFile(path)]).toEqual([text, '640', text]);
        await machine.writeFile(path, '');
        expect(await machine.readFile(path)).toBe('');
        await expect(machine.readFile(join(dir, 'no such file'))).rejects.toBeInstanceOf(RemoteCommandError);
        await expect(machine.writeFile(join(dir, 'no-such-dir', 'x'), 'text')).rejects.toBeInstanceOf(RemoteCommandError);
    });

    it('copies a file up and down over the same session', async () => {
        const [local, remote, back] = [join(dir, 'local.bin'), join(dir, 'remote.bin'), join(dir, 'back.bin')];
        const bytes = Buffer.from(Array.from({ length: 70_000 }, (_, i) => i % 251));
        writeFileSync(local, bytes);
        await machine.upload(local, remote);
        await machine.download(remote, back);
        expect([readFileSync(remote).equals(bytes), readFileSync(back).equals(bytes)]).toEqual([true, true]);
    });

    it('a second session as a user of the machine is a session of its own; a key the machine does not take is refused', async () => {
        const second = await machine.as(endpoint.username, { privateKey: key.privateKey, retry: { maxRetries: 2, retryTimeout: 100 } });
        try {
            expect([(await second.run('echo second')).stdout, second.ssh === machine.ssh]).toEqual(['second', false]);
        } finally {
            await second.close();
        }
        expect((await machine.run('echo still-open')).stdout).toBe('still-open');
        const stranger = await createSSHKeyPair('stranger');
        await expect(RemoteMachine.connect(endpoint, { privateKey: stranger.privateKey, retry: { maxRetries: 1, retryTimeout: 0 } })).rejects.toThrow();
    });
});
