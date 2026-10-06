export enum MACHINE_TYPES {
  UBUNTU_20 = "ubuntu20",
  UBUNTU_22 = "ubuntu22",
  UBUNTU_24 = "ubuntu24",
}

export enum REGION_TYPES {
  NYC = 'nyc',
  NYC_1 = 'nyc1',
  NYC_2 = 'nyc2',
  NYC_3 = 'nyc3',
  TORONTO = 'toronto',
  SAN_FRANCISCO = 'san_francisco',
  SAN_FRANCISCO_1 = 'san_francisco_1',
  SAN_FRANCISCO_2 = 'san_francisco_2',
  SAN_FRANCISCO_3 = 'san_francisco_3',
  // Scaleway: a region (Paris, Amsterdam, Warsaw, Milan) is its first zone, `_N` a zone (fr-par-N, nl-ams-N, pl-waw-N, it-mil-N).
  PARIS = 'paris',
  PARIS_1 = 'paris_1',
  PARIS_2 = 'paris_2',
  PARIS_3 = 'paris_3',
  AMSTERDAM = 'amsterdam',
  AMSTERDAM_1 = 'amsterdam_1',
  AMSTERDAM_2 = 'amsterdam_2',
  AMSTERDAM_3 = 'amsterdam_3',
  WARSAW = 'warsaw',
  WARSAW_1 = 'warsaw_1',
  WARSAW_2 = 'warsaw_2',
  WARSAW_3 = 'warsaw_3',
  MILAN = 'milan',
  MILAN_1 = 'milan_1',
}

export enum SETUP_SCRIPTS {
  NVM = 'nvm',
  NODE = "node",
  FOREVER = "forever"
}

export enum PLATFORM {
  UBUNTU_20 = 'ubuntu20',
  UBUNTU_22 = 'ubuntu22',
  UBUNTU_24 = 'ubuntu24',
  DEBIAN_11 = 'debian11',
  DEBIAN_12 = 'debian12',
  CENTOS_7 = 'centos7',
  CENTOS_9 = 'centos9',
  ROCKY_8 = 'rocky8',
  ROCKY_9 = 'rocky9',
  ALMA_8 = 'alma8',
  ALMA_9 = 'alma9',
  FEDORA = 'fedora',
}

export type PlatformFamily = 'debian' | 'rhel';

export const PLATFORM_FAMILY: Record<PLATFORM, PlatformFamily> = {
  [PLATFORM.UBUNTU_20]: 'debian',
  [PLATFORM.UBUNTU_22]: 'debian',
  [PLATFORM.UBUNTU_24]: 'debian',
  [PLATFORM.DEBIAN_11]: 'debian',
  [PLATFORM.DEBIAN_12]: 'debian',
  [PLATFORM.CENTOS_7]: 'rhel',
  [PLATFORM.CENTOS_9]: 'rhel',
  [PLATFORM.ROCKY_8]: 'rhel',
  [PLATFORM.ROCKY_9]: 'rhel',
  [PLATFORM.ALMA_8]: 'rhel',
  [PLATFORM.ALMA_9]: 'rhel',
  [PLATFORM.FEDORA]: 'rhel',
}