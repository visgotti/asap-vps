import { MACHINE_TYPES } from "./constants";

export type SSHOptions = { username?: string, privateKey?: string, publicKey?: string, password?: string };

export type CreatedServerData = { 
    ip: string, 
    id: number | string, 
    ipv6?: string,
    privateIp?: string
};

export type ChosenServerCreationOption = {
    name?: string,
    slug?: string,
    region?: string,
    size?: string,
    sizeRam?: string,
    sizeMemory?: string,
    sizeCpu?: string,
    platform?: string,
    ssh?: string | number,
    image?: string | MACHINE_TYPES,
}

export type ProviderServerImageOption = {
    distribution: string, 
    regions?: string[], 
    slug: string, 
    id: number | string,
     name: string,
      diskSize: number,
       ram: number
}

export type ProviderServerSSHOption = {
    id: string | number,
    fingerprint: string,
    name: string,
    key: string
}

export type ProviderServerCreationOptions = {
    name?: string[],
    slug?: string[],
    region?: string[],
    size?: string[],
    sizeRam?: string[],
    sizeMemory?: string[],
    sizeCpu?: string[],
    platform?: string[],
    ssh?: ProviderServerSSHOption[],
    image?: ProviderServerImageOption[],
}


export type DestroyServerOptions = {
    id: string,
}

export type CloneServerOptions = {
    id: string,
}
  
export type RestartServerOptions = {
    provider: string,
    slug?: string,
    region?: string,
    size?: string,
    sizeRam?: string,
    sizeMemory?: string,
    sizeCpu?: string,
    extra?: any,
}

export type InitializerParams = {
    apiKey: string,
    apiKey2?: string,
    apiKey3?: string,
}

export type InitializedSSHKeyData = { id: number | string, publicKey: string, name: string, fingerprint: string }
  