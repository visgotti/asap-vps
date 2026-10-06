// Vast.ai over its REST API (https://console.vast.ai, spec
// docs.vast.ai/api-reference/openapi.yaml and the official CLI vast-ai/vast-cli,
// checked 2026-09-29 and 2026-10-06; the older openapi.json still lists network
// volumes, which Vast withdrew in July 2026). A marketplace: every offer is ONE machine (an "ask"), so renting it
// twice answers 410 no_such_ask. A search returns at most 64 offers, so this
// pages by price. An interruptible offer shares its machine's id and is rented
// with a bid price. An instance is a container on that machine: env is a JSON
// object (ports ride in it as "-p" keys), each port is mapped to a RANDOM public
// port, a stopped instance bills storage only, and starting it again waits for
// that machine's GPU.

import type { CapabilityDescriptor, ProviderCapabilities } from '../../capabilities';
import { ComputeProvider } from '../../Core/ComputeProvider';
import { compareCudaVersions, cudaVersion, filterOffers, findSSHKey, http, isKind, parseSSHPublicKey, registryOf } from '../../Core/utils';
import { CapacityError, falseIfNotFound, NotFoundError, NotSupportedError, nullIfNotFound, ProviderError } from '../../errors';
import type { CreateServerOptions, InitializedSSHKeyData, LogOptions, Offer, OfferQuery, RegistryAuth, Server, ServerListOptions } from '../../types';
import { VastApi } from './api';
import { hostCuda, RELAUNCH_GRACE_MS, serverSideModels, toOffer, toServer, toSSHKey, VAST_BILLING, VAST_ID, VAST_REFUSED } from './mappers';
import type { VastAIParams, VastInstance, VastOffer, VastSSHKeyData, VastTypes } from './types';

/** What Vast can do, and how. */
export const VAST_CAPABILITIES = {
    // Instances boot registry images on the machine's driver; userData is a script run before the command at each start.
    compute: { kind: 'container', gpu: true, cpu: false, userData: true, liveAvailability: true },
    // A stopped instance bills only its disk.
    power: { stoppedBilling: 'storage' },
    restart: {},
    logs: {},
    sshKeys: { appliedAtBoot: false },
} as const satisfies CapabilityDescriptor;

type Caps = typeof VAST_CAPABILITIES;

export class VastAI extends ComputeProvider<VastTypes, VastApi> implements ProviderCapabilities<VastTypes, Caps> {
    static readonly capabilities: Caps = VAST_CAPABILITIES;
    readonly id = VAST_ID;
    readonly capabilities: Caps = VAST_CAPABILITIES;
    readonly minReliability: number;
    readonly verifiedOnly: boolean;
    readonly minCudaVersion?: number;
    readonly offerPages: number;

    /** Vast's cap on one search, whatever `limit` asks for (observed 2026-09-29). */
    static readonly PAGE = 64;
    /** Rentals bill per second while they run; the disk bills while stopped too. */
    static readonly BILLING = VAST_BILLING;
    /** How long after a start or reboot a container still reported as it was left reads as pending. */
    static readonly RELAUNCH_GRACE_MS = RELAUNCH_GRACE_MS;
    /** When this provider last started or rebooted each instance. */
    private readonly relaunched = new Map<string, number>();

    constructor(params: VastAIParams | string) {
        super(new VastApi(params));
        const p = typeof params === 'object' ? params : {} as Partial<VastAIParams>;
        this.minReliability = p.minReliability ?? 0.95;
        this.verifiedOnly = p.verifiedOnly ?? true;
        this.minCudaVersion = p.minCudaVersion;
        this.offerPages = p.offerPages ?? 8;
    }

    /** Each offer is one machine; its only region is where that machine is. */
    public async listOffers(query: OfferQuery = {}): Promise<Offer<VastOffer>[]> {
        // Every ask is a GPU machine: a question about machines without them has no answer here.
        if (query.kind === 'cpu' || query.gpuCount === 0) return [];
        const offers = (await this.search('ondemand', query)).map((a) => toOffer(a, false));
        if (query.includeInterruptible) offers.push(...(await this.search('bid', query)).map((a) => toOffer(a, true)));
        return filterOffers(offers, query);
    }

    /**
     * Rents the offer's machine. The container runs `command` (the image's own
     * CMD when none) with `env`; each of `ports` is mapped to a random public
     * port (read it from the server's `ports`). An interruptible offer's id
     * carries its bid price, which is what is sent. With `minCudaVersion` the
     * machine's driver is read first, and one below it is not rented.
     * `registryAuth` goes with the rental (Vast keeps no logins): the machine
     * pulls `image` with it. `userData` is a shell script (Vast runs no
     * cloud-init) run each time the container starts, before `command`, which
     * it then becomes (`sh -c '<script>; exec "$@"' <command>`): the image
     * needs a `sh`, and `command` must be given, as the image's own is replaced.
     */
    public async createServer(o: CreateServerOptions<VastTypes>): Promise<Server<VastInstance>> {
        // Vast authorizes every account key on its ssh-runtype images; pass
        // providerOptions { runtype: 'ssh' } for that instead of sshKeyIds.
        this.rejectOptions(o, VAST_REFUSED);
        // The offer is one machine: its GPUs are fixed, and its place is where it is (no region to pick).
        const resolved = this.resolveOffer(o);
        this.checkFixedGpuCount(o, resolved.offer?.gpuCount);
        // The container: `container`, or the top-level image, env, command, ports and registryAuth.
        const c = this.containerOf(o);
        const image = this.imageName(c?.image);
        if (!c || !image) throw new ProviderError(this.id, 'an instance needs an image');
        if (c.registryAuth && o.providerOptions?.image_login !== undefined) throw new ProviderError(this.id, 'pass registryAuth or providerOptions.image_login, not both');
        const login = c.registryAuth ? this.imageLogin(c.registryAuth, image) : undefined;
        const args = this.argsWith(o.userData, c.command);
        const offer = /^(\d+)(?::bid:(\d+(?:\.\d+)?))?$/.exec(resolved.id);
        if (!offer) throw new ProviderError(this.id, `bad offer id "${resolved.id}"`);
        // Env is a JSON object (a docker-flags string is not applied); ports ride in it as "-p" keys.
        const env: Record<string, string> = {};
        for (const [k, v] of Object.entries(c.env ?? {})) env[k] = this.flagValue(v, k);
        for (const p of c.ports ?? []) {
            const m = /^(\d+)(?:\/(tcp|udp|http))?$/.exec(p);
            if (!m) throw new ProviderError(this.id, `bad port "${p}": use <port>/<tcp|udp|http>`);
            env[`-p ${m[1]}:${m[1]}${m[2] === 'udp' ? '/udp' : ''}`] = '1';
        }
        const bid = offer[2] !== undefined ? Number(offer[2]) : undefined;
        if (o.minCudaVersion !== undefined) await this.checkCuda(Number(offer[1]), bid !== undefined, cudaVersion(o.minCudaVersion));
        const body = await this.api.call<{ new_contract: number }>('PUT', `/api/v0/asks/${offer[1]}/`, {
            image,
            label: o.name,
            runtype: 'args',
            ...args,
            ...(Object.keys(env).length ? { env } : {}),
            ...(o.diskGb ? { disk: Math.ceil(o.diskGb) } : {}),
            ...(bid !== undefined ? { price: bid } : {}),
            ...(login ? { image_login: login } : {}),
            cancel_unavail: true,
            ...o.providerOptions,
        }, false);
        if (!body?.new_contract) throw new ProviderError(this.id, 'the rental returned no instance id (new_contract)');
        const id = String(body.new_contract);
        // Not listed yet: what the rental said, as the instance it is.
        const rented: VastInstance = { id: body.new_contract, label: o.name, actual_status: 'created' };
        return (await this.getServer(id).catch(() => null)) ?? { ...toServer(rented), offerId: resolved.id };
    }

    public async getServer(id: string): Promise<Server<VastInstance> | null> {
        const body = await nullIfNotFound(this.api.call<{ instances?: VastInstance | null }>('GET', `/api/v0/instances/${encodeURIComponent(id)}/`));
        return body?.instances?.id ? this.toServer(body.instances) : null;
    }

    /** The account's instances (every rental is a GPU machine). */
    public async listServers(options: ServerListOptions = {}): Promise<Server<VastInstance>[]> {
        const out: Server<VastInstance>[] = [];
        let token = '';
        // Keyset pages of at most 25.
        for (let page = 0; page < 400; page++) {
            const body = await this.api.call<{ instances?: VastInstance[], next_token?: string | null }>(
                'GET', `/api/v1/instances/?limit=25${token ? `&after_token=${encodeURIComponent(token)}` : ''}`);
            out.push(...(body.instances ?? []).filter((i) => isKind(i.num_gpus ?? 1, options.kind)).map((i) => this.toServer(i)));
            if (!body.next_token) return out;
            token = body.next_token;
        }
        throw new ProviderError(this.id, 'the instance list has more than 400 pages');
    }

    public async deleteServer(id: string): Promise<void> {
        await falseIfNotFound(this.api.call('DELETE', `/api/v0/instances/${encodeURIComponent(id)}/`));
    }

    // ── power, restart, logs ─────────────────────────────────────────────

    public async stopServer(id: string): Promise<void> {
        await this.api.call('PUT', `/api/v0/instances/${encodeURIComponent(id)}/`, { state: 'stopped' });
    }

    /**
     * Starts the container again on its machine. When that machine's GPU is
     * someone else's now, Vast queues the start ("Required resources are
     * currently unavailable, state change queued") and would start, and bill,
     * the instance whenever the GPU frees: that start is cancelled (the
     * instance stays stopped) and this throws CapacityError.
     */
    public async startServer(id: string): Promise<void> {
        const path = `/api/v0/instances/${encodeURIComponent(id)}/`;
        try {
            await this.api.call('PUT', path, { state: 'running' });
        } catch (e) {
            if (!(e instanceof ProviderError) || !/currently unavailable|state change queued/i.test(e.message)) throw e;
            await this.api.call('PUT', path, { state: 'stopped' });
            throw new CapacityError(this.id, `instance ${id} cannot start now (its machine's GPU is taken): the queued start was cancelled, so it stays stopped`,
                { status: e.status, code: e.code, cause: e });
        }
        this.relaunched.set(id, Date.now());
    }

    /** Stops and starts the container without giving up the machine's GPU. */
    public async restartServer(id: string): Promise<void> {
        await this.api.call('PUT', `/api/v0/instances/reboot/${encodeURIComponent(id)}/`);
        this.relaunched.set(id, Date.now());
    }

    /** Vast uploads the container's log on request and hands back a URL to fetch it from. */
    public async getServerLogs(id: string, o: LogOptions = {}): Promise<string> {
        const body = await this.api.call<{ result_url?: string }>('PUT', `/api/v0/instances/request_logs/${encodeURIComponent(id)}/`, { tail: String(o.tail ?? 1000) });
        if (!body?.result_url) return '';
        for (let i = 0; i < 10; i++) {
            await this.sleep(i === 0 ? 1000 : 2000);
            // Not the API host: the key does not go along.
            const r = await http(body.result_url, { retries: 0, fetchImpl: this.api.fetchImpl, sleep: this.sleep });
            if (r.status === 200) return typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
        }
        throw new ProviderError(this.id, `the log of instance ${id} was not uploaded in time`, { retriable: true });
    }

    // ── SSH keys ─────────────────────────────────────────────────────────

    public async listSSHKeys(): Promise<InitializedSSHKeyData[]> {
        // "No SSH keys found for the user." is a 404.
        const keys = await nullIfNotFound(this.api.call<VastSSHKeyData[]>('GET', '/api/v0/ssh/'));
        return (Array.isArray(keys) ? keys : []).filter((k) => !k.deleted_at).map(toSSHKey);
    }

    /** Vast keys have no name: it rides as the key's comment. */
    public async addSSHKey(publicKey: string, keyName: string): Promise<InitializedSSHKeyData> {
        const existing = findSSHKey(await this.listSSHKeys(), publicKey);
        if (existing) return existing;
        const k = parseSSHPublicKey(publicKey);
        const body = await this.api.call<{ key: VastSSHKeyData }>('POST', '/api/v0/ssh/', { ssh_key: `${k.type} ${k.blob}${keyName ? ` ${keyName}` : ''}` });
        return toSSHKey(body.key);
    }

    public async deleteSSHKey(id: string | number): Promise<boolean> {
        try {
            await this.api.call('DELETE', `/api/v0/ssh/${encodeURIComponent(id)}/`);
            return true;
        } catch (e) {
            // A key that is already gone: 400 no_ssh_key ("No ssh key provided") or "SSH key not found".
            if (e instanceof NotFoundError || (e instanceof ProviderError && e.status === 400
                && (e.code === 'no_ssh_key' || /not found|no ssh key/i.test(e.message)))) return false;
            throw e;
        }
    }

    // ── helpers ──────────────────────────────────────────────────────────

    private toServer(i: VastInstance): Server<VastInstance> {
        return toServer(i, this.relaunched.get(String(i.id)));
    }

    /** Cheapest first, a page of 64 at a time: the next page starts at the last page's price. */
    private async search(type: 'ondemand' | 'bid', query: OfferQuery): Promise<VastOffer[]> {
        const out: VastOffer[] = [];
        const seen = new Set<number>();
        let floor: number | undefined;
        const minCuda = query.minCudaVersion !== undefined ? Number(cudaVersion(query.minCudaVersion)) : this.minCudaVersion;
        const models = serverSideModels(query);
        for (let page = 0; page < this.offerPages; page++) {
            const price = {
                ...(floor !== undefined ? { gte: floor } : {}),
                ...(query.maxPricePerHour !== undefined ? { lte: query.maxPricePerHour } : {}),
            };
            // A search is a read: retried on 5xx like any GET.
            const body = await this.api.call<{ offers?: VastOffer[] }>('POST', '/api/v0/bundles/', {
                ...(this.verifiedOnly ? { verified: { eq: true } } : {}),
                ...(query.includeUnavailable ? {} : { rentable: { eq: true } }),
                reliability: { gte: this.minReliability },
                ...(minCuda ? { cuda_max_good: { gte: minCuda } } : {}),
                ...(query.gpuCount ? { num_gpus: { eq: query.gpuCount } } : {}),
                // The vendor and the models' compute capability: an expensive model is then not
                // hidden behind hundreds of cheaper cards. filterOffers does the exact match.
                ...models,
                // MB, and Vast reports USABLE memory (an L4 lists ~22.5 GB): a margin, the exact check is filterOffers.
                ...(query.minVramGb ? { gpu_ram: { gte: Math.floor(query.minVramGb * 1024 * 0.9) } } : {}),
                ...(Object.keys(price).length ? { dph_total: price } : {}),
                type,
                order: [['dph_total', 'asc']],
                limit: VastAI.PAGE,
            }, true);
            const batch = body?.offers ?? [];
            let added = 0;
            for (const a of batch) {
                if (seen.has(a.id)) continue;
                seen.add(a.id);
                out.push(a);
                added++;
            }
            if (batch.length < VastAI.PAGE || added === 0) break;
            floor = Number(batch[batch.length - 1].dph_total);
        }
        return out;
    }

    /**
     * The offer's machine, read by its ask id: CapacityError when it is gone or
     * its driver is older than `want`. Vast's search finds an offer by
     * `ask_contract_id`; a filter on `id` matches no offer at all (observed 2026-10-02).
     */
    private async checkCuda(askId: number, bid: boolean, want: string): Promise<void> {
        const found = await this.api.call<{ offers?: VastOffer[] }>('POST', '/api/v0/bundles/', { ask_contract_id: { eq: askId }, type: bid ? 'bid' : 'ondemand', limit: 1 }, true);
        const a = (found?.offers ?? []).find((x) => x.id === askId || x.ask_contract_id === askId);
        if (!a) throw new CapacityError(this.id, `offer ${askId} is no longer offered`);
        const have = hostCuda(a);
        if (!have || compareCudaVersions(have, want) < 0) {
            throw new CapacityError(this.id, `offer ${askId}: its host's driver runs CUDA ${have ?? '(unknown)'}, below ${want}`);
        }
    }

    /**
     * The container's start, in the `args` launch mode: `command` as it is, or,
     * with a userData script, the script first and then `command` (an entrypoint
     * of `sh -c`, `onstart` being the entrypoint in this mode). A script needs a
     * command to hand over to (the image's own is replaced), and is a shell
     * script: cloud-config is cloud-init's, which a container does not run.
     */
    private argsWith(userData: string | undefined, command: string[] | undefined): { args?: string[], onstart?: string } {
        if (!userData) return command?.length ? { args: command } : {};
        if (/^\s*#cloud-config/.test(userData)) throw new NotSupportedError(this.id, 'createServer option "userData" as cloud-config (a Vast container runs no cloud-init: pass a shell script)');
        if (!command?.length) throw new NotSupportedError(this.id, 'createServer option "userData" without "command" (the script runs before the command, which replaces the image\'s own)');
        return { onstart: 'sh', args: ['-c', `${userData}\nexec "$@"`, 'asap-vps', ...command] };
    }

    /**
     * The login as Vast takes it, `docker login` arguments in one string:
     * '-u <user> -p <password> <host>' (the host the login names, else the
     * image's). A part with a space or a quote would split the string, so it is refused.
     */
    private imageLogin(auth: RegistryAuth, image: string): string {
        const host = registryOf(auth, image);
        for (const [what, v] of [['username', auth.username], ['password', auth.password], ['server', host]] as const) {
            if (!v || /[\s'"\\]/.test(v)) throw new ProviderError(this.id, `registryAuth ${what}: Vast takes the login as one string of docker login arguments, so it cannot be empty or hold spaces or quotes`);
        }
        return `-u ${auth.username} -p ${auth.password} ${host}`;
    }

    /**
     * An env entry: a plain name, and (until a live run proves Vast passes them
     * through intact) a value without spaces or quotes: encode such a value, e.g. base64.
     */
    private flagValue(v: string, key: string): string {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new ProviderError(this.id, `bad env name "${key}"`);
        if (/[\s'"\\]/.test(v)) throw new ProviderError(this.id, `env ${key}: a value cannot hold spaces or quotes on Vast (encode it, e.g. base64)`);
        return v;
    }
}
