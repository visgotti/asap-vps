import type { NodeSSH } from 'node-ssh';
import type { ISetupStep, SetupContext } from '../../types';
import { PLATFORM } from '../../constants';
import { InstallDockerStep } from './InstallDockerStep';
import { ConfigureFirewallStep } from './ConfigureFirewallStep';
import { InstallSSLCertificateStep } from './InstallSSLCertificateStep';
import { CreateDirectoryStep } from './CreateDirectoryStep';
import { RunCommandStep } from './RunCommandStep';
import { AddAuthorizedKeyStep } from './AddAuthorizedKeyStep';
import { AddUserStep } from './AddUserStep';
import { testPublicKey } from '../../testing/fakes/util';
import { asRoot } from '../ServerProvisioner';
import { addUserScript, authorizeKeysScript } from '../utils';
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

/** A session that answers `answer` to everything, and keeps each command with what it was given on its input. */
function recordingSSH(answer: Partial<ExecResult> | Error = {}) {
    const sent: Array<{ command: string, stdin?: string }> = [];
    const ssh = {
        execCommand: jest.fn(async (command: string, options?: { stdin?: string }) => {
            sent.push({ command, ...(options?.stdin !== undefined ? { stdin: options.stdin } : {}) });
            if (answer instanceof Error) throw answer;
            return { stdout: '', stderr: '', code: 0, ...answer };
        }),
    } as unknown as NodeSSH;
    return { ssh, sent };
}

describe('AddAuthorizedKeyStep', () => {
    const KEY = testPublicKey('deploy@laptop');

    it('authorizes the key for root, or for the user named, with the one script every way of adding a key runs', async () => {
        for (const [step, user] of [[new AddAuthorizedKeyStep(KEY), 'root'], [new AddAuthorizedKeyStep(`  ${KEY}\n`, 'deploy'), 'deploy']] as const) {
            const { ssh, sent } = recordingSSH();
            expect(await step.execute(ssh, debianContext)).toEqual({ step: 'add-authorized-key', success: true, message: `Public key authorized for ${user}` });
            expect(sent).toEqual([{ command: 'sh -s', stdin: authorizeKeysScript([KEY], user) }]);
        }
    });

    it('fails with what the machine said when it cannot (no such user), and with the reason when the key or the user name is not one: nothing is sent then', async () => {
        const refused = recordingSSH({ code: 1, stderr: 'asap-vps: no user deploy on this machine' });
        expect(await new AddAuthorizedKeyStep(KEY, 'deploy').execute(refused.ssh, debianContext)).toEqual({
            step: 'add-authorized-key', success: false, message: 'Could not authorize the public key for deploy', output: 'asap-vps: no user deploy on this machine',
        });
        const { ssh, sent } = recordingSSH();
        expect(await new AddAuthorizedKeyStep('ssh-rsa AAAA..."; rm -rf /').execute(ssh, debianContext)).toEqual({
            step: 'add-authorized-key', success: false, message: 'bad public key "ssh-rsa AAAA...\\"; rm -rf /": not an OpenSSH public key line (ssh-ed25519 AAAA... comment)',
        });
        expect((await new AddAuthorizedKeyStep(KEY, 'de ploy').execute(ssh, debianContext)).message).toMatch(/^bad user name "de ploy"/);
        expect(sent).toEqual([]);
        const dropped = recordingSSH(new Error('Not connected to server'));
        expect(await new AddAuthorizedKeyStep(KEY).execute(dropped.ssh, debianContext)).toEqual({ step: 'add-authorized-key', success: false, message: 'Not connected to server' });
    });
});

describe('AddUserStep', () => {
    const KEY = testPublicKey('deploy@laptop');

    it('makes the user with what RemoteMachine.addUser makes it with: its keys, sudo and shell, as one script on the input of a shell', async () => {
        const { ssh, sent } = recordingSSH();
        const options = { publicKeys: [KEY], sudo: true, shell: '/bin/bash' };
        expect(await new AddUserStep('deploy', options).execute(ssh, debianContext)).toEqual({ step: 'add-user', success: true, message: 'User deploy is ready' });
        expect(await new AddUserStep('svc').execute(ssh, rhelContext)).toEqual({ step: 'add-user', success: true, message: 'User svc is ready' });
        expect(sent).toEqual([{ command: 'sh -s', stdin: addUserScript('deploy', options) }, { command: 'sh -s', stdin: addUserScript('svc') }]);
    });

    it('fails with what the machine said when it cannot make the user, and with the reason when the name or a key is not one: nothing is sent then', async () => {
        const refused = recordingSSH({ code: 1, stderr: 'asap-vps: this machine has neither useradd nor adduser' });
        expect(await new AddUserStep('deploy').execute(refused.ssh, debianContext)).toEqual({
            step: 'add-user', success: false, message: 'Could not make the user deploy', output: 'asap-vps: this machine has neither useradd nor adduser',
        });
        const { ssh, sent } = recordingSSH();
        expect((await new AddUserStep('Root;id').execute(ssh, debianContext)).message).toMatch(/^bad user name "Root;id"/);
        expect((await new AddUserStep('deploy', { publicKeys: ['nope'] }).execute(ssh, debianContext)).message).toMatch(/^bad public key "nope"/);
        expect(sent).toEqual([]);
        const dropped = recordingSSH(new Error('Not connected to server'));
        expect(await new AddUserStep('deploy').execute(dropped.ssh, debianContext)).toEqual({ step: 'add-user', success: false, message: 'Not connected to server' });
    });

    it('in a pipeline run as a login that is not root, the script goes to a shell root runs: through sudo, its input with it', async () => {
        const { ssh, sent } = recordingSSH();
        expect((await new AddUserStep('deploy', { sudo: true }).execute(asRoot(ssh, 'ubuntu'), debianContext)).success).toBe(true);
        expect(sent).toEqual([{ command: `sudo -n bash -c 'sh -s'`, stdin: addUserScript('deploy', { sudo: true }) }]);
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

/** The commands a mock session was sent, in order. */
const sent = (ssh: NodeSSH): string[] => (ssh.execCommand as jest.Mock).mock.calls.map((c: any[]) => c[0]);

describe('each step, command by command, and the result it reports', () => {
    it('InstallDockerStep installs from apt on debian, from Docker\'s yum repo elsewhere, then enables and starts it and reports the version', async () => {
        const installed = () => {
            let checks = 0;
            return createMockSSH((cmd) => (cmd === 'docker --version' ? (checks++ === 0 ? { code: 1 } : { stdout: 'Docker version 24.0.7' }) : {}));
        };
        const debian = installed();
        expect(await new InstallDockerStep().execute(debian, debianContext)).toEqual({ step: 'install-docker', success: true, message: 'Docker installed', output: 'Docker version 24.0.7' });
        expect(sent(debian)).toEqual(['docker --version', 'apt-get update -y', 'apt-get install -y docker.io', 'systemctl enable docker', 'systemctl start docker', 'docker --version']);
        const rhel = installed();
        await new InstallDockerStep().execute(rhel, rhelContext);
        expect(sent(rhel)).toEqual([
            'docker --version',
            'yum install -y yum-utils',
            'yum-config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo',
            'yum install -y docker-ce docker-ce-cli containerd.io',
            'systemctl enable docker',
            'systemctl start docker',
            'docker --version',
        ]);
        const broken = createMockSSH((cmd) => (cmd === 'docker --version' ? { code: 127, stderr: 'docker: command not found' } : {}));
        expect(await new InstallDockerStep().execute(broken, debianContext)).toEqual({ step: 'install-docker', success: false, message: 'Docker install failed', output: 'docker: command not found' });
    });

    it('ConfigureFirewallStep on debian installs ufw, sets the defaults asked, applies each rule, enables it and reports its status', async () => {
        const ssh = createMockSSH((cmd) => (cmd === 'ufw status' ? { stdout: 'Status: active' } : {}));
        const rules = [{ port: 22, protocol: 'tcp' as const }, { port: 53, protocol: 'udp' as const, allow: false }];
        expect(await new ConfigureFirewallStep(rules).execute(ssh, debianContext)).toEqual({ step: 'configure-firewall', success: true, message: 'UFW configured', output: 'Status: active' });
        expect(sent(ssh)).toEqual(['apt-get install -y ufw', 'ufw default deny incoming', 'ufw default allow outgoing', 'ufw allow 22/tcp', 'ufw deny 53/udp', 'ufw --force enable', 'ufw status']);
        // Without the defaults, ufw keeps its own.
        const bare = createMockSSH();
        await new ConfigureFirewallStep(rules, false, false).execute(bare, debianContext);
        expect(sent(bare)).toEqual(['apt-get install -y ufw', 'ufw allow 22/tcp', 'ufw deny 53/udp', 'ufw --force enable', 'ufw status']);
    });

    it('ConfigureFirewallStep elsewhere installs, enables and starts firewalld, opens and closes each port, reloads it and reports its zone', async () => {
        const ssh = createMockSSH((cmd) => (cmd === 'firewall-cmd --list-all' ? { stdout: 'public (active)' } : {}));
        const rules = [{ port: 22, protocol: 'tcp' as const }, { port: 53, protocol: 'udp' as const, allow: false }];
        expect(await new ConfigureFirewallStep(rules).execute(ssh, rhelContext)).toEqual({ step: 'configure-firewall', success: true, message: 'firewalld configured', output: 'public (active)' });
        expect(sent(ssh)).toEqual([
            'yum install -y firewalld',
            'systemctl enable firewalld',
            'systemctl start firewalld',
            'firewall-cmd --permanent --add-port=22/tcp',
            'firewall-cmd --permanent --remove-port=53/udp',
            'firewall-cmd --reload',
            'firewall-cmd --list-all',
        ]);
    });

    it('InstallSSLCertificateStep writes the certificate and the key through quoted heredocs, makes the key private, and checks both are there', async () => {
        const ssh = createMockSSH((cmd) => (cmd.endsWith('echo "ok"') ? { stdout: 'ok\n' } : {}));
        expect(await new InstallSSLCertificateStep({ certContent: '---CERT---', keyContent: '---KEY---' }).execute(ssh, debianContext))
            .toEqual({ step: 'install-ssl-certificate', success: true, message: 'SSL certificate installed to /etc/ssl/cloudflare' });
        expect(sent(ssh)).toEqual([
            'mkdir -p /etc/ssl/cloudflare',
            "cat > /etc/ssl/cloudflare/cert.pem << 'CERTEOF'\n---CERT---\nCERTEOF",
            "cat > /etc/ssl/cloudflare/key.pem << 'KEYEOF'\n---KEY---\nKEYEOF",
            'chmod 600 /etc/ssl/cloudflare/key.pem',
            'chmod 644 /etc/ssl/cloudflare/cert.pem',
            'test -f /etc/ssl/cloudflare/cert.pem && test -f /etc/ssl/cloudflare/key.pem && echo "ok"',
        ]);
    });

    it('InstallSSLCertificateStep stops at the first write that fails, with its error, and fails when the files are not there after', async () => {
        const config = { certContent: 'c', keyContent: 'k' };
        const cert = createMockSSH((cmd) => (cmd.includes('CERTEOF') ? { code: 1, stderr: 'read-only file system' } : {}));
        expect(await new InstallSSLCertificateStep(config).execute(cert, debianContext))
            .toEqual({ step: 'install-ssl-certificate', success: false, message: 'Failed to write certificate', output: 'read-only file system' });
        expect(sent(cert)).toHaveLength(2);
        const key = createMockSSH((cmd) => (cmd.includes('KEYEOF') ? { code: 1, stderr: 'no space left on device' } : {}));
        expect(await new InstallSSLCertificateStep(config).execute(key, debianContext))
            .toEqual({ step: 'install-ssl-certificate', success: false, message: 'Failed to write key', output: 'no space left on device' });
        expect(sent(key)).toHaveLength(3);
        const missing = createMockSSH();
        expect(await new InstallSSLCertificateStep(config).execute(missing, debianContext))
            .toEqual({ step: 'install-ssl-certificate', success: false, message: 'Certificate files not found after write' });
    });

    it('CreateDirectoryStep reports the directories it made', async () => {
        expect(await new CreateDirectoryStep(['/app', '/data', '/logs']).execute(createMockSSH(), debianContext))
            .toEqual({ step: 'create-directories', success: true, message: 'Created directories: /app, /data, /logs' });
    });

    it('InstallNodeStep installs curl and nvm, then installs, uses and checks the version in one shell that has loaded nvm', async () => {
        const ssh = createMockSSH((cmd) => (cmd.endsWith('node --version') ? { stdout: 'v20.11.0' } : {}));
        expect(await new InstallNodeStep().execute(ssh, debianContext)).toEqual({ step: 'install-node', success: true, message: 'Node --lts installed', output: 'v20.11.0' });
        expect(sent(ssh)).toEqual([
            'apt-get update -y',
            'apt-get install -y curl',
            'curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash',
            'export NVM_DIR="$HOME/.nvm" && [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" && nvm install --lts && nvm use --lts && node --version',
        ]);
        const failing = createMockSSH((cmd) => (cmd.includes('nvm install') ? { code: 3, stderr: 'nvm: command not found' } : {}));
        expect(await new InstallNodeStep('18').execute(failing, rhelContext)).toEqual({ step: 'install-node', success: false, message: 'Node install failed', output: 'nvm: command not found' });
    });

    it('a step whose connection fails mid-way reports the failure as its result, under its default name, never as a throw', async () => {
        const dropped = { execCommand: jest.fn(async () => { throw new Error('Not connected to server'); }) } as unknown as NodeSSH;
        const steps: Array<[string, ISetupStep]> = [
            ['install-docker', new InstallDockerStep()],
            ['configure-firewall', new ConfigureFirewallStep([{ port: 22, protocol: 'tcp' }])],
            ['install-ssl-certificate', new InstallSSLCertificateStep({ certContent: 'c', keyContent: 'k' })],
            ['create-directories', new CreateDirectoryStep(['/app'])],
            ['run-commands', new RunCommandStep(['uptime'])],
            ['add-authorized-key', new AddAuthorizedKeyStep('ssh-ed25519 AAAA')],
            ['install-node', new InstallNodeStep()],
        ];
        for (const [name, step] of steps) {
            expect(await step.execute(dropped, debianContext)).toEqual({ step: name, success: false, message: 'Not connected to server' });
        }
        // The firewall on a RHEL machine too (firewalld, not ufw).
        expect(await new ConfigureFirewallStep([{ port: 22, protocol: 'tcp' }]).execute(dropped, rhelContext)).toEqual({ step: 'configure-firewall', success: false, message: 'Not connected to server' });
    });
});
