import { MACHINE_TYPES, PLATFORM, PlatformFamily } from "./constants";
import type { NodeSSH } from 'node-ssh';

export type SSHOptions = { username?: string, privateKey?: string, publicKey?: string, password?: string };

export type CreatedServerData = { 
    ip: string, 
    id: number | string, 
    ipv6?: string,
    privateIp?: string
};

export type FirewallRule = {
    port: number,
    protocol: 'tcp' | 'udp',
    allow?: boolean,
}

export type SSLCertificateConfig = {
    certContent: string,
    keyContent: string,
    certPath?: string,
    keyPath?: string,
}

export type SetupStepResult = {
    step: string,
    success: boolean,
    message?: string,
    output?: string,
}

export interface ISetupStep {
    readonly name: string;
    execute(ssh: NodeSSH, context: SetupContext): Promise<SetupStepResult>;
}

export type SetupContext = {
    platform: PLATFORM,
    platformFamily: PlatformFamily,
    ip: string,
    serverData?: CreatedServerData,
    [key: string]: unknown,
}

export type SetupPipelineOptions = {
    stopOnFailure?: boolean,
    onStepComplete?: (result: SetupStepResult) => void,
    onStepStart?: (stepName: string) => void,
}

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
  