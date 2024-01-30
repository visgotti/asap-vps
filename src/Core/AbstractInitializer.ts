import { ProviderServerCreationOptions, InitializerParams, InitializedSSHKeyData, RestartServerOptions, DestroyServerOptions, ChosenServerCreationOption, CreatedServerData } from "../types";
import { MACHINE_TYPES, REGION_TYPES } from "../constants";
export abstract class AbstractInitializer {
    readonly apiKey: string
    readonly apiKey2?: string
    readonly apiKey3?: string

    public options?: ProviderServerCreationOptions;

    constructor(
        params: InitializerParams | string,
    ) {
        if(typeof params === "string") {
            this.apiKey = params;
        } else {
            this.apiKey = params.apiKey;
            this.apiKey2 = params.apiKey2;
            this.apiKey3 = params.apiKey3;
        }
   
        const prev = this.getOptions.bind(this);
        this.getOptions = async (useCache, forceCacheRefresh) => {
            this.options = await prev(useCache, forceCacheRefresh);
            return this.options;
        }
    }

    private async tryGetOptionSlug(option: string, name: keyof ProviderServerCreationOptions, getter?: (v: string) => Promise<string>| string, slugProp="slug") : Promise<string | undefined> {
        const optionArray : Array<any> = this.options?.[name] as Array<any>;

        if(optionArray) {
            const slugObject = optionArray?.find(o => {
                if(typeof o === "object") {
                    return  (<any>o).id === option || (<any>o).name === option || (<any>o).slug === option
                }
                return false;
            }) as any
            
            if (slugObject) {
                return slugObject[slugProp]
            }
            const slugString = optionArray?.find(o => {
                if(typeof o === "string") {
                    return  o === option
                }
                return false;
            }) as any
            if(slugString) {
                return slugString;
            }
        }
        if(getter) {
            const slug = await getter?.(option);
            if(slug) { return slug; }
        }
    }

    protected async tryGetImageSlug(option: string | MACHINE_TYPES) : Promise<string | undefined> {
        return this.tryGetOptionSlug(option, 'image', this.getMachineTypeSlug.bind(this))
    } 

    protected async tryGetRegionSlug(option: string | REGION_TYPES) : Promise<string | undefined> {
        return this.tryGetOptionSlug(option, 'region', this.getRegionSlug.bind(this))
    } 


    public async init(...args: any[]) : Promise<ProviderServerCreationOptions> {
        const options = await this.getOptions(...args);
        if(!options) throw new Error(`Was not able to get options for intitializer.`);
        await this.onInit(options)
        this.options = options;
        return options;
    }

    public abstract deleteSSHKey(id: string | number) : Promise<boolean>;
    public abstract getRegionSlug(type: REGION_TYPES) : string | Promise<string>;
    public abstract getMachineTypeSlug(type: MACHINE_TYPES) : string | Promise<string>;
    public abstract addSSHKey(publicKey: string, keyName: string) : Promise<InitializedSSHKeyData>
    public abstract restart(options: RestartServerOptions) : Promise<void>;
    public abstract deleteServer(id: string) : Promise<void>;
    public abstract createServer(options: ChosenServerCreationOption) : Promise<CreatedServerData>;
    public abstract getOptions(useCache?: boolean, forceCacheRefresh?: boolean) : Promise<ProviderServerCreationOptions>
    public abstract onInit(options: ProviderServerCreationOptions) : Promise<void>

}