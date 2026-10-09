import type { NodeSSH } from 'node-ssh';
import type { ISetupStep, SetupStepResult, SetupContext, FirewallRule } from '../../types';

export class ConfigureFirewallStep implements ISetupStep {
    readonly name = 'configure-firewall';

    constructor(
        private readonly rules: FirewallRule[],
        private readonly defaultDenyIncoming = true,
        private readonly defaultAllowOutgoing = true,
    ) {}

    async execute(ssh: NodeSSH, context: SetupContext): Promise<SetupStepResult> {
        const { platformFamily } = context;

        try {
            // Awaited here, so a command that fails (a connection that drops) is this catch's, and a result like any step's.
            if (platformFamily === 'debian') {
                return await this.configureUfw(ssh);
            } else {
                return await this.configureFirewalld(ssh);
            }
        } catch (err: any) {
            return { step: this.name, success: false, message: err.message };
        }
    }

    private async configureUfw(ssh: NodeSSH): Promise<SetupStepResult> {
        await ssh.execCommand('apt-get install -y ufw');

        if (this.defaultDenyIncoming) {
            await ssh.execCommand('ufw default deny incoming');
        }
        if (this.defaultAllowOutgoing) {
            await ssh.execCommand('ufw default allow outgoing');
        }

        for (const rule of this.rules) {
            const action = rule.allow !== false ? 'allow' : 'deny';
            await ssh.execCommand(`ufw ${action} ${rule.port}/${rule.protocol}`);
        }

        await ssh.execCommand('ufw --force enable');

        const status = await ssh.execCommand('ufw status');
        return { step: this.name, success: true, message: 'UFW configured', output: status.stdout };
    }

    private async configureFirewalld(ssh: NodeSSH): Promise<SetupStepResult> {
        await ssh.execCommand('yum install -y firewalld');
        await ssh.execCommand('systemctl enable firewalld');
        await ssh.execCommand('systemctl start firewalld');

        for (const rule of this.rules) {
            if (rule.allow !== false) {
                await ssh.execCommand(`firewall-cmd --permanent --add-port=${rule.port}/${rule.protocol}`);
            } else {
                await ssh.execCommand(`firewall-cmd --permanent --remove-port=${rule.port}/${rule.protocol}`);
            }
        }

        await ssh.execCommand('firewall-cmd --reload');

        const status = await ssh.execCommand('firewall-cmd --list-all');
        return { step: this.name, success: true, message: 'firewalld configured', output: status.stdout };
    }
}
