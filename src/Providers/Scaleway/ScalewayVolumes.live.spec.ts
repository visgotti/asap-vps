// Scaleway's volumes against the live API: a Block Storage volume made with
// createVolume (it bills until deleteVolume, 1 GB is about EUR 0.0001 an hour),
// mounted on a server (CreateServerOptions.mounts), left out of the image of a
// server that mounts it, and kept when that server is deleted, running (the
// `terminate` action) or stopped (a plain delete): it is the caller's, deleted
// with deleteVolume. Each server is a STARDUST1-S (about EUR 0.0006 an hour).
// Runs only when asked, with the secret key and the Project in .env.test (or
// ~/.config/asap-vps/credentials.env), as the other Scaleway live suites do:
//   ASAP_VPS_LIVE=scaleway-vps npm run test:scw:volumes
// What the run creates is named after it and deleted at the end (the volume
// after the servers, so nothing holds it), the servers are watched by the
// watchdog (src/testing/live.ts) in case the run dies, and the audit at the end
// (src/testing/scalewayAudit.ts) proves no volume or snapshot of it is left.

import { writeFileSync } from 'fs';
import { AuthError, ProviderError } from '../../errors';
import { deleteRunImages, deleteRunVolumes, liveOptions, liveRequested, loadCredentials, newRunName, runMatcher, startWatchdog, sweepLeftovers, teardown, trackVolumes } from '../../testing/live';
import { AuditedScaleway, describeScalewayAudit } from '../../testing/scalewayAudit';
import type { Server, Volume } from '../../types';
import { MOUNT_TAG } from './mappers';
import { Scaleway } from './Scaleway';
import type { ScalewayBlockVolume, ScalewayServer, ScalewayZone } from './types';

const requested = liveRequested('scaleway-vps');
const { freeOnly } = liveOptions();
const paid = freeOnly ? it.skip : it;
/** The smallest Instance type, and the zones to look for stock of it in. */
const SIZE = 'STARDUST1-S';
const ZONES: ScalewayZone[] = ['fr-par-1', 'nl-ams-1', 'pl-waw-2'];
const WAIT = { intervalMs: 3000, timeoutMs: 10 * 60_000 };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

(requested ? describe : describe.skip)(`Scaleway volumes: a Block Storage volume mounted on servers, against the live API${
    requested ? '' : ' (set ASAP_VPS_LIVE=scaleway-vps to run it: it creates a real volume and Instances)'}`, () => {
    const runName = newRunName();
    const run = runMatcher(runName);
    let host: AuditedScaleway;
    /** The same account through Scaleway, which lists and deletes everything: the teardown. */
    let account: Scaleway;
    let watchdog: { doneFile: string } | undefined;
    /** The key was refused before anything ran: nothing to tear down. */
    let refused = false;
    /** Every volume the run makes through `host`: deleted by id at the end, after the servers. */
    let volumeIds = new Set<string>();
    let zone: ScalewayZone;
    let volume: Volume<ScalewayBlockVolume>;
    let server: Server<ScalewayServer>;

    /** The volume as the API reads it now. */
    const nowOf = async () => (await host.getVolume(volume.id))!;
    /** The `zone/id` of a server's root volume, which the server's deletion must take with it. */
    const rootOf = (s: Server<ScalewayServer>) => s.raw.volumes['0'].id;

    beforeAll(async () => {
        loadCredentials();
        const apiKey = process.env.SCW_SECRET_KEY?.trim();
        const projectId = process.env.SCW_DEFAULT_PROJECT_ID?.trim();
        if (!apiKey) throw new Error('ASAP_VPS_LIVE asks for scaleway-vps, but SCW_SECRET_KEY is not set');
        if (!projectId) throw new Error('ASAP_VPS_LIVE asks for scaleway-vps, but SCW_DEFAULT_PROJECT_ID is not set (the Project the volume and Instances are created in)');
        const params = { apiKey, projectId, zones: process.env.SCW_ZONES?.trim() || undefined };
        host = new AuditedScaleway(params);
        account = new Scaleway(params);
        volumeIds = trackVolumes(host);
        try {
            await account.listServers();
        } catch (e) {
            if (!(e instanceof AuthError)) throw e;
            refused = true;
            throw new Error(`SCW_SECRET_KEY is refused by Scaleway, so nothing was tried: ${e.message}`);
        }
        if (!freeOnly) {
            expect(await sweepLeftovers(account)).toEqual([]);
            watchdog = await startWatchdog('scaleway', runName, Date.now() + 60 * 60_000);
        }
    }, 10 * 60_000);

    afterAll(async () => {
        if (!account || refused) return;
        // Servers first, so no server holds a volume; then the images; then every volume the run made, by id and by name, each verified gone.
        const servers = await teardown(account, run);
        const images = await deleteRunImages(account, run);
        const volumes = await deleteRunVolumes(account, run, { ids: volumeIds, rounds: 10 });
        if (watchdog && !servers.length && !images.length && !volumes.length) writeFileSync(watchdog.doneFile, 'done\n');
        expect({ servers, images, volumes }).toEqual({ servers: [], images: [], volumes: [] });
    }, 15 * 60_000);

    paid('createVolume makes an empty volume, available at once; getVolume reads it by its id or the bare one, listVolumes lists it, an id nothing has is null', async () => {
        const stock = await Promise.all(ZONES.filter((z) => host.api.zones.includes(z)).map(async (z) => ({ z, a: (await host.api.availability(z))[SIZE] })));
        const found = stock.find((s) => s.a === 'available' || s.a === 'scarce')?.z;
        if (!found) throw new Error(`${SIZE} is not in stock in ${ZONES.join(', ')} right now`);
        zone = found;
        volume = await host.createVolume({ name: `${runName}-data`, region: zone, sizeGb: 1 });
        expect(volume).toMatchObject({ provider: 'scaleway', name: `${runName}-data`, region: zone, sizeGb: 1, status: 'available', providerStatus: 'available', serverIds: [] });
        expect(volume.id).toMatch(new RegExp(`^${zone}/`));
        expect(await host.getVolume(volume.id)).toMatchObject({ id: volume.id });
        expect(await host.getVolume(volume.id.split('/')[1])).toMatchObject({ id: volume.id });
        expect((await host.listVolumes()).map((v) => v.id)).toContain(volume.id);
        expect(await host.getVolume('00000000-0000-4000-8000-0000000000aa')).toBeNull();
    }, 10 * 60_000);

    paid('createServer mounts it: the server reports the mount and carries the tag the library keeps it by; while it is held, a second mount and deleteVolume are refused', async () => {
        const created = await host.createServer({ name: runName, offer: SIZE, region: zone, mounts: [{ volume }] });
        expect(created.mounts).toEqual([{ volumeId: volume.id }]);
        server = await host.waitUntilRunning(created.id, WAIT);
        expect(server.mounts).toEqual([{ volumeId: volume.id }]);
        expect(server.raw.tags).toContain(`${MOUNT_TAG}${volume.id.split('/')[1]}`);
        // The volume is the server's block device now: attached, to it alone.
        expect(await nowOf()).toMatchObject({ status: 'attached', providerStatus: 'in_use', serverIds: [server.id] });
        expect(rootOf(server)).toMatch(UUID);
        // A volume a server holds is not offered to another, nor deleted from under it.
        const before = (await account.listServers()).length;
        await expect(host.createServer({ name: `${runName}-2`, offer: SIZE, region: zone, mounts: [{ volume }] })).rejects.toBeInstanceOf(ProviderError);
        expect((await account.listServers()).length).toBe(before);
        await expect(host.deleteVolume(volume.id)).rejects.toMatchObject({ code: 'precondition_failed' });
        expect(await nowOf()).toMatchObject({ status: 'attached' });
    }, 15 * 60_000);

    paid('createImage leaves the mount out: the image is the root disk alone, and it deletes with its snapshot', async () => {
        await host.stopServer(server.id);
        const image = await host.createImage(server.id, { name: `${runName}-image`, intervalMs: 3000, timeoutMs: 15 * 60_000 });
        expect(image).toMatchObject({ name: `${runName}-image`, status: 'available' });
        // One snapshot, of the root volume: the mounted volume is not in it.
        expect(image.raw.root_volume).toMatchObject({ volume_type: 'sbs_snapshot' });
        expect(Object.keys(image.raw.extra_volumes)).toEqual([]);
        await host.deleteImage(image.id);
        expect(await host.getImage(image.id)).toBeNull();
        // The server stopped for the image, with the volume still its own.
        expect(await nowOf()).toMatchObject({ status: 'attached', serverIds: [server.id] });
    }, 20 * 60_000);

    paid('deleting the server while it runs keeps the volume (detached, available) and deletes the root volume', async () => {
        await host.startServer(server.id);
        const running = await host.waitUntilRunning(server.id, WAIT);
        const root = rootOf(running);
        expect(await host.deleteServerAndWait(server.id, WAIT)).toBe(true);
        expect(await host.getServer(server.id)).toBeNull();
        expect(await nowOf()).toMatchObject({ status: 'available', serverIds: [] });
        expect(await host.api.getBlockVolume(zone, root)).toBeNull();
    }, 20 * 60_000);

    paid('deleting a stopped server keeps the volume as well: the plain delete detaches it, and the root volume is deleted', async () => {
        const created = await host.createServer({ name: `${runName}-2`, offer: SIZE, region: zone, mounts: [{ volume }] });
        const up = await host.waitUntilRunning(created.id, WAIT);
        expect(await nowOf()).toMatchObject({ status: 'attached', serverIds: [up.id] });
        const root = rootOf(up);
        await host.stopServer(up.id);
        expect(await host.deleteServerAndWait(up.id, WAIT)).toBe(true);
        expect(await host.getServer(up.id)).toBeNull();
        expect(await nowOf()).toMatchObject({ status: 'available', serverIds: [] });
        expect(await host.api.getBlockVolume(zone, root)).toBeNull();
    }, 20 * 60_000);

    paid('deleteVolume deletes it once nothing holds it, and deleting it again is not an error', async () => {
        await host.deleteVolume(volume.id);
        expect(await host.getVolume(volume.id)).toBeNull();
        expect((await host.listVolumes()).map((v) => v.id)).not.toContain(volume.id);
        await expect(host.deleteVolume(volume.id)).resolves.toBeUndefined();
    }, 10 * 60_000);
});

describeScalewayAudit(requested && !freeOnly, () => new Scaleway({
    apiKey: process.env.SCW_SECRET_KEY?.trim() ?? 'unset', projectId: process.env.SCW_DEFAULT_PROJECT_ID?.trim(), zones: process.env.SCW_ZONES?.trim() || undefined,
}));
