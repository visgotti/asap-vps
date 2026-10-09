// One provisioner for every provider that can rent a VM and register a key:
// a VPS and a GPU server set up the same way, against each provider's fake.

import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { NodeSSH } from 'node-ssh';
import { tmpdir } from 'os';
import { join } from 'path';
import { PLATFORM } from '../constants';
import { NotSupportedError, ProviderError } from '../errors';
import { DigitalOcean } from '../Providers/DigitalOcean/DigitalOcean';
import { LambdaCloud } from '../Providers/LambdaCloud/LambdaCloud';
import { RunPod } from '../Providers/RunPod/RunPod';
import { fakeDigitalOcean } from '../testing/fakes/digitalocean';
import { fakeLambda } from '../testing/fakes/lambda';
import { fakeRunPod } from '../testing/fakes/runpod';
import { FAKE_SCALEWAY_PROJECT, fakeScaleway } from '../testing/fakes/scaleway';
import { Scaleway } from '../Providers/Scaleway/Scaleway';
import { testPublicKey } from '../testing/fakes/util';
import { asRoot, ProvisionError, ProvisionTarget, ServerProvisioner } from './ServerProvisioner';
import { SetupPipeline } from './SetupPipeline';
import { SSHService } from './SSHService';
import { RunCommandStep } from './steps';

const noSleep = async () => {};
const fast = { intervalMs: 0, timeoutMs: 5000 };
const quick = { wait: fast, sshRetry: { maxRetries: 1, retryTimeout: 0 } };

function mockShell(): NodeSSH {
    return {
        execCommand: jest.fn(async (cmd: string) => (cmd.includes('os-release')
            ? { stdout: 'NAME="Ubuntu"\nVERSION_ID="24.04"', stderr: '', code: 0 }
            : { stdout: '', stderr: '', code: 0 })),
        dispose: jest.fn(),
    } as unknown as NodeSSH;
}

describe('ServerProvisioner', () => {
    let shell: NodeSSH;

    beforeEach(() => {
        shell = mockShell();
        jest.spyOn(SSHService, 'createKeys').mockResolvedValue({ publicKey: testPublicKey('provision'), privateKey: 'PRIVATE' });
        jest.spyOn(SSHService, 'connect').mockResolvedValue(shell);
    });
    afterEach(() => jest.restoreAllMocks());

    const digitalOcean = () => {
        const fake = fakeDigitalOcean();
        return { fake, p: new DigitalOcean({ apiKey: 'do-test', fetchImpl: fake.fetchImpl, sleep: noSleep }) };
    };

    it('rents the offer, waits for it, and runs the pipeline over its ssh endpoint; the generated key is used once, then removed', async () => {
        const { p, fake } = digitalOcean();
        const [offer] = await p.listOffers({ kind: 'gpu' });
        const r = await new ServerProvisioner(p).provision({ serverOptions: { name: 'gpu-setup', offer }, ...quick },
            (pipeline) => void pipeline.addStep(new RunCommandStep(['nvidia-smi -L'], 'check-gpu')));
        expect(r.server).toMatchObject({ status: 'running', region: offer.regions[0], ssh: { port: 22, username: 'root' } });
        expect(r.setupResults).toEqual([expect.objectContaining({ step: 'check-gpu', success: true })]);
        expect(SSHService.connect).toHaveBeenCalledWith(expect.objectContaining({ host: r.server.ip, port: 22, username: 'root', privateKey: 'PRIVATE' }));
        expect(shell.execCommand).toHaveBeenCalledWith('nvidia-smi -L');
        expect(shell.dispose).toHaveBeenCalledTimes(1);
        expect(fake.calls.find((c) => c.method === 'POST' && c.path === '/v2/droplets')?.body.ssh_keys).toHaveLength(1);
        expect(await p.listSSHKeys()).toEqual([]);
    });

    it('sets a VPS up the same way: an offer without GPUs, its plain Ubuntu, the same steps', async () => {
        const { p, fake } = digitalOcean();
        const [offer] = await p.listOffers({ kind: 'cpu' });
        expect(offer.gpuCount).toBe(0);
        const r = await new ServerProvisioner(p).provision({ serverOptions: { name: 'web-1', offer }, ...quick },
            (pipeline) => void pipeline.addStep(new RunCommandStep(['uptime'], 'uptime')));
        expect(r.server).toMatchObject({ status: 'running', offerId: offer.id, ssh: { username: 'root' } });
        expect(r.server.gpu).toBeUndefined();
        expect(r.setupResults).toEqual([expect.objectContaining({ step: 'uptime', success: true })]);
        expect(fake.calls.find((c) => c.method === 'POST' && c.path === '/v2/droplets')?.body).toMatchObject({ size: offer.id, image: DigitalOcean.CPU_IMAGE });
        expect(await p.listSSHKeys()).toEqual([]);
    });

    it('cleanupProviderKey false keeps the key on a provider that would delete it by default, and its id comes back', async () => {
        const { p } = digitalOcean();
        const [offer] = await p.listOffers({ kind: 'cpu' });
        const r = await new ServerProvisioner(p).provision({ serverOptions: { name: 'web-2', offer }, cleanupProviderKey: false, ...quick }, () => {});
        const keys = await p.listSSHKeys();
        expect(keys).toHaveLength(1);
        expect(r.providerSshKeyId).toBe(keys[0].id);
    });

    it('runs the steps as root through sudo when the image\'s login is not root (Lambda\'s ubuntu)', async () => {
        const fake = fakeLambda();
        const p = new LambdaCloud({ apiKey: 'lambda-test', fetchImpl: fake.fetchImpl, sleep: noSleep });
        await new ServerProvisioner(p).provision({ serverOptions: { name: 'gpu-setup', offer: 'gpu_1x_a10', region: 'us-east-1' }, ...quick },
            (pipeline) => void pipeline.addStep(new RunCommandStep(["echo 'hi' > /etc/motd"], 'motd')));
        expect(SSHService.connect).toHaveBeenCalledWith(expect.objectContaining({ username: 'ubuntu', port: 22 }));
        expect(shell.execCommand).toHaveBeenCalledWith(`sudo -n bash -c 'echo '\\''hi'\\'' > /etc/motd'`);
        expect(shell.execCommand).toHaveBeenCalledWith(`sudo -n bash -c 'cat /etc/os-release'`);
    });

    it('a failed step deletes the server (verified) and says which step', async () => {
        const { p, fake } = digitalOcean();
        const before = fake.liveServers();
        const [offer] = await p.listOffers({ kind: 'gpu' });
        await expect(new ServerProvisioner(p).provision({ serverOptions: { name: 'gpu-setup', offer }, ...quick }, (pipeline) => void pipeline.addStep({
            name: 'install-driver', execute: async () => ({ step: 'install-driver', success: false, message: 'dkms failed' }),
        }))).rejects.toThrow(/setup step "install-driver" failed: dkms failed/);
        expect(fake.liveServers()).toBe(before);
        expect(await p.listSSHKeys()).toEqual([]);
    });

    it('a server its cleanup could not delete is reported, not left billing unseen: a ProvisionError names it, with the key that logs in', async () => {
        const fake = fakeDigitalOcean();
        // The droplet's DELETE fails for as long as the provision tries.
        const failing = (async (url: string, init?: RequestInit) => ((init?.method === 'DELETE' && /\/v2\/droplets\/\d+$/.test(new URL(url).pathname))
            ? new Response(JSON.stringify({ id: 'server_error', message: 'cannot delete now' }), { status: 500, headers: { 'content-type': 'application/json' } })
            : fake.fetchImpl(url, init))) as typeof fetch;
        const p = new DigitalOcean({ apiKey: 'do-test', fetchImpl: failing, sleep: noSleep });
        const before = fake.liveServers();
        const [offer] = await p.listOffers({ kind: 'cpu' });
        const e = await new ServerProvisioner(p).provision({ serverOptions: { name: 'web-1', offer }, ...quick, wait: { intervalMs: 0, timeoutMs: 50 } },
            (pipeline) => void pipeline.addStep({ name: 'bad', execute: async () => ({ step: 'bad', success: false, message: 'no' }) })).catch((x) => x);
        expect(e).toBeInstanceOf(ProvisionError);
        expect(e).toMatchObject({ kept: false, sshKeyData: { privateKey: 'PRIVATE' }, cause: expect.objectContaining({ message: expect.stringMatching(/setup step "bad" failed/) }) });
        expect(e.message).toMatch(new RegExp(`server ${e.server.id} is not verified deleted .*it may still bill`));
        expect(fake.liveServers()).toBe(before + 1);
        expect((await p.getServer(e.server.id))?.status).toBe('running');
    });

    it('a server still there when the wait for its delete ends is reported as such, after the step that failed (named alone when it gave no message)', async () => {
        const { p } = digitalOcean();
        const [offer] = await p.listOffers({ kind: 'cpu' });
        jest.spyOn(p, 'deleteServerAndWait').mockResolvedValue(false);
        const e = await new ServerProvisioner(p).provision({ serverOptions: { name: 'slow', offer }, ...quick },
            (pipeline) => void pipeline.addStep({ name: 'bad', execute: async () => ({ step: 'bad', success: false }) })).catch((x) => x);
        expect(e).toBeInstanceOf(ProvisionError);
        expect(e.message).toBe(`digitalocean: setup step "bad" failed; and server ${e.server.id} is not verified deleted (still there when the wait ended): it may still bill`);
        expect(e.kept).toBe(false);
        expect('cleanupError' in e).toBe(false);
    });

    it('a running server that reports no ssh endpoint is never dialled: it is deleted, and the provision says why', async () => {
        const { p, fake } = digitalOcean();
        const before = fake.liveServers();
        const [offer] = await p.listOffers({ kind: 'cpu' });
        const running = p.waitUntilRunning.bind(p);
        let id = '';
        jest.spyOn(p, 'waitUntilRunning').mockImplementation(async (serverId, o) => {
            id = serverId;
            return { ...(await running(serverId, o)), ssh: undefined };
        });
        const e = await new ServerProvisioner(p).provision({ serverOptions: { name: 'no-ssh', offer }, ...quick }, () => {}).catch((x) => x);
        // Verified deleted: the failure is thrown as it is.
        expect(e).toBeInstanceOf(ProviderError);
        expect(e).not.toBeInstanceOf(ProvisionError);
        expect(e.message).toBe(`digitalocean: server ${id} is running but reports no ssh endpoint`);
        expect(SSHService.connect).not.toHaveBeenCalled();
        expect(fake.liveServers()).toBe(before);
        expect(await p.listSSHKeys()).toEqual([]);
    });

    it('a failed setup that keeps its server (deleteOnFailure false) says so, with the server and the key pair to log in with', async () => {
        const { p, fake } = digitalOcean();
        const before = fake.liveServers();
        const [offer] = await p.listOffers({ kind: 'cpu' });
        (SSHService.connect as jest.Mock).mockRejectedValueOnce(new Error('connection refused'));
        const e = await new ServerProvisioner(p).provision({ serverOptions: { name: 'kept', offer }, deleteOnFailure: false, ...quick }, () => {}).catch((x) => x);
        expect(e).toBeInstanceOf(ProvisionError);
        expect(e).toMatchObject({ kept: true, sshKeyData: { privateKey: 'PRIVATE' }, cause: expect.objectContaining({ message: 'connection refused' }) });
        expect(e.message).toMatch(/connection refused \(server .* is kept, as deleteOnFailure is false/);
        expect((await p.getServer(e.server.id))?.status).toBe('running');
        expect(fake.liveServers()).toBe(before + 1);
        // DigitalOcean applies a key at creation only: the provider key goes, the server keeps it.
        expect(e.providerSshKeyId).toBeUndefined();
        expect(await p.listSSHKeys()).toEqual([]);
    });

    it('a failure that leaves nothing is thrown as it is: a CapacityError stays one, for the next offer to be tried', async () => {
        const { p } = digitalOcean();
        const e = await new ServerProvisioner(p).provision({ serverOptions: { name: 'x', offer: 's-1vcpu-1gb' }, ...quick }, () => {}).catch((x) => x);
        expect(e).toBeInstanceOf(ProviderError);
        expect(e).not.toBeInstanceOf(ProvisionError);
    });

    it('a server it cannot reach is deleted too; with deleteOnFailure false a failed setup keeps it', async () => {
        let { p, fake } = digitalOcean();
        const before = fake.liveServers();
        const [offer] = await p.listOffers({ kind: 'gpu' });
        (SSHService.connect as jest.Mock).mockRejectedValueOnce(new Error('connection refused'));
        await expect(new ServerProvisioner(p).provision({ serverOptions: { name: 'gpu-setup', offer }, ...quick }, () => {})).rejects.toThrow(/connection refused/);
        expect(fake.liveServers()).toBe(before);
        expect(await p.listSSHKeys()).toEqual([]);

        ({ p, fake } = digitalOcean());
        const r = await new ServerProvisioner(p).provision({ serverOptions: { name: 'gpu-keep', offer }, deleteOnFailure: false, ...quick },
            (pipeline) => void pipeline.addStep({ name: 'bad', execute: async () => ({ step: 'bad', success: false }) }));
        expect(r.setupResults[0].success).toBe(false);
        expect((await p.getServer(r.server.id))?.status).toBe('running');
    });

    describe('where the provider applies its keys at every boot (Scaleway)', () => {
        const scaleway = () => {
            const fake = fakeScaleway();
            return { fake, p: new Scaleway({ apiKey: 'scw-test', projectId: FAKE_SCALEWAY_PROJECT, fetchImpl: fake.fetchImpl, sleep: noSleep }) };
        };
        const keys = async (p: Scaleway) => (await p.listSSHKeys()).filter((k) => k.name === 'provisioned');

        it('keeps the key it registered, and says which: deleting it would lock the server out at its next boot', async () => {
            const { p } = scaleway();
            expect(p.capabilities.sshKeys.appliedAtBoot).toBe(true);
            const r = await new ServerProvisioner(p).provision({ serverOptions: { name: 'kept', offer: 'L4-1-24G', region: 'pl-waw-2' }, sshKeyName: 'provisioned', ...quick }, () => {});
            expect(await keys(p)).toHaveLength(1);
            expect(r.providerSshKeyId).toBe((await keys(p))[0].id);
            // The caller deletes the key once it has deleted the server.
            await p.deleteServerAndWait(r.server.id, fast);
            expect(await p.deleteSSHKey(r.providerSshKeyId!)).toBe(true);
        });

        it('an explicit cleanupProviderKey wins: true deletes it as it always did, false keeps it', async () => {
            const { p } = scaleway();
            const deleted = await new ServerProvisioner(p).provision({ serverOptions: { name: 'a', offer: 'L4-1-24G', region: 'pl-waw-2' }, sshKeyName: 'provisioned', cleanupProviderKey: true, ...quick }, () => {});
            expect(deleted.providerSshKeyId).toBeUndefined();
            expect(await keys(p)).toEqual([]);
            const kept = await new ServerProvisioner(p).provision({ serverOptions: { name: 'b', offer: 'L4-1-24G', region: 'pl-waw-2' }, sshKeyName: 'provisioned', cleanupProviderKey: false, ...quick }, () => {});
            // Kept: the provider holds exactly that key, the one named in the result.
            expect((await keys(p)).map((k) => k.id)).toEqual([kept.providerSshKeyId]);
        });

        it('a server kept after a failure keeps its key too, as one it boots with: the error says which key to delete later', async () => {
            const { p } = scaleway();
            (SSHService.connect as jest.Mock).mockRejectedValueOnce(new Error('connection refused'));
            const e = await new ServerProvisioner(p).provision({ serverOptions: { name: 'kept', offer: 'L4-1-24G', region: 'pl-waw-2' }, sshKeyName: 'provisioned', deleteOnFailure: false, ...quick }, () => {}).catch((x) => x);
            expect(e).toBeInstanceOf(ProvisionError);
            expect(e.providerSshKeyId).toBe((await keys(p))[0].id);
        });

        it('a provision that throws returns no key id, so its key goes with its server', async () => {
            const { p, fake } = scaleway();
            const before = fake.liveServers();
            await expect(new ServerProvisioner(p).provision({ serverOptions: { name: 'failed', offer: 'L4-1-24G', region: 'pl-waw-2' }, sshKeyName: 'provisioned', ...quick }, (pipeline) => void pipeline.addStep({
                name: 'bad', execute: async () => ({ step: 'bad', success: false, message: 'no' }),
            }))).rejects.toThrow(/setup step "bad" failed/);
            expect(fake.liveServers()).toBe(before);
            expect(await keys(p)).toEqual([]);
        });
    });

    it('a container provider has no host to set up: refused before anything is rented', async () => {
        const fake = fakeRunPod();
        const p = new RunPod({ apiKey: 'rp-test', fetchImpl: fake.fetchImpl, sleep: noSleep });
        const before = fake.liveServers();
        await expect(new ServerProvisioner(p as ProvisionTarget).provision({ serverOptions: { name: 'x', offer: 'NVIDIA RTX A5000', image: 'img' } }, () => {}))
            .rejects.toBeInstanceOf(NotSupportedError);
        expect(fake.liveServers()).toBe(before);
        expect(SSHService.createKeys).not.toHaveBeenCalled();
    });

    describe('what every run keeps, whatever the provider', () => {
        it('a create that fails leaves no key behind', async () => {
            const { p } = digitalOcean();
            await expect(new ServerProvisioner(p).provision({ serverOptions: { name: 'x', offer: 's-1vcpu-1gb' }, ...quick }, () => {}))
                .rejects.toThrow(/needs a region/);
            expect(await p.listSSHKeys()).toEqual([]);
            expect(SSHService.connect).not.toHaveBeenCalled();
        });

        it('reads the OS from the server unless told which it is', async () => {
            const { p } = digitalOcean();
            const [offer] = await p.listOffers({ kind: 'cpu' });
            const seen: PLATFORM[] = [];
            const spy = jest.spyOn(SetupPipeline.prototype, 'execute').mockImplementation(async function (this: SetupPipeline) {
                seen.push((this as unknown as { platform: PLATFORM }).platform);
                return [];
            });
            await new ServerProvisioner(p).provision({ serverOptions: { name: 'a', offer }, ...quick }, () => {});
            expect(shell.execCommand).toHaveBeenCalledWith('cat /etc/os-release');
            (shell.execCommand as jest.Mock).mockClear();
            await new ServerProvisioner(p).provision({ serverOptions: { name: 'b', offer }, platform: PLATFORM.DEBIAN_12, ...quick }, () => {});
            expect(shell.execCommand).not.toHaveBeenCalledWith('cat /etc/os-release');
            expect(seen).toEqual([PLATFORM.UBUNTU_24, PLATFORM.DEBIAN_12]);
            spy.mockRestore();
        });

        it('a step that throws ends the session, and the server and key go', async () => {
            const { p, fake } = digitalOcean();
            const before = fake.liveServers();
            const [offer] = await p.listOffers({ kind: 'cpu' });
            await expect(new ServerProvisioner(p).provision({ serverOptions: { name: 'x', offer }, ...quick }, (pipeline) => void pipeline.addStep({
                name: 'explode', execute: async () => { throw new Error('step exploded'); },
            }))).rejects.toThrow('step exploded');
            expect(shell.dispose).toHaveBeenCalledTimes(1);
            expect(fake.liveServers()).toBe(before);
            expect(await p.listSSHKeys()).toEqual([]);
        });

        it('connects with the retry it is given, else with 12 tries 10 s apart', async () => {
            const { p } = digitalOcean();
            const [offer] = await p.listOffers({ kind: 'cpu' });
            const retry = { maxRetries: 5, retryTimeout: 3000 };
            await new ServerProvisioner(p).provision({ serverOptions: { name: 'x', offer }, wait: fast, sshRetry: retry }, () => {});
            expect(SSHService.connect).toHaveBeenCalledWith(expect.objectContaining({ retry }));
            await new ServerProvisioner(p).provision({ serverOptions: { name: 'y', offer }, wait: fast }, () => {});
            expect((SSHService.connect as jest.Mock).mock.calls[1][0].retry).toEqual({ maxRetries: 12, retryTimeout: 10_000 });
        });
    });
});

describe('asRoot: the steps\' connection on a login that is not root', () => {
    /**
     * A real node-ssh client, so its own exec, mkdir, putFiles and putDirectory
     * run, with the server behind it stubbed: the commands it is sent and the
     * paths written over SFTP are recorded.
     */
    const client = (o: { refuse?: RegExp, stderr?: string } = {}) => {
        const commands: Array<[string, unknown?]> = [];
        const written: string[] = [];
        const ssh = new NodeSSH();
        ssh.execCommand = (async (command: string, options?: unknown) => {
            commands.push(options === undefined ? [command] : [command, options]);
            return o.refuse?.test(command) ? { stdout: '', stderr: o.stderr ?? 'mv: cannot move', code: 1, signal: null } : { stdout: '', stderr: '', code: 0, signal: null };
        }) as NodeSSH['execCommand'];
        const sftp = {
            fastPut: (_local: string, remote: string, _options: unknown, done: (e: Error | null) => void) => {
                written.push(remote);
                done(null);
            },
            mkdir: (remote: string, done: (e: Error | null) => void) => {
                written.push(remote);
                done(null);
            },
            end: () => undefined,
        };
        ssh.requestSFTP = (async () => sftp) as unknown as NodeSSH['requestSFTP'];
        return { ssh, commands, written, sent: () => commands.map(([c]) => c) };
    };
    const local = join(tmpdir(), `asap-vps-as-root-${process.pid}`);
    const STAGED = /^\.asap-vps-upload-[0-9a-f]{16}$/;
    /** A path as it stands in a command quoted for `bash -c '...'`. */
    const q = (x: string) => `'\\''${x}'\\''`;

    beforeAll(() => {
        mkdirSync(join(local, 'conf.d'), { recursive: true });
        writeFileSync(join(local, 'app.conf'), 'a');
        writeFileSync(join(local, 'conf.d', 'b.conf'), 'b');
    });
    afterAll(() => rmSync(local, { recursive: true, force: true }));

    it('a root login is used as it is', () => {
        const { ssh } = client();
        expect(asRoot(ssh, 'root')).toBe(ssh);
    });

    it('execCommand runs under sudo, and enters its cwd as root', async () => {
        const { ssh, commands } = client();
        const root = asRoot(ssh, 'ubuntu');
        await root.execCommand('systemctl restart app');
        await root.execCommand('ls', { cwd: '/root/app dir', stdin: 'x' });
        expect(commands).toEqual([
            [`sudo -n bash -c 'systemctl restart app'`],
            [`sudo -n bash -c 'cd ${q('/root/app dir')} && ls'`, { stdin: 'x' }],
        ]);
    });

    it('exec and mkdir go through sudo too: a directory is made as root, never over SFTP as the login', async () => {
        const { ssh, sent, written } = client();
        const root = asRoot(ssh, 'ubuntu');
        await root.exec('systemctl', ['restart', 'my app']);
        await root.mkdir('/etc/app/conf.d');
        await root.mkdir('/etc/app/other', 'sftp');
        expect(sent()).toEqual([
            `sudo -n bash -c 'systemctl restart ${q('my app')}'`,
            // node-ssh quotes an argument with a dot in it.
            `sudo -n bash -c 'mkdir -p ${q('/etc/app/conf.d')}'`,
            `sudo -n bash -c 'mkdir -p /etc/app/other'`,
        ]);
        expect(written).toEqual([]);
    });

    it('putFile uploads as the login, beside its home, then moves the file into place and makes it root\'s, as root', async () => {
        const { ssh, sent, written } = client();
        await asRoot(ssh, 'ubuntu').putFile(join(local, 'app.conf'), '/etc/app/app.conf');
        expect(written).toEqual([expect.stringMatching(STAGED)]);
        expect(sent()).toEqual([`sudo -n bash -c 'mkdir -p -- ${q('/etc/app')} && mv -f -- ${q(written[0])} ${q('/etc/app/app.conf')} && chown root:root -- ${q('/etc/app/app.conf')}'`]);
    });

    it('putFiles and putDirectory place every file and directory as root: nothing is written outside the login\'s home over SFTP', async () => {
        const { ssh, sent, written } = client();
        const root = asRoot(ssh, 'ubuntu');
        await root.putFiles([{ local: join(local, 'app.conf'), remote: '/etc/a.conf' }, { local: join(local, 'conf.d', 'b.conf'), remote: '/etc/b.conf' }]);
        expect(await root.putDirectory(local, '/opt/app')).toBe(true);
        expect(written).toHaveLength(4);
        for (const w of written) expect(w).toMatch(STAGED);
        const ran = sent().join('\n');
        expect(ran).toContain(`mkdir -p ${q('/opt/app/conf.d')}`);
        for (const placed of ['/etc/a.conf', '/etc/b.conf', '/opt/app/app.conf', '/opt/app/conf.d/b.conf']) expect(ran).toContain(`chown root:root -- ${q(placed)}`);
        for (const c of sent()) expect(c).toMatch(/^sudo -n bash -c '/);
    });

    it('a file that cannot be moved into place is an error, and is not left in the login\'s home', async () => {
        const { ssh, sent, written } = client({ refuse: /mv -f/ });
        await expect(asRoot(ssh, 'ubuntu').putFile(join(local, 'app.conf'), '/etc/app/app.conf')).rejects.toThrow('putFile /etc/app/app.conf: mv: cannot move');
        expect(sent().pop()).toBe(`sudo -n bash -c 'rm -f -- ${q(written[0])}'`);
    });

    it('a move that fails without a word is an error that gives its exit code', async () => {
        const { ssh } = client({ refuse: /mv -f/, stderr: '' });
        await expect(asRoot(ssh, 'ubuntu').putFile(join(local, 'app.conf'), '/etc/app/app.conf')).rejects.toThrow(/^putFile \/etc\/app\/app\.conf: exit 1$/);
    });
});
