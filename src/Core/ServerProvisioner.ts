import type { NodeSSH } from 'node-ssh';
import { PLATFORM } from '../constants';
import { AbstractInitializer } from './AbstractInitializer';
import { SSHService } from './SSHService';
import { SetupPipeline } from './SetupPipeline';
import type { ChosenServerCreationOption, CreatedServerData, SetupStepResult, SetupPipelineOptions } from '../types';

export type ProvisionResult = {
    server: CreatedServerData,
    sshKeyData: { publicKey: string, privateKey: string },
    setupResults: SetupStepResult[],
    providerSshKeyId?: string | number,
}

export type ProvisionOptions = {
    serverOptions: ChosenServerCreationOption,
    sshKeyName?: string,
    platform?: PLATFORM,
    autoDetectPlatform?: boolean,
    pipelineOptions?: SetupPipelineOptions,
    cleanupProviderKey?: boolean,
    sshRetry?: { maxRetries: number, retryTimeout: number },
}

export class ServerProvisioner {
    constructor(
        private readonly initializer: AbstractInitializer,
    ) {}

    async provision(
        options: ProvisionOptions,
        configurePipeline: (pipeline: SetupPipeline, server: CreatedServerData) => void | Promise<void>,
    ): Promise<ProvisionResult> {
        const {
            serverOptions,
            sshKeyName = `provision-${Date.now()}`,
            platform = PLATFORM.UBUNTU_24,
            autoDetectPlatform = false,
            pipelineOptions = { stopOnFailure: true },
            cleanupProviderKey = true,
            sshRetry = { maxRetries: 12, retryTimeout: 10000 },
        } = options;

        // 1. Generate SSH keys
        const sshKeyData = await SSHService.createKeys();

        // 2. Register public key with the provider
        const providerKey = await this.initializer.addSSHKey(sshKeyData.publicKey, sshKeyName);

        let server: CreatedServerData;
        try {
            // 3. Create the server
            server = await this.initializer.createServer({
                ...serverOptions,
                ssh: providerKey.id,
            });
        } catch (err) {
            // Cleanup: remove the SSH key from the provider if server creation fails
            if (cleanupProviderKey) {
                await this.initializer.deleteSSHKey(providerKey.id).catch(() => {});
            }
            throw err;
        }

        // 4. Connect via SSH
        let ssh: NodeSSH;
        try {
            ssh = await SSHService.connect(server.ip, sshKeyData.privateKey, undefined, sshRetry);
        } catch (err) {
            if (cleanupProviderKey) {
                await this.initializer.deleteSSHKey(providerKey.id).catch(() => {});
            }
            throw err;
        }

        // 5. Detect platform if requested
        let resolvedPlatform = platform;
        if (autoDetectPlatform) {
            resolvedPlatform = await SetupPipeline.detectPlatform(ssh);
        }

        // 6. Build and run the setup pipeline
        const pipeline = new SetupPipeline(resolvedPlatform, pipelineOptions);
        await configurePipeline(pipeline, server);

        let setupResults: SetupStepResult[];
        try {
            setupResults = await pipeline.execute(ssh, server.ip, server);
        } finally {
            await ssh.dispose();
        }

        // 7. Cleanup provider SSH key if requested
        if (cleanupProviderKey) {
            await this.initializer.deleteSSHKey(providerKey.id).catch(() => {});
        }

        return {
            server,
            sshKeyData,
            setupResults,
            providerSshKeyId: cleanupProviderKey ? undefined : providerKey.id,
        };
    }
}
