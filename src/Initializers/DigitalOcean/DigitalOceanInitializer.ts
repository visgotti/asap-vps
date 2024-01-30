import * as querystring from 'querystring';
import { AbstractInitializer } from "../../Core/AbstractInitializer";
import { ChosenServerCreationOption, CreatedServerData, DestroyServerOptions, InitializedSSHKeyData, InitializerParams, ProviderServerCreationOptions } from '../../types';
import axios from 'axios';
import { makeId, asyncTimeout } from '../../utils';
import * as path from 'path';
import * as fs from 'fs';
import { MACHINE_TYPES, REGION_TYPES } from '../../constants';
import { DigitalOceanSizeData, DigitalOceanImageData, DigitalOceanDropletData, DigitalOceanCreateDropletParams } from './types';

export class DigitalOcean extends AbstractInitializer {

    constructor(a: InitializerParams | string) {
        super(a);
    }

    public static async Init(params: InitializerParams | string) : Promise<DigitalOcean> {
        const initializer = new DigitalOcean(params);
        await initializer.init();
        return initializer;
    }

    public async getMachineTypeSlug(type: MACHINE_TYPES) {
        switch(type) {
            case MACHINE_TYPES.UBUNTU_22:
                return `ubuntu-22-04-x64`;
            case MACHINE_TYPES.UBUNTU_20:
                return `ubuntu-20-04-x64`;
        }
    }

    public getRegionSlug(type: REGION_TYPES): string | Promise<string> {
        switch(type) {
            case REGION_TYPES.TORONTO:
                return 'tor1';
            case REGION_TYPES.NYC:
                return 'nyc1';
            case REGION_TYPES.NYC_1:
            case REGION_TYPES.NYC_2:
            case REGION_TYPES.NYC_3:
                return type as string;
            case REGION_TYPES.SAN_FRANCISCO:
            case REGION_TYPES.SAN_FRANCISCO_1:
                return 'sfo1'
            case REGION_TYPES.SAN_FRANCISCO_2:
                return 'sfo2';
            case REGION_TYPES.SAN_FRANCISCO_3:
                return 'sfo3';
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

    public async addSSHKey(publicKey: string, keyName: string): Promise<InitializedSSHKeyData> {
        const { ssh_key } = await this.post(`https://api.digitalocean.com/v2/account/keys`, {
            public_key: publicKey,
            name: keyName
        });
        const { name, public_key, id, fingerprint } = ssh_key;
        this.options?.ssh?.push(ssh_key);
        
        return {
            name, 
            publicKey: 
            public_key,
            id, 
            fingerprint 
        }
    }

    public async deleteKeysWithName(keyName: string, waitEvery?: number, waitTimeout=500)  : Promise<number> { 
        let deleted = 0;
        const keysToDelete = this.options?.ssh?.filter(k => {
            return k.name === keyName;
        }) || [];

        for(let i = 0; i < keysToDelete.length; i++) {
            try {
                await this.deleteSSHKey(keysToDelete[i].id);
                deleted++;
            } catch (err) {
            }
            if(waitEvery && waitTimeout && !(i % waitEvery)) {
                await asyncTimeout(waitTimeout);  

            }
        }
        return deleted;
    }

    public async deleteSSHKey(keyId: string | number)  : Promise<boolean> { 
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
        return Promise.all(d.map(dd => this.deleteServer(dd.id)))
    }

    public async deleteAllServers() {
        const d = await this.getDroplets();
        return Promise.all(d.map(dd => this.deleteServer(dd.id)))
    }


    public async deleteServer(id: number | string) {
        await this.delete(`https://api.digitalocean.com/v2/droplets/${id}`);
    }

    get availableSizes() {
        return this.options?.size || [];
    }

    
    get availableImages() {
        return this.options?.image?.map(i => i.slug) || [];
    }

    public async onInit(options: ProviderServerCreationOptions) {
        /*
        if(!options.ssh?.length) {
            throw new Error(`There is no ssh keys initialized on this digital ocean droplet.`)
        }
        */
        if(!options.size?.length) throw new Error(`Expected sizes to come back from get options..`);

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
            id: `${d.id}`,
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
    
    public async createServer(options: Pick<ChosenServerCreationOption, 'size' | 'image' | 'region' | 'image' | 'ssh' | 'name'>) : Promise<CreatedServerData> {
        const o = await this.validateAndConvertCreateOptions(options);
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

    private async validateAndConvertCreateOptions(options: ChosenServerCreationOption) : Promise<DigitalOceanCreateDropletParams> {
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

        const imageSlug = await this.tryGetImageSlug(options.image);
        if(!imageSlug) {
            throw new Error(`Can not find slug for image, option given: ${options.image}`)
        }
        const regionSlug = await this.tryGetRegionSlug(options.region);
        if(!regionSlug) {
            throw new Error(`Can not find slug for region, option given: ${options.region}`)
        }

        const image = this.options!.image!.find(i => i.slug === imageSlug);
        if(!image?.regions?.includes(regionSlug)) {
            throw new Error(`Image selected does not provide region for supplied option: ${regionSlug}, the possible region slugs were: ${image?.regions?.join(', ')}`)
        }

      //  console.log('all the ssh options were:', this.options?.ssh, this.options?.ssh?.length);
     //   console.log('options.ssh was', options.ssh);
    
        const foundKey = this.options?.ssh?.find(s => s.id === options.ssh || s.fingerprint === options.ssh || s.name === options.ssh || s.key === options.ssh);

        const obj : DigitalOceanCreateDropletParams = {
            name: options.name || makeId(14),
            image: imageSlug,
            size: options.size,
            region: regionSlug
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