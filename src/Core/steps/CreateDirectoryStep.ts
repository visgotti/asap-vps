import type { NodeSSH } from 'node-ssh';
import type { ISetupStep, SetupStepResult, SetupContext } from '../../types';

export class CreateDirectoryStep implements ISetupStep {
    readonly name: string;

    constructor(
        private readonly directories: string[],
        name?: string,
    ) {
        this.name = name || `create-directories`;
    }

    async execute(ssh: NodeSSH, _context: SetupContext): Promise<SetupStepResult> {
        try {
            for (const dir of this.directories) {
                await ssh.execCommand(`mkdir -p ${dir}`);
            }
            return { step: this.name, success: true, message: `Created directories: ${this.directories.join(', ')}` };
        } catch (err: any) {
            return { step: this.name, success: false, message: err.message };
        }
    }
}
