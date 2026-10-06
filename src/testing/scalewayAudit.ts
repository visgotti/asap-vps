// What a live Scaleway run must leave nothing of: the Block Storage volumes
// and the snapshots that `terminate` and `deleteImage` do not necessarily
// remove, and which bill until they are deleted; the snapshots an import or a
// copy makes on the way; the temporary buckets (TMP_BUCKET_PREFIX) they put a
// QCOW2 in. AuditedScaleway notes, as a run reads them, the volumes of its
// servers and the snapshots of its images (an import's and its copies'
// included); describeScalewayAudit then proves, through the API, that none is
// left, nor any snapshot named after a run in any zone, nor a temporary bucket
// made since the run began (and deletes what is, so a failing run does not go
// on billing). An older temporary bucket is reported, not deleted.

import { NotFoundError } from '../errors';
import { SCALEWAY_ENDPOINTS } from '../Providers/Scaleway/endpoints';
import { regionOfZone, TMP_BUCKET_PREFIX } from '../Providers/Scaleway/mappers';
import { Scaleway } from '../Providers/Scaleway/Scaleway';
import type { ScalewayImage, ScalewayRegion, ScalewayServer, ScalewayTypes, ScalewayZone } from '../Providers/Scaleway/types';
import type { CreateServerOptions, ImportImageOptions, Server, ServerImage, ServerListOptions, WaitOptions } from '../types';
import { RUN_PREFIX } from './live';

/** When this run began (this module loaded), less a margin for the clocks: a temporary bucket made since is the run's. */
const RUN_STARTED = Date.now() - 5 * 60_000;

/** `zone/volume id` of every Block Storage volume a server of this run held (the run's: named RUN_PREFIX...). */
const volumes = new Set<string>();
/** `zone/snapshot id/volume type` of every snapshot an image of this run held. */
const snapshots = new Set<string>();

function rememberServer(s: Server<ScalewayServer> | null | undefined): void {
    if (!s || !s.name.startsWith(RUN_PREFIX)) return;
    for (const v of Object.values(s.raw.volumes)) {
        if (v.volume_type === 'sbs_volume') volumes.add(`${s.region}/${v.id}`);
    }
}

function rememberImage(i: ServerImage<ScalewayImage> | null | undefined): void {
    if (!i || !i.name.startsWith(RUN_PREFIX)) return;
    const image = i.raw;
    for (const v of [image.root_volume, ...Object.values(image.extra_volumes)]) {
        if (v) snapshots.add(`${image.zone}/${v.id}/${v.volume_type}`);
    }
}

/** Scaleway, noting the volumes of the run's servers and the snapshots of its images as it reads them. */
export class AuditedScaleway extends Scaleway {
    async createServer(o: CreateServerOptions<ScalewayTypes>): Promise<Server<ScalewayServer>> {
        const s = await super.createServer(o);
        rememberServer(s);
        return s;
    }

    async getServer(id: string): Promise<Server<ScalewayServer> | null> {
        const s = await super.getServer(id);
        rememberServer(s);
        return s;
    }

    async listServers(o?: ServerListOptions): Promise<Server<ScalewayServer>[]> {
        const all = await super.listServers(o);
        all.forEach(rememberServer);
        return all;
    }

    async createImage(serverId: string, o: { name: string } & WaitOptions): Promise<ServerImage<ScalewayImage>> {
        const image = await super.createImage(serverId, o);
        rememberImage(image);
        return image;
    }

    async getImage(id: string): Promise<ServerImage<ScalewayImage> | null> {
        const image = await super.getImage(id);
        rememberImage(image);
        return image;
    }

    async listImages(): Promise<ServerImage<ScalewayImage>[]> {
        const all = await super.listImages();
        all.forEach(rememberImage);
        return all;
    }

    async importImage(o: ImportImageOptions<ScalewayTypes>): Promise<ServerImage<ScalewayImage>> {
        const image = await super.importImage(o);
        rememberImage(image);
        return image;
    }

    /** Notes its copies (named as it is) too. */
    async copyImage(id: string, regions: string[], o?: WaitOptions): Promise<ServerImage<ScalewayImage>> {
        const image = await super.copyImage(id, regions, o);
        rememberImage(image);
        (await super.listImages()).filter((i) => i.name === image.name).forEach(rememberImage);
        return image;
    }
}

/**
 * The temporary buckets (TMP_BUCKET_PREFIX) in the regions of the provider's
 * zones, `region/name`, and whether each was made since this run began.
 * None where the provider has no access key (it makes none).
 */
export async function temporaryBuckets(p: Scaleway): Promise<Array<{ region: ScalewayRegion, name: string, sinceRunBegan: boolean }>> {
    if (!p.api.accessKey) return [];
    const regions = [...new Set(p.api.zones.map(regionOfZone))];
    const found = await Promise.all(regions.map(async (region) => (await p.api.objectStorage(region, 'the audit').listBuckets())
        .filter((b) => b.name.startsWith(TMP_BUCKET_PREFIX))
        .map((b) => ({ region, name: b.name, sinceRunBegan: (b.createdAt ?? 0) >= RUN_STARTED }))));
    return found.flat();
}

/**
 * What of the run is still there: the volumes of its servers and the snapshots of
 * its images, read through the API (a snapshot is looked for by asking for it to be
 * deleted: one that is there is deleted, and reported; one that is not is a 404).
 * Whatever is found is deleted, so a failing run does not go on billing.
 */
export async function auditScaleway(p: Scaleway, wait: WaitOptions = { timeoutMs: 120_000, intervalMs: 5000 }): Promise<string[]> {
    const left: string[] = [];
    for (const key of volumes) {
        const [zone, id] = key.split('/') as [ScalewayZone, string];
        const volume = await p.api.getBlockVolume(zone, id);
        if (!volume) continue;
        left.push(`volume ${key} (${volume.status})`);
        await p.api.deleteBlockVolume(zone, id, wait).catch(() => false);
    }
    const deleteSnapshot = async (key: string) => {
        const [zone, id, type] = key.split('/') as [ScalewayZone, string, string];
        const endpoint = type === 'sbs_snapshot' ? SCALEWAY_ENDPOINTS.deleteBlockSnapshot : SCALEWAY_ENDPOINTS.deleteSnapshot;
        try {
            await p.api.call(endpoint, { path: { zone, snapshot_id: id } });
            left.push(`snapshot ${key}`);
        } catch (e) {
            if (!(e instanceof NotFoundError)) left.push(`snapshot ${key} (${(e as Error).message})`);
        }
    };
    for (const key of snapshots) await deleteSnapshot(key);
    // Any snapshot named after a run, in every zone: one an import or a copy made, and a failure left.
    for (const zone of p.api.zones) {
        const [blocks, locals] = await Promise.all([p.api.listBlockSnapshots(zone), p.api.listInstanceSnapshots(zone)]);
        for (const x of blocks.filter((b) => b.name.startsWith(RUN_PREFIX))) await deleteSnapshot(`${zone}/${x.id}/sbs_snapshot`);
        for (const x of locals.filter((l) => l.name.startsWith(RUN_PREFIX))) await deleteSnapshot(`${zone}/${x.id}/${x.volume_type}`);
    }
    // The temporary buckets: one made since the run began is deleted (with what is in it); an older one only reported.
    for (const b of await temporaryBuckets(p)) {
        if (!b.sinceRunBegan) {
            left.push(`bucket ${b.region}/${b.name} (made before this run: not deleted)`);
            continue;
        }
        left.push(`bucket ${b.region}/${b.name}`);
        await p.api.objectStorage(b.region, 'the audit').emptyAndDeleteBucket(b.name).catch(() => undefined);
    }
    return left;
}

/** Nothing the run rented is left billing: no volume of its servers, no snapshot of its images or named after a run, no temporary bucket. */
export function describeScalewayAudit(enabled: boolean, make: () => Scaleway): void {
    (enabled ? describe : describe.skip)('scaleway: nothing the run rented is left billing', () => {
        it('every Block Storage volume of its servers, every snapshot of its images or named after a run, and every temporary bucket is gone', async () => {
            expect(await auditScaleway(make())).toEqual([]);
        }, 10 * 60_000);
    });
}
