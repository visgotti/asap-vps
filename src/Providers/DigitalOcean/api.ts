// The DigitalOcean API v2 client: one transport (the retry rules of
// Core/utils/http), one pager, and one reading of DigitalOcean's errors onto
// src/errors.ts (toError); plus the calls more than one capability makes:
// account SSH keys, and reading and deleting a droplet.

import { ApiClient, errorText, findSSHKey, HttpResult, RequestInfo } from '../../Core/utils';
import { AuthError, CapacityError, falseIfNotFound, NotFoundError, nullIfNotFound, ProviderError, QuotaError } from '../../errors';
import type { InitializedSSHKeyData, ProviderParams } from '../../types';
import { DIGITALOCEAN_ID, toSSHKey } from './mappers';
import type { DigitalOceanDropletData, DigitalOceanSSHData, DigitalOceanVolumeData } from './types';

export class DigitalOceanApi extends ApiClient {
    static readonly BASE_URL = 'https://api.digitalocean.com';

    constructor(params: ProviderParams | string) {
        super(params, DigitalOceanApi.BASE_URL, DIGITALOCEAN_ID);
    }

    /** A call whose failure throws its typed error. */
    call<T = any>(method: string, path: string, json?: unknown): Promise<T> {
        return this.send<T>(method, path, { json });
    }

    /** Every page of a list (`key`: the list's field, e.g. 'droplets'). */
    async all<T>(path: string, key: string): Promise<T[]> {
        const out: T[] = [];
        for (let page = 1; page <= 200; page++) {
            const body = await this.call('GET', `${path}${path.includes('?') ? '&' : '?'}per_page=200&page=${page}`);
            out.push(...((body?.[key] ?? []) as T[]));
            if (!body?.links?.pages?.next) return out;
        }
        throw new ProviderError(this.id, `${path} has more than 200 pages`);
    }

    /** The account's droplet limit, and how many droplets count against it (GPU droplets included). */
    async dropletUsage(): Promise<{ limit: number, used: number }> {
        const { account } = await this.call<{ account: { droplet_limit: number } }>('GET', '/v2/account');
        const total = async (path: string) => Number((await this.call('GET', `${path}${path.includes('?') ? '&' : '?'}per_page=1`))?.meta?.total ?? 0);
        const [plain, gpus] = await Promise.all([total('/v2/droplets'), total('/v2/droplets?type=gpus')]);
        return { limit: Number(account?.droplet_limit), used: plain + gpus };
    }

    /** null when DigitalOcean has no such droplet. */
    async getDroplet(id: string | number): Promise<DigitalOceanDropletData | null> {
        return (await nullIfNotFound(this.call<{ droplet: DigitalOceanDropletData }>('GET', `/v2/droplets/${encodeURIComponent(id)}`)))?.droplet ?? null;
    }

    /** null when the account has no such volume. */
    async getVolume(id: string): Promise<DigitalOceanVolumeData | null> {
        return (await nullIfNotFound(this.call<{ volume: DigitalOceanVolumeData }>('GET', `/v2/volumes/${encodeURIComponent(id)}`)))?.volume ?? null;
    }

    /** true when it was deleted, false when it was already gone. */
    deleteDroplet(id: string | number): Promise<boolean> {
        return falseIfNotFound(this.call('DELETE', `/v2/droplets/${encodeURIComponent(id)}`));
    }

    async listSSHKeys(): Promise<InitializedSSHKeyData[]> {
        return (await this.all<DigitalOceanSSHData>('/v2/account/keys', 'ssh_keys')).map(toSSHKey);
    }

    /** A new account key; when the account already holds it (registered since the caller looked), that one. */
    async registerSSHKey(publicKey: string, keyName: string): Promise<InitializedSSHKeyData> {
        try {
            const { ssh_key } = await this.call<{ ssh_key: DigitalOceanSSHData }>('POST', '/v2/account/keys', { name: keyName, public_key: publicKey });
            return toSSHKey(ssh_key);
        } catch (e) {
            // "SSH Key is already in use on your account".
            if (!(e instanceof ProviderError) || e.status !== 422 || !/already in use/i.test(e.message)) throw e;
            const existing = findSSHKey(await this.listSSHKeys(), publicKey);
            if (!existing) throw e;
            return existing;
        }
    }

    /** true when it was deleted, false when the account did not hold it. */
    deleteSSHKey(id: string | number): Promise<boolean> {
        return falseIfNotFound(this.call('DELETE', `/v2/account/keys/${encodeURIComponent(id)}`));
    }

    /** DigitalOcean's answers as typed errors: its `id` field is the code; a 422's wording tells capacity from quota. */
    protected toError(r: HttpResult, req: RequestInfo): ProviderError {
        const msg = `${req.method} ${req.path} -> ${r.status} ${errorText(r.body)}`;
        const o = { status: r.status, code: typeof r.body?.id === 'string' ? r.body.id : undefined };
        if (r.status === 401 || r.status === 403) return new AuthError(this.id, msg, o);
        if (r.status === 404) return new NotFoundError(this.id, msg, o);
        if (r.status === 429) return new ProviderError(this.id, msg, { ...o, retriable: true });
        if (/droplet limit|exceed your|quota/i.test(msg)) return new QuotaError(this.id, msg, o);
        // "Size is not available in this region.", "This size is unavailable.", "Region is not available":
        // try another size or region. An image missing from the region is not a capacity problem.
        if (r.status === 422 && !/image/i.test(msg)
            && /(size|region) is (not |un)available|not available in this region|unavailable|temporarily disabled|capacity|sold out|out of stock/i.test(msg)) {
            return new CapacityError(this.id, msg, o);
        }
        return new ProviderError(this.id, msg, { ...o, retriable: r.status >= 500 });
    }
}

/** A key reference as a droplet create takes it: an id (an integer) or a fingerprint. */
export function sshKeyRef(ref: string | number): string | number {
    return typeof ref === 'number' || !/^\d+$/.test(ref) ? ref : Number(ref);
}
