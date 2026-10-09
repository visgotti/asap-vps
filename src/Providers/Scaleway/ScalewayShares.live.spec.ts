// Scaleway's shared volumes against the live API: a File Storage filesystem
// (createVolume({ shared: true }): 25 GB in Paris, about EUR 0.0055 an hour)
// attached to two Instances of the cheapest type that attaches one (in a Paris
// zone), at once, each mounting it with virtiofs at a path of its own: a file
// written by the first is read by the second while the first still has it;
// then the Instances and the filesystem deleted, verified. Runs only when
// asked, with the secret key and the Project in .env.test (or
// ~/.config/asap-vps/credentials.env):
//   ASAP_VPS_LIVE=scaleway-vps npx jest --config jest.live.config.js ScalewayShares.live
// What the run creates is named after it and deleted at the end (the
// filesystem after the Instances); the watchdog (src/testing/live.ts) deletes it
// if the run dies, and the audit (src/testing/scalewayAudit.ts) proves no volume of it is left.

import { writeFileSync } from 'fs';
import { ProvisionResult, ServerProvisioner } from '../../Core/ServerProvisioner';
import { RunCommandStep } from '../../Core/steps';
import { AuthError } from '../../errors';
import {
    deleteRunKeys, deleteRunVolumes, liveOptions, liveRequested, loadCredentials, newRunName, runMatcher, startWatchdog, sweepLeftovers, teardown, trackSSHKeys, trackVolumes,
} from '../../testing/live';
import { AuditedScaleway, describeScalewayAudit } from '../../testing/scalewayAudit';
import type { Offer, Server, Volume } from '../../types';
import { Scaleway } from './Scaleway';
import type { ScalewayFileSystem, ScalewayOfferRaw, ScalewayServer } from './types';

const requested = liveRequested('scaleway-vps');
const { freeOnly } = liveOptions();
const paid = freeOnly ? it.skip : it;
const WAIT = { intervalMs: 3000, timeoutMs: 10 * 60_000 };
const PATH = '/mnt/shared';

let host: AuditedScaleway | undefined;

(requested ? describe : describe.skip)(`Scaleway shared volumes: a File Storage filesystem two Instances mount at once, against the live API${
    requested ? '' : ' (set ASAP_VPS_LIVE=scaleway-vps to run it: it creates a real filesystem and Instances)'}`, () => {
    const runName = newRunName();
    const run = runMatcher(runName);
    let account: Scaleway;
    let watchdog: { doneFile: string } | undefined;
    let refused = false;
    let volumeIds = new Set<string>();
    let keyIds = new Set<string>();
    let offer: Offer<ScalewayOfferRaw>;
    let zone: string;
    let share: Volume<ScalewayFileSystem>;
    const servers: Array<ProvisionResult<Server<ScalewayServer>>> = [];
    const p = () => host!;
    const provision = (name: string, commands: string[]) => new ServerProvisioner(p()).provision({
        serverOptions: { name, offer, region: zone, mounts: [{ volume: share, path: PATH }] },
        sshKeyName: name,
        wait: WAIT,
        sshRetry: { maxRetries: 30, retryTimeout: 10_000 },
    }, (pipeline) => void pipeline.addStep(new RunCommandStep(commands, 'share'))) as Promise<ProvisionResult<Server<ScalewayServer>>>;
    /** Until cloud-init is done and the filesystem is mounted: its filesystem type, or a failure on stderr. */
    const mounted = `cloud-init status --wait >/dev/null 2>&1 || true; for i in $(seq 1 60); do findmnt -n ${PATH} >/dev/null && break; sleep 2; done; `
        + `findmnt -n -o FSTYPE ${PATH} || { echo "nothing is mounted at ${PATH}: $(tail -5 /var/log/cloud-init-output.log)" >&2; exit 1; }`;
    const output = (r: ProvisionResult) => r.setupResults.map((x) => `${x.output ?? ''}${x.message ?? ''}`).join('\n');

    beforeAll(async () => {
        loadCredentials();
        const apiKey = process.env.SCW_SECRET_KEY?.trim();
        const projectId = process.env.SCW_DEFAULT_PROJECT_ID?.trim();
        if (!apiKey || !projectId) throw new Error('ASAP_VPS_LIVE asks for scaleway-vps, but SCW_SECRET_KEY or SCW_DEFAULT_PROJECT_ID is not set');
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
        const left = await teardown(account, run);
        const keys = await deleteRunKeys(account, run, { ids: keyIds, rounds: 6 });
        const volumes = await deleteRunVolumes(account, run, { ids: volumeIds, rounds: 10 });
        if (watchdog && !left.length && !keys.length && !volumes.length) writeFileSync(watchdog.doneFile, 'done\n');
        expect({ servers: left, keys, volumes }).toEqual({ servers: [], keys: [], volumes: [] });
    }, 15 * 60_000);

    paid('createVolume({ shared: true }) makes a filesystem in Paris, available; the cheapest type that attaches one is picked', async () => {
        const offers = await p().listOffers({ kind: 'cpu' });
        offer = offers.find((o) => (o.raw.serverType.capabilities?.max_file_systems ?? 0) > 0 && o.regions.some((r) => r.startsWith('fr-par')))!;
        if (!offer) throw new Error('no CPU type that attaches a filesystem is in stock in a Paris zone right now');
        zone = offer.regions.find((r) => r.startsWith('fr-par'))!;
        share = await p().createVolume({ name: `${runName}-share`, region: zone, sizeGb: 25, shared: true, ...WAIT });
        expect(share).toMatchObject({ provider: 'scaleway', name: `${runName}-share`, region: 'fr-par', shared: true, sizeGb: 25, status: 'available' });
        expect(await p().getVolume(share.id)).toMatchObject({ id: share.id, shared: true });
        expect((await p().listVolumes()).map((v) => v.id)).toContain(share.id);
    }, 15 * 60_000);

    paid('an Instance created with it has it attached, mounts it with virtiofs at its path, and writes to it', async () => {
        const a = await provision(`${runName}-a`, [mounted, `echo asap-vps-shared=${runName} > ${PATH}/marker && cat ${PATH}/marker`]);
        servers.push(a);
        expect(output(a)).toMatch(/virtiofs/);
        expect(output(a)).toContain(`asap-vps-shared=${runName}`);
        expect(a.server.mounts).toEqual([{ volumeId: share.id, path: PATH }]);
        expect(await p().getVolume(share.id)).toMatchObject({ status: 'attached' });
    }, 25 * 60_000);

    paid('a second Instance mounts it while the first still does, and reads the file', async () => {
        const b = await provision(`${runName}-b`, [mounted, `cat ${PATH}/marker`]);
        servers.push(b);
        expect(output(b)).toContain(`asap-vps-shared=${runName}`);
        expect((await p().getServer(servers[0].server.id))?.status).toBe('running');
        expect(((await p().getVolume(share.id))?.raw as ScalewayFileSystem).number_of_attachments).toBe(2);
    }, 25 * 60_000);

    paid('the Instances go; the filesystem stays until deleteVolume, then it is gone', async () => {
        for (const s of servers) expect(await p().deleteServerAndWait(s.server.id, WAIT)).toBe(true);
        expect(await p().getVolume(share.id)).toMatchObject({ status: 'available' });
        await p().deleteVolume(share.id, WAIT);
        expect(await p().getVolume(share.id)).toBeNull();
        await expect(p().deleteVolume(share.id)).resolves.toBeUndefined();
    }, 20 * 60_000);
});

describeScalewayAudit(requested && !freeOnly, () => host!);
