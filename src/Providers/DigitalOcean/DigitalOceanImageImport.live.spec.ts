// DigitalOcean's image import against the live API: Ubuntu 24.04's minimal
// cloud image (a 250 MB qcow2 from cloud-images.ubuntu.com) imported as a
// custom image (importImage: DigitalOcean fetches and converts it, minutes to
// an hour), read and listed, booted on the cheapest droplet with an SSH key,
// logged into (its OS is the image's, cloud-init done), then the droplet and
// the image deleted, verified. The image bills $0.06/GB-month while it exists,
// the droplet minutes of the cheapest size. Runs only when asked, with the key
// in .env.test (or ~/.config/asap-vps/credentials.env):
//   ASAP_VPS_LIVE=digitalocean-cpu npx jest --config jest.live.config.js DigitalOceanImageImport.live
// What the run creates is named after it and deleted at the end; the watchdog
// (src/testing/live.ts) deletes the droplet, key and image if the run dies.

import { writeFileSync } from 'fs';
import { ProvisionResult, ServerProvisioner } from '../../Core/ServerProvisioner';
import { RunCommandStep } from '../../Core/steps';
import { AuthError } from '../../errors';
import {
    deleteRunImages, deleteRunKeys, liveOptions, liveRequested, loadCredentials, newRunName, runMatcher, startWatchdog, sweepLeftovers, teardown, trackSSHKeys,
} from '../../testing/live';
import type { Offer, Server, ServerImage } from '../../types';
import { DigitalOcean } from './DigitalOcean';
import type { DigitalOceanDropletData, DigitalOceanImageData, DigitalOceanSizeData } from './types';

const requested = liveRequested('digitalocean-cpu');
const { freeOnly, maxPricePerHour } = liveOptions();
const paid = freeOnly ? it.skip : it;
const UBUNTU_MINIMAL = 'https://cloud-images.ubuntu.com/minimal/releases/noble/release/ubuntu-24.04-minimal-cloudimg-amd64.img';
const WAIT = { intervalMs: 5000, timeoutMs: 15 * 60_000 };

(requested ? describe : describe.skip)(`DigitalOcean image import: a cloud image from a URL, booted, against the live API${
    requested ? '' : ' (set ASAP_VPS_LIVE=digitalocean-cpu to run it: it imports a real image and creates a droplet)'}`, () => {
    const runName = newRunName();
    const run = runMatcher(runName);
    let p: DigitalOcean;
    let watchdog: { doneFile: string } | undefined;
    let refused = false;
    let keyIds = new Set<string>();
    let offer: Offer<DigitalOceanSizeData>;
    let image: ServerImage<DigitalOceanImageData>;
    let booted: ProvisionResult<Server<DigitalOceanDropletData>>;

    beforeAll(async () => {
        loadCredentials();
        const apiKey = process.env.DIGITAL_OCEAN_API_KEY?.trim();
        if (!apiKey) throw new Error('ASAP_VPS_LIVE asks for digitalocean-cpu, but DIGITAL_OCEAN_API_KEY is not set');
        p = new DigitalOcean(apiKey);
        keyIds = trackSSHKeys(p);
        try {
            await p.listImages();
        } catch (e) {
            if (!(e instanceof AuthError)) throw e;
            refused = true;
            throw new Error(`DIGITAL_OCEAN_API_KEY is refused by DigitalOcean, so nothing was tried: ${e.message}`);
        }
        if (!freeOnly) {
            const { limit, used } = await p.api.dropletUsage();
            if (used >= limit) throw new Error(`the account has no droplet to spare (${used} of ${limit}): nothing was created`);
            expect(await sweepLeftovers(p, { keyRounds: 3 })).toEqual([]);
            watchdog = await startWatchdog('digitalocean', runName, Date.now() + 120 * 60_000);
        }
    }, 10 * 60_000);

    afterAll(async () => {
        if (!p || refused) return;
        const servers = await teardown(p, run);
        const keys = await deleteRunKeys(p, run, { ids: keyIds, rounds: 6 });
        const images = await deleteRunImages(p, run);
        if (watchdog && !servers.length && !keys.length && !images.length) writeFileSync(watchdog.doneFile, 'done\n');
        expect({ servers, keys, images }).toEqual({ servers: [], keys: [], images: [] });
    }, 20 * 60_000);

    paid('importImage makes a bootable image of the file, in the region of the cheapest droplet in stock', async () => {
        [offer] = (await p.listOffers({ kind: 'cpu', maxPricePerHour })).filter((o) => (o.memoryGb ?? 0) >= 1);
        if (!offer) throw new Error(`no droplet size with 1 GiB at or under $${maxPricePerHour}/h is in stock right now`);
        const region = offer.regions[0];
        image = await p.importImage({
            name: `${runName}-noble`, url: UBUNTU_MINIMAL, region,
            providerOptions: { distribution: 'Ubuntu', description: 'asap-vps live run: deleted at its end' },
            intervalMs: 15_000, timeoutMs: 75 * 60_000,
        });
        expect(image).toMatchObject({ provider: 'digitalocean', name: `${runName}-noble`, status: 'available', regions: [region] });
        expect(image.sizeGb).toBeGreaterThan(0);
        expect(image.raw).toMatchObject({ type: 'custom', distribution: 'Ubuntu' });
        expect(await p.getImage(image.id)).toMatchObject({ id: image.id, status: 'available' });
        expect((await p.listImages()).map((i) => i.id)).toContain(image.id);
    }, 80 * 60_000);

    paid('a droplet boots from it: logged into over SSH, its OS is the image\'s, its cloud-init done', async () => {
        booted = await new ServerProvisioner(p).provision({
            serverOptions: { name: `${runName}-a`, offer, region: offer.regions[0], image: image.id },
            sshKeyName: runName,
            wait: WAIT,
            sshRetry: { maxRetries: 40, retryTimeout: 10_000 },
        }, (pipeline) => void pipeline.addStep(new RunCommandStep([
            '. /etc/os-release && echo "os=$ID $VERSION_ID"',
            'cloud-init status --wait >/dev/null 2>&1; cloud-init status',
        ], 'imported'))) as ProvisionResult<Server<DigitalOceanDropletData>>;
        const out = booted.setupResults.map((r) => r.output ?? '').join('\n');
        expect(out).toContain('os=ubuntu 24.04');
        expect(out).toMatch(/status: done/);
        expect(booted.server.raw.image?.id).toBe(Number(image.id));
    }, 30 * 60_000);

    paid('deleted: the droplet, then the image, each verified gone', async () => {
        expect(await p.deleteServerAndWait(booted.server.id, WAIT)).toBe(true);
        await p.deleteImage(image.id);
        expect(await p.getImage(image.id)).toBeNull();
        await expect(p.deleteImage(image.id)).resolves.toBeUndefined();
    }, 20 * 60_000);
});
