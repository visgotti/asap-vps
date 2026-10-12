// A machine behind SSH: where and as whom RemoteMachine logs in, and what each
// of its methods sends over the session. What it sends is run for real where
// that harms nothing: by a shell of this machine, in a directory of the
// test's, with a stand-in `sudo` (so a command that is quoted wrongly fails
// here, not on someone's server). What makes users is checked as the script
// it sends, which sshd.spec runs for real on a stand-in machine.

import { spawnSync } from 'child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'fs';
import type { NodeSSH } from 'node-ssh';
import { tmpdir } from 'os';
import { join } from 'path';
import { RemoteCommandError } from '../errors';
import { testPublicKey } from '../testing/fakes/util';
import type { Server, SSHEndpoint } from '../types';
import { RemoteMachine } from './RemoteMachine';
import { SSHService } from './SSHService';
import { addUserScript, authorizeKeysScript } from './utils';

const DIR = mkdtempSync(join(tmpdir(), 'asap-vps-remote-'));
const BIN = join(DIR, 'bin');
const SUDO_LOG = join(DIR, 'sudo.log');
mkdirSync(BIN);
// sudo, as far as this goes: says it ran (and as whom it was asked to), then runs the rest.
writeFileSync(join(BIN, 'sudo'), `#!/bin/sh\necho "sudo $1" >> '${SUDO_LOG}'\n[ "$1" = -n ] && shift\nexec "$@"\n`);
chmodSync(join(BIN, 'sudo'), 0o755);
afterAll(() => rmSync(DIR, { recursive: true, force: true }));

type Sent = { command: string, options?: { stdin?: string, noTrim?: boolean } };

/** A session whose commands are run by this machine's sh in DIR, as node-ssh returns them (trimmed unless noTrim). */
function localSession() {
    const sent: Sent[] = [];
    const ssh = {
        execCommand: jest.fn(async (command: string, options?: Sent['options']) => {
            sent.push({ command, ...(options !== undefined ? { options } : {}) });
            const r = spawnSync('/bin/sh', ['-c', command], { cwd: DIR, input: options?.stdin ?? '', encoding: 'utf8', env: { PATH: `${BIN}:/bin:/usr/bin`, HOME: DIR } });
            const text = (s: string) => (options?.noTrim ? s : s.trim());
            return { stdout: text(r.stdout), stderr: text(r.stderr), code: r.status, signal: r.signal };
        }),
        putFile: jest.fn(async () => undefined),
        getFile: jest.fn(async () => undefined),
        dispose: jest.fn(),
    };
    return { ssh: ssh as unknown as NodeSSH, mock: ssh, sent };
}

/** A session that answers what it is told to, and keeps what it was sent. */
function scriptedSession(answer: { stdout?: string, stderr?: string, code?: number | null, signal?: string | null } = {}) {
    const sent: Sent[] = [];
    const ssh = {
        execCommand: jest.fn(async (command: string, options?: Sent['options']) => {
            sent.push({ command, ...(options !== undefined ? { options } : {}) });
            return { stdout: '', stderr: '', code: 0, signal: null, ...answer };
        }),
        dispose: jest.fn(),
    };
    return { ssh: ssh as unknown as NodeSSH, mock: ssh, sent };
}

/** One shell word, as the code must quote it: written here on its own, so the pin does not follow the code. */
const word = (x: string) => `'${x.split("'").join(`'\\''`)}'`;
/** A script as the one command a login that is not root runs it as root with: by bash where the machine has it, else sh. */
const asRootOf = (script: string) => `sudo -n sh -c 'exec "$(command -v bash || command -v sh)" -c "$1"' asap-vps ${word(script)}`;
/** A server's first login is tried for three minutes unless the caller says. */
const FIRST_LOGIN = { maxRetries: 36, retryTimeout: 5000 };

const ROOT: SSHEndpoint = { host: '203.0.113.7', port: 22, username: 'root' };
const UBUNTU: SSHEndpoint = { host: '198.51.100.9', port: 22, username: 'ubuntu' };
const CONTAINER: SSHEndpoint = { host: '192.0.2.44', port: 41022, username: 'root' };
const server = (provider: string, ssh?: SSHEndpoint) => ({ id: 's-1', provider, name: 'box', status: 'running', ssh } as unknown as Server);
const sudoLog = () => { try { return readFileSync(SUDO_LOG, 'utf8'); } catch { return ''; } };

describe('RemoteMachine', () => {
    beforeEach(() => rmSync(SUDO_LOG, { force: true }));
    afterEach(() => jest.restoreAllMocks());

    describe('connect: one way in, whichever provider rented the machine', () => {
        it('logs in where the server says and as whom it says: a VM as root, Lambda as ubuntu, a container at its mapped port', async () => {
            const session = scriptedSession().ssh;
            const connect = jest.spyOn(SSHService, 'connect').mockResolvedValue(session);
            for (const [provider, endpoint] of [['digitalocean', ROOT], ['lambda', UBUNTU], ['runpod', CONTAINER]] as const) {
                const m = await RemoteMachine.connect(server(provider, endpoint), { privateKey: 'PRIVATE' });
                expect(connect).toHaveBeenLastCalledWith({ ...endpoint, privateKey: 'PRIVATE', retry: FIRST_LOGIN });
                expect([m.endpoint, m.username, m.login, m.ssh]).toEqual([endpoint, endpoint.username, `${endpoint.username}@${endpoint.host}`, session]);
            }
            expect(connect).toHaveBeenCalledTimes(3);
        });

        it('takes an endpoint as it is, and passes on how the key is decrypted and how often to try', async () => {
            const connect = jest.spyOn(SSHService, 'connect').mockResolvedValue(scriptedSession().ssh);
            const m = await RemoteMachine.connect(CONTAINER, { privateKey: 'ENCRYPTED', decryptionKey: 'secret', retry: { maxRetries: 3, retryTimeout: 250 } });
            expect(connect.mock.calls).toEqual([[{ ...CONTAINER, privateKey: 'ENCRYPTED', decryptionKey: 'secret', retry: { maxRetries: 3, retryTimeout: 250 } }]]);
            expect(m.endpoint).toEqual(CONTAINER);
        });

        it('a server\'s first login is given three minutes, since its SSH server may still be coming up; an endpoint given as it is, SSHService\'s own tries; what the caller says, always', async () => {
            const connect = jest.spyOn(SSHService, 'connect').mockResolvedValue(scriptedSession().ssh);
            expect(RemoteMachine.FIRST_LOGIN).toEqual({ maxRetries: 36, retryTimeout: 5000 });
            expect(Object.isFrozen(RemoteMachine.FIRST_LOGIN)).toBe(true);
            await RemoteMachine.connect(server('vast', CONTAINER), { privateKey: 'PRIVATE' });
            await RemoteMachine.connect(CONTAINER, { privateKey: 'PRIVATE' });
            await RemoteMachine.connect(server('vast', CONTAINER), { privateKey: 'PRIVATE', retry: { maxRetries: 1, retryTimeout: 0 } });
            expect(connect.mock.calls).toEqual([
                [{ ...CONTAINER, privateKey: 'PRIVATE', retry: { maxRetries: 36, retryTimeout: 5000 } }],
                [{ ...CONTAINER, privateKey: 'PRIVATE' }],
                [{ ...CONTAINER, privateKey: 'PRIVATE', retry: { maxRetries: 1, retryTimeout: 0 } }],
            ]);
            // Its own copy each time: a caller that changes what it was handed changes nobody else's.
            expect(connect.mock.calls[0][0]).not.toBe(RemoteMachine.FIRST_LOGIN);
        });

        it('as another user when one is named: the same host and port, that login; a name that is no login name is refused before anything is dialed', async () => {
            const connect = jest.spyOn(SSHService, 'connect').mockResolvedValue(scriptedSession().ssh);
            const m = await RemoteMachine.connect(server('vast', CONTAINER), { privateKey: 'PRIVATE', username: 'deploy' });
            expect(connect.mock.calls).toEqual([[{ host: CONTAINER.host, port: CONTAINER.port, username: 'deploy', privateKey: 'PRIVATE', retry: FIRST_LOGIN }]]);
            expect([m.username, m.login, m.endpoint]).toEqual(['deploy', `deploy@${CONTAINER.host}`, { ...CONTAINER, username: 'deploy' }]);
            for (const bad of ['de ploy; id', '-oProxyCommand=id', '.hidden', '', 'a/b', 'back\\slash', 'new\nline']) {
                await expect(RemoteMachine.connect(CONTAINER, { privateKey: 'PRIVATE', username: bad })).rejects.toThrow(
                    new Error(`bad login name ${JSON.stringify(bad)}: letters, digits, underscores, dots, dashes and at signs, not beginning with a dash or a dot`));
            }
            expect(connect).toHaveBeenCalledTimes(1);
        });

        it('a login the machine names its own way is one to log in as: capitals, dots, a directory\'s name@domain (a user this makes is named more narrowly)', async () => {
            const connect = jest.spyOn(SSHService, 'connect').mockResolvedValue(scriptedSession().ssh);
            for (const username of ['john.doe', 'Admin', 'jdoe@example.com', 'svc_backup-2', '9front']) {
                const m = await RemoteMachine.connect(CONTAINER, { privateKey: 'PRIVATE', username });
                expect([m.username, connect.mock.lastCall]).toEqual([username, [{ host: CONTAINER.host, port: CONTAINER.port, username, privateKey: 'PRIVATE' }]]);
            }
            // Making one is another matter: every image family must take the name, and sudo skips a sudoers file with a dot in its name.
            await expect(new RemoteMachine(scriptedSession().ssh, ROOT).addUser('john.doe')).rejects.toThrow(/^bad user name "john.doe"/);
        });

        it('a server with no ssh endpoint (not running yet, or created with no key) says so, by provider and id, and dials nothing', async () => {
            const connect = jest.spyOn(SSHService, 'connect').mockResolvedValue(scriptedSession().ssh);
            await expect(RemoteMachine.connect(server('runpod'), { privateKey: 'PRIVATE' })).rejects.toThrow(
                new Error('runpod: server s-1 reports no ssh endpoint: wait until it runs (waitUntilRunning), and create it with sshKeyIds'));
            expect(connect).not.toHaveBeenCalled();
        });

        it('a login the machine refuses is the caller\'s to see, as SSHService threw it', async () => {
            const refused = new Error('All configured authentication methods failed');
            jest.spyOn(SSHService, 'connect').mockRejectedValue(refused);
            await expect(RemoteMachine.connect(ROOT, { privateKey: 'WRONG' })).rejects.toBe(refused);
        });

        it('wraps a session someone else opened, and keeps its own copy of where it is', () => {
            const { ssh } = scriptedSession();
            const endpoint = { ...UBUNTU };
            const m = new RemoteMachine(ssh, endpoint);
            endpoint.username = 'changed';
            expect([m.ssh, m.endpoint, Object.isFrozen(m.endpoint)]).toEqual([ssh, UBUNTU, true]);
        });
    });

    describe('run: a command as the login', () => {
        it('returns what it wrote and how it ended, sent as it is', async () => {
            const { ssh, sent } = localSession();
            const r = await new RemoteMachine(ssh, ROOT).run('printf "out\\n\\n"; echo err >&2');
            expect(r).toEqual({ stdout: 'out', stderr: 'err', code: 0 });
            expect(sent).toEqual([{ command: 'printf "out\\n\\n"; echo err >&2', options: {} }]);
        });

        it('in the directory, with the environment and on the input it is given: each value one shell word, whatever is in it', async () => {
            const { ssh, sent } = localSession();
            mkdirSync(join(DIR, "it's a dir"), { recursive: true });
            const env = { GREETING: "it's $HOME; `id` \"quoted\"", EMPTY: '', _N1: '42' };
            const r = await new RemoteMachine(ssh, ROOT).run('pwd; printf "%s|%s|%s|" "$GREETING" "$EMPTY" "$_N1"; cat', { cwd: "it's a dir", env, stdin: 'from stdin\n' });
            expect(r.stdout.split('\n')).toEqual([expect.stringMatching(/\/it's a dir$/), 'it\'s $HOME; `id` "quoted"||42|from stdin']);
            // Each on a line of its own that ends the script if it fails, then the command as it was given.
            expect(sent).toEqual([{
                command: [
                    `cd -- ${word("it's a dir")} || exit`,
                    `export GREETING=${word('it\'s $HOME; `id` "quoted"')} || exit`,
                    `export EMPTY='' || exit`,
                    `export _N1='42' || exit`,
                    'pwd; printf "%s|%s|%s|" "$GREETING" "$EMPTY" "$_N1"; cat',
                ].join('\n'),
                options: { stdin: 'from stdin\n' },
            }]);
        });

        it('a directory that is not there stops the command: nothing runs anywhere else', async () => {
            const { ssh } = localSession();
            const e = await new RemoteMachine(ssh, ROOT).run('touch ran-anyway', { cwd: 'no-such-dir' }).catch((x) => x);
            expect(e).toBeInstanceOf(RemoteCommandError);
            expect(() => statSync(join(DIR, 'ran-anyway'))).toThrow(/ENOENT/);
        });

        it('a directory that is not there stops ALL of the command, whatever it is made of: `a; b`, lines, `a || b` (none of it runs in the login\'s home instead)', async () => {
            // The session's home is DIR: a statement that ran "anywhere else" would leave its mark there.
            const commands = ['echo first; touch ran-after-semicolon', 'echo first\ntouch ran-on-next-line', 'false || touch ran-after-or', 'echo first & touch ran-in-background; wait'];
            for (const [login, how] of [[ROOT, 'run'], [UBUNTU, 'sudo'], [CONTAINER, 'sudo']] as const) {
                for (const command of commands) {
                    const { ssh } = localSession();
                    const e: RemoteCommandError = await new RemoteMachine(ssh, login)[how](command, { cwd: 'no-such-dir', env: { A: 'b' } }).catch((x) => x);
                    expect([how, command, e instanceof RemoteCommandError]).toEqual([how, command, true]);
                    // The directory's own failure is the command's: its status, and what the shell said of it.
                    expect(e.code).toBeGreaterThan(0);
                    expect([e.stdout, e.stderr]).toEqual(['', expect.stringMatching(/no-such-dir/)]);
                }
            }
            expect(readdirSync(DIR).filter((f) => f.startsWith('ran-'))).toEqual([]);
            // With the directory there, the same commands run, in it.
            mkdirSync(join(DIR, 'there'), { recursive: true });
            const { ssh } = localSession();
            const ok = await new RemoteMachine(ssh, ROOT).run('echo first; touch ran-after-semicolon', { cwd: 'there' });
            expect([ok, readdirSync(join(DIR, 'there'))]).toEqual([{ stdout: 'first', stderr: '', code: 0 }, ['ran-after-semicolon']]);
        });

        it('one that does not exit 0 throws RemoteCommandError: who ran what where, its status and all it wrote; its message ends on the command\'s own last lines', async () => {
            const { ssh } = localSession();
            const m = new RemoteMachine(ssh, UBUNTU);
            const e: RemoteCommandError = await m.run('echo partial; printf "a\\nb\\nc\\nd\\n" >&2; exit 3', { env: { TOKEN: 'hunter2' }, stdin: 'secret input' }).catch((x) => x);
            expect(e).toBeInstanceOf(RemoteCommandError);
            expect([e.name, e.login, e.command, e.code, e.signal, e.stdout, e.stderr]).toEqual([
                'RemoteCommandError', 'ubuntu@198.51.100.9', 'echo partial; printf "a\\nb\\nc\\nd\\n" >&2; exit 3', 3, undefined, 'partial', 'a\nb\nc\nd']);
            expect(e.message).toBe('ubuntu@198.51.100.9: `echo partial; printf "a\\nb\\nc\\nd\\n" >&2; exit 3` exited 3: b\nc\nd');
            // Neither the environment nor the input is in the error: they may hold secrets.
            expect(JSON.stringify([e.message, e.command])).not.toMatch(/hunter2|secret input/);
        });

        it('with check false it is returned as it ended, not thrown', async () => {
            const { ssh } = localSession();
            expect(await new RemoteMachine(ssh, ROOT).run('echo no; exit 7', { check: false })).toEqual({ stdout: 'no', stderr: '', code: 7 });
        });

        it('one a signal ended has no status: thrown all the same, and returned as null with check false', async () => {
            const killed = scriptedSession({ code: null, signal: 'SIGKILL', stderr: 'Killed' });
            const m = new RemoteMachine(killed.ssh, ROOT);
            const e: RemoteCommandError = await m.run('stress').catch((x) => x);
            expect([e.message, e.code, e.signal]).toEqual(['root@203.0.113.7: `stress` was ended by SIGKILL: Killed', null, 'SIGKILL']);
            expect(await m.run('stress', { check: false })).toEqual({ stdout: '', stderr: 'Killed', code: null });
        });

        it('an environment variable whose name is not one is refused, and nothing is sent', async () => {
            const { ssh, sent } = scriptedSession();
            const m = new RemoteMachine(ssh, ROOT);
            for (const name of ['A B', '1A', 'A;id', 'A-B', '']) {
                await expect(m.run('true', { env: { [name]: 'x' } })).rejects.toThrow(new Error(`bad environment variable name ${JSON.stringify(name)}`));
                await expect(m.sudo('true', { env: { [name]: 'x' } })).rejects.toThrow(new Error(`bad environment variable name ${JSON.stringify(name)}`));
            }
            expect(sent).toEqual([]);
        });
    });

    describe('sudo: a command as root, whoever the login is', () => {
        it('a root login runs it as it is: no sudo, which a container may not have', async () => {
            const { ssh, sent } = localSession();
            const r = await new RemoteMachine(ssh, CONTAINER).sudo('echo "as root"', { env: { A: 'b' } });
            expect([r, sent, sudoLog()]).toEqual([{ stdout: 'as root', stderr: '', code: 0 }, [{ command: `export A='b' || exit\necho "as root"`, options: {} }], '']);
        });

        it('any other login goes through passwordless sudo: the whole command, its directory and environment with it, as one script root runs', async () => {
            const { ssh, sent } = localSession();
            mkdirSync(join(DIR, 'app'), { recursive: true });
            const r = await new RemoteMachine(ssh, UBUNTU).sudo('pwd; echo "$WHO says it\'s $1"; cat', { cwd: 'app', env: { WHO: "o'brien" }, stdin: 'piped' });
            expect(r.stdout.split('\n')).toEqual([expect.stringMatching(/\/app$/), "o'brien says it's ", 'piped']);
            expect(sudoLog()).toBe('sudo -n\n');
            expect(sent).toEqual([{
                command: asRootOf(`cd -- 'app' || exit\nexport WHO=${word("o'brien")} || exit\npwd; echo "$WHO says it's $1"; cat`),
                options: { stdin: 'piped' },
            }]);
            // Written out once in full, so the helper above is pinned too.
            expect(asRootOf("echo 'hi'")).toBe(`sudo -n sh -c 'exec "$(command -v bash || command -v sh)" -c "$1"' asap-vps 'echo '\\''hi'\\'''`);
        });

        it('root\'s shell is bash where the machine has it and sh where it has none (an Alpine image): the command runs either way', async () => {
            // A machine with no bash at all: its PATH holds sh, the stand-in sudo and the plain tools, nothing else.
            const bare = join(DIR, 'no-bash-bin');
            mkdirSync(bare);
            for (const tool of ['sh', 'cat', 'echo']) symlinkSync(['/bin', '/usr/bin'].map((d) => join(d, tool)).find((at) => existsSync(at))!, join(bare, tool));
            symlinkSync(join(BIN, 'sudo'), join(bare, 'sudo'));
            const on = (path: string) => {
                const ssh = { execCommand: async (command: string, options?: { stdin?: string }) => {
                    const r = spawnSync('/bin/sh', ['-c', command], { cwd: DIR, input: options?.stdin ?? '', encoding: 'utf8', env: { PATH: path, HOME: DIR } });
                    return { stdout: r.stdout.trim(), stderr: r.stderr.trim(), code: r.status, signal: r.signal };
                } };
                return new RemoteMachine(ssh as unknown as NodeSSH, UBUNTU);
            };
            expect(spawnSync('/bin/sh', ['-c', 'command -v bash'], { env: { PATH: bare }, encoding: 'utf8' }).status).not.toBe(0);
            expect(await on(bare).sudo('echo "ran: $(cat)"', { stdin: 'piped in' })).toEqual({ stdout: 'ran: piped in', stderr: '', code: 0 });
            // The session a SetupPipeline's steps run on goes the same way: it ran under `sudo -n bash -c` before, which such a machine has not.
            expect(await on(bare).root.execCommand('echo "step ran"')).toMatchObject({ stdout: 'step ran', stderr: '', code: 0 });
            // Where bash is there it is bash that runs it: what a step written for bash needs.
            expect(await on(`${BIN}:/bin:/usr/bin`).sudo('[[ a == a ]] && echo "a bash test"')).toEqual({ stdout: 'a bash test', stderr: '', code: 0 });
            expect(await on(`${BIN}:/bin:/usr/bin`).root.execCommand('[[ a == a ]] && echo "a bash test"')).toMatchObject({ stdout: 'a bash test', code: 0 });
        });

        it('a login that may not sudo gets sudo\'s own refusal, as the error of the command it asked for', async () => {
            const refused = scriptedSession({ code: 1, stderr: 'sudo: a password is required' });
            const e: RemoteCommandError = await new RemoteMachine(refused.ssh, { ...ROOT, username: 'deploy' }).sudo('systemctl restart app').catch((x) => x);
            expect([e.message, e.command]).toEqual(['deploy@203.0.113.7: `systemctl restart app` exited 1: sudo: a password is required', 'systemctl restart app']);
            expect(await new RemoteMachine(refused.ssh, { ...ROOT, username: 'deploy' }).sudo('id', { check: false })).toEqual({ stdout: '', stderr: 'sudo: a password is required', code: 1 });
        });
    });

    describe('files', () => {
        it('writeFile writes any text as it is, over the session\'s input, and readFile reads it back to its last line break', async () => {
            const { ssh, sent } = localSession();
            const m = new RemoteMachine(ssh, ROOT);
            const text = `KEY='it''s'\n$HOME \`id\` "x" \\n \ttab\n\n  spaced  \n\n`;
            await m.writeFile("conf dir's/app.env", text).catch((e) => expect(e).toBeInstanceOf(RemoteCommandError));
            mkdirSync(join(DIR, "conf dir's"), { recursive: true });
            await m.writeFile("conf dir's/app.env", text);
            expect(readFileSync(join(DIR, "conf dir's/app.env"), 'utf8')).toBe(text);
            expect(await m.readFile("conf dir's/app.env")).toBe(text);
            expect(sent.slice(1)).toEqual([
                { command: `cat > 'conf dir'\\''s/app.env'`, options: { stdin: text } },
                { command: `cat -- 'conf dir'\\''s/app.env'`, options: { noTrim: true } },
            ]);
            // Replaced, not added to; and an empty file is one.
            await m.writeFile("conf dir's/app.env", '');
            // No text is still a text: sent as the input, which ends at once.
            expect(sent[sent.length - 1]).toEqual({ command: `cat > 'conf dir'\\''s/app.env'`, options: { stdin: '' } });
            expect([readFileSync(join(DIR, "conf dir's/app.env"), 'utf8'), await m.readFile("conf dir's/app.env")]).toEqual(['', '']);
        });

        it('writeFile sets the mode it is given, as the login; a file whose name begins with a dash is a file, not an option', async () => {
            const { ssh, sent } = localSession();
            await new RemoteMachine(ssh, UBUNTU).writeFile('-secret', 'k', { mode: '600' });
            expect([(statSync(join(DIR, '-secret')).mode & 0o777).toString(8), sudoLog()]).toEqual(['600', '']);
            // Closed to everyone but its writer first, written, and given its mode last.
            expect(sent).toEqual([{ command: `umask 077 && : >> '-secret' && chmod -- 600 '-secret' && cat > '-secret' && chmod -- '600' '-secret'`, options: { stdin: 'k' } }]);
            expect(await new RemoteMachine(ssh, UBUNTU).readFile('-secret')).toBe('k');
        });

        it('with a mode the text is at no time in a file open to others: one that is there is narrowed before it is written, and stays closed when its mode or its owner cannot be set', async () => {
            const { ssh } = localSession();
            const m = new RemoteMachine(ssh, UBUNTU);
            const mode = (file: string) => (statSync(join(DIR, file)).mode & 0o777).toString(8);
            // A file that is there, open to all: the secret replaces what it held, under 600.
            writeFileSync(join(DIR, 'open.env'), 'old');
            chmodSync(join(DIR, 'open.env'), 0o644);
            await m.writeFile('open.env', 'TOKEN=secret', { mode: '600' });
            expect([readFileSync(join(DIR, 'open.env'), 'utf8'), mode('open.env')]).toEqual(['TOKEN=secret', '600']);
            // A mode chmod does not take: the write is thrown, and the text it left is no one else's to read (it was 644 before this was fixed).
            await expect(m.writeFile('new.env', 'TOKEN=secret', { mode: 'not-a-mode' })).rejects.toBeInstanceOf(RemoteCommandError);
            expect(mode('new.env')).toBe('600');
            chmodSync(join(DIR, 'open.env'), 0o644);
            await expect(m.writeFile('open.env', 'TOKEN=other', { mode: 'not-a-mode' })).rejects.toBeInstanceOf(RemoteCommandError);
            expect(mode('open.env')).toBe('600');
            // An owner that cannot be given (no such user): thrown, and the file is still closed.
            await expect(m.writeFile('owned.env', 'TOKEN=secret', { mode: '644', owner: 'no-such-user-of-this-machine' })).rejects.toBeInstanceOf(RemoteCommandError);
            expect(mode('owned.env')).toBe('600');
            // A wider mode is given all the same, once the text is in: 644 is 644.
            await m.writeFile('public.txt', 'hello', { mode: '644' });
            expect([readFileSync(join(DIR, 'public.txt'), 'utf8'), mode('public.txt')]).toEqual(['hello', '644']);
            // With no mode, nothing of this: the file is written as the login's umask makes it, as before.
            const plain = scriptedSession();
            await new RemoteMachine(plain.ssh, ROOT).writeFile('/etc/motd', 'hi\n');
            expect(plain.sent).toEqual([{ command: `cat > '/etc/motd'`, options: { stdin: 'hi\n' } }]);
        });

        it('writeFile with an owner, or with sudo, writes as root (through sudo for a login that is not root); with sudo false the login writes it even so', async () => {
            const owned = scriptedSession();
            await new RemoteMachine(owned.ssh, UBUNTU).writeFile('/etc/app/app.conf', 'a=1\n', { mode: '640', owner: 'app:www-data' });
            await new RemoteMachine(owned.ssh, UBUNTU).writeFile('/etc/motd', 'hi\n', { sudo: true });
            await new RemoteMachine(owned.ssh, UBUNTU).writeFile('mine', 'x', { owner: 'ubuntu', sudo: false });
            await new RemoteMachine(owned.ssh, ROOT).writeFile('/etc/app/app.conf', 'a=1\n', { owner: 'app' });
            await new RemoteMachine(owned.ssh, ROOT).writeFile('/etc/motd', 'hi\n', { sudo: true });
            expect(owned.sent).toEqual([
                // Its owner, then its mode: both once the text is in a file that is its writer's alone.
                { command: asRootOf(`umask 077 && : >> '/etc/app/app.conf' && chmod -- 600 '/etc/app/app.conf' && cat > '/etc/app/app.conf' && chown -- 'app:www-data' '/etc/app/app.conf' && chmod -- '640' '/etc/app/app.conf'`), options: { stdin: 'a=1\n' } },
                { command: asRootOf(`cat > '/etc/motd'`), options: { stdin: 'hi\n' } },
                { command: `cat > 'mine' && chown -- 'ubuntu' 'mine'`, options: { stdin: 'x' } },
                { command: `cat > '/etc/app/app.conf' && chown -- 'app' '/etc/app/app.conf'`, options: { stdin: 'a=1\n' } },
                { command: `cat > '/etc/motd'`, options: { stdin: 'hi\n' } },
            ]);
            // Through the stand-in sudo, the text arrives as root wrote it.
            const { ssh } = localSession();
            await new RemoteMachine(ssh, UBUNTU).writeFile('by-root', 'piped through sudo\n', { sudo: true, mode: '644' });
            expect([readFileSync(join(DIR, 'by-root'), 'utf8'), sudoLog()]).toEqual(['piped through sudo\n', 'sudo -n\n']);
        });

        it('a write that fails throws, naming the write and not the text', async () => {
            const { ssh } = localSession();
            const e: RemoteCommandError = await new RemoteMachine(ssh, ROOT).writeFile('no-such-dir/file', 'the secret text').catch((x) => x);
            expect(e).toBeInstanceOf(RemoteCommandError);
            expect(e.command).toBe(`cat > 'no-such-dir/file'`);
            expect(e.message).not.toContain('the secret text');
        });

        it('readFile throws for a file that cannot be read, and reads as root with sudo where the login is not root', async () => {
            const { ssh, sent } = localSession();
            const e: RemoteCommandError = await new RemoteMachine(ssh, ROOT).readFile('no such file').catch((x) => x);
            expect([e instanceof RemoteCommandError, e.command, e.code]).toEqual([true, `cat -- 'no such file'`, 1]);
            writeFileSync(join(DIR, 'shadow'), 'root:*:1::\n');
            expect(await new RemoteMachine(ssh, UBUNTU).readFile('shadow', { sudo: true })).toBe('root:*:1::\n');
            expect(await new RemoteMachine(ssh, ROOT).readFile('shadow', { sudo: true })).toBe('root:*:1::\n');
            expect(await new RemoteMachine(ssh, UBUNTU).readFile('shadow')).toBe('root:*:1::\n');
            expect(sent.slice(1).map((s) => s.command)).toEqual([asRootOf(`cat -- 'shadow'`), `cat -- 'shadow'`, `cat -- 'shadow'`]);
            expect(sudoLog()).toBe('sudo -n\n');
        });

        it('upload and download copy a file over the session, each the right way round', async () => {
            const { ssh, mock } = localSession();
            const m = new RemoteMachine(ssh, ROOT);
            await m.upload('./dist/app.tgz', '/srv/app.tgz');
            await m.download('/var/log/app.log', './app.log');
            expect([mock.putFile.mock.calls, mock.getFile.mock.calls]).toEqual([[['./dist/app.tgz', '/srv/app.tgz']], [['./app.log', '/var/log/app.log']]]);
        });
    });

    describe('users: not only root logs in', () => {
        const KEY = testPublicKey("deploy's laptop");

        it('addUser sends the script that makes the user, on the input of a shell root runs: as it is for a root login, through sudo for any other', async () => {
            for (const [endpoint, command] of [[CONTAINER, 'sh -s'], [UBUNTU, asRootOf('sh -s')]] as const) {
                const { ssh, sent } = scriptedSession();
                await new RemoteMachine(ssh, endpoint).addUser('deploy', { publicKeys: [KEY], sudo: true, shell: '/bin/bash' });
                expect(sent).toEqual([{ command, options: { stdin: addUserScript('deploy', { publicKeys: [KEY], sudo: true, shell: '/bin/bash' }) } }]);
            }
            const bare = scriptedSession();
            await new RemoteMachine(bare.ssh, ROOT).addUser('svc');
            expect(bare.sent).toEqual([{ command: 'sh -s', options: { stdin: addUserScript('svc') } }]);
        });

        it('addUser refuses a name or a key that is not one before anything is sent, and throws what the machine said when it cannot make the user', async () => {
            const { ssh, sent } = scriptedSession();
            const m = new RemoteMachine(ssh, ROOT);
            await expect(m.addUser('Deploy; rm -rf /')).rejects.toThrow(/^bad user name "Deploy; rm -rf \/"/);
            await expect(m.addUser('deploy', { publicKeys: ['not a key'] })).rejects.toThrow(/^bad public key "not a key"/);
            expect(sent).toEqual([]);
            const failing = scriptedSession({ code: 1, stderr: 'asap-vps: this machine has neither useradd nor adduser' });
            await expect(new RemoteMachine(failing.ssh, ROOT).addUser('deploy')).rejects.toThrow(
                new Error('root@203.0.113.7: `sh -s` exited 1: asap-vps: this machine has neither useradd nor adduser'));
        });

        it('authorizeKeys adds keys to the login\'s own with no root at all, and to another user\'s as root', async () => {
            const own = scriptedSession();
            await new RemoteMachine(own.ssh, UBUNTU).authorizeKeys([KEY]);
            await new RemoteMachine(own.ssh, UBUNTU).authorizeKeys([KEY], 'ubuntu');
            await new RemoteMachine(own.ssh, UBUNTU).authorizeKeys([KEY], 'deploy');
            await new RemoteMachine(own.ssh, ROOT).authorizeKeys([KEY], 'deploy');
            expect(own.sent).toEqual([
                { command: 'sh -s', options: { stdin: authorizeKeysScript([KEY], 'ubuntu') } },
                { command: 'sh -s', options: { stdin: authorizeKeysScript([KEY], 'ubuntu') } },
                { command: asRootOf('sh -s'), options: { stdin: authorizeKeysScript([KEY], 'deploy') } },
                { command: 'sh -s', options: { stdin: authorizeKeysScript([KEY], 'deploy') } },
            ]);
            await expect(new RemoteMachine(own.ssh, ROOT).authorizeKeys(['nope'])).rejects.toThrow(/^bad public key "nope"/);
            expect(own.sent).toHaveLength(4);
        });

        it('as() logs in to the same machine as another user, on a session of its own: the first stays open', async () => {
            const first = scriptedSession();
            const second = scriptedSession();
            const connect = jest.spyOn(SSHService, 'connect').mockResolvedValue(second.ssh);
            const root = new RemoteMachine(first.ssh, CONTAINER);
            const deploy = await root.as('deploy', { privateKey: 'DEPLOY-PRIVATE', retry: { maxRetries: 2, retryTimeout: 0 } });
            expect(connect.mock.calls).toEqual([[{ host: CONTAINER.host, port: CONTAINER.port, username: 'deploy', privateKey: 'DEPLOY-PRIVATE', retry: { maxRetries: 2, retryTimeout: 0 } }]]);
            expect([deploy.login, deploy.ssh, root.login]).toEqual([`deploy@${CONTAINER.host}`, second.ssh, `root@${CONTAINER.host}`]);
            // The new user's root goes through its sudo; the first session's is the session itself.
            await deploy.sudo('id -u');
            expect([second.sent, first.sent, first.mock.dispose.mock.calls.length]).toEqual([[{ command: asRootOf('id -u'), options: {} }], [], 0]);
        });
    });

    describe('root and close', () => {
        it('root is the session itself for a root login, and one whose every command goes through sudo for any other: what a SetupPipeline runs on', async () => {
            const asRootLogin = scriptedSession();
            expect(new RemoteMachine(asRootLogin.ssh, ROOT).root).toBe(asRootLogin.ssh);
            const asUbuntu = scriptedSession();
            const root = new RemoteMachine(asUbuntu.ssh, UBUNTU).root;
            expect(root).not.toBe(asUbuntu.ssh);
            await root.execCommand('apt-get install -y nginx');
            expect(asUbuntu.sent).toEqual([{ command: asRootOf('apt-get install -y nginx') }]);
        });

        it('close ends the session, and only this one', async () => {
            const { ssh, mock } = scriptedSession();
            await new RemoteMachine(ssh, ROOT).close();
            expect(mock.dispose).toHaveBeenCalledTimes(1);
        });
    });
});
