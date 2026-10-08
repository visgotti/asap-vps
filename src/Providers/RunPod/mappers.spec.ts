// RunPod's records as asap-vps reads them, where they are sparse or say
// something unexpected: a field RunPod leaves out is left out (or a stated
// default), never NaN or a crash, and a status word it adds later reads as
// 'unknown'.

import { toCpuOffer, toEndpoint, toOffer, toServer, toServerlessCpuOffer, toServerlessGpuOffer } from './mappers';
import type { RunPodCpuType, RunPodEndpoint, RunPodGpuType, RunPodPod } from './types';

const gpu = (o: Partial<RunPodGpuType> = {}) => ({ id: 'NVIDIA L4', secure: true, community: true, price: { secure: 0.4, community: 0.3, serverless: 0.5 }, ...o }) as RunPodGpuType;
const cpu = (o: Partial<RunPodCpuType> = {}) => ({ id: 'cpu3c', vcpu: { min: 2, max: 8 }, ramGbPerVcpu: 2, price: { securePerVcpu: 0.02, serverlessPerVcpu: 0.03 }, ...o }) as RunPodCpuType;
const pod = (o: Partial<RunPodPod> = {}) => ({ id: 'pod_1', name: 'p', status: 'RUNNING', ...o }) as RunPodPod;
const endpoint = (o: Partial<RunPodEndpoint> = {}) => ({ id: 'ep1', name: 'e', ...o }) as RunPodEndpoint;

describe('RunPod GPU and CPU offers', () => {
    it('a type its cloud sells but has no price for is no offer', () => {
        expect(toOffer(gpu({ price: { secure: 0, community: 0.3 } } as Partial<RunPodGpuType>), 1, 'SECURE')).toBeNull();
        expect(toOffer(gpu({ price: undefined } as Partial<RunPodGpuType>), 1, 'COMMUNITY')).toBeNull();
    });

    it('memory the catalog does not state is the model\'s known size, else 0; no data centers is no stock', () => {
        expect(toOffer(gpu(), 2, 'SECURE')).toMatchObject({ vramGb: 24, gpuCount: 2, pricePerHour: 0.8, regions: [] });
        expect(toOffer(gpu({ id: 'Acme Z9' }), 1, 'SECURE')).toMatchObject({ gpu: 'Acme Z9', vramGb: 0 });
    });

    it('a CPU flavor with no secure price is no offer; with no data centers, no stock', () => {
        expect(toCpuOffer(cpu({ price: { securePerVcpu: 0 } } as Partial<RunPodCpuType>), 4)).toBeNull();
        expect(toCpuOffer(cpu(), 4)).toMatchObject({ id: 'cpu3c:4', pricePerHour: 0.08, memoryGb: 8, regions: [] });
    });

    it('serverless: an AMD type is an AMD offer; a type in no pool, or with no serverless price, is none; a CPU flavor needs 2 vCPUs and a price', () => {
        expect(toServerlessGpuOffer(gpu({ id: 'AMD Instinct MI300X OAM', manufacturer: 'AMD', pool: 'AMD_192', memory: 192 }))).toMatchObject({ vendor: 'amd', vramGb: 192, pricePerHour: 0.5, regions: [] });
        expect(toServerlessGpuOffer(gpu({ pool: 'ADA_24' }))).toMatchObject({ vendor: 'nvidia', vramGb: 24 });
        expect(toServerlessGpuOffer(gpu({ id: 'Acme Z9', pool: 'X' }))?.vramGb).toBe(0);
        expect(toServerlessGpuOffer(gpu())).toBeNull();
        expect(toServerlessGpuOffer(gpu({ pool: 'ADA_24', price: { secure: 1, community: 1 } } as Partial<RunPodGpuType>))).toBeNull();
        expect(toServerlessCpuOffer(cpu(), 1)).toBeNull();
        expect(toServerlessCpuOffer(cpu({ price: { securePerVcpu: 0.02 } } as Partial<RunPodCpuType>), 4)).toBeNull();
        expect(toServerlessCpuOffer(cpu(), 4)).toMatchObject({ pricePerHour: 0.12, raw: { vcpuCount: 4 } });
    });
});

describe('RunPod pods', () => {
    it('a status RunPod adds later is unknown; a pod with no GPU or CPU, no data center and no dates says none of them', () => {
        const s = toServer(pod({ status: 'MIGRATING' as RunPodPod['status'] }));
        expect(s).toMatchObject({ status: 'unknown', providerStatus: 'MIGRATING', ports: [] });
        for (const k of ['offerId', 'gpu', 'gpuCount', 'region', 'ip', 'pricePerHour', 'billingStartedAt', 'createdAt'] as const) expect(s[k]).toBeUndefined();
    });

    it('a CPU pod\'s offer is its flavor at its vCPU count', () => {
        expect(toServer(pod({ cpu: { id: 'cpu5c', vcpuCount: 4 } } as Partial<RunPodPod>)).offerId).toBe('cpu5c:4');
    });

    it('a port RunPod has not mapped yet has no public port or address; one with no type is tcp', () => {
        const s = toServer(pod({ runtime: { ports: [{ private: 8888 }, { private: 22, public: 40022, ip: '194.68.245.10', type: 'tcp' }] } } as Partial<RunPodPod>));
        expect(s.ports).toEqual([{ privatePort: 8888, protocol: 'tcp' }, { privatePort: 22, publicPort: 40022, ip: '194.68.245.10', protocol: 'tcp' }]);
        expect(s.ip).toBe('194.68.245.10');
    });

    it('billed from its last start while it is not stopped; a date RunPod garbles is no date', () => {
        const at = '2026-10-01T00:00:00Z';
        expect(toServer(pod({ startedAt: at, createdAt: at })).billingStartedAt).toBe(Date.parse(at));
        expect(toServer(pod({ status: 'EXITED', startedAt: at })).billingStartedAt).toBeUndefined();
        expect(toServer(pod({ startedAt: 'soon', createdAt: 'yesterday' }))).toMatchObject({ billingStartedAt: undefined, createdAt: undefined });
    });
});

describe('RunPod serverless endpoints', () => {
    it('its URL: the one RunPod gives, else the load balancer\'s host or the queue API\'s path', () => {
        expect(toEndpoint(endpoint({ requestUrls: { base: 'https://ep1.api.runpod.ai/' } } as Partial<RunPodEndpoint>)).url).toBe('https://ep1.api.runpod.ai');
        expect(toEndpoint(endpoint({ type: 'LOAD_BALANCER' })).url).toBe('https://ep1.api.runpod.ai');
        expect(toEndpoint(endpoint()).url).toBe('https://api.runpod.ai/v2/ep1');
    });

    it('its port: PORT, else its first http port, else 80', () => {
        expect(toEndpoint(endpoint({ env: { PORT: '8000' }, ports: ['9000/http'] })).port).toBe(8000);
        expect(toEndpoint(endpoint({ ports: ['9000/http'] })).port).toBe(9000);
        expect(toEndpoint(endpoint({ ports: ['22/tcp'] })).port).toBe(80);
        expect(toEndpoint(endpoint()).port).toBe(80);
    });

    it('what RunPod leaves out: a queue endpoint, no image, no workers, no region unless it names exactly one, no date', () => {
        const e = toEndpoint(endpoint({ createdAt: 'later' }));
        expect(e).toMatchObject({ providerStatus: 'QUEUE', image: '', minWorkers: 0, maxWorkers: 0, status: 'ready', createdAt: undefined });
        for (const k of ['offerId', 'region', 'idleTimeoutSeconds'] as const) expect(e[k]).toBeUndefined();
        expect(toEndpoint(endpoint({ dataCenterIds: ['EU-RO-1', 'US-TX-3'] })).region).toBeUndefined();
        expect(toEndpoint(endpoint({ dataCenterIds: ['EU-RO-1'], workers: { min: 1, max: 3, idleTimeout: 5 }, cpu: [{ id: 'cpu3c', vcpuCount: 2 }] } as Partial<RunPodEndpoint>)))
            .toMatchObject({ region: 'EU-RO-1', minWorkers: 1, maxWorkers: 3, idleTimeoutSeconds: 5, offerId: 'cpu3c:2' });
    });
});
