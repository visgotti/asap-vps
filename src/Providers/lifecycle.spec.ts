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
import { requireCapability, supports } from '../capabilities';
import { SSHService } from '../Core/SSHService';
import { sshKeyFingerprint, toOpenSSHPublicKey } from '../Core/utils';
import type { FakeApi } from '../testing/fakes/util';
import { describeGpuLifecycle, fakeLifecycle, USER_DATA_FILE } from '../testing/lifecycle';
import { RUN_PREFIX } from '../testing/live';
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
/** Each lifecycle's provider, as its run left it: the last one it made (the one before is only asked what it can do). */
const ran = new Map<string, ReturnType<(typeof CONTRACT_SUBJECTS)[number]['make']>['provider']>();

afterAll(async () => {
    jest.restoreAllMocks();
    // Each run was ended before its teardown: a step that outlived it (jest's timeout does not stop one) can rent nothing more.
    expect(ran.size).toBeGreaterThan(CONTRACT_SUBJECTS.length);
    for (const p of ran.values()) {
        await expect(p.createServer({ name: 'after-the-run', offer: 'any' })).rejects.toThrow(/is over: createServer is refused/);
        // Reading still works, and finds no server of a run left: each run's teardown took its own.
        expect((await p.listServers()).filter((s) => s.name.startsWith(RUN_PREFIX))).toEqual([]);
    }
});

const target = (subject: (typeof CONTRACT_SUBJECTS)[number], o: { cpu?: boolean } = {}) => fakeLifecycle(subject.name, (apiKey) => {
    const { provider, fake } = subject.make(apiKey ? { apiKey } : {});
    if (!apiKey) {
        current = fake;
        ran.set(`${subject.name}${o.cpu ? ' (cpu)' : ''}`, provider);
    }
    return provider;
}, o);

for (const subject of CONTRACT_SUBJECTS) {
    describeGpuLifecycle(target(subject));
    // Where a provider rents machines without GPUs (capabilities.compute.cpu), its whole lifecycle also runs on one.
    if (subject.make().provider.capabilities.compute.cpu) describeGpuLifecycle(target(subject, { cpu: true }));
}

describe('the image copy\'s fallback region, asked for where no other region has an offer in stock', () => {
    const fast = { intervalMs: 0, timeoutMs: 5000 };

    for (const subject of CONTRACT_SUBJECTS.filter((x) => supports(x.make().provider, 'imageCopy'))) {
        it(`${subject.name}: is a region of the provider's own, which an image copies to`, async () => {
            const { provider } = subject.make();
            const p = requireCapability(requireCapability(requireCapability(provider, 'imageCopy'), 'images'), 'power');
            const [offer] = await p.listOffers({ kind: 'cpu' });
            const s = await p.createServer({ name: 'copy-fallback', offer, ...(await subject.extra(provider)) });
            await p.waitUntilRunning(s.id, fast);
            await p.stopServer(s.id);
            const image = await p.createImage(s.id, { name: 'copy-fallback', ...fast });
            const to = fakeLifecycle(subject.name, () => provider).copyRegion(image.regions[0]);
            expect(to).not.toBe(image.regions[0]);
            expect((await p.copyImage(image.id, [to], fast)).regions).toEqual(expect.arrayContaining([image.regions[0], to]));
        });
    }

    it('a provider with no regions of its own to copy to says so, rather than borrow another\'s', () => {
        expect(() => fakeLifecycle('lambda', () => CONTRACT_SUBJECTS[0].make().provider).copyRegion('us-east-1')).toThrow(/no region to copy an image of lambda to from us-east-1/);
    });
});
