// Scaleway as a VPS host: an Instance without GPUs, created, read and deleted
// through the same provider that rents GPU Instances, against the fake of
// Scaleway's API (src/testing/fakes/scaleway.ts). ScalewayVps.live.spec.ts is
// the live counterpart (opt-in: it creates a real Instance). A region is a zone
// (or a REGION_TYPES member), an image a Marketplace label (or a MACHINE_TYPES
// member), and an SSH key one of the Project's.

import { MACHINE_TYPES, REGION_TYPES } from '../../constants';
import { sshKeyFingerprint } from '../../Core/utils';
import { NotFoundError, NotSupportedError, ProviderError, QuotaError } from '../../errors';
import { FAKE_SCALEWAY_PROJECT, fakeScaleway, FakeScalewayOptions } from '../../testing/fakes/scaleway';
import { testPublicKey } from '../../testing/fakes/util';
import { isScalewayZone, SCALEWAY_ENUMS } from './mappers';
import { Scaleway } from './Scaleway';
import type { ScalewayParams } from './types';

const noSleep = async () => {};
const fast = { timeoutMs: 1000, intervalMs: 1 };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function made(o: FakeScalewayOptions = {}, params: Partial<ScalewayParams> = {}) {
    const fake = fakeScaleway(o);
    const vps = new Scaleway({ apiKey: 'scw-test', projectId: FAKE_SCALEWAY_PROJECT, fetchImpl: fake.fetchImpl, sleep: noSleep, ...params });
    return { fake, vps };
}

type Fake = ReturnType<typeof fakeScaleway>;
const creates = (fake: Fake) => fake.calls.filter((c) => c.method === 'POST' && /\/servers$/.test(c.path));
const server = { name: 'web-1', offer: 'DEV1-S', region: REGION_TYPES.PARIS_1, image: MACHINE_TYPES.UBUNTU_24 };

describe('Scaleway as a VPS host: offers', () => {
    it('offers every x86 Instance type without GPUs (Arm ones are created by id), each once, with no GPU', async () => {
        const { vps } = made();
        const ids = (await vps.listOffers({ kind: 'cpu', includeUnavailable: true })).map((o) => o.id);
        expect(ids).toEqual(expect.arrayContaining(['DEV1-S', 'PLAY2-NANO', 'STARDUST1-S']));
        expect(ids).not.toContain('BASIC2-A2C-4G');
        expect(ids).not.toContain('L4-1-24G');
        expect(new Set(ids).size).toBe(ids.length);
    });

    it('leaves out a type at end of service, and reads only the zones it was given', async () => {
        expect((await made({ endOfService: ['DEV1-S'] }).vps.listOffers({ kind: 'cpu', includeUnavailable: true })).map((o) => o.id)).not.toContain('DEV1-S');
        const { vps, fake } = made({}, { zones: ['fr-par-1', 'nl-ams'] });
        expect(vps.api.zones).toEqual(['fr-par-1', 'nl-ams-1', 'nl-ams-2', 'nl-ams-3']);
        await vps.listOffers({ kind: 'cpu' });
        expect(fake.calls.filter((c) => c.path.startsWith('/instance/')).every((c) => /\/zones\/(fr-par-1|nl-ams-[123])\//.test(c.path))).toBe(true);
    });

    it('lists the Project\'s keys with SHA256 fingerprints, and refuses a wrong key', async () => {
        const { vps, fake } = made();
        expect(await vps.listSSHKeys()).toEqual([{ id: expect.stringMatching(UUID), name: 'laptop', publicKey: expect.stringMatching(/^ssh-ed25519 /), fingerprint: expect.stringMatching(/^SHA256:/) }]);
        await expect(new Scaleway({ apiKey: 'wrong', fetchImpl: fake.fetchImpl, sleep: noSleep }).listOffers()).rejects.toMatchObject({ name: 'AuthError' });
    });
});

describe('Scaleway as a VPS host: the library\'s enums', () => {
    it('names each Ubuntu by its Marketplace label', async () => {
        const { vps, fake } = made();
        for (const [machine, label] of [[MACHINE_TYPES.UBUNTU_24, 'ubuntu_noble'], [MACHINE_TYPES.UBUNTU_22, 'ubuntu_jammy'], [MACHINE_TYPES.UBUNTU_20, 'ubuntu_focal']]) {
            await vps.deleteServer((await vps.createServer({ ...server, image: machine })).id);
            expect(creates(fake).pop()?.body.image).toBe(label);
        }
    });

    it('maps the Scaleway members of REGION_TYPES onto its zones, and refuses any other before anything is created', async () => {
        expect(SCALEWAY_ENUMS.regions).toEqual({
            paris: 'fr-par-1', paris_1: 'fr-par-1', paris_2: 'fr-par-2', paris_3: 'fr-par-3',
            amsterdam: 'nl-ams-1', amsterdam_1: 'nl-ams-1', amsterdam_2: 'nl-ams-2', amsterdam_3: 'nl-ams-3',
            warsaw: 'pl-waw-1', warsaw_1: 'pl-waw-1', warsaw_2: 'pl-waw-2', warsaw_3: 'pl-waw-3',
            milan: 'it-mil-1', milan_1: 'it-mil-1',
        });
        for (const zone of Object.values(SCALEWAY_ENUMS.regions ?? {})) expect(isScalewayZone(zone as string)).toBe(true);
        const { vps, fake } = made();
        await vps.deleteServer((await vps.createServer({ ...server, region: REGION_TYPES.AMSTERDAM })).id);
        expect(creates(fake).pop()?.path).toMatch(/\/zones\/nl-ams-1\/servers$/);
        // DigitalOcean's regions are not Scaleway's.
        await expect(vps.createServer({ ...server, region: REGION_TYPES.NYC_1 })).rejects.toThrow(/region "nyc1" \(REGION_TYPES has no scaleway region by that name\) is not supported/);
        expect(creates(fake)).toHaveLength(1);
    });
});

describe('Scaleway as a VPS host: createServer', () => {
    it('creates the server in the zone and starts it; it runs with its public IP; the body is what the Instance API takes', async () => {
        const { fake, vps } = made({ bootReads: 3 });
        const key = await vps.addSSHKey(testPublicKey(), 'deploy');
        const before = fake.liveServers();
        const created = await vps.createServer({ ...server, sshKeyIds: [key.id] });
        expect(created).toMatchObject({ id: expect.stringMatching(/^fr-par-1\/[0-9a-f-]{36}$/), status: 'pending', gpu: undefined });
        const running = await vps.waitUntilRunning(created.id, fast);
        expect(running).toMatchObject({ ip: expect.stringMatching(/^51\.159\.0\.\d+$/), ssh: { port: 22, username: 'root' } });
        expect(creates(fake)[0].body).toEqual({
            name: 'web-1', commercial_type: 'DEV1-S', image: 'ubuntu_noble', project: FAKE_SCALEWAY_PROJECT, dynamic_ip_required: true, boot_type: 'local', protected: false,
        });
        expect(fake.calls.filter((c) => c.body?.action).map((c) => c.body.action)).toEqual(['poweron']);
        expect(fake.liveServers()).toBe(before + 1);
        expect(fake.state.servers.get(created.id).state).toBe('running');
    });

    it('boots plain Ubuntu on a type without GPUs unless told otherwise, and takes any zone, a label, an image of the Project\'s own, or a GPU type by id', async () => {
        const { fake, vps } = made();
        await vps.createServer({ name: 'default', offer: 'DEV1-S', region: 'fr-par-1' });
        await vps.createServer({ name: 'gpu', region: REGION_TYPES.WARSAW_2, offer: 'L4-1-24G', image: 'ubuntu_noble_gpu_os_13_nvidia' });
        await vps.createServer({ name: 'by-zone', region: 'nl-ams-1', offer: 'PLAY2-NANO', image: 'debian_bookworm' });
        expect(creates(fake).map((c) => [c.path.split('/')[4], c.body.commercial_type, c.body.image])).toEqual([
            ['fr-par-1', 'DEV1-S', Scaleway.CPU_IMAGE], ['pl-waw-2', 'L4-1-24G', 'ubuntu_noble_gpu_os_13_nvidia'], ['nl-ams-1', 'PLAY2-NANO', 'debian_bookworm'],
        ]);
        // An image of the account's own: by its zonal id (which fixes the zone) or by a bare id.
        const own = fake.backupImageId;
        const zoned = await vps.createServer({ name: 'own', offer: 'DEV1-S', image: `fr-par-1/${own}` });
        expect(zoned.id).toMatch(/^fr-par-1\//);
        expect(creates(fake)[3].body.image).toBe(own);
        await expect(vps.createServer({ name: 'x', region: 'fr-par-2', offer: 'DEV1-S', image: `fr-par-1/${own}` })).rejects.toThrow(/is in fr-par-1, not fr-par-2/);
        expect(creates(fake)).toHaveLength(4);
    });

    it('names a key by id, name, public key, or fingerprint (SHA256), and refuses one the Project does not hold before anything is created', async () => {
        const { fake, vps } = made();
        const pub = testPublicKey();
        const key = await vps.addSSHKey(pub, 'by-ref');
        for (const ref of [String(key.id), 'by-ref', pub, `${pub} another-comment`, key.fingerprint, sshKeyFingerprint(pub)]) {
            await vps.deleteServer((await vps.createServer({ ...server, sshKeyIds: [ref] })).id);
        }
        const before = creates(fake).length;
        expect(before).toBe(6);
        // Another Project's key, an unknown one: refused, and Scaleway is not asked to create.
        const theirs = [...fake.state.keys.values()].find((k) => k.name === 'theirs');
        for (const ref of ['nobody', theirs.id, 'theirs']) await expect(vps.createServer({ ...server, sshKeyIds: [ref] })).rejects.toBeInstanceOf(NotFoundError);
        expect(creates(fake)).toHaveLength(before);
        // A key added elsewhere is found in the Project; no key asked for, none looked for.
        const elsewhere = new Scaleway({ apiKey: 'scw-test', projectId: FAKE_SCALEWAY_PROJECT, fetchImpl: fake.fetchImpl, sleep: noSleep });
        await elsewhere.addSSHKey(testPublicKey(), 'added-elsewhere');
        await vps.deleteServer((await vps.createServer({ ...server, sshKeyIds: ['added-elsewhere'] })).id);
        const listed = fake.calls.length;
        await vps.deleteServer((await vps.createServer(server)).id);
        expect(fake.calls.slice(listed).some((c) => c.path.startsWith('/iam/'))).toBe(false);
    });

    it('refuses what it cannot create from, and nothing is started', async () => {
        const { fake, vps } = made({}, { zones: 'fr-par,nl-ams-1' });
        await expect(vps.createServer({ ...server, offer: 'NOT-A-TYPE' })).rejects.toThrow(/NOT-A-TYPE is not offered in fr-par-1/);
        await expect(vps.createServer({ ...server, offer: '' })).rejects.toThrow(/needs an offer/);
        await expect(vps.createServer({ ...server, region: 'fr-par-9' })).rejects.toThrow(/unknown Scaleway zone "fr-par-9"/);
        await expect(vps.createServer({ ...server, region: REGION_TYPES.WARSAW_2 })).rejects.toThrow(/zone pl-waw-2 is not one of this provider's zones/);
        await expect(vps.createServer({ ...server, gpuCount: 1 })).rejects.toBeInstanceOf(NotSupportedError);
        expect(creates(fake)).toHaveLength(0);
        // A label Scaleway does not have: refused by Scaleway at the create, so nothing exists to start.
        await expect(vps.createServer({ ...server, image: 'ubuntu_noblee' })).rejects.toThrow(/unknown image label ubuntu_noblee/);
        expect(fake.calls.filter((c) => c.body?.action)).toEqual([]);
        expect(fake.liveServers()).toBe(made().fake.liveServers());
    });

    it('needs the Project: without it nothing is created', async () => {
        const { fake, vps } = made({}, { projectId: undefined });
        await expect(vps.createServer(server)).rejects.toMatchObject({ code: 'project_required' });
        expect(creates(fake)).toHaveLength(0);
    });

    it('a create is never retried after a server error (it may have made a server); failures are typed', async () => {
        const { fake, vps } = made({ gpuQuota: 1 });
        let posts = 0;
        const flaky = (async (url: string, init?: RequestInit) => {
            if (init?.method === 'POST' && String(url).endsWith('/servers') && ++posts === 1) {
                return new Response(JSON.stringify({ message: 'internal error' }), { status: 500, headers: { 'content-type': 'application/json' } });
            }
            return fake.fetchImpl(url, init);
        }) as typeof fetch;
        const vps2 = new Scaleway({ apiKey: 'scw-test', projectId: FAKE_SCALEWAY_PROJECT, fetchImpl: flaky, sleep: noSleep });
        await expect(vps2.createServer(server)).rejects.toMatchObject({ status: 500, retriable: true });
        expect(posts).toBe(1);
        // The account's GPU quota: nothing will be created until it changes.
        const gpu = { ...server, region: REGION_TYPES.WARSAW_2, offer: 'L4-1-24G', image: 'ubuntu_noble_gpu_os_13_nvidia' };
        await vps.createServer(gpu);
        await expect(vps.createServer(gpu)).rejects.toBeInstanceOf(QuotaError);
    });

    it('a server that never gets running with an address times out naming it, so it can be deleted', async () => {
        const { vps } = made({ bootReads: Number.POSITIVE_INFINITY });
        const created = await vps.createServer({ ...server, name: 'stuck' });
        const e = await vps.waitUntilRunning(created.id, { timeoutMs: 20, intervalMs: 1 }).catch((x) => x);
        expect(e).toBeInstanceOf(ProviderError);
        expect(e).toMatchObject({ code: 'timeout', message: expect.stringContaining(`waiting for server ${created.id}: pending (starting)`) });
        // It still exists, by the id the error names: the caller can delete it.
        expect((await vps.getServer(created.id))?.status).toBe('pending');
    });

    it('a server that is locked while it starts is an error, not a wait', async () => {
        const { fake, vps } = made({ bootReads: Number.POSITIVE_INFINITY });
        const created = await vps.createServer({ ...server, name: 'locked' });
        Object.assign(fake.state.servers.get(created.id), { state: 'locked', state_detail: 'locked for non-payment' });
        await expect(vps.waitUntilRunning(created.id, fast)).rejects.toThrow(`is error (locked)`);
    });

    it('a server that is deleted while it starts is gone, not a wait', async () => {
        const { fake, vps } = made({ bootReads: Number.POSITIVE_INFINITY });
        const created = await vps.createServer({ ...server, name: 'vanished' });
        fake.state.servers.delete(created.id);
        await expect(vps.waitUntilRunning(created.id, fast)).rejects.toThrow(/disappeared before it was running/);
    });
});

describe('Scaleway as a VPS host: other operations', () => {
    it('deletes idempotently, with the volume terminate leaves behind, and by a bare id', async () => {
        const { fake, vps } = made();
        const before = { servers: fake.liveServers(), volumes: fake.liveVolumes() };
        const a = await vps.waitUntilRunning((await vps.createServer(server)).id, fast);
        const b = await vps.waitUntilRunning((await vps.createServer({ ...server, name: 'web-2' })).id, fast);
        expect(fake.liveVolumes()).toBe(before.volumes + 2);
        await vps.deleteServer(a.id);
        await vps.deleteServer(b.id.split('/')[1]);
        await expect(vps.deleteServer(a.id)).resolves.toBeUndefined();
        await expect(vps.deleteServer('nonsense')).resolves.toBeUndefined();
        expect({ servers: fake.liveServers(), volumes: fake.liveVolumes() }).toEqual(before);
    });

    it('restarts by id with a reboot, by a bare id too; a server that is not there is a NotFoundError', async () => {
        const { fake, vps } = made();
        const created = await vps.createServer(server);
        await vps.restartServer(created.id);
        await vps.restartServer(created.id.split('/')[1]);
        expect(fake.calls.filter((c) => c.body?.action).map((c) => c.body.action)).toEqual(['poweron', 'reboot', 'reboot']);
        await expect(vps.restartServer('fr-par-1/00000000-0000-4000-8000-0000000000aa')).rejects.toBeInstanceOf(NotFoundError);
        await expect(vps.restartServer('00000000-0000-4000-8000-0000000000aa')).rejects.toThrow(/no server 00000000-0000-4000-8000-0000000000aa/);
    });

    it('adds a key to the Project once and returns that registration for the same key again; deletes it: true, then false', async () => {
        const { fake, vps } = made();
        const pub = testPublicKey();
        const first = await vps.addSSHKey(pub, 'ci');
        expect(first).toMatchObject({ name: 'ci', publicKey: pub, fingerprint: sshKeyFingerprint(pub) });
        expect(first.id).toMatch(UUID);
        expect((await vps.addSSHKey(pub, 'ci-again')).id).toBe(first.id);
        expect((await vps.listSSHKeys()).filter((s) => s.id === first.id)).toHaveLength(1);
        expect(fake.calls.filter((c) => c.method === 'POST' && c.path === '/iam/v1alpha1/ssh-keys')).toHaveLength(1);
        expect(await vps.deleteSSHKey(first.id)).toBe(true);
        expect((await vps.listSSHKeys()).some((s) => s.id === first.id)).toBe(false);
        expect(await vps.deleteSSHKey(first.id)).toBe(false);
    });
});
