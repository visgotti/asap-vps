import { SetupPipeline } from './SetupPipeline';
import { PLATFORM } from '../constants';
import type { NodeSSH } from 'node-ssh';
import type { ISetupStep, SetupStepResult, SetupContext } from '../types';

function createMockSSH(execResults: Record<string, { stdout: string; stderr: string; code: number }> = {}): NodeSSH {
    return {
        execCommand: jest.fn(async (cmd: string) => {
            return execResults[cmd] ?? { stdout: '', stderr: '', code: 0 };
        }),
    } as unknown as NodeSSH;
}

function createMockStep(name: string, result: Partial<SetupStepResult> = {}): ISetupStep {
    return {
        name,
        execute: jest.fn(async () => ({
            step: name,
            success: true,
            ...result,
        })),
    };
}

describe('SetupPipeline', () => {
    describe('addStep / addSteps / getSteps', () => {
        it('should add a single step', () => {
            const pipeline = new SetupPipeline(PLATFORM.UBUNTU_24);
            const step = createMockStep('step-1');
            pipeline.addStep(step);

            expect(pipeline.getSteps()).toHaveLength(1);
            expect(pipeline.getSteps()[0]).toBe(step);
        });

        it('should support fluent chaining', () => {
            const pipeline = new SetupPipeline(PLATFORM.UBUNTU_24);
            const result = pipeline.addStep(createMockStep('a')).addStep(createMockStep('b'));

            expect(result).toBe(pipeline);
            expect(pipeline.getSteps()).toHaveLength(2);
        });

        it('should add multiple steps at once', () => {
            const pipeline = new SetupPipeline(PLATFORM.UBUNTU_24);
            const steps = [createMockStep('a'), createMockStep('b'), createMockStep('c')];
            pipeline.addSteps(steps);

            expect(pipeline.getSteps()).toHaveLength(3);
        });
    });

    describe('execute', () => {
        it('should execute all steps in order and return results', async () => {
            const pipeline = new SetupPipeline(PLATFORM.UBUNTU_22);
            const step1 = createMockStep('step-1');
            const step2 = createMockStep('step-2');
            pipeline.addSteps([step1, step2]);

            const ssh = createMockSSH();
            const results = await pipeline.execute(ssh, '1.2.3.4');

            expect(results).toHaveLength(2);
            expect(results[0]).toEqual({ step: 'step-1', success: true });
            expect(results[1]).toEqual({ step: 'step-2', success: true });

            // Verify context passed to steps
            const context = (step1.execute as jest.Mock).mock.calls[0][1] as SetupContext;
            expect(context.platform).toBe(PLATFORM.UBUNTU_22);
            expect(context.platformFamily).toBe('debian');
            expect(context.ip).toBe('1.2.3.4');
        });

        it('should pass serverData in context when provided', async () => {
            const pipeline = new SetupPipeline(PLATFORM.CENTOS_9);
            const step = createMockStep('check');
            pipeline.addStep(step);

            const ssh = createMockSSH();
            const serverData = { ip: '10.0.0.1', id: 'srv-1' };
            await pipeline.execute(ssh, '10.0.0.1', serverData);

            const context = (step.execute as jest.Mock).mock.calls[0][1] as SetupContext;
            expect(context.platformFamily).toBe('rhel');
            expect(context.serverData).toBe(serverData);
        });

        it('should stop on failure when stopOnFailure is true', async () => {
            const pipeline = new SetupPipeline(PLATFORM.UBUNTU_24, { stopOnFailure: true });
            const step1 = createMockStep('fail', { success: false, message: 'boom' });
            const step2 = createMockStep('never-runs');
            pipeline.addSteps([step1, step2]);

            const results = await pipeline.execute(createMockSSH(), '1.2.3.4');

            expect(results).toHaveLength(1);
            expect(results[0].success).toBe(false);
            expect(step2.execute).not.toHaveBeenCalled();
        });

        it('should continue past failures when stopOnFailure is false', async () => {
            const pipeline = new SetupPipeline(PLATFORM.UBUNTU_24, { stopOnFailure: false });
            const step1 = createMockStep('fail', { success: false });
            const step2 = createMockStep('still-runs');
            pipeline.addSteps([step1, step2]);

            const results = await pipeline.execute(createMockSSH(), '1.2.3.4');

            expect(results).toHaveLength(2);
            expect(step2.execute).toHaveBeenCalled();
        });

        it('should call onStepStart and onStepComplete callbacks', async () => {
            const onStepStart = jest.fn();
            const onStepComplete = jest.fn();
            const pipeline = new SetupPipeline(PLATFORM.UBUNTU_24, { onStepStart, onStepComplete });
            pipeline.addSteps([createMockStep('a'), createMockStep('b')]);

            await pipeline.execute(createMockSSH(), '1.2.3.4');

            expect(onStepStart).toHaveBeenCalledTimes(2);
            expect(onStepStart).toHaveBeenNthCalledWith(1, 'a');
            expect(onStepStart).toHaveBeenNthCalledWith(2, 'b');

            expect(onStepComplete).toHaveBeenCalledTimes(2);
            expect(onStepComplete.mock.calls[0][0].step).toBe('a');
            expect(onStepComplete.mock.calls[1][0].step).toBe('b');
        });

        it('should return empty results for empty pipeline', async () => {
            const pipeline = new SetupPipeline(PLATFORM.UBUNTU_24);
            const results = await pipeline.execute(createMockSSH(), '1.2.3.4');
            expect(results).toEqual([]);
        });
    });

    describe('detectPlatform', () => {
        const cases: Array<[string, PLATFORM]> = [
            ['PRETTY_NAME="Ubuntu 24.04 LTS"', PLATFORM.UBUNTU_24],
            ['PRETTY_NAME="Ubuntu 22.04.3 LTS"', PLATFORM.UBUNTU_22],
            ['PRETTY_NAME="Ubuntu 20.04.6 LTS"', PLATFORM.UBUNTU_20],
            ['PRETTY_NAME="Debian GNU/Linux 12 (bookworm)"', PLATFORM.DEBIAN_12],
            ['PRETTY_NAME="Debian GNU/Linux 11 (bullseye)"', PLATFORM.DEBIAN_11],
            ['PRETTY_NAME="Rocky Linux 9.3"', PLATFORM.ROCKY_9],
            ['PRETTY_NAME="Rocky Linux 8.9"', PLATFORM.ROCKY_8],
            ['PRETTY_NAME="AlmaLinux 9.3"', PLATFORM.ALMA_9],
            ['PRETTY_NAME="AlmaLinux 8.9"', PLATFORM.ALMA_8],
            ['PRETTY_NAME="CentOS Stream 9"', PLATFORM.CENTOS_9],
            ['PRETTY_NAME="CentOS Linux 7"', PLATFORM.CENTOS_7],
            ['PRETTY_NAME="Fedora Linux 39"', PLATFORM.FEDORA],
        ];

        it.each(cases)('should detect %s as %s', async (osRelease, expected) => {
            const ssh = createMockSSH({
                'cat /etc/os-release': { stdout: osRelease, stderr: '', code: 0 },
            });
            const result = await SetupPipeline.detectPlatform(ssh);
            expect(result).toBe(expected);
        });

        it('should default to UBUNTU_24 for unknown OS', async () => {
            const ssh = createMockSSH({
                'cat /etc/os-release': { stdout: 'PRETTY_NAME="Unknown OS"', stderr: '', code: 0 },
            });
            const result = await SetupPipeline.detectPlatform(ssh);
            expect(result).toBe(PLATFORM.UBUNTU_24);
        });

        it('should be case-insensitive', async () => {
            const ssh = createMockSSH({
                'cat /etc/os-release': { stdout: 'PRETTY_NAME="UBUNTU 24.04 LTS"', stderr: '', code: 0 },
            });
            const result = await SetupPipeline.detectPlatform(ssh);
            expect(result).toBe(PLATFORM.UBUNTU_24);
        });
    });
});
