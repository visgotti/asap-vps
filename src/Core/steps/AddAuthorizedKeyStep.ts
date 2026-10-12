import type { NodeSSH } from 'node-ssh';
import type { ISetupStep, SetupStepResult, SetupContext } from '../../types';
import { authorizeKeysScript } from '../utils';

/**
 * Makes a public key one that logs in as `user` (who must exist: AddUserStep
 * makes one), once however often it runs. The user's home is the one the
 * machine says it has, and the key file is left the user's own.
 */
export class AddAuthorizedKeyStep implements ISetupStep {
    readonly name = 'add-authorized-key';

    constructor(
        private readonly publicKey: string,
        private readonly user = 'root',
    ) {}

    async execute(ssh: NodeSSH, _context: SetupContext): Promise<SetupStepResult> {
        try {
            const result = await ssh.execCommand('sh -s', { stdin: authorizeKeysScript([this.publicKey], this.user) });
            if (result.code !== 0) return { step: this.name, success: false, message: `Could not authorize the public key for ${this.user}`, output: result.stderr };
            return { step: this.name, success: true, message: `Public key authorized for ${this.user}` };
        } catch (err: any) {
            return { step: this.name, success: false, message: err.message };
        }
    }
}
