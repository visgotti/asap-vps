// Lambda's filesystems against the live API: a filesystem made with
// createVolume (shared storage in one region; it bills for what it holds
// until deleteVolume), mounted at launch by two instances at once
// (CreateServerOptions.mounts), a file one writes read by the other over SSH,
// and the filesystem kept when the instances are terminated. Each instance is
// the cheapest GPU in stock under ASAP_VPS_LIVE_MAX_PRICE (default $1/h), for
// about ten minutes. Runs only when asked, with the key in .env.test (or
// ~/.config/asap-vps/credentials.env):
//   ASAP_VPS_LIVE=lambda npx jest --config jest.live.config.js LambdaVolumes.live
// What the run creates is named after it and deleted at the end (the
// filesystem after the instances, so none mounts it); the watchdog
// (src/testing/live.ts) deletes it if the run dies.

import { writeFileSync } from 'fs';
import { ProvisionResult, ServerProvisioner } from '../../Core/ServerProvisioner';
import { RunCommandStep } from '../../Core/steps';
import { AuthError, ProviderError } from '../../errors';
import {
    deleteRunKeys, deleteRunVolumes, liveOptions, liveRequested, loadCredentials, newRunName, runMatcher, startWatchdog, sweepLeftovers, teardown, trackSSHKeys,
    trackVolumes,
} from '../../testing/live';
import type { Offer, Server, Volume } from '../../types';
import { LambdaCloud } from './LambdaCloud';
import type { LambdaFilesystem, LambdaInstance, LambdaInstanceTypes } from './types';

const requested = liveRequested('lambda');
const { freeOnly, maxPricePerHour } = liveOptions();
const paid = freeOnly ? it.skip : it;
const WAIT = { intervalMs: 10_000, timeoutMs: 20 * 60_000 };
const SSH_RETRY = { maxRetries: 30, retryTimeout: 10_000 };

(requested ? describe : describe.skip)(`Lambda filesystems: one filesystem mounted by two instances at once, against the live API${
    requested ? '' : ' (set ASAP_VPS_LIVE=lambda to run it: it creates a real filesystem and instances)'}`, () => {
    const runName = newRunName();
    const run = runMatcher(runName);
    let p: LambdaCloud;
    let watchdog: { doneFile: string } | undefined;
    let refused = false;
    let volumeIds = new Set<string>();
    let keyIds = new Set<string>();
    let offer: Offer<LambdaInstanceTypes[string]>;
    let region: string;
    let fs: Volume<LambdaFilesystem>;
    let writer: ProvisionResult<Server<LambdaInstance>>;
    let reader: ProvisionResult<Server<LambdaInstance>>;

    /** A server mounting the filesystem, provisioned over SSH (the provisioner's own key), running `commands` as root. */
    const provision = (name: string, path: string | undefined, commands: string[]) => new ServerProvisioner(p).provision({
        serverOptions: { name, offer, region, mounts: [{ volume: fs, ...(path ? { path } : {}) }] },
        sshKeyName: name,
        wait: WAIT,
        sshRetry: SSH_RETRY,
    }, (pipeline) => void pipeline.addStep(new RunCommandStep(commands, 'filesystem'))) as Promise<ProvisionResult<Server<LambdaInstance>>>;
    const output = (r: ProvisionResult) => r.setupResults.map((x) => `${x.output ?? ''}${x.message ?? ''}`).join('\n');

    beforeAll(async () => {
        loadCredentials();
        const apiKey = process.env.LAMBDA_API_KEY?.trim();
        if (!apiKey) throw new Error('ASAP_VPS_LIVE asks for lambda, but LAMBDA_API_KEY is not set');
        p = new LambdaCloud(apiKey);
        volumeIds = trackVolumes(p);
        keyIds = trackSSHKeys(p);
        try {
            await p.listVolumes();
        } catch (e) {
            if (!(e instanceof AuthError)) throw e;
            refused = true;
            throw new Error(`LAMBDA_API_KEY is refused by Lambda, so nothing was tried: ${e.message}`);
        }
        if (!freeOnly) {
            expect(await sweepLeftovers(p, { keyRounds: 3 })).toEqual([]);
            watchdog = await startWatchdog('lambda', runName, Date.now() + 75 * 60_000);
        }
    }, 10 * 60_000);

    afterAll(async () => {
        if (!p || refused) return;
        // Instances first, so none mounts the filesystem; then the run's keys and filesystems, by id and by name, each verified gone.
        const servers = await teardown(p, run);
        const keys = await deleteRunKeys(p, run, { ids: keyIds, rounds: 3 });
        const volumes = await deleteRunVolumes(p, run, { ids: volumeIds, rounds: 12 });
        if (watchdog && !servers.length && !keys.length && !volumes.length) writeFileSync(watchdog.doneFile, 'done\n');
        expect({ servers, keys, volumes }).toEqual({ servers: [], keys: [], volumes: [] });
    }, 20 * 60_000);

    paid('createVolume makes a filesystem where a GPU is in stock; getVolume and listVolumes read it', async () => {
        [offer] = await p.listOffers({ maxPricePerHour });
        if (!offer) throw new Error(`no GPU at or under $${maxPricePerHour}/h is in stock right now (ASAP_VPS_LIVE_MAX_PRICE raises the cap)`);
        region = offer.regions[0];
        fs = await p.createVolume({ name: `${runName}-models`, region });
        expect(fs).toMatchObject({ provider: 'lambda', name: `${runName}-models`, region, status: 'available', mountPath: `/lambda/nfs/${runName}-models` });
        expect(fs.sizeGb).toBeUndefined();
        expect((await p.getVolume(fs.id))?.id).toBe(fs.id);
        expect((await p.listVolumes()).map((v) => v.id)).toContain(fs.id);
    }, 5 * 60_000);

    paid('an instance mounts it at the path asked, and writes to it', async () => {
        writer = await provision(`${runName}-writer`, '/data/models', [
            `echo asap-vps-wrote=${runName} > /data/models/marker`, 'cat /data/models/marker', 'findmnt -n -o FSTYPE /data/models',
        ]);
        expect(writer.server.mounts).toEqual([{ volumeId: fs.id, path: '/data/models' }]);
        expect(output(writer)).toContain(`asap-vps-wrote=${runName}`);
        // A filesystem is a virtiofs mount (seen live 2026-10-06), not NFS.
        expect(output(writer)).toMatch(/virtiofs/);
        expect((await p.getVolume(fs.id))?.status).toBe('attached');
    }, 30 * 60_000);

    paid('a second instance mounts it at its own mount point while the first runs, and reads what the first wrote', async () => {
        reader = await provision(`${runName}-reader`, undefined, [`cat ${fs.mountPath}/marker`]);
        expect(reader.server.mounts).toEqual([{ volumeId: fs.id, path: fs.mountPath }]);
        expect((await p.getServer(writer.server.id))?.status).toBe('running');
        expect(output(reader)).toContain(`asap-vps-wrote=${runName}`);
    }, 30 * 60_000);

    paid('the instances go; the filesystem stays until deleteVolume, which is idempotent', async () => {
        expect(await p.deleteServerAndWait(writer.server.id, WAIT)).toBe(true);
        expect(await p.deleteServerAndWait(reader.server.id, WAIT)).toBe(true);
        // The instances are gone; the filesystem is not.
        expect((await p.getVolume(fs.id))?.id).toBe(fs.id);
        // Lambda clears `in use` once the instances are gone: until then, a delete is refused.
        let deleted = false;
        for (let i = 0; i < 24 && !deleted; i++) {
            try {
                await p.deleteVolume(fs.id);
                deleted = true;
            } catch (e) {
                if (!(e instanceof ProviderError) || e.code !== 'filesystems/filesystem-in-use') throw e;
                await new Promise((r) => setTimeout(r, 10_000));
            }
        }
        expect(deleted).toBe(true);
        expect(await p.getVolume(fs.id)).toBeNull();
        await expect(p.deleteVolume(fs.id)).resolves.toBeUndefined();
    }, 20 * 60_000);
});
