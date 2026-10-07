// The every-method lifecycle (src/testing/lifecycle.ts) against each
// provider's fake: the steps the live suites take on real hardware, proven here
// first, in milliseconds. A VM's shell is a mock that answers for the one
// server at the address it logs in to, from what the fake knows of that server
// (FakeApi.machine): nothing answers where no server runs, sshd takes only the
// keys that server authorizes, its boot id changes with its own reboots and
// power-ons alone, its files are what its own user data wrote or the image it
// booted from carried, and only root (or sudo) is uid 0.

import { createPublicKey } from 'crypto';
import type { NodeSSH } from 'node-ssh';
import { SSHService } from '../Core/SSHService';
import { sshKeyFingerprint, toOpenSSHPublicKey } from '../Core/utils';
import type { FakeApi } from '../testing/fakes/util';
import { describeGpuLifecycle, fakeLifecycle, USER_DATA_FILE } from '../testing/lifecycle';
import { CONTRACT_SUBJECTS } from '../testing/subjects';
import type { SSHConnectOptions } from '../types';

/** The fake behind the lifecycle's provider (the last one made with the right key). */
let current: FakeApi | undefined;

function mockShell(o: SSHConnectOptions): NodeSSH {
    /** The server at the address, as of now: asked at each command, so a reboot shows. */
    const machine = () => current?.machine?.(o.host);
    const answer = (cmd: string): { stdout: string, code: number } => {
        if (cmd.includes('os-release')) return { stdout: 'NAME="Ubuntu"\nVERSION_ID="22.04"', code: 0 };
        if (cmd.includes('nvidia-smi')) return { stdout: 'GPU 0: NVIDIA RTX 4000 Ada Generation (UUID: GPU-0f1e2d3c)', code: 0 };
        if (cmd.includes(USER_DATA_FILE)) {
            const file = machine()?.files[USER_DATA_FILE];
            return file !== undefined ? { stdout: file, code: 0 } : { stdout: '', code: 1 };
        }
        if (cmd.includes('id -u')) return { stdout: o.username === 'root' || cmd.startsWith('sudo -n ') ? '0' : '1000', code: 0 };
        if (cmd.includes('boot_id')) {
            const m = machine();
            return m ? { stdout: m.bootId, code: 0 } : { stdout: '', code: 255 };
        }
        return { stdout: '', code: 0 };
    };
    return {
        execCommand: jest.fn(async (cmd: string) => {
            const a = answer(cmd);
            return { stdout: a.stdout, stderr: a.code ? `${cmd}: failed` : '', code: a.code };
        }),
        dispose: jest.fn(),
    } as unknown as NodeSSH;
}

/** A login, as sshd answers it: no server at the address refuses the connection; a key the server does not authorize is refused. */
function connect(o: SSHConnectOptions): NodeSSH {
    if (current?.machine) {
        const m = current.machine(o.host);
        if (!m) throw new Error(`connect ECONNREFUSED ${o.host}:${o.port ?? 22}`);
        const key = o.privateKey ? sshKeyFingerprint(toOpenSSHPublicKey(createPublicKey(o.privateKey))) : undefined;
        if (!key || !m.keys.some((k) => sshKeyFingerprint(k) === key)) throw new Error('All configured authentication methods failed');
    }
    return mockShell(o);
}

beforeAll(() => {
    jest.spyOn(SSHService, 'connect').mockImplementation((async (o: SSHConnectOptions) => connect(o)) as never);
});
afterAll(() => jest.restoreAllMocks());

const target = (subject: (typeof CONTRACT_SUBJECTS)[number], o: { cpu?: boolean } = {}) => fakeLifecycle(subject.name, (apiKey) => {
    const { provider, fake } = subject.make(apiKey ? { apiKey } : {});
    if (!apiKey) current = fake;
    return provider;
}, o);

for (const subject of CONTRACT_SUBJECTS) {
    describeGpuLifecycle(target(subject));
    // Where a provider rents machines without GPUs (capabilities.compute.cpu), its whole lifecycle also runs on one.
    if (subject.make().provider.capabilities.compute.cpu) describeGpuLifecycle(target(subject, { cpu: true }));
}
