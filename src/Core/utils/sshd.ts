// What makes a machine one that can be logged in to, as shell scripts (POSIX
// sh: an image may have no bash): the SSH server a container is given, where
// the platform gives it none (a VM has its image's); and a machine's users and
// the keys each takes, the same on any image family. Each is run as root: at a
// container's start, from a VM's cloud-init, or over a session (RemoteMachine).
// Every value a caller gives is checked first and quoted as one shell word.

import { shellQuote } from './container';
import { parseSSHPublicKey } from './ssh';

/** A name for a user this makes, which every image family takes: a lowercase letter or underscore, then letters, digits, underscores and dashes, 32 in all. */
export const USERNAME = /^[a-z_][a-z0-9_-]{0,31}$/;

/**
 * The name of a login a machine already has: wider than USERNAME, since a
 * machine names its own (capitals and dots on a RHEL family or a
 * directory-backed one: `Admin`, `john.doe`, `jdoe@example.com`). Letters,
 * digits, underscores, dots, dashes and at signs, not beginning with a dash
 * or a dot: nothing a shell, awk or chown reads as anything but a name.
 */
export const LOGIN_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.@-]{0,255}$/;

/** What a user is made with (RemoteMachine.addUser). */
export type RemoteUser = {
    /** The keys that log in as the user (OpenSSH public key lines), added to the ones it has. */
    publicKeys?: string[],
    /** true: the user may run anything as root, with no password; false: that right, if this gave it, is taken back; unset: left as it is. */
    sudo?: boolean,
    /** Its login shell, for a user that is new (default: bash where the machine has it, else sh). */
    shell?: string,
};

/** `name` as the name of a user to make (USERNAME), or the error that says it is not one. */
export function checkUsername(name: string): string {
    if (typeof name !== 'string' || !USERNAME.test(name)) {
        throw new Error(`bad user name ${JSON.stringify(name)}: a lowercase letter or underscore, then letters, digits, underscores and dashes (32 at most)`);
    }
    return name;
}

/** `name` as the name of a login the machine has (LOGIN_NAME), or the error that says it is not one. */
export function checkLoginName(name: string): string {
    if (typeof name !== 'string' || !LOGIN_NAME.test(name)) {
        throw new Error(`bad login name ${JSON.stringify(name)}: letters, digits, underscores, dots, dashes and at signs, not beginning with a dash or a dot`);
    }
    return name;
}

/** authorized_keys' options before a key: `no-pty`, `from="10.0.0.0/8"`, comma-separated, a value in double quotes (sshd(8), AUTHORIZED_KEYS FILE FORMAT). */
const KEY_OPTIONS = /^[A-Za-z-]+(?:="(?:[^"\\]|\\.)*")?(?:,[A-Za-z-]+(?:="(?:[^"\\]|\\.)*")?)*[ \t]+(.+)$/;

/**
 * Each key as its authorized_keys line (one line, trimmed), or the error that
 * says which is not one: an OpenSSH public key, with the options
 * authorized_keys takes before it or without. A text of more than one line is
 * refused, whatever its lines are: each key is one line of the file.
 */
export function checkPublicKeys(publicKeys: readonly string[]): string[] {
    return publicKeys.map((key) => {
        const line = String(key).trim();
        const isKey = (text: string | undefined) => {
            try {
                return text !== undefined && !!parseSSHPublicKey(text);
            } catch {
                return false;
            }
        };
        // A key as it is; else one with options before it (a key's own type is never read as an option: the plain reading comes first).
        if (/[\r\n\0]/.test(line) || !(isKey(line) || isKey(KEY_OPTIONS.exec(line)?.[1]))) {
            throw new Error(`bad public key ${JSON.stringify(String(key).slice(0, 40))}: not an OpenSSH public key line (ssh-ed25519 AAAA... comment)`);
        }
        return line;
    });
}

/**
 * `asap_vps_install <apt name> <apk name> <rpm name>`: a package, by the
 * manager the image has (apt-get, apk, dnf, yum); fails where it has none of them.
 */
const INSTALL = [
    'asap_vps_install() {',
    '    if command -v apt-get >/dev/null 2>&1; then',
    '        DEBIAN_FRONTEND=noninteractive apt-get update -y >/dev/null 2>&1 || true',
    '        DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "$1" >/dev/null',
    '    elif command -v apk >/dev/null 2>&1; then apk add --no-cache "$2" >/dev/null',
    '    elif command -v dnf >/dev/null 2>&1; then dnf install -y "$3" >/dev/null',
    '    elif command -v yum >/dev/null 2>&1; then yum install -y "$3" >/dev/null',
    '    else return 1; fi',
    '}',
];

/**
 * `asap_vps_keys <user> <key>...`: the keys in the user's authorized_keys,
 * each once, the directory and the file the user's own and closed to others
 * (sshd takes no key from a file anyone else can write).
 */
const KEYS = [
    // Each step says for itself that it failed: a shell ignores `set -e` in a function called on the left of `||` (sshdBootScript calls it there).
    'asap_vps_keys() {',
    '    user=$1; shift',
    '    home=$(awk -F: -v u="$user" \'$1 == u { print $6 }\' /etc/passwd)',
    '    [ -n "$home" ] || home=$(getent passwd "$user" 2>/dev/null | cut -d: -f6)',
    '    [ -n "$home" ] || { echo "asap-vps: no user $user on this machine" >&2; return 1; }',
    '    mkdir -p "$home/.ssh" || return 1',
    '    touch "$home/.ssh/authorized_keys" || return 1',
    '    for key in "$@"; do',
    '        grep -qxF -- "$key" "$home/.ssh/authorized_keys" || printf \'%s\\n\' "$key" >> "$home/.ssh/authorized_keys" || return 1',
    '    done',
    '    chmod 700 "$home/.ssh" || return 1',
    '    chmod 600 "$home/.ssh/authorized_keys" || return 1',
    '    chown -R "$user:$(id -gn "$user")" "$home/.ssh" || return 1',
    '}',
];

/**
 * A script that makes `publicKeys` log in as `user` (who must exist: a
 * login of the machine's own, by any name it has), each key once however
 * often it runs: what RemoteMachine.authorizeKeys runs, and
 * what a VM's first boot runs for keys its platform's launch does not take.
 */
export function authorizeKeysScript(publicKeys: readonly string[], user: string): string {
    const keys = checkPublicKeys(publicKeys);
    return ['set -eu', ...KEYS, `asap_vps_keys ${[checkLoginName(user), ...keys].map(shellQuote).join(' ')}`, ''].join('\n');
}

/**
 * A script that makes the user `name`, or brings one that exists to what is
 * asked: its keys (added to the ones it has), and with `sudo` the right to run
 * anything as root with no password (a sudoers file of its own, which `sudo:
 * false` removes; `sudo` itself is installed where the machine has none). A
 * new user has a home and no password: only its keys log in. The same on a
 * Debian, an Alpine or a RHEL family image, a VM or a container, and done
 * again changes nothing.
 */
export function addUserScript(name: string, o: RemoteUser = {}): string {
    const user = shellQuote(checkUsername(name));
    const keys = checkPublicKeys(o.publicKeys ?? []);
    if (o.shell !== undefined && !/^\/[A-Za-z0-9_./-]+$/.test(o.shell)) throw new Error(`bad shell ${JSON.stringify(o.shell)}: the absolute path of one (/bin/bash)`);
    const sudoers = `/etc/sudoers.d/90-asap-vps-${name}`;
    return [
        'set -eu',
        ...INSTALL,
        ...KEYS,
        `user=${user}`,
        `shell=${o.shell ? shellQuote(o.shell) : '$(command -v bash || command -v sh)'}`,
        'if ! id -u "$user" >/dev/null 2>&1; then',
        '    if command -v useradd >/dev/null 2>&1; then useradd -m -s "$shell" "$user"',
        '    elif command -v adduser >/dev/null 2>&1; then adduser -D -s "$shell" "$user"',
        '    else echo "asap-vps: this machine has neither useradd nor adduser" >&2; exit 1; fi',
        // No password is not a locked account: an sshd without PAM (Alpine's) lets no key in to one that is locked ("!").
        '    if command -v usermod >/dev/null 2>&1; then usermod -p \'*\' "$user"',
        // Rewritten in place, with no copy of it left anywhere (and no `sed -i`, which not every sed has).
        '    elif [ -f /etc/shadow ]; then shadow=$(sed "s|^$user:[^:]*:|$user:*:|" /etc/shadow); printf \'%s\\n\' "$shadow" > /etc/shadow; fi',
        'fi',
        `asap_vps_keys "$user"${keys.map((k) => ` ${shellQuote(k)}`).join('')}`,
        ...(o.sudo === true ? [
            'if ! command -v sudo >/dev/null 2>&1; then',
            '    asap_vps_install sudo sudo sudo || { echo "asap-vps: this machine has no sudo, and no package manager this knows (apt-get, apk, dnf, yum) to install it with" >&2; exit 1; }',
            'fi',
            'mkdir -p /etc/sudoers.d',
            `printf '%s ALL=(ALL) NOPASSWD:ALL\\n' "$user" > ${shellQuote(sudoers)}`,
            `chmod 440 ${shellQuote(sudoers)}`,
        ] : o.sudo === false ? [`rm -f ${shellQuote(sudoers)}`] : []),
        '',
    ].join('\n');
}

/**
 * The start of a container that is to be logged in to (sshKeyIds on a
 * container platform, which gives it no SSH server): shell that starts one
 * taking `publicKeys` as root's, and leaves the rest of the start to what
 * follows it (a script, then `exec "$@"`: the container's own command). An
 * sshd the image has is used; where it has none, OpenSSH is installed with
 * the image's package manager (apt-get, apk, dnf, yum). Only keys log in, and
 * a session has the container's own PATH and LD_LIBRARY_PATH (where its sshd
 * can set them), so what the image runs by name a login does too. It needs a
 * container that starts as root; one where no sshd can be started does not
 * start at all, and says why in its log, rather than run where nobody can
 * log in to it.
 */
export function sshdBootScript(publicKeys: readonly string[]): string {
    const keys = checkPublicKeys(publicKeys);
    if (!keys.length) throw new Error('an SSH server needs a key to take: none was given');
    return [
        '# asap-vps: an SSH server for this container (CreateServerOptions.sshKeyIds), started before its command.',
        ...INSTALL,
        ...KEYS,
        // Called on the left of `||` (below), where a shell ignores `set -e`, here and in what this calls: each step that can
        // fail ends it by hand, so a container whose keys were not written is not one that starts with nobody able to log in.
        'asap_vps_sshd() (',
        '    set -u',
        '    [ "$(id -u)" = 0 ] || { echo "asap-vps: an SSH server needs a container that starts as root" >&2; exit 1; }',
        '    PATH="$PATH:/usr/sbin:/sbin"',
        '    if ! command -v sshd >/dev/null 2>&1; then',
        '        asap_vps_install openssh-server openssh openssh-server || { echo "asap-vps: this image has no sshd, and no package manager this knows (apt-get, apk, dnf, yum) to install one with" >&2; exit 1; }',
        '    fi',
        '    sshd=$(command -v sshd) || { echo "asap-vps: OpenSSH was installed, but there is no sshd to run" >&2; exit 1; }',
        // Debian's sshd wants its privilege-separation directory; the host keys are made where the image has none.
        '    mkdir -p /run/sshd || exit 1',
        '    ssh-keygen -A >/dev/null || { echo "asap-vps: the SSH server\'s host keys could not be made" >&2; exit 1; }',
        `    asap_vps_keys root${keys.map((k) => ` ${shellQuote(k)}`).join('')} || { echo "asap-vps: the keys that log in could not be written" >&2; exit 1; }`,
        // On the command line, where they come before whatever the image's own sshd_config says.
        '    set -- -o PermitRootLogin=prohibit-password -o PubkeyAuthentication=yes -o PasswordAuthentication=no',
        // The container's own search paths for a session, where they are plain enough to pass on and this sshd knows SetEnv (OpenSSH 7.8).
        '    env="PATH=$ASAP_VPS_PATH${LD_LIBRARY_PATH:+ LD_LIBRARY_PATH=$LD_LIBRARY_PATH}"',
        '    case "$env" in *[\\"\\\'\\\\\\$]*) ;; *) if "$sshd" -t "$@" -o "SetEnv=$env" >/dev/null 2>&1; then set -- "$@" -o "SetEnv=$env"; fi ;; esac',
        '    "$sshd" -e "$@"',
        ')',
        'ASAP_VPS_PATH=$PATH asap_vps_sshd || { echo "asap-vps: no SSH server could be started in this container: it does not start" >&2; exit 1; }',
        '',
    ].join('\n');
}
