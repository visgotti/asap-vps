import type { NodeSSH } from 'node-ssh';
import type { SetupContext } from '../../types';
import { PLATFORM } from '../../constants';
import { InstallDockerStep } from './InstallDockerStep';
import { ConfigureFirewallStep } from './ConfigureFirewallStep';
import { InstallSSLCertificateStep } from './InstallSSLCertificateStep';
import { CreateDirectoryStep } from './CreateDirectoryStep';
import { RunCommandStep } from './RunCommandStep';
import { AddAuthorizedKeyStep } from './AddAuthorizedKeyStep';
import { InstallNodeStep } from './InstallNodeStep';

type ExecResult = { stdout: string; stderr: string; code: number };

function createMockSSH(handler?: (cmd: string) => Partial<ExecResult>): NodeSSH {
    return {
        execCommand: jest.fn(async (cmd: string) => {
            const defaults: ExecResult = { stdout: '', stderr: '', code: 0 };
            return handler ? { ...defaults, ...handler(cmd) } : defaults;
        }),
    } as unknown as NodeSSH;
}

const debianContext: SetupContext = {
    platform: PLATFORM.UBUNTU_24,
    platformFamily: 'debian',
    ip: '1.2.3.4',
};

const rhelContext: SetupContext = {
    platform: PLATFORM.CENTOS_9,
    platformFamily: 'rhel',
    ip: '5.6.7.8',
};

describe('InstallDockerStep', () => {
    it('should skip install when docker is already present', async () => {
        const ssh = createMockSSH((cmd) => {
            if (cmd === 'docker --version') return { stdout: 'Docker version 24.0.7', code: 0 };
            return {};
        });
        const step = new InstallDockerStep();
        const result = await step.execute(ssh, debianContext);

        expect(result.success).toBe(true);
        expect(result.message).toContain('already installed');
        // Should only have called docker --version, not apt-get
        expect((ssh.execCommand as jest.Mock).mock.calls).toHaveLength(1);
    });

    it('should install docker on debian using apt-get', async () => {
        let callIdx = 0;
        const ssh = createMockSSH((cmd) => {
            if (cmd === 'docker --version') {
                return callIdx++ === 0
                    ? { code: 1, stderr: 'not found' }
                    : { stdout: 'Docker version 24.0.7', code: 0 };
            }
            return {};
        });
        const step = new InstallDockerStep();
        const result = await step.execute(ssh, debianContext);

        expect(result.success).toBe(true);
        const cmds = (ssh.execCommand as jest.Mock).mock.calls.map((c: any[]) => c[0]);
        expect(cmds).toContain('apt-get update -y');
        expect(cmds).toContain('apt-get install -y docker.io');
        expect(cmds).toContain('systemctl enable docker');
        expect(cmds).toContain('systemctl start docker');
    });

    it('should install docker on rhel using yum', async () => {
        let callIdx = 0;
        const ssh = createMockSSH((cmd) => {
            if (cmd === 'docker --version') {
                return callIdx++ === 0
                    ? { code: 1 }
                    : { stdout: 'Docker version 24.0.7', code: 0 };
            }
            return {};
        });
        const step = new InstallDockerStep();
        const result = await step.execute(ssh, rhelContext);

        expect(result.success).toBe(true);
        const cmds = (ssh.execCommand as jest.Mock).mock.calls.map((c: any[]) => c[0]);
        expect(cmds).toContain('yum install -y yum-utils');
        expect(cmds).toContain('yum install -y docker-ce docker-ce-cli containerd.io');
    });

    it('should return failure when docker verify fails', async () => {
        const ssh = createMockSSH((cmd) => {
            if (cmd === 'docker --version') return { code: 1, stderr: 'failed' };
            return {};
        });
        const step = new InstallDockerStep();
        const result = await step.execute(ssh, debianContext);

        expect(result.success).toBe(false);
    });
});

describe('ConfigureFirewallStep', () => {
    it('should configure UFW on debian platforms', async () => {
        const ssh = createMockSSH((cmd) => {
            if (cmd === 'ufw status') return { stdout: 'Status: active' };
            return {};
        });

        const step = new ConfigureFirewallStep([
            { port: 22, protocol: 'tcp' },
            { port: 80, protocol: 'tcp' },
            { port: 443, protocol: 'tcp' },
        ]);
        const result = await step.execute(ssh, debianContext);

        expect(result.success).toBe(true);
        const cmds = (ssh.execCommand as jest.Mock).mock.calls.map((c: any[]) => c[0]);
        expect(cmds).toContain('ufw default deny incoming');
        expect(cmds).toContain('ufw default allow outgoing');
        expect(cmds).toContain('ufw allow 22/tcp');
        expect(cmds).toContain('ufw allow 80/tcp');
        expect(cmds).toContain('ufw --force enable');
    });

    it('should use deny action when allow is false', async () => {
        const ssh = createMockSSH();
        const step = new ConfigureFirewallStep([{ port: 8080, protocol: 'tcp', allow: false }]);
        await step.execute(ssh, debianContext);

        const cmds = (ssh.execCommand as jest.Mock).mock.calls.map((c: any[]) => c[0]);
        expect(cmds).toContain('ufw deny 8080/tcp');
    });

    it('should configure firewalld on rhel platforms', async () => {
        const ssh = createMockSSH();
        const step = new ConfigureFirewallStep([{ port: 22, protocol: 'tcp' }]);
        const result = await step.execute(ssh, rhelContext);

        expect(result.success).toBe(true);
        const cmds = (ssh.execCommand as jest.Mock).mock.calls.map((c: any[]) => c[0]);
        expect(cmds).toContain('yum install -y firewalld');
        expect(cmds).toContain('firewall-cmd --permanent --add-port=22/tcp');
        expect(cmds).toContain('firewall-cmd --reload');
    });

    it('should remove port on rhel when allow is false', async () => {
        const ssh = createMockSSH();
        const step = new ConfigureFirewallStep([{ port: 3000, protocol: 'tcp', allow: false }]);
        await step.execute(ssh, rhelContext);

        const cmds = (ssh.execCommand as jest.Mock).mock.calls.map((c: any[]) => c[0]);
        expect(cmds).toContain('firewall-cmd --permanent --remove-port=3000/tcp');
    });
});

describe('InstallSSLCertificateStep', () => {
    it('should write cert and key with correct permissions', async () => {
        const ssh = createMockSSH((cmd) => {
            if (cmd.includes('echo "ok"')) return { stdout: 'ok' };
            return {};
        });

        const step = new InstallSSLCertificateStep({
            certContent: '---CERT---',
            keyContent: '---KEY---',
        });
        const result = await step.execute(ssh, debianContext);

        expect(result.success).toBe(true);
        const cmds = (ssh.execCommand as jest.Mock).mock.calls.map((c: any[]) => c[0]);
        expect(cmds).toContain('mkdir -p /etc/ssl/cloudflare');
        expect(cmds.some((c: string) => c.includes('chmod 600'))).toBe(true);
        expect(cmds.some((c: string) => c.includes('chmod 644'))).toBe(true);
    });

    it('should use custom paths when provided', async () => {
        const ssh = createMockSSH((cmd) => {
            if (cmd.includes('echo "ok"')) return { stdout: 'ok' };
            return {};
        });

        const step = new InstallSSLCertificateStep({
            certContent: 'cert',
            keyContent: 'key',
            certPath: '/custom/ssl/cert.pem',
            keyPath: '/custom/ssl/key.pem',
        });
        const result = await step.execute(ssh, debianContext);

        expect(result.success).toBe(true);
        const cmds = (ssh.execCommand as jest.Mock).mock.calls.map((c: any[]) => c[0]);
        expect(cmds).toContain('mkdir -p /custom/ssl');
    });

    it('should return failure when cert write fails', async () => {
        const ssh = createMockSSH((cmd) => {
            if (cmd.includes('CERTEOF')) return { code: 1, stderr: 'write error' };
            return {};
        });

        const step = new InstallSSLCertificateStep({ certContent: 'c', keyContent: 'k' });
        const result = await step.execute(ssh, debianContext);

        expect(result.success).toBe(false);
        expect(result.message).toContain('certificate');
    });
});

describe('CreateDirectoryStep', () => {
    it('should create all listed directories', async () => {
        const ssh = createMockSSH();
        const step = new CreateDirectoryStep(['/app', '/data', '/logs']);
        const result = await step.execute(ssh, debianContext);

        expect(result.success).toBe(true);
        expect(ssh.execCommand).toHaveBeenCalledTimes(3);
        expect(ssh.execCommand).toHaveBeenCalledWith('mkdir -p /app');
        expect(ssh.execCommand).toHaveBeenCalledWith('mkdir -p /data');
        expect(ssh.execCommand).toHaveBeenCalledWith('mkdir -p /logs');
    });

    it('should use custom name when provided', () => {
        const step = new CreateDirectoryStep(['/tmp'], 'create-temp');
        expect(step.name).toBe('create-temp');
    });

    it('should use default name when not provided', () => {
        const step = new CreateDirectoryStep(['/tmp']);
        expect(step.name).toBe('create-directories');
    });
});

describe('RunCommandStep', () => {
    it('should run all commands and collect output', async () => {
        const ssh = createMockSSH((cmd) => {
            if (cmd === 'echo hello') return { stdout: 'hello' };
            if (cmd === 'echo world') return { stdout: 'world' };
            return {};
        });

        const step = new RunCommandStep(['echo hello', 'echo world']);
        const result = await step.execute(ssh, debianContext);

        expect(result.success).toBe(true);
        expect(result.output).toContain('hello');
        expect(result.output).toContain('world');
    });

    it('should fail fast on non-zero exit code', async () => {
        const ssh = createMockSSH((cmd) => {
            if (cmd === 'bad-cmd') return { code: 1, stderr: 'not found' };
            return {};
        });

        const step = new RunCommandStep(['bad-cmd', 'should-not-run']);
        const result = await step.execute(ssh, debianContext);

        expect(result.success).toBe(false);
        expect(result.message).toContain('bad-cmd');
        expect(ssh.execCommand).toHaveBeenCalledTimes(1);
    });

    it('should use custom name', () => {
        const step = new RunCommandStep(['ls'], 'list-files');
        expect(step.name).toBe('list-files');
    });
});

describe('AddAuthorizedKeyStep', () => {
    it('should add public key when not already present', async () => {
        const ssh = createMockSSH((cmd) => {
            if (cmd.includes('grep -F')) return { code: 1, stdout: '' };
            return {};
        });

        const step = new AddAuthorizedKeyStep('ssh-rsa AAAA...');
        const result = await step.execute(ssh, debianContext);

        expect(result.success).toBe(true);
        const cmds = (ssh.execCommand as jest.Mock).mock.calls.map((c: any[]) => c[0]);
        expect(cmds.some((c: string) => c.includes('authorized_keys'))).toBe(true);
        expect(cmds).toContain('mkdir -p /root/.ssh');
        expect(cmds).toContain('chmod 700 /root/.ssh');
    });

    it('should skip adding when key already exists', async () => {
        const ssh = createMockSSH((cmd) => {
            if (cmd.includes('grep -F')) return { code: 0, stdout: 'ssh-rsa AAAA...' };
            return {};
        });

        const step = new AddAuthorizedKeyStep('ssh-rsa AAAA...');
        const result = await step.execute(ssh, debianContext);

        expect(result.success).toBe(true);
        expect(result.message).toContain('already exists');
    });

    it('should use correct home directory for non-root users', async () => {
        const ssh = createMockSSH((cmd) => {
            if (cmd.includes('grep -F')) return { code: 1, stdout: '' };
            return {};
        });

        const step = new AddAuthorizedKeyStep('ssh-rsa AAAA...', 'deploy');
        await step.execute(ssh, debianContext);

        const cmds = (ssh.execCommand as jest.Mock).mock.calls.map((c: any[]) => c[0]);
        expect(cmds).toContain('mkdir -p /home/deploy/.ssh');
    });
});

describe('InstallNodeStep', () => {
    it('should install nvm and node with default --lts', async () => {
        const ssh = createMockSSH((cmd) => {
            if (cmd.includes('node --version')) return { stdout: 'v20.11.0', code: 0 };
            return {};
        });

        const step = new InstallNodeStep();
        const result = await step.execute(ssh, debianContext);

        expect(result.success).toBe(true);
        const cmds = (ssh.execCommand as jest.Mock).mock.calls.map((c: any[]) => c[0]);
        expect(cmds).toContain('apt-get update -y');
        expect(cmds.some((c: string) => c.includes('nvm install --lts'))).toBe(true);
    });

    it('should install specific node version when provided', async () => {
        const ssh = createMockSSH((cmd) => {
            if (cmd.includes('node --version')) return { stdout: 'v18.19.0', code: 0 };
            return {};
        });

        const step = new InstallNodeStep('18');
        const result = await step.execute(ssh, debianContext);

        expect(result.success).toBe(true);
        const cmds = (ssh.execCommand as jest.Mock).mock.calls.map((c: any[]) => c[0]);
        expect(cmds.some((c: string) => c.includes('nvm install 18'))).toBe(true);
    });

    it('should use yum on rhel platforms', async () => {
        const ssh = createMockSSH((cmd) => {
            if (cmd.includes('node --version')) return { stdout: 'v20.11.0', code: 0 };
            return {};
        });

        const step = new InstallNodeStep();
        const result = await step.execute(ssh, rhelContext);

        expect(result.success).toBe(true);
        const cmds = (ssh.execCommand as jest.Mock).mock.calls.map((c: any[]) => c[0]);
        expect(cmds).toContain('yum install -y curl');
    });

    it('should return failure when node install fails', async () => {
        const ssh = createMockSSH((cmd) => {
            if (cmd.includes('nvm install')) return { code: 1, stderr: 'nvm not found' };
            return {};
        });

        const step = new InstallNodeStep();
        const result = await step.execute(ssh, debianContext);

        expect(result.success).toBe(false);
    });
});
