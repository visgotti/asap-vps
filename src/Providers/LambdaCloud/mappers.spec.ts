// Lambda's records as asap-vps reads them, where they are sparse or say
// something unexpected: a field Lambda leaves out is left out (or a stated
// default), never NaN or a crash, and a status word it adds later reads as
// 'unknown'.

import { toOffer, toServer, toVolume } from './mappers';
import type { LambdaFilesystem, LambdaInstance, LambdaInstanceType, LambdaInstanceTypes } from './types';

const type = (o: Partial<LambdaInstanceType> = {}): LambdaInstanceType => ({
    name: 'gpu_1x_a10', description: '1x A10 (24 GB PCIe)', gpu_description: 'A10 (24 GB PCIe)', price_cents_per_hour: 75,
    specs: { vcpus: 30, memory_gib: 200, storage_gib: 1400, gpus: 1 }, ...o,
});
const offerOf = (it: LambdaInstanceType, regions?: string[]) =>
    toOffer({ instance_type: it, regions_with_capacity_available: regions?.map((name) => ({ name, description: name })) } as LambdaInstanceTypes[string]);

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
