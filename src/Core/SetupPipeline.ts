import type { NodeSSH } from 'node-ssh';
import { PLATFORM, PLATFORM_FAMILY } from '../constants';
import type { ISetupStep, SetupStepResult, SetupContext, SetupPipelineOptions, CreatedServerData } from '../types';

export class SetupPipeline {
    private steps: ISetupStep[] = [];

    constructor(
        private readonly platform: PLATFORM,
        private readonly options: SetupPipelineOptions = {},
    ) {}

    addStep(step: ISetupStep): this {
        this.steps.push(step);
        return this;
    }

    addSteps(steps: ISetupStep[]): this {
        this.steps.push(...steps);
        return this;
    }

    getSteps(): readonly ISetupStep[] {
        return this.steps;
    }

    async execute(ssh: NodeSSH, ip: string, serverData?: CreatedServerData): Promise<SetupStepResult[]> {
        const context: SetupContext = {
            platform: this.platform,
            platformFamily: PLATFORM_FAMILY[this.platform],
            ip,
            serverData,
        };

        const results: SetupStepResult[] = [];

        for (const step of this.steps) {
            this.options.onStepStart?.(step.name);

            const result = await step.execute(ssh, context);
            results.push(result);

            this.options.onStepComplete?.(result);

            if (!result.success && this.options.stopOnFailure) {
                break;
            }
        }

        return results;
    }

    static async detectPlatform(ssh: NodeSSH): Promise<PLATFORM> {
        const result = await ssh.execCommand('cat /etc/os-release');
        const osRelease = (result.stdout || '').toLowerCase();

        if (osRelease.includes('ubuntu')) {
            if (osRelease.includes('24.')) return PLATFORM.UBUNTU_24;
            if (osRelease.includes('22.')) return PLATFORM.UBUNTU_22;
            if (osRelease.includes('20.')) return PLATFORM.UBUNTU_20;
        }
        if (osRelease.includes('debian')) {
            if (osRelease.includes('12')) return PLATFORM.DEBIAN_12;
            if (osRelease.includes('11')) return PLATFORM.DEBIAN_11;
        }
        if (osRelease.includes('rocky')) {
            if (/\s9[.\s"]/.test(osRelease)) return PLATFORM.ROCKY_9;
            return PLATFORM.ROCKY_8;
        }
        if (osRelease.includes('almalinux')) {
            if (/\s9[.\s"]/.test(osRelease)) return PLATFORM.ALMA_9;
            return PLATFORM.ALMA_8;
        }
        if (osRelease.includes('centos')) {
            if (/\s9[.\s"]/.test(osRelease)) return PLATFORM.CENTOS_9;
            return PLATFORM.CENTOS_7;
        }
        if (osRelease.includes('fedora')) {
            return PLATFORM.FEDORA;
        }

        // Default fallback
        return PLATFORM.UBUNTU_24;
    }
}
