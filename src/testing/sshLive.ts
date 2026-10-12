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
        /** What the run rented, for what it cost: the offer's price and when its server was asked for. */
        let rented: { pricePerHour: number, at: number } | undefined;
        const log = (m: string) => void process.stdout.write(`[${new Date().toISOString().slice(11, 19)}] ${id}: ${m}\n`);
        /** A server as a read of it showed it: its status, where it is logged in to, and its ports. */
        const shown = (s: Server | null) => (s
            ? `${s.status} (${s.providerStatus}), ssh ${s.ssh ? `${s.ssh.username}@${s.ssh.host}:${s.ssh.port}` : 'none'}, ports ${JSON.stringify(s.ports?.map((x) => `${x.privatePort}/${x.protocol}->${x.publicPort}`) ?? [])}`
            : 'gone');

        /** The cheapest offers in stock, tried in turn: one that is taken, or whose host cannot start the server, moves on to the next. */
        const rentRunning = async (o: Omit<CreateServerOptions, 'offer'>): Promise<Server> => {
            const offers = (await p.listOffers({ maxPricePerHour, ...(container ? { minCudaVersion: TEST_IMAGE_CUDA } : {}) })).slice(0, 8);
            if (!offers.length) throw new Error(`no GPU at or under $${maxPricePerHour}/h in stock right now (ASAP_VPS_LIVE_MAX_PRICE raises the cap)`);
            for (const offer of offers) {
                let made: Server | undefined;
                try {
                    log(`renting ${offer.gpuCount}x ${offer.gpu} (${offer.id}) in ${offer.regions[0]} at $${offer.pricePerHour.toFixed(3)}/h as ${o.name}`);
                    rented = { pricePerHour: offer.pricePerHour, at: Date.now() };
                    made = await p.createServer({ ...o, offer });
                    // What each read says while it comes up, where it changes: when the platform says it runs, and when it says where to log in.
                    const read = p.getServer.bind(p);
                    let last = '';
                    p.getServer = async (serverId: string) => {
                        const s = await read(serverId);
                        if (shown(s) !== last) log(`  ${Math.round((Date.now() - rented!.at) / 1000)} s: ${last = shown(s)}`);
                        return s;
                    };
                    try {
                        // The documented way in: what waitUntilRunning returns is what RemoteMachine.connect takes.
                        return await p.waitUntilRunning(made.id, WAIT);
                    } finally {
                        p.getServer = read;
                    }
                } catch (e) {
                    log(`${offer.id} did not give a server to log in to: ${(e as Error).message.slice(0, 300)}`);
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
                // A port of the caller's own beside the SSH server's, to see both mapped.
                ...(container ? { image: TEST_IMAGE, minCudaVersion: TEST_IMAGE_CUDA, command: ['sleep', 'infinity'], ports: ['8080/tcp'] } : {}),
            });
            const login = id === 'lambda' ? 'ubuntu' : 'root';
            log(`${server.id}: waitUntilRunning returned it ${Math.round((Date.now() - rented!.at) / 1000)} s after the create, as ${shown(server)}`);
            // What the platform's own record says of where to log in, by field name (nothing of it is a secret).
            const said = Object.entries((server.raw ?? {}) as Record<string, unknown>).filter(([k]) => /runtype|^ssh_(host|port|idx)$|^ssh$|^ports$|direct_port|^onstart$/.test(k));
            log(`${server.id}: its record says ${JSON.stringify(Object.fromEntries(said))}`);
            expect(server.ssh).toEqual({ host: expect.any(String), port: expect.any(Number), username: login });
            const machine = await RemoteMachine.connect(server, { privateKey: first.privateKey, retry: FIRST_LOGIN }).catch(async (e) => {
                // A container that could start no SSH server says why in its log.
                const logs = supports(p, 'logs') ? await p.getServerLogs(server.id).catch(() => '') : '';
                throw new Error(`no SSH session to ${server.id} at ${server.ssh?.host}:${server.ssh?.port}: ${(e as Error).message}${logs ? `\n${logs.slice(-2000)}` : ''}`);
            });
            const sessions = [machine];
            log(`${server.id}: logged in as ${machine.login}, ${Math.round((Date.now() - rented!.at) / 1000)} s after the create`);
            try {
                expect((await machine.run('id -un')).stdout).toBe(login);
                expect((await machine.sudo('id -u')).stdout).toBe('0');
                // A session finds what the image's own processes find (a container's PATH and library path).
                expect((await machine.run('nvidia-smi -L')).stdout).toMatch(/^GPU \d+: /m);
                if (container) {
                    // The start handed over to the command: it runs, beside the SSH server.
                    const processes = (await machine.run('for f in /proc/[0-9]*/cmdline; do tr "\\0" " " < "$f" 2>/dev/null; echo; done')).stdout.split('\n').map((l) => l.trim()).filter(Boolean);
                    log(`${server.id}: runs ${JSON.stringify(processes.filter((l) => !l.startsWith('sh -c for f in') && !l.startsWith('tr ')).map((l) => l.slice(0, 100)))}`);
                    expect(processes).toContain('sleep infinity');
                    expect(processes.some((l) => /sshd/.test(l))).toBe(true);
                    // A session's search paths are the container's own: the ones its first process was started with.
                    const own = Object.fromEntries((await machine.run('tr "\\0" "\\n" < /proc/1/environ')).stdout.split('\n').filter((l) => /^(PATH|LD_LIBRARY_PATH)=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
                    const session = (await machine.run('echo "$PATH"; echo "${LD_LIBRARY_PATH:-}"')).stdout.split('\n');
                    log(`${server.id}: the container's own ${JSON.stringify(own)}; a session's ${JSON.stringify(session)}`);
                    expect(session[0]).toBe(own.PATH);
                    expect(session[1] ?? '').toBe(own.LD_LIBRARY_PATH ?? '');
                }
                // A key that was not named does not log in.
                await expect(RemoteMachine.connect(server, { privateKey: deployKeys.privateKey, retry: { maxRetries: 1, retryTimeout: 0 } })).rejects.toThrow();
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
            const seconds = Math.round((Date.now() - rented!.at) / 1000);
            log(`${server.id} is deleted, verified, ${seconds} s after its create: about $${(rented!.pricePerHour * seconds / 3600).toFixed(3)} at its offer's price`);
        }, 45 * 60_000);
    });
}
