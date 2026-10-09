// The `container` option on a VM (CreateServerOptions.container) against the
// live APIs, the same run on DigitalOcean, Scaleway and Lambda: a private
// registry made for the run in the Scaleway account (privateRegistry.ts: a
// pull-only IAM key, never the account's own), and a server created with a
// container of the registry's image (its env, its command, that login) and
// user data of the caller's own. Over SSH, once cloud-init is done: the
// caller's user data ran; the container asap-vps runs the private image with
// its env and command (its output in `docker logs`); its env file is root's
// alone; the login is gone from the machine's Docker config; a GPU machine's
// GPUs are passed through; and after a real reboot it runs again by itself
// (restart unless-stopped), the user data not run twice. Then the server is
// deleted, verified. Everything is named after the run and deleted at the end,
// verified; the watchdog (live.ts) deletes the server if the run dies.

import { writeFileSync } from 'fs';
import { ProvisionResult, ProvisionTarget, ServerProvisioner } from '../Core/ServerProvisioner';
import { VM_CONTAINER_ENV_FILE, VM_CONTAINER_NAME } from '../Core/utils';
import { AuthError, CapacityError } from '../errors';
import type { Offer, Server, WaitOptions } from '../types';
import { deleteRunKeys, liveOptions, liveRequested, loadCredentials, newRunName, runMatcher, sshRun, startWatchdog, sweepLeftovers, teardown, trackSSHKeys } from './live';
import { makePrivateRegistry, PrivateRegistry, sweepPrivateRegistries } from './privateRegistry';

export type ContainerOnVm<P extends ProvisionTarget> = {
    /** What ASAP_VPS_LIVE names to run it ('digitalocean-cpu', 'scaleway-cpu', 'lambda'). */
    target: string,
    /** The provider's id, for the watchdog. */
    provider: string,
    /** The provider, with the credentials loaded. */
    make(): P,
    /** The offers to try, best first: the cheapest in stock that runs Docker comfortably. */
    offers(p: P): Promise<Offer[]>,
    /** A GPU machine: its GPUs must reach the container. */
    gpu: boolean,
    /** Checks before anything is rented (DigitalOcean: a droplet to spare). */
    before?(p: P): Promise<void>,
    wait: WaitOptions,
    /** How long the run may take before the watchdog deletes what it made. */
    minutes: number,
};

const SSH_RETRY = { maxRetries: 30, retryTimeout: 10_000 };

/** The credential `name` from the environment (loaded from .env.test), or why the run cannot start. */
export function liveKey(name: string): string {
    const v = process.env[name]?.trim();
    if (!v) throw new Error(`ASAP_VPS_LIVE asks for a run that needs ${name}, but it is not set`);
    return v;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function describeContainerOnVm<P extends ProvisionTarget>(t: ContainerOnVm<P>): void {
    const requested = liveRequested(t.target);
    const { freeOnly } = liveOptions();
    const paid = freeOnly ? it.skip : it;

    (requested ? describe : describe.skip)(`${t.target}: a container on a VM, from a private registry, against the live APIs${
        requested ? '' : ` (set ASAP_VPS_LIVE=${t.target} to run it: it rents a real server and makes a registry)`}`, () => {
        const runName = newRunName();
        const run = runMatcher(runName);
        let p: P;
        let registry: PrivateRegistry | undefined;
        let watchdog: { doneFile: string } | undefined;
        let refused = false;
        let keyIds = new Set<string>();
        let made: ProvisionResult<Server> | undefined;
        const scw = () => ({ secretKey: process.env.SCW_SECRET_KEY!.trim(), projectId: process.env.SCW_DEFAULT_PROJECT_ID!.trim() });
        const server = () => {
            if (!made) throw new Error('no server (an earlier step failed)');
            return made.server;
        };
        /** `command` on the server as root: its stdout; an exit other than 0 throws. */
        const sh = (command: string, retry = SSH_RETRY) => sshRun(server(), made!.sshKeyData.privateKey, command, retry);

        beforeAll(async () => {
            loadCredentials();
            if (!process.env.SCW_SECRET_KEY || !process.env.SCW_DEFAULT_PROJECT_ID) throw new Error('the private registry needs SCW_SECRET_KEY and SCW_DEFAULT_PROJECT_ID');
            p = t.make();
            keyIds = trackSSHKeys(p);
            try {
                await p.listServers();
            } catch (e) {
                if (!(e instanceof AuthError)) throw e;
                refused = true;
                throw new Error(`the ${t.provider} key is refused, so nothing was tried: ${e.message}`);
            }
            if (!freeOnly) {
                await t.before?.(p);
                expect(await sweepLeftovers(p, { keyRounds: 3 })).toEqual([]);
                expect(await sweepPrivateRegistries(scw())).toEqual([]);
                watchdog = await startWatchdog(t.provider, runName, Date.now() + t.minutes * 60_000);
                registry = await makePrivateRegistry({ ...scw(), runName });
            }
        }, 10 * 60_000);

        afterAll(async () => {
            if (!p || refused) return;
            const servers = await teardown(p, run);
            const keys = await deleteRunKeys(p, run, { ids: keyIds, rounds: 6 });
            const registryLeft = registry ? await registry.cleanup() : [];
            if (watchdog && !servers.length && !keys.length && !registryLeft.length) writeFileSync(watchdog.doneFile, 'done\n');
            expect({ servers, keys, registry: registryLeft }).toEqual({ servers: [], keys: [], registry: [] });
        }, 20 * 60_000);

        paid(`the server runs the private image as its container from its first boot${t.gpu ? ', its GPUs passed through' : ''}, and the caller's user data too`, async () => {
            for (const offer of (await t.offers(p)).slice(0, 4)) {
                try {
                    made = await new ServerProvisioner(p).provision({
                        serverOptions: {
                            name: runName,
                            offer,
                            region: offer.regions[0],
                            userData: `#!/bin/bash\necho asap-vps-own=${runName} > /root/asap-vps-own\n`,
                            container: {
                                image: registry!.image,
                                env: { MARK: runName },
                                command: ['sh', '-c', 'echo "asap-vps-container=$MARK"; exec sleep 2147483647'],
                                registryAuth: registry!.pullAuth,
                            },
                        },
                        sshKeyName: runName,
                        wait: t.wait,
                        sshRetry: SSH_RETRY,
                    }, () => undefined);
                    break;
                } catch (e) {
                    if (!(e instanceof CapacityError)) throw e;
                }
            }
            server();
            // Every part of the user data ran, without an error.
            expect(await sh('cloud-init status --wait >/dev/null 2>&1; cloud-init status')).toMatch(/status: done/);
            expect(await sh('cat /root/asap-vps-own')).toBe(`asap-vps-own=${runName}`);
            expect(await sh(`docker inspect -f '{{.State.Running}} {{.HostConfig.RestartPolicy.Name}} {{.Config.Image}}' ${VM_CONTAINER_NAME}`))
                .toBe(`true unless-stopped ${registry!.image}`);
            expect(await sh(`docker logs ${VM_CONTAINER_NAME} 2>&1`)).toContain(`asap-vps-container=${runName}`);
            expect(await sh(`stat -c '%a %U' ${VM_CONTAINER_ENV_FILE}`)).toBe('600 root');
            // The pull-only key is not left on the machine.
            expect(await sh('cat /root/.docker/config.json 2>/dev/null || true')).not.toContain(registry!.pullAuth.server!);
            if (t.gpu) {
                expect(await sh(`docker inspect -f '{{json .HostConfig.DeviceRequests}}' ${VM_CONTAINER_NAME}`)).toContain('"Capabilities":[["gpu"]]');
                expect(await sh(`docker exec ${VM_CONTAINER_NAME} ls /dev`)).toMatch(/^nvidia0$/m);
            }
        }, 45 * 60_000);

        paid('it runs again after a real reboot by itself, without its registry login; the user data does not run twice', async () => {
            const bootId = await sh('cat /proc/sys/kernel/random/boot_id');
            await sh('rm /root/asap-vps-own && setsid -f sh -c "sleep 2; systemctl reboot" >/dev/null 2>&1 < /dev/null');
            let now = bootId;
            for (let i = 0; i < 60 && now === bootId; i++) {
                await sleep(10_000);
                now = await sh('cat /proc/sys/kernel/random/boot_id', { maxRetries: 1, retryTimeout: 0 }).catch(() => bootId);
            }
            expect(now).not.toBe(bootId);
            expect(await sh(`for i in $(seq 1 60); do [ "$(docker inspect -f '{{.State.Running}}' ${VM_CONTAINER_NAME} 2>/dev/null)" = true ] && break; sleep 3; done; `
                + `docker inspect -f '{{.State.Running}}' ${VM_CONTAINER_NAME}`)).toBe('true');
            // Its command ran once per start.
            expect(await sh(`docker logs ${VM_CONTAINER_NAME} 2>&1 | grep -c 'asap-vps-container=${runName}'`)).toBe('2');
            expect(await sh('test -e /root/asap-vps-own && echo again || echo once')).toBe('once');
        }, 30 * 60_000);

        paid('deleted, verified gone', async () => {
            expect(await p.deleteServerAndWait(server().id, t.wait)).toBe(true);
        }, 20 * 60_000);
    });
}
