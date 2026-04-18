import type { NodeSSH } from 'node-ssh';
import type { ISetupStep, SetupStepResult, SetupContext } from '../../types';

export class InstallNodeStep implements ISetupStep {
    readonly name = 'install-node';

    constructor(
        private readonly nodeVersion = '--lts',
    ) {}

    async execute(ssh: NodeSSH, context: SetupContext): Promise<SetupStepResult> {
        const { platformFamily } = context;

        try {
            // Install dependencies
            if (platformFamily === 'debian') {
                await ssh.execCommand('apt-get update -y');
                await ssh.execCommand('apt-get install -y curl');
            } else {
                await ssh.execCommand('yum install -y curl');
            }

            // Install nvm
            const nvmInstall = await ssh.execCommand(
                'curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash'
            );

            // Source nvm and install node
            const installCmd = [
                'export NVM_DIR="$HOME/.nvm"',
                '[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"',
                `nvm install ${this.nodeVersion}`,
                `nvm use ${this.nodeVersion}`,
                'node --version',
            ].join(' && ');

            const result = await ssh.execCommand(installCmd);
            if (result.code !== 0) {
                return { step: this.name, success: false, message: 'Node install failed', output: result.stderr };
            }

            return { step: this.name, success: true, message: `Node ${this.nodeVersion} installed`, output: result.stdout };
        } catch (err: any) {
            return { step: this.name, success: false, message: err.message };
        }
    }
}
