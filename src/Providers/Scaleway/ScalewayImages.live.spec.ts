// Scaleway's image import and copy against the live API: Ubuntu 24.04's
// minimal cloud image (a QCOW2 from cloud-images.ubuntu.com) imported in a zone
// of the cheapest Instance type in stock in two regions (importImage:
// downloaded here, put in a bucket of its own, imported as a Block snapshot,
// imaged, the bucket deleted) and booted; copied to another zone of its region
// and to one of the other region (copyImage: the root snapshot exported as a
// QCOW2, moved to the other region through this machine, imported, imaged), and
// booted in the other region for the source's id; an image of a server on local
// storage (an Instance snapshot) copied to the other region, and its copy booted
// with the file the server wrote; then the servers and the images (copies with
// them) deleted, verified. The audit proves no volume, snapshot or temporary
// bucket of the run is left. Billed: minutes of the cheapest Instances, and
// snapshots and buckets for about an hour (cents). Runs only when asked, with
// the secret key, its access key and the Project in .env.test (or
// ~/.config/asap-vps/credentials.env):
//   ASAP_VPS_LIVE=scaleway-cpu npx jest --config jest.live.config.js ScalewayImages.live
// What the run creates is named after it and deleted at the end; the watchdog
// (src/testing/live.ts) deletes its servers, keys and images if the run dies.

import { writeFileSync } from 'fs';
import { ProvisionResult, ServerProvisioner } from '../../Core/ServerProvisioner';
import { RunCommandStep } from '../../Core/steps';
import { AuthError } from '../../errors';
import {
    deleteRunImages, deleteRunKeys, deleteRunVolumes, liveOptions, liveRequested, loadCredentials, newRunName, runMatcher, startWatchdog, sweepLeftovers, teardown, trackSSHKeys, trackVolumes,
} from '../../testing/live';
import { AuditedScaleway, describeScalewayAudit } from '../../testing/scalewayAudit';
import type { CreateServerOptions, Offer, Server, ServerImage } from '../../types';
import { copyTag, regionOfZone } from './mappers';
import { Scaleway } from './Scaleway';
import type { ScalewayImage, ScalewayOfferRaw, ScalewayServer, ScalewayTypes, ScalewayZone } from './types';
import { SCALEWAY_ZONES } from './types';

const requested = liveRequested('scaleway-cpu');
const { freeOnly } = liveOptions();
const paid = freeOnly ? it.skip : it;
const UBUNTU_MINIMAL = 'https://cloud-images.ubuntu.com/minimal/releases/noble/release/ubuntu-24.04-minimal-cloudimg-amd64.img';
const WAIT = { intervalMs: 5000, timeoutMs: 15 * 60_000 };
const IMAGE_WAIT = { intervalMs: 15_000, timeoutMs: 90 * 60_000 };
/** An Ubuntu cloud image lets no key in as root (Scaleway's own images do): this does. */
const ROOT_LOGIN = '#cloud-config\ndisable_root: false\n';
/** Its cloud-init done (degraded is done too), and its OS. */
const BOOTED = ['cloud-init status --wait >/dev/null 2>&1; cloud-init status || true', '. /etc/os-release && echo "os=$ID $VERSION_ID"'];
const MARK = '/root/asap-vps-image-mark';

let host: AuditedScaleway | undefined;

(requested ? describe : describe.skip)(`Scaleway image import and copy: a cloud image from a URL, copied across zones and regions, each booted, against the live API${
    requested ? '' : ' (set ASAP_VPS_LIVE=scaleway-cpu to run it: it imports and copies real images and creates Instances)'}`, () => {
    const runName = newRunName();
    const run = runMatcher(runName);
    let account: Scaleway;
    let watchdog: { doneFile: string } | undefined;
    let refused = false;
    let volumeIds = new Set<string>();
    let keyIds = new Set<string>();
    let offer: Offer<ScalewayOfferRaw>;
    /** Where the import is, and the server on local storage. */
    let home: ScalewayZone;
    /** Another zone of home's region. */
    let near: ScalewayZone;
    /** A zone of another region, with stock. */
    let away: ScalewayZone;
    let imported: ServerImage<ScalewayImage> | undefined;
    let captured: ServerImage<ScalewayImage> | undefined;
    const p = () => host!;
    const need = <T>(x: T | undefined, what: string): T => {
        if (x === undefined) throw new Error(`no ${what} (an earlier step failed)`);
        return x;
    };
    const provision = (name: string, zone: ScalewayZone, commands: string[], o: Partial<CreateServerOptions<ScalewayTypes>> = {}) => new ServerProvisioner(p()).provision({
        serverOptions: { name, offer, region: zone, ...o },
        sshKeyName: name,
        wait: WAIT,
        sshRetry: { maxRetries: 40, retryTimeout: 10_000 },
    }, (pipeline) => void pipeline.addStep(new RunCommandStep(commands, 'image'))) as Promise<ProvisionResult<Server<ScalewayServer>>>;
    const output = (r: ProvisionResult) => r.setupResults.map((x) => `${x.output ?? ''}${x.message ?? ''}`).join('\n');
    const uuidOf = (zonedId: string) => zonedId.split('/').pop()!;

    beforeAll(async () => {
        loadCredentials();
        const apiKey = process.env.SCW_SECRET_KEY?.trim();
        const projectId = process.env.SCW_DEFAULT_PROJECT_ID?.trim();
        const accessKey = process.env.SCW_ACCESS_KEY?.trim();
        if (!apiKey || !projectId || !accessKey) throw new Error('ASAP_VPS_LIVE asks for scaleway-cpu, but SCW_SECRET_KEY, SCW_ACCESS_KEY or SCW_DEFAULT_PROJECT_ID is not set');
        const params = { apiKey, projectId, accessKey, zones: process.env.SCW_ZONES?.trim() || undefined };
        host = new AuditedScaleway(params);
        account = new Scaleway(params);
        volumeIds = trackVolumes(p());
        keyIds = trackSSHKeys(p());
        try {
            await account.listImages();
        } catch (e) {
            if (!(e instanceof AuthError)) throw e;
            refused = true;
            throw new Error(`SCW_SECRET_KEY is refused by Scaleway, so nothing was tried: ${e.message}`);
        }
        if (!freeOnly) {
            expect(await sweepLeftovers(account, { keyRounds: 3 })).toEqual([]);
            watchdog = await startWatchdog('scaleway', runName, Date.now() + 240 * 60_000);
        }
    }, 10 * 60_000);

    afterAll(async () => {
        if (!account || refused) return;
        const servers = await teardown(account, run);
        const keys = await deleteRunKeys(account, run, { ids: keyIds, rounds: 6 });
        const volumes = await deleteRunVolumes(account, run, { ids: volumeIds, rounds: 10 });
        const images = await deleteRunImages(account, run);
        if (watchdog && !servers.length && !keys.length && !volumes.length && !images.length) writeFileSync(watchdog.doneFile, 'done\n');
        expect({ servers, keys, volumes, images }).toEqual({ servers: [], keys: [], volumes: [], images: [] });
    }, 20 * 60_000);

    paid('importImage: the QCOW2 put in a bucket of its own, imported as a Block snapshot and imaged, in a zone of the cheapest type in stock in two regions', async () => {
        const offers = await p().listOffers({ kind: 'cpu' });
        const regions = (o: Offer<ScalewayOfferRaw>) => new Set(o.regions.map((r) => regionOfZone(r as ScalewayZone)));
        // Block Storage (an import boots from it), 10 GB of local storage (the server on local storage), stock in two regions.
        offer = offers.find((o) => o.raw.serverType.capabilities?.block_storage && o.raw.serverType.volumes_constraint.max_size >= 10e9 && regions(o).size >= 2)!;
        if (!offer) throw new Error('no CPU type with Block Storage and 10 GB of local storage is in stock in two regions right now');
        home = offer.regions[0] as ScalewayZone;
        away = offer.regions.find((r) => regionOfZone(r as ScalewayZone) !== regionOfZone(home)) as ScalewayZone;
        near = SCALEWAY_ZONES.find((z) => z !== home && regionOfZone(z) === regionOfZone(home))!;
        console.log(`scaleway images: ${offer.id}, imported in ${home}, copied to ${near} and ${away}`);
        imported = await p().importImage({ name: `${runName}-noble`, url: UBUNTU_MINIMAL, region: home, ...IMAGE_WAIT });
        expect(imported).toMatchObject({ provider: 'scaleway', name: `${runName}-noble`, status: 'available', regions: [home] });
        expect(imported.raw.root_volume?.volume_type).toBe('sbs_snapshot');
        expect(imported.sizeGb).toBeGreaterThan(0);
        expect(await p().getImage(imported.id)).toMatchObject({ id: imported.id, status: 'available' });
        expect((await p().listImages()).map((i) => i.id)).toContain(imported.id);
    }, 100 * 60_000);

    paid('a server boots from it: logged into over SSH, its OS the image\'s, its cloud-init done', async () => {
        const image = need(imported, 'imported image');
        const a = await provision(`${runName}-a`, home, BOOTED, { image: image.id, userData: ROOT_LOGIN });
        expect(output(a)).toContain('os=ubuntu 24.04');
        expect(output(a)).toMatch(/status: done/);
        expect(a.server.raw.image?.id).toBe(uuidOf(image.id));
        expect(await p().deleteServerAndWait(a.server.id, WAIT)).toBe(true);
    }, 30 * 60_000);

    paid('copyImage: to another zone of its region and one of the other region, each a copy of it there; a server of the other region boots the copy for its id', async () => {
        const image = need(imported, 'imported image');
        const all = [home, near, away].sort();
        const copied = await p().copyImage(image.id, [near, away], IMAGE_WAIT);
        expect(copied.id).toBe(image.id);
        expect([...copied.regions].sort()).toEqual(all);
        const copies = (await p().listImages()).filter((i) => i.name === image.name && i.id !== image.id);
        expect(copies.map((c) => c.regions[0]).sort()).toEqual([near, away].sort());
        for (const c of copies) expect(c).toMatchObject({ status: 'available', raw: { tags: expect.arrayContaining([copyTag(uuidOf(image.id))]) } });
        expect((await p().getImage(image.id))?.regions.slice().sort()).toEqual(all);
        // Again: nothing more to copy, nothing done.
        expect([...(await p().copyImage(image.id, [away], IMAGE_WAIT)).regions].sort()).toEqual(all);
        const b = await provision(`${runName}-b`, away, BOOTED, { image: image.id, userData: ROOT_LOGIN });
        expect(output(b)).toContain('os=ubuntu 24.04');
        expect(b.server.region).toBe(away);
        expect(b.server.raw.image?.id).toBe(uuidOf(copies.find((c) => c.regions[0] === away)!.id));
        expect(await p().deleteServerAndWait(b.server.id, WAIT)).toBe(true);
    }, 150 * 60_000);

    paid('an image of a server on local storage (an Instance snapshot) is copied too: its copy boots in the other region with the file the server wrote', async () => {
        const local = await provision(`${runName}-local`, home, [`echo ${runName} > ${MARK} && sync && cat ${MARK}`], {
            providerOptions: { volumes: { 0: { volume_type: 'l_ssd', size: 10e9 } } },
        });
        expect(output(local)).toContain(runName);
        expect(Object.values(local.server.raw.volumes).map((v) => v.volume_type)).toEqual(['l_ssd']);
        await p().stopServer(local.server.id);
        captured = await p().createImage(local.server.id, { name: `${runName}-local-image`, ...IMAGE_WAIT });
        expect(captured.raw.root_volume?.volume_type).not.toBe('sbs_snapshot');
        expect(await p().deleteServerAndWait(local.server.id, WAIT)).toBe(true);
        const copied = await p().copyImage(captured.id, [away], IMAGE_WAIT);
        expect([...copied.regions].sort()).toEqual([home, away].sort());
        const c = await provision(`${runName}-c`, away, [`cat ${MARK}`, ...BOOTED], { image: captured.id });
        expect(output(c)).toContain(runName);
        expect(output(c)).toContain('os=ubuntu 24.04');
        expect(await p().deleteServerAndWait(c.server.id, WAIT)).toBe(true);
    }, 150 * 60_000);

    paid('deleteImage deletes each image with its copies: gone, and deleting again is no error', async () => {
        for (const image of [imported, captured].filter((x): x is ServerImage<ScalewayImage> => !!x)) {
            await p().deleteImage(image.id);
            expect(await p().getImage(image.id)).toBeNull();
            await expect(p().deleteImage(image.id)).resolves.toBeUndefined();
        }
        expect((await p().listImages()).filter((i) => run(i.name)).map((i) => i.id)).toEqual([]);
    }, 20 * 60_000);
});

describeScalewayAudit(requested && !freeOnly, () => host!);
