import type { NodeSSH } from 'node-ssh';
import type { Capable, ComputeTraits, ICompute, ISSHKeys, SSHKeyTraits } from '../capabilities';
import { PLATFORM } from '../constants';
import { NotSupportedError, ProviderError } from '../errors';
import type { CreateServerOptions, PlatformTypes, Server, SetupPipelineOptions, SetupStepResult, SSHKeyData, SSHRetryOptions, WaitOptions } from '../types';
import { SetupPipeline } from './SetupPipeline';
import { SSHService } from './SSHService';
import { shellQuote } from './utils';

/**
 * What a provisioner sets up servers on: a provider that rents servers (VMs,
 * whose OS it can log in to) and registers SSH keys. Any provider with the
 * compute and sshKeys capabilities: DigitalOcean, Scaleway, Lambda, ... A
 * container provider has both too, and is refused at run time (it runs an image).
 */
export type ProvisionTarget<T extends PlatformTypes = PlatformTypes> = ICompute<T> & ISSHKeys & Capable & {
    readonly capabilities: { readonly compute: Readonly<ComputeTraits>, readonly sshKeys: Readonly<SSHKeyTraits> },
};

/**
 * A provision that failed after it made a server, and left that server: kept
 * (deleteOnFailure false) or not verified deleted (its delete failed, or the
 * server outlasted the wait). It may bill. `server` says which it is,
 * `sshKeyData` logs in to it, and `cause` is what failed. A provision that
 * failed and left nothing (no server made, or it is verified gone) throws its
 * failure as it is: a CapacityError stays one, for the next offer to be tried.
 */
export class ProvisionError extends Error {
    readonly server: Server;
    readonly sshKeyData: SSHKeyData;
    /** The key at the provider, when it is kept for the server (cleanupProviderKey false, as on success). */
    readonly providerSshKeyId?: string | number;
    /** true: kept on purpose (deleteOnFailure false); false: its delete did not verify it gone. */
    readonly kept: boolean;
    /** Why the delete did not verify it gone; undefined when kept, or when it outlasted the wait. */
    readonly cleanupError?: unknown;
    readonly cause: unknown;

    constructor(cause: unknown, o: { server: Server, sshKeyData: SSHKeyData, kept: boolean, cleanupError?: unknown, providerSshKeyId?: string | number }) {
        const why = (cause as Error)?.message ?? String(cause);
        super(o.kept
            ? `${why} (server ${o.server.id} is kept, as deleteOnFailure is false: the error's sshKeyData logs in to it)`
            : `${why}; and server ${o.server.id} is not verified deleted (${o.cleanupError !== undefined ? (o.cleanupError as Error).message ?? String(o.cleanupError) : 'still there when the wait ended'}): it may still bill`);
        this.name = 'ProvisionError';
        this.server = o.server;
        this.sshKeyData = o.sshKeyData;
        this.kept = o.kept;
        this.cause = cause;
        if (o.cleanupError !== undefined) this.cleanupError = o.cleanupError;
        if (o.providerSshKeyId !== undefined) this.providerSshKeyId = o.providerSshKeyId;
    }
}

/** What a provision made: the server (running, with its ssh endpoint), its key pair and the setup's results. */
export type ProvisionResult<S = Server> = {
    server: S,
    sshKeyData: SSHKeyData,
    setupResults: SetupStepResult[],
    /** The key's id at the provider, when it was kept (cleanupProviderKey false). */
    providerSshKeyId?: string | number,
}

export type ProvisionOptions<T extends PlatformTypes = PlatformTypes> = {
    /** What to rent. The provisioner authorizes its own key, so no sshKeyIds. */
    serverOptions: Omit<CreateServerOptions<T>, 'sshKeyIds'>,
    sshKeyName?: string,
    /** The OS the steps target (default: read from the server, as images differ by provider). */
    platform?: PLATFORM,
    /** Read the OS from the server (default: true unless `platform` is given). */
    autoDetectPlatform?: boolean,
    pipelineOptions?: SetupPipelineOptions,
    /**
     * Delete the key it registered at the provider once the setup is done.
     * Default: true, except where `capabilities.sshKeys.appliedAtBoot` (Scaleway),
     * since there the provider applies its keys at every boot and deleting this
     * one locks the server out at its next reboot or power-on: the key is kept,
     * and its id comes back as `providerSshKeyId` for the caller to delete once
     * it has deleted the server (meanwhile it is authorized on every server of
     * the account's Project that boots). An explicit value always wins.
     */
    cleanupProviderKey?: boolean,
    sshRetry?: SSHRetryOptions,
    /**
     * How long the server may take to run, and to be deleted again when the
     * provision fails (waitUntilRunning's and deleteServerAndWait's defaults otherwise).
     */
    wait?: WaitOptions,
    /**
     * Delete the server, verified gone, when anything after its create fails,
     * a setup step included (default true: nothing a failed provision made goes
     * on billing). A server it could not verify gone, or one kept as this is
     * false, comes back in a ProvisionError: nothing is left unreported.
     */
    deleteOnFailure?: boolean,
}

/**
 * Rents a server, waits until it runs, then runs a SetupPipeline on it over
 * ssh as the login its image has: the same run for a VPS and a GPU VM, on any
 * provider that can rent one and register a key. Steps expect root: with
 * another login (Lambda's ubuntu) every command goes through sudo. A fresh key
 * pair is made for each run and authorized on the server alone (sshKeyIds).
 */
export class ServerProvisioner<T extends PlatformTypes = PlatformTypes> {
    constructor(private readonly provider: ProvisionTarget<T>) {}

    async provision(
        options: ProvisionOptions<T>,
        configurePipeline: (pipeline: SetupPipeline, server: Server<T['server']>) => void | Promise<void>,
    ): Promise<ProvisionResult<Server<T['server']>>> {
        const p = this.provider;
        if (p.capabilities.compute.kind !== 'vm') {
            throw new NotSupportedError(p.id, 'provisioning over ssh (a container provider runs an image: put the setup in it)');
        }
        const {
            sshKeyName = `provision-${Date.now()}`,
            platform,
            autoDetectPlatform = platform === undefined,
            deleteOnFailure = true,
            cleanupProviderKey = !p.capabilities.sshKeys.appliedAtBoot,
            pipelineOptions = { stopOnFailure: true },
            sshRetry = { maxRetries: 12, retryTimeout: 10_000 },
        } = options;

        const sshKeyData = await SSHService.createKeys();
        const key = await p.addSSHKey(sshKeyData.publicKey, sshKeyName);
        let server: Server<T['server']> | undefined;
        let ssh: NodeSSH | undefined;
        // The key goes, unless a server it logs in to is left for the caller (made, or kept), where cleanupProviderKey says.
        let keepKey = false;
        try {
            server = await p.createServer({ ...options.serverOptions, sshKeyIds: [key.id] } as CreateServerOptions<T>);
            server = await p.waitUntilRunning(server.id, options.wait);
            const endpoint = server.ssh;
            if (!endpoint) throw new ProviderError(p.id, `server ${server.id} is running but reports no ssh endpoint`);
            ssh = await SSHService.connect({ ...endpoint, privateKey: sshKeyData.privateKey, retry: sshRetry });
            const shell = asRoot(ssh, endpoint.username);
            const resolvedPlatform = autoDetectPlatform ? await SetupPipeline.detectPlatform(shell) : platform ?? PLATFORM.UBUNTU_24;
            const pipeline = new SetupPipeline(resolvedPlatform, pipelineOptions);
            await configurePipeline(pipeline, server);
            const ip = server.ip ?? endpoint.host;
            const setupResults = await pipeline.execute(shell, ip, { id: server.id, ip, ipv6: server.ipv6, privateIp: server.privateIp });
            const failed = setupResults.find((r) => !r.success);
            if (failed && deleteOnFailure) {
                throw new ProviderError(p.id, `setup step "${failed.step}" failed${failed.message ? `: ${failed.message}` : ''}`);
            }
            keepKey = !cleanupProviderKey;
            return { server, sshKeyData, setupResults, ...(keepKey ? { providerSshKeyId: key.id } : {}) };
        } catch (e) {
            if (!server) throw e;
            const made = server;
            let cleanupError: unknown;
            if (deleteOnFailure) {
                const gone = await p.deleteServerAndWait(made.id, options.wait).catch((x) => {
                    cleanupError = x;
                    return false;
                });
                // Verified gone: nothing is left of this provision but its failure.
                if (gone) throw e;
            }
            keepKey = !cleanupProviderKey;
            throw new ProvisionError(e, { server: made, sshKeyData, kept: !deleteOnFailure, cleanupError, ...(keepKey ? { providerSshKeyId: key.id } : {}) });
        } finally {
            ssh?.dispose();
            if (!keepKey) await p.deleteSSHKey(key.id).catch(() => false);
        }
    }
}

/**
 * The steps' commands as root: through passwordless sudo when the login is not
 * root (as on Lambda's images).
 */
export function asRoot(ssh: NodeSSH, username: string): NodeSSH {
    if (username === 'root') return ssh;
    return new Proxy(ssh, {
        get(target, prop) {
            if (prop === 'execCommand') {
                return (command: string, opts?: Parameters<NodeSSH['execCommand']>[1]) => (opts === undefined
                    ? target.execCommand(`sudo -n bash -c ${shellQuote(command)}`)
                    : target.execCommand(`sudo -n bash -c ${shellQuote(command)}`, opts));
            }
            const v = Reflect.get(target, prop, target);
            return typeof v === 'function' ? v.bind(target) : v;
        },
    });
}
