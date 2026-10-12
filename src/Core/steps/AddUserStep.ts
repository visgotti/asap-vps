import type { NodeSSH } from 'node-ssh';
import type { ISetupStep, SetupStepResult, SetupContext } from '../../types';
import { addUserScript, RemoteUser } from '../utils';

/**
 * Makes a user to log in as besides the machine's own login (or brings one
 * that exists to what is asked): the keys that log in as it, and with `sudo`
 * the right to run anything as root with no password. The same on every
 * provider's machines, a VM or a container, and done again changes nothing:
 * what RemoteMachine.addUser does, as a step of a pipeline.
 */
export class AddUserStep implements ISetupStep {
    readonly name = 'add-user';

    constructor(
        private readonly username: string,
        private readonly options: RemoteUser = {},
    ) {}

    async execute(ssh: NodeSSH, _context: SetupContext): Promise<SetupStepResult> {
        try {
            const result = await ssh.execCommand('sh -s', { stdin: addUserScript(this.username, this.options) });
            if (result.code !== 0) return { step: this.name, success: false, message: `Could not make the user ${this.username}`, output: result.stderr };
            return { step: this.name, success: true, message: `User ${this.username} is ready` };
        } catch (err: any) {
            return { step: this.name, success: false, message: err.message };
        }
    }
}
