// The parts of Vast.ai's API objects the VastAI provider reads and sends
// (https://docs.vast.ai/api-reference/openapi.yaml, read 2026-09-29 and
// 2026-10-06), and VastTypes, which types its records and create options by them.

import type { ProviderParams } from '../../types';
import type { VAST_REFUSED } from './mappers';

export type VastAIParams = ProviderParams & {
    /** Machines below this reliability score are not offered (default 0.95). */
    minReliability?: number,
    /** Only machines Vast has verified (default true). */
    verifiedOnly?: boolean,
    /** Only machines whose driver runs at least this CUDA version, e.g. 12.8, where a query sets none. */
    minCudaVersion?: number,
    /** Offer pages of 64 read per search, cheapest first (default 8: 512 offers). */
    offerPages?: number,
};

export type VastOffer = {
    /** The ask id a create rents. */
    id: number,
    /** The same ask id: what the offer search filters by (a filter on `id` matches nothing). */
    ask_contract_id?: number,
    gpu_name?: string,
    num_gpus?: number,
    /** Per GPU, MB. */
    gpu_ram?: number,
    /** USD per hour for the whole offer (a bid search: the minimum bid plus storage). */
    dph_total: number,
    /** The least an interruptible rental of this machine may bid, USD per hour. */
    min_bid?: number,
    /** 'City, CC'. */
    geolocation?: string,
    rentable?: boolean,
    cuda_max_good?: number,
    reliability?: number,
    machine_id?: number,
    cpu_cores_effective?: number,
    /** MB. */
    cpu_ram?: number,
    /** GB. */
    disk_space?: number,
};

export type VastInstance = {
    id: number,
    label?: string | null,
    /** The container: 'running', 'loading', 'exited', 'created', 'offline', ... */
    actual_status?: string | null,
    intended_status?: string | null,
    /** The machine contract: 'running' or 'stopped'. */
    cur_state?: string | null,
    status_msg?: string | null,
    public_ipaddr?: string | null,
    geolocation?: string | null,
    gpu_name?: string | null,
    num_gpus?: number | null,
    dph_total?: number | null,
    /** Epoch seconds. */
    start_date?: number | null,
    machine_id?: number | null,
    ssh_host?: string | null,
    ssh_port?: number | null,
    /** Each open container port and the RANDOM public port it maps to: {"8080/tcp": [{HostIp, HostPort}]}. */
    ports?: Record<string, Array<{ HostIp?: string, HostPort?: string }> | null> | null,
};

export type VastSSHKeyData = { id: number, key?: string, public_key?: string, deleted_at?: string | null };

/** The body of `PUT /api/v0/asks/{id}/` (renting an offer's machine): what CreateServerOptions.providerOptions adds fields to. */
export type VastCreateInstanceBody = {
    image: string,
    label: string,
    /** 'args': the container runs `args` (or the image's CMD); 'ssh' authorizes every account key on an sshd image. */
    runtype: 'args' | 'ssh' | 'jupyter' | string,
    args?: string[],
    /** Environment variables, and ports as "-p <port>:<port>[/udp]" keys. */
    env?: Record<string, string>,
    /** GB. */
    disk?: number,
    /** An interruptible rental's bid, USD per hour. */
    price?: number,
    cancel_unavail?: boolean,
    /** The private registry's login, as `docker login` arguments: '-u <user> -p <password> <host>'. */
    image_login?: string,
    /** runtype 'args': the container's ENTRYPOINT, overridden ('sh'); 'ssh' / 'jupyter': a script run when it starts. */
    onstart?: string,
};

/**
 * Vast's records, as the VastAI provider's records carry them (`raw`), and the
 * options its createServer takes. Instances boot registry images: no images of
 * the account's own; and no volumes (Vast's live on one machine).
 */
export type VastTypes = {
    server: VastInstance,
    offer: VastOffer,
    image: never,
    volume: never,
    createBody: VastCreateInstanceBody,
    volumeBody: never,
    imageImportBody: never,
    endpoint: never,
    endpointOffer: never,
    endpointBody: never,
    refused: (typeof VAST_REFUSED)[number],
    volumeSize: {},
    volumeKind: {},
    mount: {},
};
