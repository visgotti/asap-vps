import type { NodeSSH } from 'node-ssh';
import type { ISetupStep, SetupStepResult, SetupContext } from '../../types';

export class RunCommandStep implements ISetupStep {
    readonly name: string;

    constructor(
        private readonly commands: string[],
        name?: string,
    ) {
        this.name = name || 'run-commands';
    }

    async execute(ssh: NodeSSH, _context: SetupContext): Promise<SetupStepResult> {
        const outputs: string[] = [];

        try {
            for (const cmd of this.commands) {
                const result = await ssh.execCommand(cmd);
                if (result.stdout) outputs.push(result.stdout);
                if (result.code !== 0 && result.stderr) {
                    return {
                        step: this.name,
                        success: false,
                        message: `Command failed: ${cmd}`,
                        output: result.stderr,
                    };
                }
            }
            return { step: this.name, success: true, message: 'All commands completed', output: outputs.join('\n') };
        } catch (err: any) {
            return { step: this.name, success: false, message: err.message };
        }
    }
}
