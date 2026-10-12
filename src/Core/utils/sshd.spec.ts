// The scripts that make a machine one to log in to, run for real: under a
// POSIX shell (dash where this machine has it, and sh), on a stand-in machine
// whose /etc, /run and homes are a directory of the test's, with stand-ins
// for what changes a system (useradd, sshd, the package managers, chown) on a
// PATH that holds nothing else but the plain tools the scripts use. What each
// stand-in was called with is what a machine would run.

import { execFileSync } from 'child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { testPublicKey } from '../../testing/fakes/util';
import { shellQuote } from './container';
import { addUserScript, authorizeKeysScript, checkLoginName, checkPublicKeys, checkUsername, LOGIN_NAME, sshdBootScript, USERNAME } from './sshd';

type Tool = 'useradd' | 'adduser' | 'usermod' | 'sshd' | 'sudo' | 'apt-get' | 'apk' | 'dnf' | 'yum' | 'getent' | 'bash';

type Box = {
    /** The stand-ins on its PATH (default: a Debian family machine with sshd and sudo: useradd, usermod, sshd, sudo, apt-get, bash). */
    tools?: Tool[],
    /** Users it has besides root, each with a home under the box. */
    users?: string[],
    /** Who runs the script (`id -u`): 0 by default. */
    uid?: number,
    /** Whether its sshd knows SetEnv (default true). */
    setEnv?: boolean,
    /** A shadow file, where the box has one: `name` -> its password field. */
    shadow?: Record<string, string>,
    /** Environment the script starts with, besides its PATH. */
    env?: Record<string, string>,
    /** A user known to getent alone (a directory service): not in the passwd file. */
    directoryUser?: string,
    /** A box whose passwd file has no root: nowhere to put root's keys. */
    noRoot?: boolean,
    /** A stand-in that fails each time it is called (it is still written down). */
    fail?: 'chown' | 'ssh-keygen' | 'sshd',
};

const SHELLS = ['/bin/dash', '/bin/sh'].filter((s) => existsSync(s));
const DEBIAN: Tool[] = ['useradd', 'usermod', 'sshd', 'sudo', 'apt-get', 'bash'];

// One program stands in for every tool that would change a system: it writes
// down how it was called, and does what the tool it was called as (its name on
// the box's PATH, a link to it) does to the box. One file, since this machine
// checks each new program it is asked to run, which a file per tool per test
// would make slow.
const SUITE = mkdtempSync(join(tmpdir(), 'asap-vps-sshd-'));
const STUB = join(SUITE, 'stand-in');
writeFileSync(STUB, [
    '#!/bin/sh',
    'name=$(basename "$0")',
    // `id` is a question, not a change: it is not written down.
    'case $name in id) ;; *) { printf \'%s\' "$name"; for a in "$@"; do printf \' [%s]\' "$a"; done; echo; } >> "$BOX_LOG";; esac',
    // The one tool this box has broken: called, and failing.
    '[ "$name" = "$BOX_FAIL" ] && exit 1',
    'case $name in',
    // `id -u`: who runs this; `id -u <name>`: whether the box has the user; `id -gn <name>`: its group, named as it is.
    '    id)',
    '        if [ "$1" = -u ] && [ -z "${2:-}" ]; then echo "$BOX_UID"; exit 0; fi',
    '        if [ "$1" = -u ]; then grep -q "^$2:" "$BOX_ROOT/etc/passwd" || [ "$2" = "$BOX_DIRECTORY_USER" ]; exit $?; fi',
    '        echo "$2";;',
    // A new user: a line of the passwd file and a home, as useradd -m and busybox's adduser -D make them (the latter with a locked password).
    '    useradd|adduser)',
    '        for user in "$@"; do :; done',
    '        echo "$user:x:2000:2000::$BOX_ROOT/home/$user:/bin/sh" >> "$BOX_ROOT/etc/passwd"',
    '        mkdir -p "$BOX_ROOT/home/$user"',
    '        if [ "$name" = adduser ] && [ -f "$BOX_ROOT/etc/shadow" ]; then echo "$user:!:19000:0:99999:7:::" >> "$BOX_ROOT/etc/shadow"; fi;;',
    '    getent)',
    '        [ -n "$BOX_DIRECTORY_USER" ] && [ "$2" = "$BOX_DIRECTORY_USER" ] || exit 2',
    '        echo "$2:x:3000:3000::$BOX_ROOT/home/$2:/bin/sh";;',
    // A test of its configuration (-t) passes unless it is given SetEnv on a box whose sshd does not know it.
    '    sshd)',
    '        case " $* " in *" -t "*) case "$*" in *SetEnv=*) exit "$BOX_SETENV";; esac;; esac;;',
    // A package manager puts what it installs on the PATH.
    '    apt-get|apk|dnf|yum)',
    '        case " $* " in *" openssh-server "*|*" openssh "*) ln -s "$BOX_STUB" "$BOX_BIN/sshd";; esac',
    '        case " $* " in *" sudo "*) ln -s "$BOX_STUB" "$BOX_BIN/sudo";; esac;;',
    'esac',
    '',
].join('\n'));
chmodSync(STUB, 0o755);
afterAll(() => rmSync(SUITE, { recursive: true, force: true }));

/**
 * Runs `script` on a stand-in machine, as RemoteMachine and a container's
 * start do (`sh -s` with the script on its input, or `sh -c <script> asap-vps
 * <command...>`): what it called, what it left on the box's disk, and how it ended.
 */
function runOn(script: string, box: Box = {}, o: { shell?: string, command?: string[] } = {}) {
    const dir = mkdtempSync(join(SUITE, 'box-'));
    const [bin, root, log] = [join(dir, 'bin'), join(dir, 'root'), join(dir, 'calls.log')];
    for (const d of [bin, join(root, 'etc'), join(root, 'run'), join(root, 'home'), join(root, 'root')]) mkdirSync(d, { recursive: true });
    writeFileSync(log, '');
    writeFileSync(join(root, 'etc/passwd'), [...(box.noRoot ? [] : [`root:x:0:0:root:${join(root, 'root')}:/bin/sh`]), ...(box.users ?? []).map((u, i) => `${u}:x:${1000 + i}:${1000 + i}::${join(root, 'home', u)}:/bin/sh`)].join('\n') + '\n');
    for (const u of [...(box.users ?? []), ...(box.directoryUser ? [box.directoryUser] : [])]) mkdirSync(join(root, 'home', u), { recursive: true });
    if (box.shadow) writeFileSync(join(root, 'etc/shadow'), Object.entries(box.shadow).map(([u, p]) => `${u}:${p}:19000:0:99999:7:::`).join('\n') + '\n');
    // The plain tools the scripts use, from this machine; nothing else is on the PATH.
    const real = (tool: string) => ['/bin', '/usr/bin'].map((d) => join(d, tool)).find((at) => existsSync(at))!;
    for (const tool of ['awk', 'grep', 'mkdir', 'touch', 'chmod', 'cut', 'sed', 'rm', 'cat', 'sh', 'basename', 'echo', 'true', 'ln']) symlinkSync(real(tool), join(bin, tool));
    for (const tool of ['id', 'chown', 'ssh-keygen', ...(box.tools ?? DEBIAN)]) symlinkSync(tool === 'bash' ? '/bin/sh' : STUB, join(bin, tool));
    // The box's own /etc, /run and system directories, wherever the scripts name them: nothing of this machine's is run or written.
    const here = script.split('/etc/').join(`${join(root, 'etc')}/`).split('/run/sshd').join(join(root, 'run/sshd'))
        .split(':/usr/sbin:/sbin').join(`:${join(root, 'usr/sbin')}:${join(root, 'sbin')}`);
    if (/(^|[\s"'=:])\/(etc|run|usr|sbin|root|home)\b/.test(here.split(dir).join('BOX'))) throw new Error('the script names a path of this machine');
    const env = {
        PATH: bin, BOX_STUB: STUB, BOX_BIN: bin, BOX_ROOT: root, BOX_LOG: log, BOX_UID: String(box.uid ?? 0),
        BOX_SETENV: box.setEnv === false ? '1' : '0', BOX_DIRECTORY_USER: box.directoryUser ?? '', BOX_FAIL: box.fail ?? '', ...(box.env ?? {}),
    };
    let [status, stdout, stderr] = [0, '', ''];
    try {
        stdout = o.command
            ? execFileSync(o.shell ?? '/bin/sh', ['-c', here, 'asap-vps', ...o.command], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
            : execFileSync(o.shell ?? '/bin/sh', ['-s'], { env, encoding: 'utf8', input: here, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
        const failed = e as { status: number, stdout: string, stderr: string };
        [status, stdout, stderr] = [failed.status, String(failed.stdout), String(failed.stderr)];
    }
    // What it left on the box's disk: each file's text and each path's mode.
    const disk = new Map<string, { text?: string, mode: string }>();
    const walk = (at: string) => {
        for (const entry of readdirSync(join(root, at), { withFileTypes: true })) {
            const path = join(at, entry.name);
            const mode = (statSync(join(root, path)).mode & 0o777).toString(8);
            disk.set(path, entry.isDirectory() ? { mode } : { mode, text: readFileSync(join(root, path), 'utf8') });
            if (entry.isDirectory()) walk(path);
        }
    };
    walk('');
    const tidy = (text: string) => text.split(root).join('').split(`${bin}/`).join('');
    const calls = tidy(readFileSync(log, 'utf8')).trim().split('\n').filter(Boolean);
    return { status, stdout, stderr: tidy(stderr), calls, file: (path: string) => disk.get(path), dirMode: (path: string) => disk.get(path)?.mode };
}

const [KEY_A, KEY_B] = [testPublicKey('a@laptop'), testPublicKey("o'brien's key")];

describe('user names and keys are checked before any script is written', () => {
    it('a user name every image family takes: lowercase, digits, underscores and dashes, 32 at most; anything else is refused by what was given', () => {
        for (const ok of ['deploy', '_svc', 'a', 'web-01', 'a_b-c9', 'x'.repeat(32)]) expect([USERNAME.test(ok), checkUsername(ok)]).toEqual([true, ok]);
        for (const bad of ['', 'Deploy', '1user', '-x', 'a b', 'a;rm -rf /', 'root\n', 'a.b', 'x'.repeat(33), "o'brien", '$(id)']) {
            expect(() => checkUsername(bad)).toThrow(new Error(`bad user name ${JSON.stringify(bad)}: a lowercase letter or underscore, then letters, digits, underscores and dashes (32 at most)`));
        }
        expect(() => checkUsername(undefined as never)).toThrow(/^bad user name undefined/);
    });

    it('a key is one OpenSSH public key line, trimmed; anything else is refused, named by its start alone', () => {
        expect(checkPublicKeys([`  ${KEY_A}\n`, KEY_B])).toEqual([KEY_A, KEY_B]);
        expect(checkPublicKeys([])).toEqual([]);
        for (const bad of ['', 'not a key', `${KEY_A}\n${KEY_B}`, 'ssh-ed25519', '-----BEGIN OPENSSH PRIVATE KEY-----']) {
            expect(() => checkPublicKeys([KEY_A, bad])).toThrow(new Error(`bad public key ${JSON.stringify(bad.slice(0, 40))}: not an OpenSSH public key line (ssh-ed25519 AAAA... comment)`));
        }
        expect(() => addUserScript('deploy', { publicKeys: ['nope'] })).toThrow(/^bad public key "nope"/);
        expect(() => addUserScript('Deploy')).toThrow(/^bad user name "Deploy"/);
        expect(() => authorizeKeysScript([KEY_A], 'a b')).toThrow(/^bad login name "a b"/);
        expect(() => authorizeKeysScript(['x'], 'root')).toThrow(/^bad public key "x"/);
        for (const shell of ['bash', '/bin/ba sh', '/bin/sh; id', '']) expect(() => addUserScript('deploy', { shell })).toThrow(new Error(`bad shell ${JSON.stringify(shell)}: the absolute path of one (/bin/bash)`));
    });

    it('a key is one line of the file, whatever its lines are: a second key behind a line break is not smuggled in, with a comment on the first or without', () => {
        const [type, blob] = KEY_A.split(' ');
        const bare = `${type} ${blob}`;
        expect(checkPublicKeys([bare])).toEqual([bare]);
        for (const two of [`${bare}\n${KEY_B}`, `${KEY_A}\n${KEY_B}`, `${bare}\r\n${KEY_B}`, `${bare}\r${KEY_B}`, `${type}\n${blob}`, `${bare}\0${KEY_B}`]) {
            expect(() => checkPublicKeys([two])).toThrow(/^bad public key /);
            expect(() => authorizeKeysScript([two], 'root')).toThrow(/^bad public key /);
        }
    });

    it('a key may carry the options authorized_keys takes before it; what is before a key and is no option is refused', () => {
        const withOptions = [
            `no-pty ${KEY_A}`, `restrict,pty ${KEY_A}`, `from="10.0.0.0/8,192.168.1.*" ${KEY_A}`,
            `command="echo \\"read only\\"; exit",no-port-forwarding,from="*.example.com" ${KEY_A}`, `environment="A=b c",expiry-time="20270101" ${KEY_B}`,
            // A key whose type is all letters and dashes reads as a key, not as an option before one.
            'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAAAgQC7 old@box', 'ssh-dss AAAAB3NzaC1kc3MAAACBAP7 older@box',
        ];
        expect(checkPublicKeys(withOptions)).toEqual(withOptions);
        for (const bad of [`no pty ${KEY_A}`, `from="unterminated ${KEY_A}`, `from=10.0.0.0/8 ${KEY_A}`, `no-pty, ${KEY_A}`, `no-pty not-a-key AAAA`, `1bad ${KEY_A}`, 'no-pty', `no-pty ${KEY_A}\n${KEY_B}`]) {
            expect(() => checkPublicKeys([bad])).toThrow(/^bad public key /);
        }
    });

    it('a login a machine has is named more widely than a user this makes: capitals, dots, name@domain; nothing a shell, awk or chown would read as more than a name', () => {
        for (const ok of ['root', 'john.doe', 'Admin', 'jdoe@example.com', 'svc_backup-2', '9front', '_x', 'x'.repeat(256)]) {
            expect([LOGIN_NAME.test(ok), checkLoginName(ok), authorizeKeysScript([KEY_A], ok).includes(`asap_vps_keys '${ok}' `)]).toEqual([true, ok, true]);
        }
        for (const bad of ['', '-x', '.hidden', '@home', 'a b', 'a;id', 'a:b', 'a/b', 'back\\slash', "o'brien", '$(id)', 'a\nb', 'root\n', 'x'.repeat(257)]) {
            expect(() => checkLoginName(bad)).toThrow(new Error(`bad login name ${JSON.stringify(bad)}: letters, digits, underscores, dots, dashes and at signs, not beginning with a dash or a dot`));
        }
        expect(() => checkLoginName(undefined as never)).toThrow(/^bad login name undefined/);
        // What may log in is not what may be made: every image family must take a new user's name.
        expect(() => addUserScript('john.doe')).toThrow(/^bad user name "john.doe"/);
    });
});

describe.each(SHELLS)('addUserScript, under %s', (shell) => {
    it('makes a user that is new: a home, the shell asked for or the machine\'s bash, no password, and its keys in a directory and a file closed to others', () => {
        const r = runOn(addUserScript('deploy', { publicKeys: [KEY_A, KEY_B] }), {}, { shell });
        expect([r.status, r.stderr]).toEqual([0, '']);
        expect(r.calls).toEqual(['useradd [-m] [-s] [bash] [deploy]', 'usermod [-p] [*] [deploy]', 'chown [-R] [deploy:deploy] [/home/deploy/.ssh]']);
        // Each key a line, as it was given: a quote in a comment is the comment's.
        expect(r.file('home/deploy/.ssh/authorized_keys')).toEqual({ text: `${KEY_A}\n${KEY_B}\n`, mode: '600' });
        expect(r.dirMode('home/deploy/.ssh')).toBe('700');
        expect(r.file('etc/sudoers.d/90-asap-vps-deploy')).toBeUndefined();
        const zsh = runOn(addUserScript('deploy', { shell: '/bin/zsh' }), {}, { shell });
        expect(zsh.calls[0]).toBe('useradd [-m] [-s] [/bin/zsh] [deploy]');
        // No bash on the machine: sh.
        expect(runOn(addUserScript('deploy'), { tools: ['useradd', 'usermod'] }, { shell }).calls[0]).toBe('useradd [-m] [-s] [sh] [deploy]');
    });

    it('a user that exists is not made again, nor its password touched: its keys are added to the ones it has, each once however often it runs', () => {
        const box: Box = { users: ['deploy'] };
        const script = addUserScript('deploy', { publicKeys: [KEY_A] });
        const r = runOn(`mkdir -p /etc/../home/deploy/.ssh\nprintf '%s\\n' ${shellQuote(KEY_B)} > /etc/../home/deploy/.ssh/authorized_keys\n${script}${script}`, box, { shell });
        expect([r.status, r.stderr]).toEqual([0, '']);
        expect(r.calls).toEqual(['chown [-R] [deploy:deploy] [/home/deploy/.ssh]', 'chown [-R] [deploy:deploy] [/home/deploy/.ssh]']);
        expect(r.file('home/deploy/.ssh/authorized_keys')?.text).toBe(`${KEY_B}\n${KEY_A}\n`);
        // No keys asked for: the file is there, empty, and the user's own.
        const none = runOn(addUserScript('deploy'), box, { shell });
        expect(none.file('home/deploy/.ssh/authorized_keys')).toEqual({ text: '', mode: '600' });
    });

    it('with sudo the user may run anything as root with no password: a sudoers file of its own, read-only; sudo false takes it back, and unset leaves it', () => {
        const granted = runOn(addUserScript('deploy', { sudo: true }), {}, { shell });
        expect([granted.status, granted.stderr]).toEqual([0, '']);
        expect(granted.file('etc/sudoers.d/90-asap-vps-deploy')).toEqual({ text: 'deploy ALL=(ALL) NOPASSWD:ALL\n', mode: '440' });
        // Nothing is installed where sudo is there already.
        expect(granted.calls.filter((c) => c.startsWith('apt-get'))).toEqual([]);
        const again = `${addUserScript('deploy', { sudo: true })}`;
        expect(runOn(`${again}${addUserScript('deploy')}`, {}, { shell }).file('etc/sudoers.d/90-asap-vps-deploy')?.text).toBe('deploy ALL=(ALL) NOPASSWD:ALL\n');
        const revoked = runOn(`${again}${addUserScript('deploy', { sudo: false })}`, {}, { shell });
        expect([revoked.status, revoked.file('etc/sudoers.d/90-asap-vps-deploy')]).toEqual([0, undefined]);
        // Taking back what was never given is no error.
        expect(runOn(addUserScript('deploy', { sudo: false }), {}, { shell }).status).toBe(0);
    });

    it('installs sudo where the machine has none, with the package manager it has; with none of them it says so and stops', () => {
        const managers: Array<[Tool, string[]]> = [
            ['apt-get', ['apt-get [update] [-y]', 'apt-get [install] [-y] [--no-install-recommends] [sudo]']], ['apk', ['apk [add] [--no-cache] [sudo]']],
            ['dnf', ['dnf [install] [-y] [sudo]']], ['yum', ['yum [install] [-y] [sudo]']],
        ];
        for (const [manager, calls] of managers) {
            const r = runOn(addUserScript('deploy', { sudo: true }), { tools: ['useradd', 'usermod', manager] }, { shell });
            expect([r.status, r.stderr]).toEqual([0, '']);
            expect(r.calls.filter((c) => c.startsWith(manager))).toEqual(calls);
            expect(r.file('etc/sudoers.d/90-asap-vps-deploy')?.text).toBe('deploy ALL=(ALL) NOPASSWD:ALL\n');
        }
        const none = runOn(addUserScript('deploy', { sudo: true }), { tools: ['useradd', 'usermod'] }, { shell });
        expect([none.status, none.stderr]).toEqual([1, 'asap-vps: this machine has no sudo, and no package manager this knows (apt-get, apk, dnf, yum) to install it with\n']);
        expect(none.file('etc/sudoers.d/90-asap-vps-deploy')).toBeUndefined();
    });

    it('on a busybox machine (Alpine): adduser, and the new account\'s password field made one that matches nothing, since its sshd lets no key in to a locked one', () => {
        const r = runOn(addUserScript('deploy', { publicKeys: [KEY_A] }), { tools: ['adduser'], shadow: { root: '*' } }, { shell });
        expect([r.status, r.stderr]).toEqual([0, '']);
        expect(r.calls).toEqual(['adduser [-D] [-s] [sh] [deploy]', 'chown [-R] [deploy:deploy] [/home/deploy/.ssh]']);
        expect(r.file('etc/shadow')?.text).toBe('root:*:19000:0:99999:7:::\ndeploy:*:19000:0:99999:7:::\n');
        expect(r.file('home/deploy/.ssh/authorized_keys')?.text).toBe(`${KEY_A}\n`);
        // No shadow file either: nothing to unlock, and no failure for it.
        expect(runOn(addUserScript('deploy'), { tools: ['adduser'] }, { shell }).status).toBe(0);
    });

    it('a machine with neither useradd nor adduser says so, and nothing is made', () => {
        const r = runOn(addUserScript('deploy', { publicKeys: [KEY_A], sudo: true }), { tools: ['sudo'] }, { shell });
        expect([r.status, r.stderr, r.calls]).toEqual([1, 'asap-vps: this machine has neither useradd nor adduser\n', []]);
        expect(r.file('etc/sudoers.d/90-asap-vps-deploy')).toBeUndefined();
    });
});

describe.each(SHELLS)('authorizeKeysScript, under %s', (shell) => {
    it('adds the keys to the ones the user has, each once; root\'s home is root\'s, another user\'s its own', () => {
        const twice = `${authorizeKeysScript([KEY_A, KEY_B], 'root')}${authorizeKeysScript([KEY_B], 'root')}`;
        const r = runOn(twice, {}, { shell });
        expect([r.status, r.stderr]).toEqual([0, '']);
        expect(r.file('root/.ssh/authorized_keys')).toEqual({ text: `${KEY_A}\n${KEY_B}\n`, mode: '600' });
        expect(r.dirMode('root/.ssh')).toBe('700');
        expect(r.calls).toEqual(['chown [-R] [root:root] [/root/.ssh]', 'chown [-R] [root:root] [/root/.ssh]']);
        const ubuntu = runOn(authorizeKeysScript([KEY_A], 'ubuntu'), { users: ['ubuntu'] }, { shell });
        expect(ubuntu.file('home/ubuntu/.ssh/authorized_keys')?.text).toBe(`${KEY_A}\n`);
        expect(ubuntu.calls).toEqual(['chown [-R] [ubuntu:ubuntu] [/home/ubuntu/.ssh]']);
    });

    it('a user the machine knows only through its directory service (getent) is found; one it does not know at all is said, and nothing written', () => {
        const directory = runOn(authorizeKeysScript([KEY_A], 'ldapuser'), { tools: ['getent'], directoryUser: 'ldapuser' }, { shell });
        expect([directory.status, directory.stderr]).toEqual([0, '']);
        expect(directory.file('home/ldapuser/.ssh/authorized_keys')?.text).toBe(`${KEY_A}\n`);
        for (const tools of [['getent'], []] as Tool[][]) {
            const none = runOn(authorizeKeysScript([KEY_A], 'ghost'), { tools }, { shell });
            expect([none.status, none.stderr]).toEqual([1, 'asap-vps: no user ghost on this machine\n']);
            expect(none.calls.filter((c) => c.startsWith('chown'))).toEqual([]);
        }
    });
});

describe.each(SHELLS)('sshdBootScript: an SSH server for a container, under %s', (shell) => {
    const start = (keys: string[]) => `${sshdBootScript(keys)}exec "$@"`;
    const PATHS = '[SetEnv=PATH=';

    it('with the image\'s own sshd: host keys, root\'s keys, then sshd for key logins only with the container\'s own PATH, and the command it hands over to', () => {
        const r = runOn(start([KEY_A, KEY_B]), {}, { shell, command: ['echo', 'handed over'] });
        expect([r.status, r.stderr, r.stdout]).toEqual([0, '', 'handed over\n']);
        expect(r.calls.slice(0, 2)).toEqual(['ssh-keygen [-A]', 'chown [-R] [root:root] [/root/.ssh]']);
        // Its configuration is tested with SetEnv first, then it is started with it.
        expect(r.calls[2]).toMatch(/^sshd \[-t\] \[-o\] \[PermitRootLogin=prohibit-password\] \[-o\] \[PubkeyAuthentication=yes\] \[-o\] \[PasswordAuthentication=no\] \[-o\] \[SetEnv=PATH=[^ \]]+\]$/);
        expect(r.calls[3]).toMatch(/^sshd \[-e\] \[-o\] \[PermitRootLogin=prohibit-password\] \[-o\] \[PubkeyAuthentication=yes\] \[-o\] \[PasswordAuthentication=no\] \[-o\] \[SetEnv=PATH=[^ \]]+\]$/);
        expect(r.calls).toHaveLength(4);
        // The PATH a session gets is the container's own, not the one this adds sshd's directories to.
        expect(r.calls[3]).not.toContain('/usr/sbin');
        expect(r.file('root/.ssh/authorized_keys')).toEqual({ text: `${KEY_A}\n${KEY_B}\n`, mode: '600' });
        expect(r.dirMode('run/sshd')).toMatch(/^7/);
    });

    it('a session has the container\'s LD_LIBRARY_PATH too; search paths this cannot pass on as they are, or an sshd that does not know SetEnv, start it without them', () => {
        const withLibs = runOn(start([KEY_A]), { env: { LD_LIBRARY_PATH: '/usr/local/nvidia/lib64:/opt/lib' } }, { shell, command: ['true'] });
        expect(withLibs.calls[3]).toMatch(/\[SetEnv=PATH=\S+ LD_LIBRARY_PATH=\/usr\/local\/nvidia\/lib64:\/opt\/lib\]$/);
        for (const env of [{ LD_LIBRARY_PATH: '/opt/"quoted"' }, { LD_LIBRARY_PATH: "/opt/it's" }, { LD_LIBRARY_PATH: '/opt/$HOME' }, { LD_LIBRARY_PATH: '/opt/back\\slash' }]) {
            const plain = runOn(start([KEY_A]), { env }, { shell, command: ['true'] });
            expect([plain.status, plain.calls.filter((c) => c.startsWith('sshd'))]).toEqual([0, ['sshd [-e] [-o] [PermitRootLogin=prohibit-password] [-o] [PubkeyAuthentication=yes] [-o] [PasswordAuthentication=no]']]);
        }
        const old = runOn(start([KEY_A]), { setEnv: false }, { shell, command: ['true'] });
        expect(old.status).toBe(0);
        expect(old.calls.filter((c) => c.startsWith('sshd')).map((c) => c.includes(PATHS))).toEqual([true, false]);
        expect(old.calls[3]).toBe('sshd [-e] [-o] [PermitRootLogin=prohibit-password] [-o] [PubkeyAuthentication=yes] [-o] [PasswordAuthentication=no]');
    });

    it('installs OpenSSH where the image has no sshd, with the package manager it has, by the name each has for it', () => {
        const managers: Array<[Tool, string[]]> = [
            ['apt-get', ['apt-get [update] [-y]', 'apt-get [install] [-y] [--no-install-recommends] [openssh-server]']], ['apk', ['apk [add] [--no-cache] [openssh]']],
            ['dnf', ['dnf [install] [-y] [openssh-server]']], ['yum', ['yum [install] [-y] [openssh-server]']],
        ];
        for (const [manager, calls] of managers) {
            const r = runOn(start([KEY_A]), { tools: [manager] }, { shell, command: ['echo', 'up'] });
            expect([r.status, r.stderr, r.stdout]).toEqual([0, '', 'up\n']);
            expect(r.calls.slice(0, calls.length)).toEqual(calls);
            expect(r.calls.filter((c) => c.startsWith('sshd [-e]'))).toHaveLength(1);
        }
    });

    it('a container where no SSH server can be started does not start at all, and says why: no package manager it knows, or one that does not start as root', () => {
        const none = runOn(start([KEY_A]), { tools: [] }, { shell, command: ['echo', 'must not run'] });
        expect([none.status, none.stdout]).toEqual([1, '']);
        expect(none.stderr).toBe('asap-vps: this image has no sshd, and no package manager this knows (apt-get, apk, dnf, yum) to install one with\n'
            + 'asap-vps: no SSH server could be started in this container: it does not start\n');
        const user = runOn(start([KEY_A]), { uid: 1000 }, { shell, command: ['echo', 'must not run'] });
        expect([user.status, user.stdout, user.calls]).toEqual([1, '', []]);
        expect(user.stderr).toBe('asap-vps: an SSH server needs a container that starts as root\nasap-vps: no SSH server could be started in this container: it does not start\n');
    });

    it('a container whose SSH server could not be set up does not start, at whatever step: its keys not written, its host keys not made, sshd not starting. Never up with nobody able to log in', () => {
        // Each is a step `set -e` would have stopped at, were it not ignored where this runs (the left side of `||`).
        const cases: Array<[string, Box, string[]]> = [
            ['no root in the passwd file: nowhere to put the keys', { noRoot: true }, ['asap-vps: no user root on this machine', 'asap-vps: the keys that log in could not be written']],
            ['the keys\' file cannot be made root\'s own', { fail: 'chown' }, ['asap-vps: the keys that log in could not be written']],
            ['no host keys', { fail: 'ssh-keygen' }, ['asap-vps: the SSH server\'s host keys could not be made']],
            ['sshd does not start', { fail: 'sshd' }, []],
        ];
        for (const [what, box, said] of cases) {
            const r = runOn(start([KEY_A]), box, { shell, command: ['echo', 'must not run'] });
            expect([what, r.status, r.stdout]).toEqual([what, 1, '']);
            expect(r.stderr.trim().split('\n')).toEqual([...said, 'asap-vps: no SSH server could be started in this container: it does not start']);
            // Nothing after the step that failed: above all, no sshd started for keys that are not there.
            if (box.fail !== 'sshd') expect(r.calls.filter((c) => c.startsWith('sshd [-e]'))).toEqual([]);
        }
        // The same steps, none failing, on the same box: it starts, and hands over.
        const ok = runOn(start([KEY_A]), {}, { shell, command: ['echo', 'handed over'] });
        expect([ok.status, ok.stdout, ok.stderr]).toEqual([0, 'handed over\n', '']);
    });

    it('the same holds under a caller\'s own `set -e`, and without one: the start script decides, not the shell\'s options', () => {
        for (const prefix of ['', 'set -e\n', 'set -eu\n']) {
            const failed = runOn(`${prefix}${start([KEY_A])}`, { noRoot: true }, { shell, command: ['echo', 'must not run'] });
            expect([prefix, failed.status, failed.stdout]).toEqual([prefix, 1, '']);
            const ok = runOn(`${prefix}${start([KEY_A])}`, {}, { shell, command: ['echo', 'handed over'] });
            expect([prefix, ok.status, ok.stdout]).toEqual([prefix, 0, 'handed over\n']);
        }
    });

    it('a script of the caller\'s own runs after the SSH server and before the command, which keeps its own arguments', () => {
        const script = `${sshdBootScript([KEY_A])}echo "script ran with $#: $1"\nexec "$@"`;
        const r = runOn(script, {}, { shell, command: ['echo', 'then the command'] });
        expect([r.status, r.stdout]).toEqual([0, 'script ran with 2: echo\nthen the command\n']);
    });

    it('needs a key to take: with none there is no one to log in, and no script', () => {
        expect(() => sshdBootScript([])).toThrow(new Error('an SSH server needs a key to take: none was given'));
        expect(() => sshdBootScript(['nope'])).toThrow(/^bad public key "nope"/);
    });
});
