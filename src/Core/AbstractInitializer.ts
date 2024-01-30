import { MACHINE_TYPES } from "../constants";

export type SSHOptions = { username?: string, privateKey?: string, publicKey?: string, password?: string };


export type CreatedServerData = { 
    ip: string, 
    internalId: number | string, 
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
    image?: string,
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
  
// this cant be injectable because we need to initialize one eventually for each provider.
export abstract class AbstractInitializer {
    readonly apiKey: string
    readonly apiKey2?: string
    readonly apiKey3?: string

    public options?: ProviderServerCreationOptions;

    constructor(
        params: InitializerParams,
       // readonly gameRepository: Repository<Game>,
       //  readonly serverRepository: Repository<ServerEntity>,
    ) {
        this.apiKey = params.apiKey;
        this.apiKey2 = params.apiKey2;
        this.apiKey3 = params.apiKey3;
        const prev = this.getOptions.bind(this);
        this.getOptions = async (useCache, forceCacheRefresh) => {
            this.options = await prev(useCache, forceCacheRefresh);
            return this.options;
        }
    }
    public async init(...args: any[]) : Promise<ProviderServerCreationOptions> {
        const options = await this.getOptions(...args);
        if(!options) throw new Error(`Was not able to get options for intitializer.`);
        await this.onInit(options)
        this.options = options;
        return options;
    }

    /*
    public async initialize(server: ServerEntity | number, options: CreateServerOptions) : Promise<Server> {
        server = typeof server === 'object' ? server : await this.serverRepository.findOneByOrFail({ id: server as number });
        const game = await this.gameRepository.findOneOrFail({ where: { id: server.game.id }, relations: ['ssh'] });
    }*/


    public abstract getMachineTypeSlug(type: MACHINE_TYPES) : string | Promise<string>;
    public abstract initKey(publicKey: string, keyName: string) : Promise<InitializedSSHKeyData>
    public abstract restart(options: RestartServerOptions) : Promise<void>;
    public abstract destroy(options: DestroyServerOptions) : Promise<void>;
    public abstract create(options: ChosenServerCreationOption) : Promise<CreatedServerData>;
    public abstract getOptions(useCache?: boolean, forceCacheRefresh?: boolean) : Promise<ProviderServerCreationOptions>
    public abstract onInit(options: ProviderServerCreationOptions) : Promise<void>

}