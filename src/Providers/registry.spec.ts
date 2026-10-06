// The provider registry: every shipped provider by id, built from a key, and
// the environment variables asap-vps reads those keys from.

import { readFileSync } from 'fs';
import { join } from 'path';
import { supports } from '../capabilities';
import { ComputeProvider } from '../Core/ComputeProvider';
import { LambdaCloud } from './LambdaCloud/LambdaCloud';
import { createProvider, isProviderId, PROVIDERS, providerInfo, providerParams, providersFromEnv, providersWith } from './registry';
import type { Scaleway } from './Scaleway/Scaleway';

describe('provider registry', () => {
    it('builds every registered provider by id, and each reports that id', () => {
        expect(Object.keys(PROVIDERS).sort()).toEqual(['digitalocean', 'lambda', 'runpod', 'scaleway', 'vast']);
        for (const [id, info] of Object.entries(PROVIDERS)) {
            const p = createProvider(id, `${id}-key`);
            expect(p).toBeInstanceOf(ComputeProvider);
            expect([p.id, info.id, p.apiKey]).toEqual([id, id, `${id}-key`]);
            // What it can do is known without building one, and is what the class says.
            expect(info.capabilities).toBe(p.capabilities);
        }
    });

    it('is typed per id: the class it builds, with exactly its capabilities', () => {
        const lambda = createProvider('lambda', 'k');
        expect(lambda).toBeInstanceOf(LambdaCloud);
        // @ts-expect-error Lambda has no stop: its class has no stopServer to call.
        expect(lambda.stopServer).toBeUndefined();
        const any = createProvider(String('runpod'), 'k');
        // @ts-expect-error A provider by a name only known at run time is any provider: narrow it first.
        expect(typeof any.stopServer).toBe('function');
        if (supports(any, 'power')) expect(any.capabilities.power.stoppedBilling).toBe('storage');
        expect(isProviderId('runpod')).toBe(true);
        expect(isProviderId('toString')).toBe(false);
    });

    it('finds the providers that have every capability asked for, from their descriptors', () => {
        expect(providersWith('images').sort()).toEqual(['digitalocean', 'scaleway']);
        expect(providersWith('images', 'imageCopy').sort()).toEqual(['digitalocean', 'scaleway']);
        expect(providersWith('logs').sort()).toEqual(['runpod', 'vast']);
        expect(providersWith('power').sort()).toEqual(['digitalocean', 'runpod', 'scaleway', 'vast']);
        expect(providersWith('compute', 'sshKeys', 'restart')).toHaveLength(5);
        // Every platform with storage that outlives its servers; Vast's live on one machine.
        expect(providersWith('volumes')).toEqual(['digitalocean', 'runpod', 'lambda', 'scaleway']);
        expect(providersWith('volumes', 'images').sort()).toEqual(['digitalocean', 'scaleway']);
    });

    it('refuses an id it does not know, naming the ones it does', () => {
        expect(() => createProvider('fly', 'k')).toThrow(/unknown provider "fly" \(asap-vps has digitalocean, runpod, vast, lambda, scaleway\)/);
        // Names every object has are not providers.
        for (const id of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
            expect(() => createProvider(id, 'k')).toThrow(/unknown provider/);
            expect(() => providersFromEnv({ undefined: 'k' }, [id])).toThrow(/unknown provider/);
        }
    });

    it('builds from an environment only the providers with a key set', () => {
        const ps = providersFromEnv({ RUNPOD_API_KEY: 'rp', DIGITAL_OCEAN_API_KEY: '  ', VAST_API_KEY: 'va' });
        expect(ps.map((p) => [p.id, p.apiKey])).toEqual([['runpod', 'rp'], ['vast', 'va']]);
        expect(providersFromEnv({ RUNPOD_API_KEY: 'rp', VAST_API_KEY: 'va' }, ['vast']).map((p) => p.id)).toEqual(['vast']);
        expect(() => providersFromEnv({}, ['nope'])).toThrow(/unknown provider "nope"/);
    });

    it('names the key variables .env.template lists, one per provider, and the other settings its providers read', () => {
        const template = readFileSync(join(__dirname, '..', '..', '.env.template'), 'utf8');
        for (const info of Object.values(PROVIDERS)) {
            for (const variable of [info.keyEnv, ...Object.values(info.paramsEnv ?? {})]) expect(template).toMatch(new RegExp(`^${variable}=`, 'm'));
        }
    });

    it('hands a provider the other settings the environment has for it, and only with its key', () => {
        const env = { SCW_SECRET_KEY: ' scw-key ', SCW_DEFAULT_PROJECT_ID: '11111111-1111-4111-8111-111111111111', SCW_ZONES: 'fr-par-2, pl-waw' };
        const [scaleway] = providersFromEnv(env, ['scaleway']) as Scaleway[];
        expect([scaleway.apiKey, scaleway.api.projectId, scaleway.api.zones]).toEqual(['scw-key', env.SCW_DEFAULT_PROJECT_ID, ['fr-par-2', 'pl-waw-1', 'pl-waw-2', 'pl-waw-3']]);
        // A setting without its key configures nothing; a setting that is empty is left out.
        expect(providersFromEnv({ SCW_DEFAULT_PROJECT_ID: env.SCW_DEFAULT_PROJECT_ID }, ['scaleway'])).toEqual([]);
        expect(providerParams(providerInfo('scaleway'), { SCW_SECRET_KEY: 'k', SCW_DEFAULT_PROJECT_ID: '  ', SCW_ZONES: '' })).toEqual({ apiKey: 'k' });
        // A provider with no extra settings takes the key alone.
        expect(providerParams(providerInfo('runpod'), { RUNPOD_API_KEY: 'rp', SCW_DEFAULT_PROJECT_ID: 'x' })).toEqual({ apiKey: 'rp' });
    });
});
