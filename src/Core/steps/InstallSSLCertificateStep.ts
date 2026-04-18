import type { NodeSSH } from 'node-ssh';
import type { ISetupStep, SetupStepResult, SetupContext, SSLCertificateConfig } from '../../types';

const DEFAULT_CERT_PATH = '/etc/ssl/cloudflare/cert.pem';
const DEFAULT_KEY_PATH = '/etc/ssl/cloudflare/key.pem';

export class InstallSSLCertificateStep implements ISetupStep {
    readonly name = 'install-ssl-certificate';

    constructor(private readonly config: SSLCertificateConfig) {}

    async execute(ssh: NodeSSH, _context: SetupContext): Promise<SetupStepResult> {
        const certPath = this.config.certPath || DEFAULT_CERT_PATH;
        const keyPath = this.config.keyPath || DEFAULT_KEY_PATH;
        const certDir = certPath.substring(0, certPath.lastIndexOf('/'));

        try {
            await ssh.execCommand(`mkdir -p ${certDir}`);

            // Write cert using heredoc to avoid shell interpolation issues
            const certResult = await ssh.execCommand(
                `cat > ${certPath} << 'CERTEOF'\n${this.config.certContent}\nCERTEOF`
            );
            if (certResult.code !== 0) {
                return { step: this.name, success: false, message: 'Failed to write certificate', output: certResult.stderr };
            }

            const keyResult = await ssh.execCommand(
                `cat > ${keyPath} << 'KEYEOF'\n${this.config.keyContent}\nKEYEOF`
            );
            if (keyResult.code !== 0) {
                return { step: this.name, success: false, message: 'Failed to write key', output: keyResult.stderr };
            }

            await ssh.execCommand(`chmod 600 ${keyPath}`);
            await ssh.execCommand(`chmod 644 ${certPath}`);

            const verify = await ssh.execCommand(`test -f ${certPath} && test -f ${keyPath} && echo "ok"`);
            if (verify.stdout.trim() !== 'ok') {
                return { step: this.name, success: false, message: 'Certificate files not found after write' };
            }

            return { step: this.name, success: true, message: `SSL certificate installed to ${certDir}` };
        } catch (err: any) {
            return { step: this.name, success: false, message: err.message };
        }
    }
}
