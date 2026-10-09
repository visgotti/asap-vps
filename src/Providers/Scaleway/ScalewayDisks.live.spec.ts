// Scaleway's disks against the live API, on the smallest Instance in stock
// (STARDUST1-S, about EUR 0.0006 an hour; else a DEV1-S): `diskGb` sizes its
// root disk (a Block Storage one: the OS sees it, its filesystem grown to it);
// and a Block Storage volume is attached while it runs (volumeAttach): it
// shows up as a disk, is formatted and written, detached (the server runs on,
// the disk is gone), attached again with the file still on it; then the server
// is deleted and the volume kept, until deleteVolume. Runs only when asked,
// with the secret key and the Project in .env.test (or
// ~/.config/asap-vps/credentials.env), as the other Scaleway live suites do:
//   ASAP_VPS_LIVE=scaleway-vps npx jest --config jest.live.config.js ScalewayDisks.live
// What the run creates is named after it and deleted at the end (the volume
// after the server, so nothing holds it); the watchdog (src/testing/live.ts)
// deletes the server if the run dies, and the audit at the end
// (src/testing/scalewayAudit.ts) proves no volume of it is left.

import { writeFileSync } from 'fs';
import { ProvisionResult, ServerProvisioner } from '../../Core/ServerProvisioner';
import { AuthError } from '../../errors';
import {
    deleteRunKeys, deleteRunVolumes, liveOptions, liveRequested, loadCredentials, newRunName, runMatcher, sshRun, startWatchdog, sweepLeftovers, teardown,
    trackSSHKeys, trackVolumes,
} from '../../testing/live';
import { AuditedScaleway, describeScalewayAudit } from '../../testing/scalewayAudit';
import type { Server, Volume } from '../../types';
import { GB, MOUNT_TAG } from './mappers';
import { Scaleway } from './Scaleway';
import type { ScalewayBlockVolume, ScalewayServer, ScalewayZone } from './types';

const requested = liveRequested('scaleway-vps');
const { freeOnly } = liveOptions();
const paid = freeOnly ? it.skip : it;
/** The Instance types to try, smallest first, and the zones to look for stock in. */
const SIZES = ['STARDUST1-S', 'DEV1-S'];
const ZONES: ScalewayZone[] = ['pl-waw-2', 'nl-ams-1', 'fr-par-1'];
const WAIT = { intervalMs: 3000, timeoutMs: 10 * 60_000 };
const SSH_RETRY = { maxRetries: 30, retryTimeout: 10_000 };
const ROOT_GB = 20;

let host: AuditedScaleway | undefined;

(requested ? describe : describe.skip)(`Scaleway disks: diskGb, and a volume attached and detached while the server runs, against the live API${
    requested ? '' : ' (set ASAP_VPS_LIVE=scaleway-vps to run it: it creates a real Instance and volume)'}`, () => {
    const runName = newRunName();
    const run = runMatcher(runName);
    /** The same account through Scaleway, which lists and deletes everything: the teardown. */
    let account: Scaleway;
    let watchdog: { doneFile: string } | undefined;
    let refused = false;
    let volumeIds = new Set<string>();
    let keyIds = new Set<string>();
    let zone: ScalewayZone;
    let made: ProvisionResult<Server<ScalewayServer>>;
    let volume: Volume<ScalewayBlockVolume>;
    const p = () => host!;
    const sh = (command: string) => sshRun(made.server, made.sshKeyData.privateKey, command, SSH_RETRY);
    /** The server's disks, by name (lsblk), and the one of `volume` (by its id in /dev/disk/by-id, once it shows up). */
    const disks = async () => (await sh('lsblk -dn -o NAME,TYPE | awk \'$2 == "disk" { print $1 }\'')).split('\n').filter(Boolean).sort();
    const deviceOf = (v: Volume) => sh(`for i in $(seq 1 60); do d=$(ls /dev/disk/by-id/ | grep -i '${v.id.split('/')[1]}' | head -1); `
        + '[ -n "$d" ] && break; sleep 2; done; if [ -n "$d" ]; then readlink -f "/dev/disk/by-id/$d"; else ls -l /dev/disk/by-id/ >&2; exit 1; fi');

    beforeAll(async () => {
        loadCredentials();
        const apiKey = process.env.SCW_SECRET_KEY?.trim();
        const projectId = process.env.SCW_DEFAULT_PROJECT_ID?.trim();
        if (!apiKey) throw new Error('ASAP_VPS_LIVE asks for scaleway-vps, but SCW_SECRET_KEY is not set');
        if (!projectId) throw new Error('ASAP_VPS_LIVE asks for scaleway-vps, but SCW_DEFAULT_PROJECT_ID is not set');
        const params = { apiKey, projectId, zones: process.env.SCW_ZONES?.trim() || undefined };
        host = new AuditedScaleway(params);
        account = new Scaleway(params);
        volumeIds = trackVolumes(p());
        keyIds = trackSSHKeys(p());
        try {
            await account.listServers();
        } catch (e) {
            if (!(e instanceof AuthError)) throw e;
            refused = true;
            throw new Error(`SCW_SECRET_KEY is refused by Scaleway, so nothing was tried: ${e.message}`);
        }
        if (!freeOnly) {
            expect(await sweepLeftovers(account, { keyRounds: 3 })).toEqual([]);
            watchdog = await startWatchdog('scaleway', runName, Date.now() + 60 * 60_000);
        }
    }, 10 * 60_000);

    afterAll(async () => {
        if (!account || refused) return;
        const servers = await teardown(account, run);
        const keys = await deleteRunKeys(account, run, { ids: keyIds, rounds: 6 });
        const volumes = await deleteRunVolumes(account, run, { ids: volumeIds, rounds: 10 });
        if (watchdog && !servers.length && !keys.length && !volumes.length) writeFileSync(watchdog.doneFile, 'done\n');
        expect({ servers, keys, volumes }).toEqual({ servers: [], keys: [], volumes: [] });
    }, 15 * 60_000);

    paid(`diskGb: the server's root disk is ${ROOT_GB} GB, a Block Storage one, and its OS sees it, its filesystem grown to it`, async () => {
        let size: string | undefined;
        for (const z of ZONES.filter((x) => p().api.zones.includes(x))) {
            const a = await p().api.availability(z);
            size = SIZES.find((s) => a[s] === 'available' || a[s] === 'scarce');
            if (size) {
                zone = z;
                break;
            }
        }
        if (!size) throw new Error(`none of ${SIZES.join(', ')} is in stock in ${ZONES.join(', ')} right now`);
        made = await new ServerProvisioner(p()).provision({
            serverOptions: { name: runName, offer: size, region: zone, diskGb: ROOT_GB },
            sshKeyName: runName,
            wait: WAIT,
            sshRetry: SSH_RETRY,
        }, () => undefined) as ProvisionResult<Server<ScalewayServer>>;
        // The root volume, as the server holds it and as the Block Storage API reads it.
        const root = made.server.raw.volumes['0'];
        expect(root.volume_type).toBe('sbs_volume');
        expect(await p().getVolume(`${zone}/${root.id}`)).toMatchObject({ sizeGb: ROOT_GB, status: 'attached', serverIds: [made.server.id] });
        // The disk the root filesystem is on, as the OS sees it, and the filesystem: grown to (nearly) all of it.
        const bytes = Number(await sh('lsblk -bdn -o SIZE "/dev/$(lsblk -no PKNAME "$(findmnt -n -o SOURCE /)")"'));
        expect(bytes).toBe(ROOT_GB * GB);
        expect(Number(await sh('df -B1 --output=size / | tail -1'))).toBeGreaterThan(0.85 * ROOT_GB * GB);
    }, 20 * 60_000);

    paid('volumeAttach: a volume attached while it runs shows up as a disk; formatted and written, detached (the server runs on), attached again: the file is there', async () => {
        const server = made.server;
        volume = await p().createVolume({ name: `${runName}-data`, region: zone, sizeGb: 1 });
        const before = await disks();
        await p().attachVolume(volume.id, server.id, WAIT);
        // Idempotent: attached already.
        await p().attachVolume(volume.id, server.id, WAIT);
        expect(await p().getVolume(volume.id)).toMatchObject({ status: 'attached', serverIds: [server.id] });
        const attached = await p().getServer(server.id);
        expect(attached?.mounts).toEqual([{ volumeId: volume.id }]);
        expect(attached?.raw.tags).toContain(`${MOUNT_TAG}${volume.id.split('/')[1]}`);
        const device = await deviceOf(volume);
        expect(device).toMatch(/^\/dev\/[a-z0-9]+$/);
        expect((await disks()).filter((d) => !before.includes(d))).toEqual([device.slice('/dev/'.length)]);
        expect(await sh(`mkfs.ext4 -q -F ${device} && mkdir -p /mnt/data && mount ${device} /mnt/data && echo asap-vps-wrote=${runName} > /mnt/data/marker && umount /mnt/data && echo ok`)).toBe('ok');

        await p().detachVolume(volume.id, server.id, WAIT);
        // Idempotent: detached already.
        await p().detachVolume(volume.id, server.id, WAIT);
        expect(await p().getVolume(volume.id)).toMatchObject({ status: 'available', serverIds: [] });
        const detached = await p().getServer(server.id);
        expect(detached).toMatchObject({ status: 'running' });
        expect(detached?.mounts ?? []).toEqual([]);
        expect(detached?.raw.tags ?? []).not.toContain(`${MOUNT_TAG}${volume.id.split('/')[1]}`);
        expect(await sh(`for i in $(seq 1 30); do lsblk -dn -o NAME | grep -qx ${device.slice('/dev/'.length)} || break; sleep 2; done; lsblk -dn -o NAME`))
            .not.toMatch(new RegExp(`^${device.slice('/dev/'.length)}$`, 'm'));

        await p().attachVolume(volume.id, server.id, WAIT);
        const again = await deviceOf(volume);
        expect(await sh(`mount ${again} /mnt/data && cat /mnt/data/marker && umount /mnt/data`)).toBe(`asap-vps-wrote=${runName}`);
    }, 20 * 60_000);

    paid('the server goes; the volume it held stays, until deleteVolume', async () => {
        expect(await p().deleteServerAndWait(made.server.id, WAIT)).toBe(true);
        expect(await p().getVolume(volume.id)).toMatchObject({ status: 'available', serverIds: [] });
        await p().deleteVolume(volume.id);
        expect(await p().getVolume(volume.id)).toBeNull();
    }, 15 * 60_000);
});

describeScalewayAudit(requested && !freeOnly, () => host!);
