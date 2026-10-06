// The audit of a live Scaleway run (scalewayAudit.ts) against the fake: it finds
// what a run leaves billing, deletes it, and finds nothing after a clean run.

import { SCALEWAY_ENDPOINTS } from '../Providers/Scaleway/endpoints';
import { FAKE_SCALEWAY_PROJECT, fakeScaleway } from './fakes/scaleway';
import { RUN_PREFIX } from './live';
import { AuditedScaleway, auditScaleway, temporaryBuckets } from './scalewayAudit';

const fast = { intervalMs: 0, timeoutMs: 5000 };

async function rented() {
    const fake = fakeScaleway();
    const p = new AuditedScaleway({ apiKey: 'scw-test', projectId: FAKE_SCALEWAY_PROJECT, fetchImpl: fake.fetchImpl, sleep: async () => {} });
    const [offer] = await p.listOffers({ kind: 'gpu' });
    const server = await p.waitUntilRunning((await p.createServer({ name: `${RUN_PREFIX}audit`, offer })).id, fast);
    await p.stopServer(server.id);
    const image = await p.createImage(server.id, { name: `${RUN_PREFIX}audit-image`, ...fast });
    return { fake, p, server, image };
}

describe('the audit of a live Scaleway run', () => {
    it('finds nothing after a clean run: the server, its volume, the image and its snapshots are all deleted', async () => {
        const { fake, p, server, image } = await rented();
        expect(fake.liveVolumes()).toBe(2);
        await p.deleteServer(server.id);
        await p.deleteImage(image.id);
        expect(await auditScaleway(p, fast)).toEqual([]);
        expect([fake.liveVolumes(), fake.liveSnapshots()]).toEqual([1, 0]);
    });

    it('finds the volume and the snapshot a run leaves billing, and deletes them', async () => {
        const { fake, p, server, image } = await rented();
        // The server goes by itself, as it would if nothing deleted its volume, and the image without its snapshots.
        const [zone, imageId] = image.id.split('/');
        await p.api.call(SCALEWAY_ENDPOINTS.deleteServer, { path: { zone: server.region!, server_id: server.id.split('/')[1] } });
        await p.api.call(SCALEWAY_ENDPOINTS.deleteImage, { path: { zone, image_id: imageId } });
        const left = await auditScaleway(p, fast);
        expect(left).toHaveLength(2);
        expect(left.join(' ')).toMatch(/volume pl-waw-2\/[0-9a-f-]+ \(available\)/);
        expect(left.join(' ')).toMatch(/snapshot pl-waw-2\/[0-9a-f-]+\/sbs_snapshot/);
        expect([fake.liveVolumes(), fake.liveSnapshots()]).toEqual([1, 0]);
    });

    it('finds what an import or a copy leaves: a snapshot named after a run, the snapshots of a copy, a temporary bucket of this run (deleted) and an older one (only reported)', async () => {
        const fake = fakeScaleway();
        const p = new AuditedScaleway({ apiKey: 'scw-test', projectId: FAKE_SCALEWAY_PROJECT, accessKey: 'SCWFAKEACCESSKEY0000', fetchImpl: fake.fetchImpl, sleep: async () => {} });
        const image = await p.importImage({ name: `${RUN_PREFIX}audit-import`, url: 'https://cloud-images.example.com/noble.qcow2', region: 'fr-par-2', ...fast });
        await p.copyImage(image.id, ['pl-waw-2'], fast);
        // The source goes without its copy; an import's snapshot is left before it is imaged; a run's bucket, and an older one.
        const [zone, imageId] = image.id.split('/');
        await p.api.call(SCALEWAY_ENDPOINTS.deleteImage, { path: { zone, image_id: imageId } });
        const s3 = p.api.objectStorage('fr-par', 'a test');
        await s3.createBucket('asap-vps-tmp-0123456789ab');
        await s3.putObject('asap-vps-tmp-0123456789ab', 'image.qcow2', new Uint8Array([1]));
        fake.state.s3['nl-ams'].buckets.set('asap-vps-tmp-older0000000', new Map());
        fake.state.s3['nl-ams'].buckets.set('someone-elses', new Map());
        expect((await temporaryBuckets(p)).map((b) => [b.region, b.name, b.sinceRunBegan])).toEqual([
            ['fr-par', 'asap-vps-tmp-0123456789ab', true], ['nl-ams', 'asap-vps-tmp-older0000000', false],
        ]);
        const left = await auditScaleway(p, fast);
        expect(left).toEqual(expect.arrayContaining([
            expect.stringMatching(/^snapshot fr-par-2\/[0-9a-f-]+\/sbs_snapshot$/),
            expect.stringMatching(/^snapshot pl-waw-2\/[0-9a-f-]+\/sbs_snapshot \(.*used by an image/),
            'bucket fr-par/asap-vps-tmp-0123456789ab', 'bucket nl-ams/asap-vps-tmp-older0000000 (made before this run: not deleted)',
        ]));
        expect(fake.state.s3['fr-par'].buckets.has('asap-vps-tmp-0123456789ab')).toBe(false);
        expect([...fake.state.s3['nl-ams'].buckets.keys()].sort()).toEqual(['asap-vps-tmp-older0000000', 'someone-elses']);
        // An Instance snapshot named after a run, left by itself: found, deleted.
        const local = await p.waitUntilRunning((await p.createServer({ name: `${RUN_PREFIX}local`, offer: 'DEV1-S', region: 'pl-waw-2',
            providerOptions: { volumes: { 0: { volume_type: 'l_ssd', size: 20e9 } } } })).id, fast);
        await p.stopServer(local.id);
        const captured = await p.createImage(local.id, { name: `${RUN_PREFIX}local-image`, ...fast });
        await p.api.call(SCALEWAY_ENDPOINTS.deleteImage, { path: { zone: 'pl-waw-2', image_id: captured.id.split('/')[1] } });
        fake.state.s3['nl-ams'].buckets.delete('asap-vps-tmp-older0000000');
        const again = await auditScaleway(p, fast);
        expect(again).toEqual(expect.arrayContaining([expect.stringMatching(/^snapshot pl-waw-2\/[0-9a-f-]+\/unified$/)]));
        expect((await p.api.listInstanceSnapshots('pl-waw-2')).filter((x) => x.name.startsWith(RUN_PREFIX))).toEqual([]);
    });

    it('ignores what is not the run\'s: a server and an image without its prefix are not noted', async () => {
        const fake = fakeScaleway();
        const p = new AuditedScaleway({ apiKey: 'scw-test', projectId: FAKE_SCALEWAY_PROJECT, fetchImpl: fake.fetchImpl, sleep: async () => {} });
        await p.listServers();
        await p.listImages();
        expect(await auditScaleway(p, fast)).toEqual([]);
        expect(await p.getServer('00000000-0000-4000-8000-0000000000aa')).toBeNull();
        expect(await p.getImage('00000000-0000-4000-8000-0000000000aa')).toBeNull();
    });
});
