// The every-method lifecycle (src/testing/lifecycle.ts) against each
// provider's fake: the steps the live suites take on real hardware, proven here
// first, in milliseconds. A VM's shell is a mock that answers from what the
// fake API was asked to do: the boot id changes only once a reboot or power-on
// was sent, the user-data file exists only if the create sent it, and only
// root (or sudo) is uid 0.

import { createPublicKey } from 'crypto';
import type { NodeSSH } from 'node-ssh';
import { SSHService } from '../Core/SSHService';
import { toOpenSSHPublicKey } from '../Core/utils';
import type { FakeApi } from '../testing/fakes/util';
import { describeGpuLifecycle, fakeLifecycle, USER_DATA_FILE } from '../testing/lifecycle';
import { CONTRACT_SUBJECTS } from '../testing/subjects';
import type { SSHConnectOptions } from '../types';

/** The fake behind the lifecycle's initializer (the last one made with the right key). */
let current: FakeApi | undefined;

/** The calls the fake was sent that `match` (POSTs, or the `methods` named). */
const sent = (match: (c: FakeApi['calls'][number]) => boolean, ...methods: string[]) => (current?.calls ?? []).filter((c) => (methods.length ? methods : ['POST']).includes(c.method) && match(c));

/** DigitalOcean's reboot and power_on, Lambda's restart, Scaleway's poweron (the create's own included) and reboot. */
function bootId(): string {
    const boots = 1 + sent((c) => (/^\/v2\/droplets\/\d+\/actions$/.test(c.path) && ['reboot', 'power_on'].includes(c.body?.type))
        || c.path === '/api/v1/instance-operations/restart'
        || (/^\/instance\/v1\/zones\/[a-z0-9-]+\/servers\/[^/]+\/action$/.test(c.path) && ['poweron', 'reboot'].includes(c.body?.action))).length;
    return `00000000-0000-4000-8000-${String(boots).padStart(12, '0')}`;
}

/** Sent with the create (DigitalOcean's, Lambda's), or set before the first power-on (Scaleway's PATCH of the `cloud-init` user data). */
function userDataWritten(): boolean {
    const mark = 'asap-vps-user-data-ok';
    return sent((c) => ['/v2/droplets', '/api/v1/instance-operations/launch'].includes(c.path) && String(c.body?.user_data ?? '').includes(mark)).length > 0
        || sent((c) => /\/servers\/[^/]+\/user_data\/cloud-init$/.test(c.path) && String(c.body ?? '').includes(mark), 'PATCH').length > 0;
}

function mockShell(o: SSHConnectOptions): NodeSSH {
    const answer = (cmd: string): { stdout: string, code: number } => {
        if (cmd.includes('os-release')) return { stdout: 'NAME="Ubuntu"\nVERSION_ID="22.04"', code: 0 };
        if (cmd.includes('nvidia-smi')) return { stdout: 'GPU 0: NVIDIA RTX 4000 Ada Generation (UUID: GPU-0f1e2d3c)', code: 0 };
        if (cmd.includes(USER_DATA_FILE)) return userDataWritten() ? { stdout: 'asap-vps-user-data-ok', code: 0 } : { stdout: '', code: 1 };
        if (cmd.includes('id -u')) return { stdout: o.username === 'root' || cmd.startsWith('sudo -n ') ? '0' : '1000', code: 0 };
        if (cmd.includes('boot_id')) return { stdout: bootId(), code: 0 };
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

/** A server that authorizes only some keys (Scaleway's, per boot) refuses the others, as sshd does: the login fails. */
function connect(o: SSHConnectOptions): NodeSSH {
    if (o.privateKey && current?.authorized && !current.authorized(o.host, toOpenSSHPublicKey(createPublicKey(o.privateKey)))) {
        throw new Error('All configured authentication methods failed');
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
    // Where a provider's API is the same for a CPU server (Scaleway, DigitalOcean), its whole lifecycle also runs on the
    // cheapest one: live, that proves every code path but the GPU's own for cents.
    if (['scaleway', 'digitalocean'].includes(subject.name)) describeGpuLifecycle(target(subject, { cpu: true }));
}
