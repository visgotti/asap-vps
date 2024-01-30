import * as querystring from 'querystring';
import { AbstractInitializer, ChosenServerCreationOption, CreatedServerData, DestroyServerOptions, InitializedSSHKeyData, InitializerParams, ProviderServerCreationOptions } from "../Core/AbstractInitializer";
import axios from 'axios';
import { makeId, asyncTimeout } from '../utils';
import * as path from 'path';
import * as fs from 'fs';
import { MACHINE_TYPES } from '../constants';

type DigitalOceanCreateDropletParams = {
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
  
  type DigitalOceanNetworkData = {
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


export class DigitalOceanInitializer extends AbstractInitializer {
    constructor(a: InitializerParams) {
        super(a);
    }
    public async getMachineTypeSlug(type: MACHINE_TYPES) {
        switch(type) {
            case MACHINE_TYPES.UBUNTU_22:
                return `ubuntu-22-04-x64`;
            case MACHINE_TYPES.UBUNTU_20:
                return `ubuntu-20-04-x64`;
        }
    }
    public async getOptions(tryUseCache = false, forceCacheRefresh = false): Promise<ProviderServerCreationOptions> {
        if (process.env.NODE_ENV === 'test' && tryUseCache) {
            const testOptPath = path.join(process.cwd(), 'do-server-options.test.json');
            if (!forceCacheRefresh && fs.existsSync(testOptPath)) {
                const data = JSON.parse(fs.readFileSync(testOptPath, 'utf-8'));
                return data as ProviderServerCreationOptions;
            } else {
                const options = await this.fetchOptions();
                fs.writeFileSync(testOptPath, JSON.stringify(options), 'utf-8');
                return options;
            }
        }
        return this.fetchOptions();
    }

    private async fetchOptions(): Promise<ProviderServerCreationOptions> {
        const sizes = await this.getAll('https://api.digitalocean.com/v2/sizes', 'sizes');
        const ssh_keys = await this.getAll('https://api.digitalocean.com/v2/account/keys', 'ssh_keys');
        const images = await this.getAll('https://api.digitalocean.com/v2/images', 'images');

        return {
            size: sizes.map((s: DigitalOceanSizeData) => s.slug),
            ssh: ssh_keys,
            image: images.filter(i => i.status === 'available').map((i: DigitalOceanImageData) => ({
                name: i.name,
                slug: i.slug,
                regions: i.regions,
                ram: i.size_gigabytes,
                diskSize: i.min_disk_size,
                id: i.id,
                distribution: i.distribution
            })),
        }

    }

    readonly digitalOceanOptions : DigitalOceanDropletData

    private availableSizes: Array<string> 
    private availableImages: Array<string>

    public async initKey(ssh: string, keyName: string): Promise<InitializedSSHKeyData> {
        const { ssh_key } = await this.post(`https://api.digitalocean.com/v2/account/keys`, {
            public_key: ssh,
            name: keyName
        });
        const { name, public_key: publicKey, id, fingerprint } = ssh_key;
        this.options?.ssh?.push(ssh_key);
        
        return {
            name, publicKey, id, fingerprint 
        }
    }

    public async deleteKey(keyId: string | number)  : Promise<boolean> { 
        try {
            await this.delete(`https://api.digitalocean.com/v2/account/keys/${keyId}`);
            if(Array.isArray(this.options?.ssh)) {
                this.options!.ssh = this.options!.ssh.filter(p => {
                    return `${p.id}` !== `${keyId}` && `${p.name !== keyId}`;
                });
            }
            return true;
        } catch (err) {
            return false;
        }
    }

    public async deleteAllDroplets() {
        const d = await this.getDroplets();
        return Promise.all(d.map(dd => this.deleteDroplet(dd.id)))
    }

    public async deleteDroplet(id: number | string) {
        await this.delete(`https://api.digitalocean.com/v2/droplets/${id}`);
    }

    public async onInit(options: ProviderServerCreationOptions) {
        /*
        if(!options.ssh?.length) {
            throw new Error(`There is no ssh keys initialized on this digital ocean droplet.`)
        }
        */
        if(!options.size?.length) throw new Error(`Expected sizes to come back from get options..`);
        this.availableSizes = options.size;

        /*
        this.options?.ssh?.forEach(s => {
            this.deleteKey(s.id)
        });
        */
    }


    public async restart(options: any): Promise<void> {
        throw new Error(`Unimplemented`);
    }

    public async destroy(options: DestroyServerOptions): Promise<void> {
        throw new Error(`Unimplemented`);
    }

    private convertDropletToCreatedServerData(d: DigitalOceanDropletData) : CreatedServerData {
        return {
            internalId: `${d.id}`,
            ip: this.getPublicIp(d),
            ipv6: this.getPublicIp6(d),
            privateIp: this.getPrivateIp(d),
        }
    }

    private getPrivateIp(droplet: DigitalOceanDropletData)  {
        const privateIp = droplet.networks?.v4?.find(v => v.type === "private");
        if(privateIp) return privateIp.ip_address;
        return '';
    }    
    private getPublicIp(droplet: DigitalOceanDropletData) : string {
        const pub = droplet?.networks?.v4?.find(v => v.type === "public");
        if(pub) return pub.ip_address;
        return '';
    }
    private getPublicIp6(droplet: DigitalOceanDropletData)  {
        const pub = droplet.networks?.v6?.find(v => v.type === "public");
        if(pub) return pub.ip_address;
        return '';
    }
    private getDroplets() : Promise<DigitalOceanDropletData[]> {
        return this.getAll(`https://api.digitalocean.com/v2/droplets`, 'droplets');
    }
    private async getDroplet(id: number | string) : Promise<DigitalOceanDropletData> {
        const { droplet } = await this.get(`https://api.digitalocean.com/v2/droplets/${id}`);
        return droplet;
    }

    public async confirmDropletCreated(dropletId: number, polled=0) : Promise<DigitalOceanDropletData> {
        polled++;
        return new Promise( async (resolve, reject) => {
//            console.log("Checking if droplet", dropletId, "finished creating on poll check", polled)
            const  droplet = await this.getDroplet(dropletId);
            //console.log('droplet', droplet.networks.v4.length);
            const ip = this.getPublicIp(droplet)
            if(ip) {
                return resolve(droplet)
            } else {
                polled++;
                if(polled < 10) {
              //      console.log('no droplet with ip try again in 15 seconds...')
                    await asyncTimeout(15000);
                    return resolve(this.confirmDropletCreated(dropletId, polled))
                } else {
                    return reject(`Can not confirm droplet with public ip ${droplet}`)
                }
            }
        })
    }
    
    public async create(options: ChosenServerCreationOption) : Promise<CreatedServerData> {
        const o = this.validateAndConvertCreateOptions(options);
        let droplet;
        let retryCreate = 0;
        while(!droplet && retryCreate < 5) {
          try {
           ({ droplet }  = await this.post(`https://api.digitalocean.com/v2/droplets`, o));
          } catch(err) {
            console.error("Error creating droplet on try:", retryCreate, err.message);
          }
          retryCreate++;
          await asyncTimeout(5000);
        }
        if(droplet) {
            await asyncTimeout(15000);
            droplet = await this.confirmDropletCreated(droplet.id);
        } else {
            throw new Error(`Failed to create droplet`);
        }
        
        return this.convertDropletToCreatedServerData(droplet);
    }

    private validateAndConvertCreateOptions(options: ChosenServerCreationOption) : DigitalOceanCreateDropletParams {
        if(!options.size) {
            throw new Error(`Expected options.size`);
        }
        if(!this.availableSizes.includes(options.size)) {
            throw new Error(`Size not available.`)
        }

        if(!options.image) {
            throw new Error(`Must provide image...`);
        }

        if(!options.region) {
            throw new Error(`Must provide region...`);
        }

        const image = this.options?.image?.find(o => o.id === options.image || o.name === options.image || o.slug === options.image);

        if(!image) {
            throw new Error(`Image not available.`)
        }

      //  console.log('all the ssh options were:', this.options?.ssh, this.options?.ssh?.length);
     //   console.log('options.ssh was', options.ssh);
    
        const foundKey = this.options?.ssh?.find(s => s.id === options.ssh || s.fingerprint === options.ssh || s.name === options.ssh || s.key === options.ssh);

        const obj : DigitalOceanCreateDropletParams = {
            name: options.name || makeId(14),
            image: options.image,
            size: options.size,
            region: options.region,
        }
        if(foundKey) {
            obj.ssh_keys = [foundKey.id]
        }
        return obj;
    }

    private async get(url: string, payload?: any) {
        url = payload ? `${url}?${querystring.stringify(payload)}` : url;
        const { data } = await axios.get(url, {
            headers: {
                Authorization: `Bearer ${this.apiKey}`
            }
        })
        return data;
    }

    private async delete(url: string, payload?: any) {
        url = payload ? `${url}?${querystring.stringify(payload)}` : url;
        const { data } = await axios.delete(url, {
            headers: {
                Authorization: `Bearer ${this.apiKey}`
            }
        })
        return data;
    }

    private async getAll(url: string, arrayPropPath: string, page=0, previousItems=[]) : Promise<Array<any>> {
        const results = await this.get(url, { page });
        if(!('meta' in results)) {
            throw new Error(`Expected meta prop in results... otherwise this probably isnt a list`);
        }
        if(!('total' in results.meta)) {
            throw new Error(`Expected total prop in ,meta... otherwise this probably isnt a list`);
        }
        const items : Array<any> = results[arrayPropPath] || [];
        const allItems = [...previousItems, ...items]
        if(allItems.length >= results.meta.total) {
            return allItems;
        }
        return this.getAll(url, arrayPropPath, ++page, allItems as never[])
    }

    private async post(url: string, payload: any) {
        const { data } = await axios.post(url, payload, {
            headers: {
                Authorization: `Bearer ${this.apiKey}`
            }
        })
        return data;
    }
}