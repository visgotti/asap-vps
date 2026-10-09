// Every provider asap-vps ships, by id: what configuration-driven code (a CLI
// flag, a config file, an orchestrator reading its environment) needs to turn
// "runpod" into a working provider without importing each class by name, and
// to know what each can do before building one. Typed per id:
// createProvider('lambda', key) is a LambdaCloud, with no stopServer to call.

import type { CapabilityDescriptor, CapabilityName } from '../capabilities';
import type { ProviderParams } from '../types';
import { DigitalOcean } from './DigitalOcean/DigitalOcean';
import { LambdaCloud } from './LambdaCloud/LambdaCloud';
import { RunPod } from './RunPod/RunPod';
import { Scaleway } from './Scaleway/Scaleway';
import { VastAI } from './VastAI/VastAI';

export type ProviderInfo<P = unknown> = {
    /** The provider's `id`, as its records report it. */
    id: string,
    name: string,
    /** What it can do and how: the class's `capabilities`, readable without building one. */
    capabilities: CapabilityDescriptor,
    /** The environment variable asap-vps reads this provider's API key from (.env.template, scripts). */
    keyEnv: string,
    /**
     * The settings besides the key that its provider takes, by ProviderParams
     * field, and the environment variable each is read from (Scaleway's Project
     * and zones). A variable that is not set leaves its setting out.
     */
    paramsEnv?: Readonly<Record<string, string>>,
    create(params: ProviderParams | string): P,
};

const info = <P>(i: ProviderInfo<P>) => Object.freeze(i);

export const PROVIDERS = Object.freeze({
    digitalocean: info({ id: 'digitalocean', name: 'DigitalOcean', capabilities: DigitalOcean.capabilities, keyEnv: 'DIGITAL_OCEAN_API_KEY', create: (p) => new DigitalOcean(p) }),
    runpod: info({ id: 'runpod', name: 'RunPod', capabilities: RunPod.capabilities, keyEnv: 'RUNPOD_API_KEY', create: (p) => new RunPod(p) }),
    vast: info({ id: 'vast', name: 'Vast.ai', capabilities: VastAI.capabilities, keyEnv: 'VAST_API_KEY', create: (p) => new VastAI(p) }),
    lambda: info({ id: 'lambda', name: 'Lambda', capabilities: LambdaCloud.capabilities, keyEnv: 'LAMBDA_API_KEY', create: (p) => new LambdaCloud(p) }),
    // The secret key (X-Auth-Token); the Project is where servers and SSH keys are created (SCW_DEFAULT_PROJECT_ID).
    scaleway: info({
        id: 'scaleway', name: 'Scaleway', capabilities: Scaleway.capabilities, keyEnv: 'SCW_SECRET_KEY',
        paramsEnv: { projectId: 'SCW_DEFAULT_PROJECT_ID', zones: 'SCW_ZONES', accessKey: 'SCW_ACCESS_KEY' },
        create: (p) => new Scaleway(p),
    }),
});

export type ProviderId = keyof typeof PROVIDERS;
/** The class `createProvider(id)` builds: DigitalOcean for 'digitalocean', RunPod for 'runpod', ... */
export type ProviderOf<K extends ProviderId> = ReturnType<(typeof PROVIDERS)[K]['create']>;
/** Any shipped provider: narrow it by its `id`, or by a capability (`supports(p, 'power')`). */
export type AnyProvider = ProviderOf<ProviderId>;

export function isProviderId(id: string): id is ProviderId {
    return Object.prototype.hasOwnProperty.call(PROVIDERS, id);
}

/**
 * What `info`'s provider is built from, out of `env`: its key and each other
 * setting that is set; undefined when the key is not (a provider without a key
 * is not configured).
 */
export function providerParams(i: ProviderInfo, env: Record<string, string | undefined>): ProviderParams | undefined {
    const apiKey = env[i.keyEnv]?.trim();
    if (!apiKey) return undefined;
    const params: Record<string, unknown> = { apiKey };
    for (const [field, name] of Object.entries(i.paramsEnv ?? {})) {
        const value = env[name]?.trim();
        if (value) params[field] = value;
    }
    return params as ProviderParams;
}

/** A provider by id: createProvider('runpod', process.env.RUNPOD_API_KEY!) is a RunPod. */
export function createProvider<K extends ProviderId>(id: K, params: ProviderParams | string): ProviderOf<K>;
export function createProvider(id: string, params: ProviderParams | string): AnyProvider;
export function createProvider(id: string, params: ProviderParams | string): AnyProvider {
    return providerInfo(id).create(params) as AnyProvider;
}

/** A registered provider's entry. Only the registry's own ids: "constructor" or "toString" are not providers. */
export function providerInfo<K extends ProviderId>(id: K): (typeof PROVIDERS)[K];
export function providerInfo(id: string): ProviderInfo<AnyProvider>;
export function providerInfo(id: string): ProviderInfo<AnyProvider> {
    if (!isProviderId(id)) throw new Error(`unknown provider "${id}" (asap-vps has ${Object.keys(PROVIDERS).join(', ')})`);
    return PROVIDERS[id] as ProviderInfo<AnyProvider>;
}

/**
 * The providers whose API key is set in `env` (by default every registered
 * one, else just `ids`), each built with its key and the other settings `env`
 * has for it (providerParams). A listed id without a key is skipped, never an
 * error: a deployment configures the providers it has accounts on.
 */
export function providersFromEnv(env: Record<string, string | undefined>, ids: string[] = Object.keys(PROVIDERS)): AnyProvider[] {
    const out: AnyProvider[] = [];
    for (const id of ids) {
        const i = providerInfo(id);
        const params = providerParams(i, env);
        if (params) out.push(i.create(params));
    }
    return out;
}

/** The registered providers that have every one of `capabilities` (by their descriptors: nothing is built). */
export function providersWith(...capabilities: CapabilityName[]): ProviderId[] {
    return (Object.keys(PROVIDERS) as ProviderId[]).filter((id) => capabilities.every((c) => PROVIDERS[id].capabilities[c] !== undefined));
}
