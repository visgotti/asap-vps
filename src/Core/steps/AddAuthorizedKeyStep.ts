import type { NodeSSH } from 'node-ssh';
import type { ISetupStep, SetupStepResult, SetupContext } from '../../types';

export class AddAuthorizedKeyStep implements ISetupStep {
    readonly name = 'add-authorized-key';

    constructor(
        private readonly publicKey: string,
        private readonly user = 'root',
    ) {}

    async execute(ssh: NodeSSH, _context: SetupContext): Promise<SetupStepResult> {
        try {
            const home = this.user === 'root' ? '/root' : `/home/${this.user}`;
            const sshDir = `${home}/.ssh`;

            await ssh.execCommand(`mkdir -p ${sshDir}`);
            await ssh.execCommand(`chmod 700 ${sshDir}`);

            // Check if key already exists to avoid duplicates
            const existing = await ssh.execCommand(`grep -F "${this.publicKey.trim()}" ${sshDir}/authorized_keys 2>/dev/null`);
            if (existing.code === 0 && existing.stdout.trim()) {
                return { step: this.name, success: true, message: 'Key already exists in authorized_keys' };
            }

            await ssh.execCommand(`echo "${this.publicKey.trim()}" >> ${sshDir}/authorized_keys`);
            await ssh.execCommand(`chmod 600 ${sshDir}/authorized_keys`);

            return { step: this.name, success: true, message: `Public key added for ${this.user}` };
        } catch (err: any) {
            return { step: this.name, success: false, message: err.message };
        }
    }
}
