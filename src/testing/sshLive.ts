// What the SSH layer promises, against a provider's live API: a server made
// with `sshKeyIds` is logged in to with RemoteMachine, by each key named, as
// the login its endpoint says; commands run as that login and as root; and a
// user made there (addUser) logs in with its own key, with sudo and then
// without. The same steps on every provider it is run on: a VM whose platform
// installs the keys (Lambda: one of them, the library the other), and a
// container whose SSH server the library starts (RunPod, Vast). One server,
// the cheapest in stock under ASAP_VPS_LIVE_MAX_PRICE, for a few minutes;
// what the run creates is named after it and deleted at the end, and the
// watchdog (./live.ts) deletes it if the run dies.

import { writeFileSync } from 'fs';
import { requireCapability, supports } from '../capabilities';
import { RemoteMachine } from '../Core/RemoteMachine';
import { createSSHKeyPair } from '../Core/utils';
import { AuthError, CapacityError, ProviderError, RemoteCommandError } from '../errors';
import { providerInfo } from '../Providers/registry';
import type { CreateServerOptions, Server } from '../types';
import {
    ComputeSubject, deleteRunKeys, endRun, liveOptions, liveRequested, loadCredentials, newRunName, providerFromEnv, runMatcher, startWatchdog, sweepLeftovers,
    teardown, TEST_IMAGE, TEST_IMAGE_CUDA, trackSSHKeys,
} from './live';

const WAIT = { intervalMs: 10_000, timeoutMs: 15 * 60_000 };
/** A machine that has just come up may not take logins yet, and a container may be installing its SSH server. */
const FIRST_LOGIN = { maxRetries: 60, retryTimeout: 10_000 };
const LOGIN = { maxRetries: 6, retryTimeout: 5000 };

export function describeLiveSsh(id: 'runpod' | 'vast' | 'lambda'): void {
    const requested = liveRequested(id);
    const { freeOnly, maxPricePerHour } = liveOptions();
    const paid = freeOnly ? it.skip : it;
    const container = providerInfo(id).capabilities.compute?.kind === 'container';

    (requested ? describe : describe.skip)(`${id}: logging in over SSH and a user of its own, against the live API${
        requested ? '' : ` (set ASAP_VPS_LIVE=${id} to run it: it rents a real GPU machine)`}`, () => {
        const runName = newRunName();
        const run = runMatcher(runName);
        let p: ComputeSubject;
        let keyIds: Set<string> | undefined;
        let watchdog: { doneFile: string } | undefined;
        let refused = false;

        /** The cheapest offers in stock, tried in turn: one that is taken, or whose host cannot start the server, moves on to the next. */
        const rentRunning = async (o: Omit<CreateServerOptions, 'offer'>): Promise<Server> => {
            const offers = (await p.listOffers({ maxPricePerHour, ...(container ? { minCudaVersion: TEST_IMAGE_CUDA } : {}) })).slice(0, 8);
            if (!offers.length) throw new Error(`no GPU at or under $${maxPricePerHour}/h in stock right now (ASAP_VPS_LIVE_MAX_PRICE raises the cap)`);
            for (const offer of offers) {
                let made: Server | undefined;
                try {
                    made = await p.createServer({ ...o, offer });
                    await p.waitUntilRunning(made.id, WAIT);
                    // Where sshd is may be known a moment after the server reads as running (a container's mapped port).
                    return (await p.waitForServer(made.id, (s) => s?.status === 'running' && !!s.ssh, WAIT))!;
                } catch (e) {
                    if (!(e instanceof CapacityError) && !(made && e instanceof ProviderError)) throw e;
                    if (made) expect(await p.deleteServerAndWait(made.id, WAIT)).toBe(true);
                }
            }
            throw new Error('no offer could be rented and started');
        };

        beforeAll(async () => {
            loadCredentials();
            p = providerFromEnv(id);
            try {
                await p.listServers();
            } catch (e) {
                if (!(e instanceof AuthError)) throw e;
                refused = true;
                throw new Error(`the key for ${id} is refused, so nothing was tried: ${e.message}`);
            }
            keyIds = trackSSHKeys(p);
            if (!freeOnly) {
                expect(await sweepLeftovers(p, { keyRounds: 3 })).toEqual([]);
                watchdog = await startWatchdog(id, runName, Date.now() + 45 * 60_000);
            }
        }, 10 * 60_000);

        afterAll(async () => {
            if (!p || refused) return;
            endRun(p, runName);
            const servers = await teardown(p, run);
            const keys = await deleteRunKeys(p, run, { ids: keyIds, rounds: 3 });
            if (watchdog && !servers.length) writeFileSync(watchdog.doneFile, 'done\n');
            expect([...servers, ...keys]).toEqual([]);
        }, 15 * 60_000);

        paid('each key named logs in as the login the server says; commands run as it and as root; a user made there logs in with its own key, with sudo and then without', async () => {
            const keysOf = requireCapability(p, 'sshKeys');
            const [first, second, deployKeys] = await Promise.all([createSSHKeyPair(`${runName}-a`), createSSHKeyPair(`${runName}-b`), createSSHKeyPair('deploy')]);
            const named = [await keysOf.addSSHKey(first.publicKey, `${runName}-a`), await keysOf.addSSHKey(second.publicKey, `${runName}-b`)];
            const server = await rentRunning({
                name: runName, sshKeyIds: named.map((k) => k.id),
                ...(container ? { image: TEST_IMAGE, minCudaVersion: TEST_IMAGE_CUDA, command: ['sleep', 'infinity'] } : {}),
            });
            const login = id === 'lambda' ? 'ubuntu' : 'root';
            expect(server.ssh).toEqual({ host: expect.any(String), port: expect.any(Number), username: login });
            const machine = await RemoteMachine.connect(server, { privateKey: first.privateKey, retry: FIRST_LOGIN }).catch(async (e) => {
                // A container that could start no SSH server says why in its log.
                const logs = supports(p, 'logs') ? await p.getServerLogs(server.id).catch(() => '') : '';
                throw new Error(`no SSH session to ${server.id} at ${server.ssh?.host}:${server.ssh?.port}: ${(e as Error).message}${logs ? `\n${logs.slice(-2000)}` : ''}`);
            });
            const sessions = [machine];
            try {
                expect((await machine.run('id -un')).stdout).toBe(login);
                expect((await machine.sudo('id -u')).stdout).toBe('0');
                // A session finds what the image's own processes find (a container's PATH and library path).
                expect((await machine.run('nvidia-smi -L')).stdout).toMatch(/^GPU \d+: /m);
                // The second key named logs in too (on Lambda, the one the library adds at the first boot).
                const other = await RemoteMachine.connect(server, { privateKey: second.privateKey, retry: FIRST_LOGIN });
                sessions.push(other);
                expect((await other.run('id -un')).stdout).toBe(login);

                // A user of its own, made twice (the second changes nothing), logged in to with its own key.
                await machine.addUser('deploy', { publicKeys: [deployKeys.publicKey], sudo: true });
                await machine.addUser('deploy', { publicKeys: [deployKeys.publicKey], sudo: true });
                expect(await machine.readFile('/home/deploy/.ssh/authorized_keys', { sudo: true })).toBe(`${deployKeys.publicKey}\n`);
                const deploy = await machine.as('deploy', { privateKey: deployKeys.privateKey, retry: LOGIN });
                sessions.push(deploy);
                expect([(await deploy.run('id -un')).stdout, (await deploy.run('id -u')).stdout === '0', (await deploy.sudo('id -u')).stdout]).toEqual(['deploy', false, '0']);
                await deploy.writeFile('/etc/asap-vps-live.conf', "mark='it''s here'\n", { owner: 'root', mode: '600' });
                expect(await deploy.readFile('/etc/asap-vps-live.conf', { sudo: true })).toBe("mark='it''s here'\n");
                await expect(deploy.readFile('/etc/asap-vps-live.conf')).rejects.toBeInstanceOf(RemoteCommandError);
                // The right to sudo is taken back by the same call; the login stays.
                await machine.addUser('deploy', { sudo: false });
                await expect(deploy.sudo('true')).rejects.toBeInstanceOf(RemoteCommandError);
                expect((await deploy.run('id -un')).stdout).toBe('deploy');
            } finally {
                await Promise.all(sessions.map((s) => s.close().catch(() => undefined)));
            }
            expect(await p.deleteServerAndWait(server.id, WAIT)).toBe(true);
        }, 45 * 60_000);
    });
}
