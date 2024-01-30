
export type DigitalOceanCreateDropletParams = {
  name: string,
  image: string,
  size: string,
  region: string,
  ssh_keys?: Array<string | number>
}

export type DigitalOceanSizeData = {
  slug: string,
  memory: number,
  vcpus: number,
  disk: number,
  transfer: number,
  price_monthly: number
  price_hourly: number,
  regions: Array<string>,
  available: boolean,
  description: string,
}

export type DigitalOceanOpts = {
  sizes: Array<string>,
}

export type DigitalOceanImageData = {
  id: number,
  name:string,
  distribution: string,
  slug: string,
  public: boolean,
  regions: string[],
  created_at: string,
  min_disk_size: number,
  type: string,
  size_gigabytes: number,
  description: string,
  tags: [],
  status:  string,
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
  type: string,
}

export type DigitalOceanSSHData = {
  id: number,
  fingerprint: string,
  public_key: string,
  name: string,
}

export type DigitalOceanDropletData = {
  id: number,
  name: string,
  memory: number,
  vcpus: number,
  disk: number,
  locked: boolean,
  status: boolean,
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
}

