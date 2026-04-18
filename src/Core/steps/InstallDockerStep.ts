import type { NodeSSH } from 'node-ssh';
import type { ISetupStep, SetupStepResult, SetupContext } from '../../types';

export class InstallDockerStep implements ISetupStep {
    readonly name = 'install-docker';

    async execute(ssh: NodeSSH, context: SetupContext): Promise<SetupStepResult> {
        const { platformFamily } = context;

        try {
            const check = await ssh.execCommand('docker --version');
            if (check.code === 0) {
                return { step: this.name, success: true, message: 'Docker already installed', output: check.stdout };
            }

            if (platformFamily === 'debian') {
                await ssh.execCommand('apt-get update -y');
                await ssh.execCommand('apt-get install -y docker.io');
            } else {
                await ssh.execCommand('yum install -y yum-utils');
                await ssh.execCommand('yum-config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo');
                await ssh.execCommand('yum install -y docker-ce docker-ce-cli containerd.io');
            }

            await ssh.execCommand('systemctl enable docker');
            await ssh.execCommand('systemctl start docker');

            const verify = await ssh.execCommand('docker --version');
            if (verify.code !== 0) {
                return { step: this.name, success: false, message: 'Docker install failed', output: verify.stderr };
            }

            return { step: this.name, success: true, message: 'Docker installed', output: verify.stdout };
        } catch (err: any) {
            return { step: this.name, success: false, message: err.message };
        }
    }
}
