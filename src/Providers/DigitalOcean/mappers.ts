// How DigitalOcean's records read as asap-vps's: a size as an offer (with its
// GPUs, if any), a droplet as a server, a snapshot as an image, a Block Storage
// volume as a volume, an account key as a key, its status words, its billing,
// and the library's region and OS enums by DigitalOcean's names. Pure functions
// of the raw records, typed by DigitalOceanTypes.

import type { EnumTranslations } from '../../Core/ComputeProvider';
import { canonicalGpu, gpuName, sshKeyFingerprint } from '../../Core/utils';
import { MACHINE_TYPES, REGION_TYPES } from '../../constants';
import type { Billing, ImageStatus, InitializedSSHKeyData, Offer, RefusableOption, Server, ServerImage, ServerStatus, Volume, VolumeStatus } from '../../types';
import type { DigitalOceanDropletData, DigitalOceanDropletStatus, DigitalOceanGpuInfo, DigitalOceanImageData, DigitalOceanNetworkData, DigitalOceanNfsShare, DigitalOceanSizeData, DigitalOceanSSHData, DigitalOceanVolumeData } from './types';

export const DIGITALOCEAN_ID = 'digitalocean';

/**
 * The createServer options DigitalOcean cannot honor: a container's (env,
 * command, ports, a registry login, a disk of its own) and a disk size (the
 * size slug fixes it). Left out of its CreateServerOptions, refused at run time.
 */
export const DIGITALOCEAN_REFUSED = ['env', 'command', 'ports', 'registryAuth', 'volume', 'diskGb'] as const satisfies readonly RefusableOption[];

export const DROPLET_STATUS: Readonly<Record<DigitalOceanDropletStatus, ServerStatus>> = { new: 'pending', active: 'running', off: 'stopped', archive: 'terminated' };

/**
 * How DigitalOcean bills a droplet, GPU or not: per second, at least 60
 * seconds or $0.01, from creation to deletion, powered off or not
 * (docs.digitalocean.com/products/droplets/details/pricing, 2026-10-02).
 */
export const DIGITALOCEAN_BILLING: Billing = Object.freeze({ incrementSeconds: 1, minimumSeconds: 60, minimumUsd: 0.01 });

/** The library's enums by DigitalOcean's names: its regions (a region is its first datacenter) and its Ubuntu images. */
export const DIGITALOCEAN_ENUMS: EnumTranslations = Object.freeze({
    regions: {
        [REGION_TYPES.TORONTO]: 'tor1',
        [REGION_TYPES.NYC]: 'nyc1',
        [REGION_TYPES.NYC_1]: 'nyc1',
        [REGION_TYPES.NYC_2]: 'nyc2',
        [REGION_TYPES.NYC_3]: 'nyc3',
        [REGION_TYPES.SAN_FRANCISCO]: 'sfo1',
        [REGION_TYPES.SAN_FRANCISCO_1]: 'sfo1',
        [REGION_TYPES.SAN_FRANCISCO_2]: 'sfo2',
        [REGION_TYPES.SAN_FRANCISCO_3]: 'sfo3',
    },
    machines: {
        [MACHINE_TYPES.UBUNTU_24]: 'ubuntu-24-04-x64',
        [MACHINE_TYPES.UBUNTU_22]: 'ubuntu-22-04-x64',
        [MACHINE_TYPES.UBUNTU_20]: 'ubuntu-20-04-x64',
    },
});

/** A GPU model as DigitalOcean writes it ('nvidia_rtx_4000_ada_generation'), by its canonical name. */
function modelOf(model: string, slug?: string) {
    return canonicalGpu(model.replace(/^(nvidia|amd)_/i, '').replace(/_/g, ' ')) ?? canonicalGpu(slug);
}

/** A size's GPU as DigitalOcean says it: its `gpu_info` model, else its slug. */
const rawModel = (info: DigitalOceanGpuInfo, slug: string | undefined) => String(info.model ?? slug ?? '');

/** The name a size's GPU goes by, on its offer and on its droplets alike: the canonical one, else DigitalOcean's own for a model asap-vps does not know. */
function gpuOf(info: DigitalOceanGpuInfo, slug: string | undefined): string {
    const model = rawModel(info, slug);
    return modelOf(model, slug)?.name ?? gpuName(model);
}

/** A size: its GPUs where it has `gpu_info`, else a machine without GPUs. */
export function toOffer(s: DigitalOceanSizeData): Offer<DigitalOceanSizeData> {
    const base = {
        provider: DIGITALOCEAN_ID,
        id: s.slug,
        pricePerHour: Number(s.price_hourly),
        billing: DIGITALOCEAN_BILLING,
        regions: s.available ? [...(s.regions ?? [])] : [],
        vcpus: s.vcpus,
        memoryGb: s.memory / 1024,
        diskGb: s.disk,
        raw: s,
    };
    const info = s.gpu_info;
    if (!info) return { ...base, gpu: '', vendor: null, gpuCount: 0, vramGb: 0 };
    const model = rawModel(info, s.slug);
    const canon = modelOf(model, s.slug);
    const count = Number(info.count) || 1;
    return {
        ...base,
        gpu: gpuOf(info, s.slug),
        vendor: /^amd/i.test(model) || canon?.vendor === 'amd' ? 'amd' : 'nvidia',
        gpuCount: count,
        vramGb: info.vram?.amount ? Number(info.vram.amount) / count : canon?.vramGb ?? 0,
        interruptible: /spot/.test(s.slug),
    };
}

export function toServer(d: DigitalOceanDropletData): Server<DigitalOceanDropletData> {
    const ip = (list: DigitalOceanNetworkData[] | undefined, type: string) => list?.find((n) => n.type === type)?.ip_address;
    const info = d.gpu_info ?? d.size?.gpu_info;
    const publicIp = ip(d.networks?.v4, 'public');
    return {
        provider: DIGITALOCEAN_ID,
        id: String(d.id),
        name: d.name,
        status: DROPLET_STATUS[d.status] ?? 'unknown',
        providerStatus: d.status,
        offerId: d.size_slug ?? d.size?.slug,
        gpu: info ? gpuOf(info, d.size_slug ?? d.size?.slug) || undefined : undefined,
        gpuCount: info?.count,
        region: d.region?.slug,
        ip: publicIp,
        ipv6: ip(d.networks?.v6, 'public'),
        privateIp: ip(d.networks?.v4, 'private'),
        ...(publicIp ? { ssh: { host: publicIp, port: 22, username: 'root' } } : {}),
        pricePerHour: d.size?.price_hourly,
        // Billed from creation to deletion, stopped or not.
        billingStartedAt: Date.parse(d.created_at) || undefined,
        billing: DIGITALOCEAN_BILLING,
        // Its volumes: Block Storage by id (each mounted where the volume's mountPath says), and NFS shares by the tags it carries for them (with their paths).
        ...(d.volume_ids?.length || nfsMounts(d.tags).length ? { mounts: [...(d.volume_ids ?? []).map((volumeId) => ({ volumeId })), ...nfsMounts(d.tags)] } : {}),
        createdAt: Date.parse(d.created_at) || undefined,
        raw: d,
    };
}

/**
 * Where a droplet mounts a formatted volume: /mnt/<name>, each dash an
 * underscore, as systemd names its mount units ('models-v2' ->
 * /mnt/models_v2; docs.digitalocean.com/products/volumes/how-to/create,
 * 2026-10-06, and seen live).
 */
export function volumeMountPath(name: string): string {
    return `/mnt/${name.replace(/-/g, '_')}`;
}

/**
 * The tag createVolume gives a volume it formats, with the filesystem
 * (`asap-vps-fs:ext4`): DigitalOcean says a volume's filesystem only in its
 * create's answer; a read or a list answers `filesystem_type: ""` (seen live 2026-10-06).
 */
export const FS_TAG = 'asap-vps-fs:';

/** The filesystem a volume was formatted with, by DigitalOcean's word or the library's tag; undefined for a bare disk (or one formatted elsewhere, unsaid). */
export function formattedAs(v: Pick<DigitalOceanVolumeData, 'filesystem_type' | 'tags'>): string | undefined {
    return v.filesystem_type || (v.tags ?? []).find((t) => t.startsWith(FS_TAG))?.slice(FS_TAG.length) || undefined;
}

/**
 * The script (cloud-init user data, bash) that mounts the formatted volumes a
 * droplet is created with at their mountPath, at once and at every boot:
 * DigitalOcean mounts a volume by itself only on the first droplet it is
 * attached to (seen live 2026-10-06: a second droplet created with it had it
 * attached, not mounted). One already mounted there is left as it is (the
 * first droplet's, DigitalOcean's own); an unformatted volume is a bare disk,
 * not mounted. undefined when there is nothing to mount.
 */
export function volumeMountScript(volumes: ReadonlyArray<Pick<DigitalOceanVolumeData, 'name' | 'filesystem_type' | 'tags'>>): string | undefined {
    const formatted = volumes.filter((v) => formattedAs(v));
    if (!formatted.length) return undefined;
    const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
    return [
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
        ...formatted.map((v) => `mount_volume ${q(v.name)} ${q(volumeMountPath(v.name))}`),
        'ASAP_VPS_VOLUMES',
        'chmod 755 /var/lib/cloud/scripts/per-boot/asap-vps-volumes.sh',
        '/var/lib/cloud/scripts/per-boot/asap-vps-volumes.sh',
        '',
    ].join('\n');
}

/**
 * A Block Storage volume as a volume. One that was formatted is mounted on
 * each droplet created with it (volumeMountPath, volumeMountScript); one that
 * was not is a bare disk.
 */
export function toVolume(v: DigitalOceanVolumeData): Volume<DigitalOceanVolumeData> {
    const droplets = (v.droplet_ids ?? []).map(String);
    return {
        provider: DIGITALOCEAN_ID,
        id: v.id,
        name: v.name,
        region: v.region?.slug,
        sizeGb: v.size_gigabytes,
        status: droplets.length ? 'attached' : 'available',
        providerStatus: droplets.length ? 'attached' : 'detached',
        shared: false,
        serverIds: droplets,
        ...(formattedAs(v) ? { mountPath: volumeMountPath(v.name) } : {}),
        createdAt: Date.parse(v.created_at) || undefined,
        raw: v,
    };
}

export function toImage(i: DigitalOceanImageData): ServerImage<DigitalOceanImageData> {
    // A droplet's snapshot list carries no status: a listed snapshot is ready.
    const word = i.status ?? 'available';
    const status: ImageStatus = word === 'available' ? 'available'
        : word === 'NEW' || word === 'pending' ? 'pending'
        : i.error_message ? 'error' : 'unknown';
    return {
        provider: DIGITALOCEAN_ID,
        id: String(i.id),
        name: i.name,
        status,
        providerStatus: word,
        regions: [...(i.regions ?? [])],
        // The spec has it nullable: no size known is no size, never null.
        sizeGb: i.size_gigabytes ?? undefined,
        createdAt: Date.parse(i.created_at) || undefined,
        raw: i,
    };
}

/** A key as asap-vps reports it: DigitalOcean's numeric id, and the SHA256 fingerprint. */
export function toSSHKey(k: DigitalOceanSSHData): InitializedSSHKeyData {
    let fingerprint = k.fingerprint;
    try {
        fingerprint = sshKeyFingerprint(k.public_key);
    } catch {
        // Keep DigitalOcean's own (MD5) fingerprint for a key this parser does not read.
    }
    return { id: k.id, name: k.name, publicKey: k.public_key, fingerprint };
}

// ── Network File Storage (shared volumes) ────────────────────────────────

/** The tag a droplet carries for each NFS share it was created to mount: `asap-vps-nfs:<share id>:<path, hex>` (a tag takes no slash). */
export const NFS_TAG = 'asap-vps-nfs:';

export function nfsTag(shareId: string, path: string): string {
    return `${NFS_TAG}${shareId}:${Buffer.from(path, 'utf8').toString('hex')}`;
}

/** The shares a droplet's tags say it mounts, with their paths. */
export function nfsMounts(tags: readonly string[] | undefined): Array<{ volumeId: string, path: string }> {
    return (tags ?? []).flatMap((t) => {
        const m = /^asap-vps-nfs:([0-9a-f-]{36}):((?:[0-9a-f]{2})+)$/.exec(t);
        return m ? [{ volumeId: m[1], path: Buffer.from(m[2], 'hex').toString('utf8') }] : [];
    });
}

/**
 * A share's status as a volume's. INACTIVE is no failure: "the share exists but
 * is not attached to any VPC", so nothing can mount it yet. No unified word
 * says that, so it reads 'unknown', with DigitalOcean's own word beside it.
 */
export const NFS_STATUS: Readonly<Record<string, VolumeStatus>> = Object.freeze({ CREATING: 'pending', ACTIVE: 'available', INACTIVE: 'unknown', FAILED: 'error', DELETED: 'deleting' });

/** A Network File Storage share as a volume: shared, mounted by the library at the mount's path (default /mnt/<name>). DigitalOcean does not say which droplets mount it. */
export function toNfsVolume(s: DigitalOceanNfsShare): Volume<DigitalOceanNfsShare> {
    return {
        provider: DIGITALOCEAN_ID,
        id: s.id,
        name: s.name,
        region: s.region,
        shared: true,
        sizeGb: s.size_gib,
        status: NFS_STATUS[s.status] ?? 'unknown',
        providerStatus: s.status,
        mountPath: `/mnt/${s.name}`,
        createdAt: Date.parse(s.created_at) || undefined,
        raw: s,
    };
}

/**
 * The script (cloud-init user data, bash) that mounts NFS shares at their
 * paths, at once and at every boot (an /etc/fstab line each, _netdev):
 * nfs-common installed where the image lacks it (waiting out a fresh
 * machine's apt lock), each mount tried until the network is up. undefined
 * when there is nothing to mount.
 */
export function nfsMountScript(mounts: ReadonlyArray<{ share: Pick<DigitalOceanNfsShare, 'host' | 'mount_path'>, path: string }>): string | undefined {
    if (!mounts.length) return undefined;
    const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
    return [
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
        ...mounts.map((m) => `mount_share ${q(`${m.share.host}:${m.share.mount_path}`)} ${q(m.path)}`),
        '',
    ].join('\n');
}
