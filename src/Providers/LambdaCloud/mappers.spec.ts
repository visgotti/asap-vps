// Lambda's records as asap-vps reads them, where they are sparse or say
// something unexpected: a field Lambda leaves out is left out (or a stated
// default), never NaN or a crash, and a status word it adds later reads as
// 'unknown'.

import { countryOf, LAMBDA_ENUMS, toOffer, toServer, toVolume } from './mappers';
import type { LambdaFilesystem, LambdaInstance, LambdaInstanceType, LambdaInstanceTypes } from './types';

const type = (o: Partial<LambdaInstanceType> = {}): LambdaInstanceType => ({
    name: 'gpu_1x_a10', description: '1x A10 (24 GB PCIe)', gpu_description: 'A10 (24 GB PCIe)', price_cents_per_hour: 75,
    specs: { vcpus: 30, memory_gib: 200, storage_gib: 1400, gpus: 1 }, ...o,
});
const offerOf = (it: LambdaInstanceType, regions?: string[]) =>
    toOffer({ instance_type: it, regions_with_capacity_available: regions?.map((name) => ({ name, description: name })) } as LambdaInstanceTypes[string]);

describe('the library\'s enums by Lambda\'s names', () => {
    it('each Ubuntu it has is its image family, and with cuda its Lambda Stack family; no regions', () => {
        expect(LAMBDA_ENUMS).toEqual({
            machines: { ubuntu24: 'ubuntu-24-04', ubuntu22: 'ubuntu-22-04' },
            cudaMachines: { ubuntu24: 'lambda-stack-24-04', ubuntu22: 'lambda-stack-22-04' },
        });
        expect(Object.isFrozen(LAMBDA_ENUMS)).toBe(true);
    });
});

describe('Lambda places', () => {
    it('the country a region is in is the one its description ends with, as Lambda writes it (seen 2026-10-12); a us- code is the United States whatever it says', () => {
        const live: Array<[string, string, string]> = [
            ['asia-south-1', 'India', 'IN'], ['us-east-1', 'Virginia, USA', 'US'], ['us-south-2', 'North Texas, USA', 'US'], ['us-west-1', 'California, USA', 'US'],
            ['us-west-2', 'Arizona, USA', 'US'], ['us-west-3', 'Utah, USA', 'US'],
        ];
        expect(live.map(([name, description]) => countryOf({ name, description }))).toEqual(live.map(([, , country]) => country));
        expect(countryOf({ name: 'europe-central-1', description: 'Germany' })).toBe('DE');
        expect(countryOf({ name: 'us-east-9', description: '' })).toBe('US');
        expect(countryOf({ name: 'us-east-9' })).toBe('US');
        // A country it does not know by name is not guessed from the code.
        expect([{ name: 'asia-south-1', description: '' }, { name: 'mars-1', description: 'Olympus Mons, Mars' }, {}, null, undefined].map(countryOf)).toEqual(Array(5).fill(undefined));
    });

    it('an offer and an instance carry the country of each of their places', () => {
        const t = { instance_type: { name: 'gpu_1x_a10', description: '1x A10 (24 GB PCIe)', gpu_description: 'A10 (24 GB PCIe)', price_cents_per_hour: 75,
            specs: { vcpus: 30, memory_gib: 200, storage_gib: 1400, gpus: 1 } }, regions_with_capacity_available: [{ name: 'us-west-1', description: 'California, USA' },
            { name: 'asia-south-1', description: 'India' }, { name: 'mars-1', description: 'Mars' }] } as LambdaInstanceTypes[string];
        expect(toOffer(t).locations).toEqual([{ region: 'us-west-1', country: 'US' }, { region: 'asia-south-1', country: 'IN' }, { region: 'mars-1' }]);
        expect(toOffer(t).regions).toEqual(['us-west-1', 'asia-south-1', 'mars-1']);
        const i = { id: 'i-1', status: 'active', ssh_key_names: [], region: { name: 'asia-south-1', description: 'India' } } as unknown as LambdaInstance;
        expect(toServer(i).country).toBe('IN');
        expect('country' in toServer({ ...i, region: { name: 'mars-1', description: 'Mars' } })).toBe(false);
    });
});

describe('Lambda instance types as offers', () => {
    it('its GPU: by its description, else by its name, else the description as it is; its memory as the description states it, else the model\'s', () => {
        expect(offerOf(type(), ['us-east-1'])).toMatchObject({ gpu: 'A10', vendor: 'nvidia', vramGb: 24, pricePerHour: 0.75, regions: ['us-east-1'] });
        expect(offerOf(type({ name: 'gpu_1x_h100_pcie', gpu_description: 'Tensor Core' }))).toMatchObject({ gpu: 'H100', vramGb: 80 });
        expect(offerOf(type({ name: 'gpu_1x_z9', gpu_description: 'Acme Z9' }))).toMatchObject({ gpu: 'Acme Z9', vendor: 'nvidia', vramGb: 0 });
    });

    it('a type with no regions listed is in stock nowhere', () => {
        expect(offerOf(type()).regions).toStrictEqual([]);
    });
});

describe('Lambda instances', () => {
    const instance = (o: Partial<LambdaInstance> = {}) => ({ id: 'i-1', status: 'active', ssh_key_names: [], region: { name: 'us-east-1', description: '' }, ...o }) as LambdaInstance;

    it('a status Lambda adds later is unknown; one with no name, no type, no address and no health check says none of them', () => {
        const s = toServer(instance({ status: 'hibernating' as LambdaInstance['status'] }));
        expect(s).toMatchObject({ status: 'unknown', providerStatus: 'hibernating', name: '', region: 'us-east-1' });
        for (const k of ['offerId', 'gpu', 'gpuCount', 'ip', 'privateIp', 'ssh', 'pricePerHour', 'billingStartedAt', 'mounts'] as const) expect(s[k]).toBeUndefined();
    });

    it('its GPU: the model its type names, else its type\'s description; billed from its first passed health check, a date Lambda garbles being none', () => {
        const at = '2026-10-01T00:00:00Z';
        expect(toServer(instance({ instance_type: type(), first_healthy: at, ip: '203.0.113.5' }))).toMatchObject({
            gpu: 'A10', gpuCount: 1, pricePerHour: 0.75, billingStartedAt: Date.parse(at), ssh: { host: '203.0.113.5', port: 22, username: 'ubuntu' },
        });
        expect(toServer(instance({ instance_type: type({ name: 'gpu_1x_z9', gpu_description: 'Acme Z9' }) })).gpu).toBe('Acme Z9');
        expect(toServer(instance({ first_healthy: 'soon' })).billingStartedAt).toBeUndefined();
    });
});

describe('Lambda filesystems', () => {
    it('one in use is attached; a creation date Lambda garbles is no date', () => {
        const f = (o: Partial<LambdaFilesystem>) => toVolume({ id: 'fs-1', name: 'models', mount_point: '/lambda/nfs/models', created: '2026-10-01T00:00:00Z', is_in_use: false, region: { name: 'us-east-1', description: '' }, ...o });
        expect(f({ is_in_use: true, created: 'x' })).toMatchObject({ status: 'attached', providerStatus: 'in use', createdAt: undefined, shared: true, mountPath: '/lambda/nfs/models' });
        expect(f({})).toMatchObject({ status: 'available', createdAt: Date.parse('2026-10-01T00:00:00Z') });
    });

    it('one whose record names no region has none', () => {
        const v = toVolume({ id: 'fs-1', name: 'models', mount_point: '/lambda/nfs/models', created: '2026-10-01T00:00:00Z', is_in_use: false } as LambdaFilesystem);
        expect(v).toMatchObject({ id: 'fs-1', name: 'models', status: 'available' });
        expect(v.region).toBeUndefined();
    });
});
