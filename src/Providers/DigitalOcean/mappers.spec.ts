// DigitalOcean's records as asap-vps reads them, where they are sparse or say
// something unexpected: a field DigitalOcean leaves out is left out (or a
// stated default), never NaN or a crash, and a status word it adds later
// reads as 'unknown'.

import { formattedAs, FS_TAG, nfsMounts, nfsMountScript, nfsTag, toImage, toNfsVolume, toOffer, toServer, toVolume, volumeMountScript } from './mappers';
import type { DigitalOceanDropletData, DigitalOceanImageData, DigitalOceanNfsShare, DigitalOceanSizeData, DigitalOceanVolumeData } from './types';

const size = (o: Partial<DigitalOceanSizeData> = {}) => ({ slug: 's-1vcpu-1gb', price_hourly: 0.00893, available: true, regions: ['nyc3'], vcpus: 1, memory: 1024, disk: 25, ...o }) as DigitalOceanSizeData;
const droplet = (o: Partial<DigitalOceanDropletData> = {}) => ({ id: 7, name: 'd', status: 'active', created_at: '2026-10-01T00:00:00Z', ...o }) as DigitalOceanDropletData;
const SHARE = '0b4c5b1e-6a0e-4c47-9c1a-0a1b2c3d4e5f';

describe('DigitalOcean sizes as offers', () => {
    it('a size that is not available, or names no regions, is in stock nowhere', () => {
        expect(toOffer(size({ available: false })).regions).toEqual([]);
        expect(toOffer(size({ regions: undefined })).regions).toEqual([]);
    });

    it('a GPU size\'s model is its gpu_info model, else its slug; its count 1 when unsaid; its memory per GPU, else the model\'s known size, else 0', () => {
        const h100x8 = toOffer(size({ slug: 'gpu-h100x8-640gb', gpu_info: { count: 8, vram: { amount: 640, unit: 'gib' }, model: 'nvidia_h100' } } as Partial<DigitalOceanSizeData>));
        expect(h100x8).toMatchObject({ gpu: 'H100', vendor: 'nvidia', gpuCount: 8, vramGb: 80, interruptible: false });
        const bySlug = toOffer(size({ slug: 'gpu-l40sx1-48gb', gpu_info: {} } as Partial<DigitalOceanSizeData>));
        expect(bySlug).toMatchObject({ gpu: 'L40S', gpuCount: 1, vramGb: 48 });
        const unknown = toOffer(size({ slug: 'gpu-acme-z9', gpu_info: { model: 'acme_z9' } } as Partial<DigitalOceanSizeData>));
        expect(unknown).toMatchObject({ gpuCount: 1, vramGb: 0 });
        expect(toOffer(size({ slug: 'gpu-mi300x1-192gb', gpu_info: { count: 1, model: 'amd_mi300x' } } as Partial<DigitalOceanSizeData>)).vendor).toBe('amd');
    });
});

describe('DigitalOcean droplets', () => {
    it('a status DigitalOcean adds later is unknown; a date it garbles is no date', () => {
        expect(toServer(droplet({ status: 'migrating' as DigitalOceanDropletData['status'] }))).toMatchObject({ status: 'unknown', providerStatus: 'migrating' });
        expect(toServer(droplet({ created_at: 'today' }))).toMatchObject({ billingStartedAt: undefined, createdAt: undefined });
    });

    it('its size by size_slug, else its size object, whose gpu_info names its GPU', () => {
        const d = toServer(droplet({ size: { slug: 'gpu-l40sx1-48gb', price_hourly: 1.57, gpu_info: { count: 1, model: 'nvidia_l40s' } } } as Partial<DigitalOceanDropletData>));
        expect(d).toMatchObject({ offerId: 'gpu-l40sx1-48gb', gpu: 'L40S', gpuCount: 1, pricePerHour: 1.57 });
        expect(toServer(droplet()).gpu).toBeUndefined();
    });

    it('a GPU droplet that names neither its size nor its model has its GPU count, and no GPU name', () => {
        expect(toServer(droplet({ gpu_info: { count: 2 } } as Partial<DigitalOceanDropletData>))).toMatchObject({ gpu: undefined, gpuCount: 2, offerId: undefined });
    });

    it('mounts: its volumes, and the shares its tags name with their paths; none is no mounts', () => {
        expect(toServer(droplet()).mounts).toBeUndefined();
        expect(toServer(droplet({ tags: [nfsTag(SHARE, '/mnt/models'), 'web'] })).mounts).toEqual([{ volumeId: SHARE, path: '/mnt/models' }]);
        expect(toServer(droplet({ volume_ids: ['v-1'], tags: [nfsTag(SHARE, '/data')] })).mounts).toEqual([{ volumeId: 'v-1' }, { volumeId: SHARE, path: '/data' }]);
    });

    it('a share tag that is not one of the library\'s is ignored', () => {
        expect(nfsMounts(undefined)).toEqual([]);
        expect(nfsMounts([`asap-vps-nfs:${SHARE}:zz`, 'asap-vps-nfs:not-a-uuid:2f61', `asap-vps-nfs:${SHARE}:2f61`])).toEqual([{ volumeId: SHARE, path: '/a' }]);
    });
});

describe('DigitalOcean volumes, images and shares', () => {
    it('a volume\'s filesystem: DigitalOcean\'s word, else the library\'s tag, else none (a bare disk)', () => {
        expect(formattedAs({ filesystem_type: 'ext4', tags: [] })).toBe('ext4');
        expect(formattedAs({ filesystem_type: '', tags: ['team', `${FS_TAG}xfs`] })).toBe('xfs');
        expect(formattedAs({ filesystem_type: '', tags: undefined } as unknown as DigitalOceanVolumeData)).toBeUndefined();
    });

    it('a volume attached to nothing is available; a date DigitalOcean garbles is no date', () => {
        const v = toVolume({ id: 'v-1', name: 'models', size_gigabytes: 10, created_at: 'never', tags: [] } as unknown as DigitalOceanVolumeData);
        expect(v).toMatchObject({ status: 'available', providerStatus: 'detached', serverIds: [], createdAt: undefined });
        expect(v.mountPath).toBeUndefined();
    });

    it('an image\'s status: NEW and pending are pending; another word is an error when DigitalOcean gives one, else unknown', () => {
        const image = (o: Partial<DigitalOceanImageData>) => toImage({ id: 1, name: 'i', created_at: '2026-10-01T00:00:00Z', ...o } as DigitalOceanImageData);
        expect(['NEW', 'pending', 'available', 'deleted'].map((status) => image({ status: status as DigitalOceanImageData['status'] }).status)).toEqual(['pending', 'pending', 'available', 'unknown']);
        expect(image({ status: 'deleted' as DigitalOceanImageData['status'], error_message: 'the file could not be read' }).status).toBe('error');
        // A droplet's snapshot list gives no status, no regions and no date that parses: a listed snapshot is ready.
        expect(image({ created_at: 'x' })).toMatchObject({ status: 'available', providerStatus: 'available', regions: [], createdAt: undefined });
    });

    it('a share\'s status DigitalOcean adds later is unknown; a date it garbles is no date', () => {
        const s = toNfsVolume({ id: SHARE, name: 'models', region: 'atl1', size_gib: 50, status: 'RESIZING', created_at: 'x' } as unknown as DigitalOceanNfsShare);
        expect(s).toMatchObject({ status: 'unknown', providerStatus: 'RESIZING', shared: true, mountPath: '/mnt/models', createdAt: undefined });
    });
});

describe('DigitalOcean user data: the scripts that mount a droplet\'s volumes', () => {
    it('mounts each formatted Block Storage volume at its mountPath, by its device, now and at every boot; a bare disk is left out', () => {
        const script = volumeMountScript([
            { name: 'models-v2', filesystem_type: '', tags: [`${FS_TAG}ext4`] },
            { name: 'raw', filesystem_type: '', tags: [] },
            { name: 'logs', filesystem_type: 'xfs', tags: [] },
        ]);
        expect(script).toBe([
            '#!/bin/bash',
            '# asap-vps: mounts the droplet\'s volumes (CreateServerOptions.mounts) at their mountPath, now and at every boot.',
            'cat > /var/lib/cloud/scripts/per-boot/asap-vps-volumes.sh <<\'ASAP_VPS_VOLUMES\'',
            '#!/bin/bash',
            'mount_volume() {',
            '  device="/dev/disk/by-id/scsi-0DO_Volume_$1"',
            '  for i in $(seq 1 60); do [ -e "$device" ] && break; sleep 2; done',
            '  mkdir -p "$2"',
            '  findmnt -n "$2" >/dev/null || mount -o defaults,nofail,discard,noatime "$device" "$2"',
            '}',
            "mount_volume 'models-v2' '/mnt/models_v2'",
            "mount_volume 'logs' '/mnt/logs'",
            'ASAP_VPS_VOLUMES',
            'chmod 755 /var/lib/cloud/scripts/per-boot/asap-vps-volumes.sh',
            '/var/lib/cloud/scripts/per-boot/asap-vps-volumes.sh',
            '',
        ].join('\n'));
        expect(volumeMountScript([{ name: 'raw', filesystem_type: '', tags: [] }])).toBeUndefined();
    });

    it('mounts each share over NFS at its path, through /etc/fstab, nfs-common installed where it is missing; a path is quoted for the shell, a quote in it too', () => {
        const script = nfsMountScript([
            { share: { host: '10.10.0.5', mount_path: '/2559851/abc' }, path: "/mnt/it's" },
            { share: { host: '10.10.0.6', mount_path: '/2559851/def' }, path: '/data' },
        ]);
        expect(script).toBe([
            '#!/bin/bash',
            '# asap-vps: mounts the droplet\'s shared volumes (CreateServerOptions.mounts) over NFS, now and at every boot.',
            'export DEBIAN_FRONTEND=noninteractive',
            'apt_get() { for i in $(seq 1 60); do apt-get -o DPkg::Lock::Timeout=60 "$@" && return 0; sleep 10; done; return 1; }',
            'command -v mount.nfs >/dev/null 2>&1 || { apt_get update -y; apt_get install -y nfs-common; }',
            'mount_share() {',
            '  mkdir -p "$2"',
            '  grep -qs " $2 nfs " /etc/fstab || echo "$1 $2 nfs _netdev,nofail,nconnect=8,vers=4.1 0 0" >> /etc/fstab',
            '  for i in $(seq 1 30); do findmnt -n "$2" >/dev/null && break; mount "$2" && break; sleep 5; done',
            '}',
            "mount_share '10.10.0.5:/2559851/abc' '/mnt/it'\\''s'",
            "mount_share '10.10.0.6:/2559851/def' '/data'",
            '',
        ].join('\n'));
        expect(nfsMountScript([])).toBeUndefined();
    });
});
