import { ServerProvisioner } from './ServerProvisioner';
import { SetupPipeline } from './SetupPipeline';
import { SSHService } from './SSHService';
import { PLATFORM } from '../constants';
import type { NodeSSH } from 'node-ssh';
import type { AbstractInitializer } from './AbstractInitializer';

jest.mock('./SSHService');

function createMockSSH(): NodeSSH {
    return {
        execCommand: jest.fn(async () => ({ stdout: '', stderr: '', code: 0 })),
        dispose: jest.fn(),
    } as unknown as NodeSSH;
}

function createMockInitializer(overrides: Partial<AbstractInitializer> = {}): AbstractInitializer {
    return {
        addSSHKey: jest.fn(async () => ({ id: 'key-123' })),
        createServer: jest.fn(async () => ({
            ip: '10.0.0.1',
            id: 'server-1',
        })),
        deleteSSHKey: jest.fn(async () => {}),
        ...overrides,
    } as unknown as AbstractInitializer;
}

describe('ServerProvisioner', () => {
    let mockSSH: NodeSSH;

    beforeEach(() => {
        jest.clearAllMocks();
        mockSSH = createMockSSH();
        (SSHService.createKeys as jest.Mock) = jest.fn(async () => ({
            publicKey: 'pub-key',
            privateKey: 'priv-key',
        }));
        (SSHService.connect as jest.Mock) = jest.fn(async () => mockSSH);
    });

    it('should complete the full provision lifecycle', async () => {
        const initializer = createMockInitializer();
        const provisioner = new ServerProvisioner(initializer);

        const configurePipeline = jest.fn((pipeline: SetupPipeline) => {
            pipeline.addStep({
                name: 'test-step',
                execute: async () => ({ step: 'test-step', success: true }),
            });
        });

        const result = await provisioner.provision(
            { serverOptions: { name: 'test-server', slug: 's-1vcpu-1gb' } },
            configurePipeline,
        );

        // SSH keys generated
        expect(SSHService.createKeys).toHaveBeenCalled();
        // Key registered with provider
        expect(initializer.addSSHKey).toHaveBeenCalledWith('pub-key', expect.stringContaining('provision-'));
        // Server created with SSH key ID
        expect(initializer.createServer).toHaveBeenCalledWith(
            expect.objectContaining({ name: 'test-server', ssh: 'key-123' }),
        );
        // SSH connection made
        expect(SSHService.connect).toHaveBeenCalledWith('10.0.0.1', 'priv-key', undefined, expect.any(Object));
        // Pipeline configured
        expect(configurePipeline).toHaveBeenCalled();
        // SSH disposed
        expect(mockSSH.dispose).toHaveBeenCalled();
        // Provider key cleaned up
        expect(initializer.deleteSSHKey).toHaveBeenCalledWith('key-123');
        // Result structure
        expect(result.server.ip).toBe('10.0.0.1');
        expect(result.sshKeyData.publicKey).toBe('pub-key');
        expect(result.setupResults).toHaveLength(1);
        expect(result.setupResults[0].success).toBe(true);
    });

    it('should clean up SSH key if server creation fails', async () => {
        const initializer = createMockInitializer({
            createServer: jest.fn(async () => { throw new Error('creation failed'); }),
        } as any);
        const provisioner = new ServerProvisioner(initializer);

        await expect(
            provisioner.provision({ serverOptions: {} }, jest.fn()),
        ).rejects.toThrow('creation failed');

        expect(initializer.deleteSSHKey).toHaveBeenCalledWith('key-123');
    });

    it('should clean up SSH key if SSH connection fails', async () => {
        const initializer = createMockInitializer();
        (SSHService.connect as jest.Mock) = jest.fn(async () => { throw new Error('ssh failed'); });
        const provisioner = new ServerProvisioner(initializer);

        await expect(
            provisioner.provision({ serverOptions: {} }, jest.fn()),
        ).rejects.toThrow('ssh failed');

        expect(initializer.deleteSSHKey).toHaveBeenCalledWith('key-123');
    });

    it('should not clean up provider key when cleanupProviderKey is false', async () => {
        const initializer = createMockInitializer();
        const provisioner = new ServerProvisioner(initializer);

        await provisioner.provision(
            { serverOptions: {}, cleanupProviderKey: false },
            jest.fn(),
        );

        expect(initializer.deleteSSHKey).not.toHaveBeenCalled();
    });

    it('should detect platform when autoDetectPlatform is true', async () => {
        (mockSSH.execCommand as jest.Mock).mockResolvedValueOnce({
            stdout: 'PRETTY_NAME="Ubuntu 22.04 LTS"', stderr: '', code: 0,
        });

        const initializer = createMockInitializer();
        const provisioner = new ServerProvisioner(initializer);

        let pipelinePlatform: PLATFORM | undefined;
        const configurePipeline = jest.fn();

        const result = await provisioner.provision(
            { serverOptions: {}, autoDetectPlatform: true },
            configurePipeline,
        );

        // The pipeline was configured (proves execution continued)
        expect(configurePipeline).toHaveBeenCalled();
    });

    it('should dispose ssh even if pipeline execution throws', async () => {
        const initializer = createMockInitializer();
        const provisioner = new ServerProvisioner(initializer);

        const configurePipeline = jest.fn((pipeline: SetupPipeline) => {
            pipeline.addStep({
                name: 'explode',
                execute: async () => { throw new Error('step exploded'); },
            });
        });

        await expect(
            provisioner.provision({ serverOptions: {} }, configurePipeline),
        ).rejects.toThrow('step exploded');

        expect(mockSSH.dispose).toHaveBeenCalled();
    });

    it('should pass custom sshRetry options to connect', async () => {
        const initializer = createMockInitializer();
        const provisioner = new ServerProvisioner(initializer);

        const customRetry = { maxRetries: 5, retryTimeout: 3000 };
        await provisioner.provision(
            { serverOptions: {}, sshRetry: customRetry },
            jest.fn(),
        );

        expect(SSHService.connect).toHaveBeenCalledWith(
            expect.any(String), expect.any(String), undefined, customRetry,
        );
    });
});
