// DigitalOcean API v2 objects, as the DigitalOcean provider reads and sends
// them (https://docs.digitalocean.com/reference/api/), and DigitalOceanTypes,
// which types its records and create options by them.

import type { MountPath, VolumeSize } from '../../types';
import type { DIGITALOCEAN_REFUSED } from './mappers';

/** The body of `POST /v2/droplets`: what CreateServerOptions.providerOptions adds fields to. */
export type DigitalOceanCreateDropletParams = {
  name: string,
  /** A slug, or an image id (a snapshot of the account's own). */
  image: string | number,
  size: string,
  region: string,
  /** Key ids or fingerprints. */
  ssh_keys?: Array<string | number>,
  backups?: boolean,
  ipv6?: boolean,
  monitoring?: boolean,
  tags?: string[],
  /** cloud-init user data. */
  user_data?: string,
  /** Block Storage volume ids to attach. */
  volumes?: string[],
  vpc_uuid?: string,
  with_droplet_agent?: boolean,
}

/** The body of `POST /v2/volumes`: what CreateVolumeOptions.providerOptions adds fields to. */
export type DigitalOceanCreateVolumeParams = {
  /** Lowercase letters, digits and dashes, starting with a letter; at most 64. */
  name: string,
  /** GiB. */
  size_gigabytes: number,
  region: string,
  description?: string,
  /** Formats it: a formatted volume is mounted at /mnt/<name> (dashes as underscores) on Ubuntu and other supported images. */
  filesystem_type?: 'ext4' | 'xfs',
  filesystem_label?: string,
  /** A volume snapshot to make it from (`size_gigabytes` then does not apply). */
  snapshot_id?: string,
  tags?: string[],
}

/** A Block Storage volume: in one region, attached to one droplet at a time, and kept when that droplet is deleted. */
export type DigitalOceanVolumeData = {
  id: string,
  name: string,
  description?: string,
  /** GiB. */
  size_gigabytes: number,
  region: DigitalOceanRegionData,
  /** The droplet it is attached to, if any (a volume is attached to one at most). */
  droplet_ids: number[] | null,
  /** Its filesystem, in a create's answer only: a read or a list says "" (seen live 2026-10-06), so createVolume tags it too (FS_TAG). */
  filesystem_type?: string,
  filesystem_label?: string,
  created_at: string,
  tags?: string[] | null,
}

/**
 * DigitalOcean's records, as the DigitalOcean provider's records carry them
 * (`raw`), and the options it takes. Its volumes are Block Storage: sized when
 * made, and mounted by DigitalOcean at /mnt/<name>, dashes as underscores (no path of your choosing).
 */
export type DigitalOceanTypes = {
  server: DigitalOceanDropletData,
  offer: DigitalOceanSizeData,
  image: DigitalOceanImageData,
  /** A Block Storage volume, or a Network File Storage share (`shared`). */
  volume: DigitalOceanVolumeData | DigitalOceanNfsShare,
  createBody: DigitalOceanCreateDropletParams,
  volumeBody: DigitalOceanCreateVolumeParams | DigitalOceanCreateNfsParams,
  imageImportBody: DigitalOceanImportImageParams,
  endpoint: never,
  endpointOffer: never,
  endpointBody: never,
  refused: (typeof DIGITALOCEAN_REFUSED)[number],
  volumeSize: VolumeSize,
  /** Block Storage by default; `shared: true` makes an NFS share: each takes its own request's fields. */
  volumeKind:
    | { shared?: false, providerOptions?: Partial<DigitalOceanCreateVolumeParams> & Record<string, unknown> }
    | { shared: true, providerOptions?: Partial<DigitalOceanCreateNfsParams> & Record<string, unknown> },
  /** A path for a shared volume (an NFS share); a block volume is mounted at its own mountPath. */
  mount: MountPath,
}

/** The GPUs of a GPU size or droplet. */
export type DigitalOceanGpuInfo = {
  count: number,
  /** The machine's TOTAL video memory. */
  vram?: { amount: number, unit: string },
  /** e.g. 'nvidia_rtx_4000_ada_generation', 'amd_mi300x'. */
  model?: string,
}

export type DigitalOceanSizeData = {
  slug: string,
  /** MB. */
  memory: number,
  vcpus: number,
  /** GB. */
  disk: number,
  transfer: number,
  price_monthly: number
  price_hourly: number,
  /** Where the size can be created right now. */
  regions: Array<string>,
  available: boolean,
  description: string,
  /** GPU sizes only. */
  gpu_info?: DigitalOceanGpuInfo | null,
}

/** An image; a droplet's snapshot list (/v2/droplets/{id}/snapshots) carries no status. */
export type DigitalOceanImageData = {
  id: number,
  name:string,
  distribution: string,
  slug: string,
  public: boolean,
  /** Where it can boot: snapshots are region-bound. */
  regions: string[],
  created_at: string,
  min_disk_size: number,
  /** 'base' | 'snapshot' | 'backup' | 'custom' | ... */
  type: string,
  size_gigabytes: number,
  description: string,
  tags: [],
  /** 'NEW' | 'available' | 'pending' | 'deleted' | 'retired' (an import that failed ends 'deleted', with its error_message). */
  status?:  string,
  error_message?: string,
}

/** POST /v2/images: a custom image from a file at a URL (what ImportImageOptions.providerOptions adds fields to). */
export type DigitalOceanImportImageParams = {
  name: string,
  /** http, https or ftp; the host must answer HEAD. raw, qcow2, vhdx, vdi or vmdk, gzip or bzip2 too, under 100 GB uncompressed. */
  url: string,
  region: string,
  /** Shown with the image; any other word is stored as 'Unknown'. */
  distribution?: 'Arch Linux' | 'CentOS' | 'CoreOS' | 'Debian' | 'Fedora' | 'Fedora Atomic' | 'FreeBSD' | 'Gentoo' | 'openSUSE' | 'RancherOS' | 'Rocky Linux' | 'Ubuntu' | 'Unknown',
  description?: string,
  tags?: string[],
}

export type DigitalOceanRegionData ={
  name: string,
  slug: string,
  features: string[],
  available: boolean,
  sizes: string[]
}

export type DigitalOceanNetworkData = {
  ip_address: string,
  netmask: string,
  gateway:string,
  /** 'public' | 'private'. */
  type: string,
}

export type DigitalOceanSSHData = {
  id: number,
  /** DigitalOcean's own, MD5 (asap-vps reports the SHA256 form). */
  fingerprint: string,
  public_key: string,
  name: string,
}

export type DigitalOceanDropletStatus = 'new' | 'active' | 'off' | 'archive';

export type DigitalOceanDropletData = {
  id: number,
  name: string,
  memory: number,
  vcpus: number,
  disk: number,
  locked: boolean,
  status: DigitalOceanDropletStatus,
  kernel: string | null,
  created_at: string,
  features: string[],
  backup_ids: string[],
  next_backup_window: string | null,
  snapshot_ids: string[],
  image: DigitalOceanImageData
  volume_ids: string[],
  size: DigitalOceanSizeData,
  size_slug: string,
  networks: { v4: DigitalOceanNetworkData[], v6: DigitalOceanNetworkData[] },
  region: DigitalOceanRegionData,
  tags: Array<string>,
  vpc_uuid: string,
  /** GPU droplets only. */
  gpu_info?: DigitalOceanGpuInfo | null,
}

/** A droplet or image action (power, snapshot, transfer): the droplet is locked until it completes. */
export type DigitalOceanAction = { id: number, type: string, status: 'in-progress' | 'completed' | 'errored' }

/**
 * A Network File Storage share (/v2/nfs; generally available in nyc2, ams3,
 * atl1, ric1, mkc1 and mem1): a filesystem the droplets of its VPCs mount over
 * NFSv4.1, many at once (up to 32), at host:mount_path.
 */
export type DigitalOceanNfsShare = {
  /** A UUID. */
  id: string,
  name: string,
  size_gib: number,
  region: string,
  /** 'CREATING' | 'ACTIVE' | 'INACTIVE' (no VPC attached) | 'FAILED' | 'DELETED'. */
  status: string,
  created_at: string,
  vpc_ids: string[],
  /** Set once ACTIVE: a VPC address, e.g. 10.128.32.2. */
  host?: string,
  /** Set once ACTIVE, e.g. /2559851/<share id>. */
  mount_path?: string,
  /** As DigitalOcean answers it, e.g. 'PERFORMANCE_TIER_STANDARD'. */
  performance_tier?: string,
};

/** POST /v2/nfs: what CreateVolumeOptions.providerOptions adds fields to for a shared volume. */
export type DigitalOceanCreateNfsParams = {
  name: string,
  /** 50-32768 on 'standard' ($0.15/GiB-month), from 500 on 'high'. */
  size_gib: number,
  region: string,
  /** The VPCs whose droplets may mount it (at least one, of its region; default: the region's default VPC). */
  vpc_ids: string[],
  performance_tier?: 'standard' | 'high',
};

/** A VPC (GET /v2/vpcs): one private network of a region; each region has a default one, which droplets join unless they name another. */
export type DigitalOceanVpc = {
  id: string,
  name: string,
  region: string,
  default: boolean,
  ip_range?: string,
};
