// A machine behind SSH, whichever provider rented it: one way to get a
// session on any server (`RemoteMachine.connect(server, { privateKey })`, the
// server's `ssh` endpoint being where and as whom), and the same few things to
// do there: run a command as the login or as root, read and write files, make
// a user and give it keys, and log in as that user. A VM and a container, a
// root login and a sudoer's (Lambda's `ubuntu`), read alike. The session
// itself (`ssh`, node-ssh's) is there for what this has no word for.

import type { NodeSSH } from 'node-ssh';
import { RemoteCommandError } from '../errors';
import type { Server, SSHEndpoint, SSHRetryOptions } from '../types';
import { asRoot } from './ServerProvisioner';
import { SSHService } from './SSHService';
import { addUserScript, authorizeKeysScript, checkUsername, RemoteUser, shellQuote } from './utils';

/** What a login needs besides where to: the private key of a key the machine takes. */
export type RemoteLogin = {
    privateKey: string,
    /** Whom to log in as (default: the endpoint's own login, `server.ssh.username`: root, or ubuntu on Lambda). */
    username?: string,
    /** Decrypts `privateKey` when it is stored encrypted (SSHService.initKeys with an encryptionKey). */
    decryptionKey?: string,
    /** How often to try, and how long apart (default 10 tries, 5 s apart): a machine that has just come up may not take logins yet. */
    retry?: SSHRetryOptions,
};

/** How a command is run. */
export type RunOptions = {
    /** The directory it runs in. */
    cwd?: string,
    /** Environment variables for it (names of letters, digits and underscores). */
    env?: Record<string, string>,
    /** What it reads on its standard input. */
    stdin?: string,
    /** false: a command that does not exit 0 is returned, not thrown (default true: it throws RemoteCommandError). */
    check?: boolean,
};

/** How a command ended, and what it wrote (trailing line breaks trimmed). */
export type RunResult = {
    stdout: string,
    stderr: string,
    /** Its exit status; null when a signal ended it. */
    code: number | null,
};

/** How a file is written (RemoteMachine.writeFile). */
export type WriteFileOptions = {
    /** Its mode, as chmod takes it ('600', 'u=rw,go='). */
    mode?: string,
    /** Its owner, as chown takes it ('deploy', 'deploy:www-data'): needs root. */
    owner?: string,
    /** Written as root (default: when `owner` is given, or the login is root). */
    sudo?: boolean,
};

export class RemoteMachine {
    /** Where the session is, and whom it is logged in as. */
    readonly endpoint: Readonly<SSHEndpoint>;

    /**
     * A session someone else opened, as a RemoteMachine: `ssh` is node-ssh's
     * (SSHService.connect), `endpoint` where it is and whom it is logged in as.
     */
    constructor(readonly ssh: NodeSSH, endpoint: SSHEndpoint) {
        this.endpoint = Object.freeze({ ...endpoint });
    }

    /**
     * Logs in to a server of any provider (its `ssh` endpoint: it must run,
     * and have been created with a key this is the private half of), or to an
     * endpoint given as it is. As the endpoint's own login unless
     * `login.username` names another (a user made with addUser).
     */
    static async connect(target: Server<any> | SSHEndpoint, login: RemoteLogin): Promise<RemoteMachine> {
        const server = 'host' in target ? undefined : target;
        const endpoint = server ? server.ssh : target as SSHEndpoint;
        if (!endpoint) {
            throw new Error(`${server!.provider}: server ${server!.id} reports no ssh endpoint: wait until it runs (waitUntilRunning), and create it with sshKeyIds`);
        }
        const username = login.username === undefined ? endpoint.username : checkUsername(login.username);
        const to: SSHEndpoint = { host: endpoint.host, port: endpoint.port, username };
        const ssh = await SSHService.connect({
            ...to, privateKey: login.privateKey,
            ...(login.decryptionKey !== undefined ? { decryptionKey: login.decryptionKey } : {}), ...(login.retry ? { retry: login.retry } : {}),
        });
        return new RemoteMachine(ssh, to);
    }

    /** Whom the session is logged in as. */
    get username(): string {
        return this.endpoint.username;
    }

    /** `<user>@<host>`, as errors name the session. */
    get login(): string {
        return `${this.endpoint.username}@${this.endpoint.host}`;
    }

    /**
     * The session with everything done as root: its commands and uploads go
     * through passwordless sudo where the login is not root (asRoot), and as
     * they are where it is. What a SetupPipeline's steps run on.
     */
    get root(): NodeSSH {
        return asRoot(this.ssh, this.endpoint.username);
    }

    /**
     * Runs a shell command as the login, and returns what it wrote. One that
     * does not exit 0 throws RemoteCommandError (with its output), unless
     * `check` is false.
     */
    async run(command: string, o: RunOptions = {}): Promise<RunResult> {
        return this.exec(command, RemoteMachine.scripted(command, o), o);
    }

    /**
     * Runs a shell command as root: as it is where the login is root, through
     * passwordless sudo where it is not (a login that may not is refused by
     * sudo, which the error says).
     */
    async sudo(command: string, o: RunOptions = {}): Promise<RunResult> {
        const script = RemoteMachine.scripted(command, o);
        return this.exec(command, this.endpoint.username === 'root' ? script : `sudo -n sh -c ${shellQuote(script)}`, o);
    }

    /** A text file's contents, read as the login (or as root with `sudo`). One that cannot be read throws. */
    async readFile(path: string, o: { sudo?: boolean } = {}): Promise<string> {
        const read = `cat -- ${shellQuote(path)}`;
        // As it is, to its last line break: nothing of the file is trimmed.
        const r = await this.ssh.execCommand(o.sudo && this.endpoint.username !== 'root' ? `sudo -n sh -c ${shellQuote(read)}` : read, { noTrim: true });
        return this.checked(read, r, true).stdout;
    }

    /**
     * Writes a text file, replacing what is there (its directory must exist),
     * with a mode and an owner where given. The text goes over the session's
     * input, never into a command line: any text is written as it is.
     */
    async writeFile(path: string, content: string, o: WriteFileOptions = {}): Promise<void> {
        const file = shellQuote(path);
        // `--` before the mode and the owner: where every chmod and chown takes it (BSD's and busybox's as GNU's).
        const write = [`cat > ${file}`, ...(o.mode !== undefined ? [`chmod -- ${shellQuote(o.mode)} ${file}`] : []), ...(o.owner !== undefined ? [`chown -- ${shellQuote(o.owner)} ${file}`] : [])].join(' && ');
        const asRootToo = o.sudo ?? o.owner !== undefined;
        await (asRootToo ? this.sudo(write, { stdin: content }) : this.run(write, { stdin: content }));
    }

    /** Copies a local file to the machine, as the login (over SFTP). */
    async upload(localPath: string, remotePath: string): Promise<void> {
        await this.ssh.putFile(localPath, remotePath);
    }

    /** Copies a file of the machine to a local path, as the login (over SFTP). */
    async download(remotePath: string, localPath: string): Promise<void> {
        await this.ssh.getFile(localPath, remotePath);
    }

    /**
     * Makes a user (or brings one that exists to what is asked): the keys that
     * log in as it, and with `sudo` the right to run anything as root with no
     * password. Needs root (the login's, or its sudo). The same on every image
     * family, a VM or a container, and done again changes nothing: log in as
     * the user with `as(name, ...)`.
     */
    async addUser(name: string, o: RemoteUser = {}): Promise<void> {
        await this.sudo('sh -s', { stdin: addUserScript(name, o) });
    }

    /**
     * Adds keys (OpenSSH public key lines) to the ones that log in as `user`
     * (default: the login itself), each once. Another user's need root.
     */
    async authorizeKeys(publicKeys: string[], user: string = this.endpoint.username): Promise<void> {
        const script = authorizeKeysScript(publicKeys, user);
        await (user === this.endpoint.username ? this.run('sh -s', { stdin: script }) : this.sudo('sh -s', { stdin: script }));
    }

    /** A second session to the same machine as another user (one of its keys' private half), this one left open. */
    as(username: string, login: Omit<RemoteLogin, 'username'>): Promise<RemoteMachine> {
        return RemoteMachine.connect(this.endpoint, { ...login, username });
    }

    /** Ends the session. */
    async close(): Promise<void> {
        await this.ssh.dispose();
    }

    /** `command` with its directory and environment, as one shell script. */
    private static scripted(command: string, o: RunOptions): string {
        const env = Object.entries(o.env ?? {}).map(([k, v]) => {
            if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw new Error(`bad environment variable name ${JSON.stringify(k)}`);
            return `export ${k}=${shellQuote(String(v))}`;
        });
        return [...(o.cwd !== undefined ? [`cd ${shellQuote(o.cwd)}`] : []), ...env, command].join(' && ');
    }

    private async exec(command: string, script: string, o: RunOptions): Promise<RunResult> {
        const r = await this.ssh.execCommand(script, o.stdin !== undefined ? { stdin: o.stdin } : {});
        return this.checked(command, r, o.check !== false);
    }

    /** What a command returned, or the error of one that did not exit 0. */
    private checked(command: string, r: { stdout: string, stderr: string, code: number | null, signal?: string | null }, check: boolean): RunResult {
        if (check && r.code !== 0) throw new RemoteCommandError(this.login, command, r);
        return { stdout: r.stdout, stderr: r.stderr, code: r.code };
    }
}
