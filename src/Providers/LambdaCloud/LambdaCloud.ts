// Lambda Cloud over its REST API (https://cloud.lambda.ai/api/v1, spec
// /api/v1/openapi.json read 2026-09-29). VMs that boot with the NVIDIA stack
// installed (Lambda Stack); every instance type lists the regions with capacity
// right now. There is no stop: an instance runs until it is terminated, so
// LambdaCloud has no power capability, and no images. What outlives an
// instance is a filesystem: shared storage in one region, mounted at launch by
// any number of instances there. The API allows about one request per second,
// and one launch per 12 s.

import type { CapabilityDescriptor, ProviderCapabilities } from '../../capabilities';
import { ComputeProvider } from '../../Core/ComputeProvider';
import { filterOffers, findSSHKey, isKind, pickSSHKeys } from '../../Core/utils';
import { falseIfNotFound, NotFoundError, NotSupportedError, nullIfNotFound, ProviderError } from '../../errors';
import type { CreateServerOptions, CreateVolumeOptions, InitializedSSHKeyData, Offer, OfferQuery, ProviderParams, Server, ServerListOptions, Volume } from '../../types';
import { LambdaApi } from './api';
import { LAMBDA_BILLING, LAMBDA_ID, LAMBDA_MOUNT_PATH, LAMBDA_REFUSED, toOffer, toServer, toSSHKey, toVolume } from './mappers';
import type { LambdaFilesystem, LambdaFilesystemMount, LambdaInstance, LambdaInstanceTypes, LambdaSSHKeyData, LambdaTypes } from './types';

/** What Lambda can do, and how: no stop, and no images of a server. */
export const LAMBDA_CAPABILITIES = {
    compute: { kind: 'vm', gpu: true, cpu: false, userData: true, liveAvailability: true },
    restart: {},
    sshKeys: { appliedAtBoot: false },
    // Filesystems: any number of instances in its region mount one, at launch, where the launch says; it grows as it fills.
    volumes: { shared: { mount: 'path', size: 'elastic' } },
} as const satisfies CapabilityDescriptor;

type Caps = typeof LAMBDA_CAPABILITIES;

export class LambdaCloud extends ComputeProvider<LambdaTypes, LambdaApi> implements ProviderCapabilities<LambdaTypes, Caps> {
    static readonly capabilities: Caps = LAMBDA_CAPABILITIES;
    readonly id = LAMBDA_ID;
    readonly capabilities: Caps = LAMBDA_CAPABILITIES;

    /** Lambda's limits on a launch (spec 1.10.0): names, and tag keys and values. */
    static readonly MAX_NAME = 64;
    static readonly TAG_KEY = /^[a-z][a-z0-9-:]{1,54}$/;
    /** Billed in one-minute steps from the first passed health check to termination. */
    static readonly BILLING = LAMBDA_BILLING;

    constructor(params: ProviderParams | string) {
        super(new LambdaApi(params));
    }

    public async listOffers(query: OfferQuery = {}): Promise<Offer<LambdaInstanceTypes[string]>[]> {
        const { data } = await this.api.call<{ data: LambdaInstanceTypes }>('GET', '/api/v1/instance-types');
        return filterOffers(Object.values(data ?? {}).filter((t) => t.instance_type?.specs?.gpus > 0).map(toOffer), query);
    }

    /**
     * Lambda requires exactly one SSH key at launch (more can be added in
     * user-data); `image` is an image id or an image family (default: the latest
     * Lambda Stack). Tags are `key` or `key=value`, with Lambda's key format.
     * `mounts` are filesystems of the instance's region, each at its `path`
     * (under /home, /lambda/nfs or /data; default its own mount point,
     * /lambda/nfs/<name>): one elsewhere is refused before anything is launched.
     */
    public async createServer(o: CreateServerOptions<LambdaTypes>): Promise<Server<LambdaInstance>> {
        this.rejectOptions(o, LAMBDA_REFUSED);
        const { id: type, offer, region } = this.resolveOffer(o);
        this.checkFixedGpuCount(o, offer?.gpuCount ?? LambdaCloud.gpuCountOf(type));
        if (!region) throw new ProviderError(this.id, 'an instance needs a region (one of the offer\'s regions)');
        if (!o.sshKeyIds?.length) throw new ProviderError(this.id, 'Lambda requires exactly one SSH key (sshKeyIds)');
        if (o.sshKeyIds.length > 1) throw new NotSupportedError(this.id, 'more than one SSH key at launch');
        if (o.name.length > LambdaCloud.MAX_NAME) throw new ProviderError(this.id, `an instance name is at most ${LambdaCloud.MAX_NAME} characters`);
        const tags = o.tags?.map((t) => {
            const i = t.indexOf('=');
            const key = i < 0 ? t : t.slice(0, i);
            const value = i < 0 ? '' : t.slice(i + 1);
            if (!LambdaCloud.TAG_KEY.test(key) || key.startsWith('lambda-ai-') || value.length > 128) {
                throw new ProviderError(this.id, `tag "${t}": a key is 2-55 of a-z 0-9 - : starting with a letter (not lambda-ai-), a value at most 128 characters`);
            }
            return { key, value };
        });
        const mounts = await this.filesystemMounts(o, region);
        // Lambda's instances have GPUs (a type that lists none is a CPU one).
        const userData = this.userDataWith(o, (offer?.gpuCount ?? LambdaCloud.gpuCountOf(type) ?? 1) > 0);
        // Launch takes key NAMES: resolve the ids (a name is accepted too).
        const names = pickSSHKeys(await this.listSSHKeys(), o.sshKeyIds, this.id).map((k) => k.name);
        const ref = this.imageName(o.image);
        const image = ref ? (/^([0-9a-f]{32}|[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12})$/i.test(ref) ? { id: ref } : { family: ref }) : undefined;
        const { data } = await this.api.call<{ data: { instance_ids: string[] } }>('POST', '/api/v1/instance-operations/launch', {
            region_name: region,
            instance_type_name: type,
            ssh_key_names: names,
            name: o.name,
            ...(image ? { image } : {}),
            ...(userData ? { user_data: userData } : {}),
            ...(tags?.length ? { tags } : {}),
            ...(mounts.length ? { file_system_mounts: mounts } : {}),
            ...o.providerOptions,
        });
        const id = data?.instance_ids?.[0];
        if (!id) throw new ProviderError(this.id, 'the launch returned no instance id');
        // Not listed yet: what the launch said, as the instance it is.
        const launched = { id, name: o.name, status: 'booting', ssh_key_names: names, region: { name: region, description: '' } } as LambdaInstance;
        return (await this.getServer(id).catch(() => null)) ?? { ...toServer(launched), offerId: type };
    }

    public async getServer(id: string): Promise<Server<LambdaInstance> | null> {
        const found = await nullIfNotFound(this.api.call<{ data: LambdaInstance }>('GET', `/api/v1/instances/${encodeURIComponent(id)}`));
        return found ? toServer(found.data) : null;
    }

    /** The GPU count an instance type's name states ('gpu_8x_a100_80gb_sxm4': 8), or undefined. */
    static gpuCountOf(type: string): number | undefined {
        const m = /^gpu_(\d+)x_/.exec(type);
        return m ? Number(m[1]) : undefined;
    }

    /** The account's instances, with GPUs or without unless `kind` says which. */
    public async listServers(options: ServerListOptions = {}): Promise<Server<LambdaInstance>[]> {
        const { data } = await this.api.call<{ data: LambdaInstance[] }>('GET', '/api/v1/instances');
        // An instance whose type is not reported is kept as one with GPUs: Lambda's are.
        return (data ?? []).filter((i) => isKind(i.instance_type?.specs?.gpus ?? 1, options.kind)).map(toServer);
    }

    public async deleteServer(id: string): Promise<void> {
        // Terminating twice is harmless, so this POST may be retried.
        await falseIfNotFound(this.api.call('POST', '/api/v1/instance-operations/terminate', { instance_ids: [id] }, true));
    }

    public async restartServer(id: string): Promise<void> {
        await this.api.call('POST', '/api/v1/instance-operations/restart', { instance_ids: [id] });
    }

    // ── volumes ──────────────────────────────────────────────────────────

    /** The account's filesystems, in every region. */
    public async listVolumes(): Promise<Volume<LambdaFilesystem>[]> {
        return (await this.filesystems()).map(toVolume);
    }

    /** Lambda reads filesystems only as a list: this is a lookup in it. */
    public async getVolume(id: string): Promise<Volume<LambdaFilesystem> | null> {
        const f = (await this.filesystems()).find((x) => x.id === id);
        return f ? toVolume(f) : null;
    }

    /**
     * A filesystem in `region`, mounted at /lambda/nfs/<name> unless a mount
     * says otherwise. It has no size: it grows as it fills, and bills for what
     * it holds until deleteVolume. Its name is 1-60 characters (a letter, then
     * letters, digits and dashes), unique in the account.
     */
    public async createVolume(o: CreateVolumeOptions<LambdaTypes>): Promise<Volume<LambdaFilesystem>> {
        // Not in its type; code typed for any provider may still pass it.
        if ((o as { sizeGb?: unknown }).sizeGb !== undefined) throw new NotSupportedError(this.id, 'createVolume option "sizeGb" (a filesystem grows as it fills)');
        if (!/^[a-zA-Z][0-9a-zA-Z-]{0,59}$/.test(o.name)) throw new ProviderError(this.id, `filesystem name "${o.name}": 1-60 characters, a letter then letters, digits and dashes`);
        const { data } = await this.api.call<{ data: LambdaFilesystem }>('POST', '/api/v1/filesystems', { name: o.name, region: this.regionName(o.region), ...o.providerOptions });
        return toVolume(data);
    }

    /** One an instance mounts is refused (filesystems/filesystem-in-use): terminate the instance first. */
    public async deleteVolume(id: string): Promise<void> {
        await falseIfNotFound(this.api.call('DELETE', `/api/v1/filesystems/${encodeURIComponent(id)}`));
    }

    // ── SSH keys ─────────────────────────────────────────────────────────

    public async listSSHKeys(): Promise<InitializedSSHKeyData[]> {
        const { data } = await this.api.call<{ data: LambdaSSHKeyData[] }>('GET', '/api/v1/ssh-keys');
        return (data ?? []).map(toSSHKey);
    }

    public async addSSHKey(publicKey: string, keyName: string): Promise<InitializedSSHKeyData> {
        const existing = findSSHKey(await this.listSSHKeys(), publicKey);
        if (existing) return existing;
        if (!keyName || keyName.length > LambdaCloud.MAX_NAME) throw new ProviderError(this.id, `an SSH key name is 1-${LambdaCloud.MAX_NAME} characters`);
        const { data } = await this.api.call<{ data: LambdaSSHKeyData }>('POST', '/api/v1/ssh-keys', { name: keyName, public_key: publicKey.trim() });
        return toSSHKey(data);
    }

    public async deleteSSHKey(id: string | number): Promise<boolean> {
        return falseIfNotFound(this.api.call('DELETE', `/api/v1/ssh-keys/${encodeURIComponent(id)}`));
    }

    // ── helpers ──────────────────────────────────────────────────────────

    private async filesystems(): Promise<LambdaFilesystem[]> {
        return (await this.api.call<{ data: LambdaFilesystem[] }>('GET', '/api/v1/filesystems')).data ?? [];
    }

    /**
     * A launch's `file_system_mounts`: each filesystem's id and where it mounts
     * (its own mount point unless the mount says). A filesystem in another
     * region than the instance, or a path Lambda does not mount at, is refused here.
     */
    private async filesystemMounts(o: CreateServerOptions<LambdaTypes>, region: string): Promise<LambdaFilesystemMount[]> {
        const mounts = this.mountsOf(o.mounts);
        if (!mounts.length) return [];
        const known = mounts.every((m) => m.volume) ? [] : await this.filesystems();
        return mounts.map((m) => {
            const f = m.volume?.raw ?? known.find((x) => x.id === m.id);
            if (!f) throw new NotFoundError(this.id, `no filesystem ${m.id}`);
            if (f.region?.name !== region) throw new ProviderError(this.id, `filesystem ${f.name} is in ${f.region?.name}: an instance in ${region} cannot mount it`);
            const path = m.path ?? f.mount_point;
            if (path.length > 256 || !LAMBDA_MOUNT_PATH.test(path)) throw new ProviderError(this.id, `mount path "${path}": Lambda mounts a filesystem under /home, /lambda/nfs or /data`);
            return { file_system_id: f.id, mount_point: path };
        });
    }
}
