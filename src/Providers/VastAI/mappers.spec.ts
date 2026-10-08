// Vast's records as asap-vps reads them, where they are sparse or say
// something unexpected: a field Vast leaves out is left out (or a stated
// default), never NaN or a crash.

import { testPublicKey } from '../../testing/fakes/util';
import { instanceStatus, toImage, toOffer, toServer, toSSHKey } from './mappers';
import type { VastInstance, VastOffer, VastSnapshotRepository } from './types';

describe('Vast offers', () => {
    it('an ask that says next to nothing: one GPU of no known model, its place unknown, no CUDA', () => {
        const o = toOffer({ id: 5, dph_total: 0.3 } as VastOffer, false);
        expect(o).toMatchObject({ id: '5', gpu: '', gpuCount: 1, vramGb: 0, pricePerHour: 0.3, regions: ['unknown'] });
        expect(o.cudaVersion).toBeUndefined();
        expect(toOffer({ id: 5, dph_total: 0.3, cuda_max_good: 0 } as VastOffer, false).cudaVersion).toBeUndefined();
    });

    it('an ask no longer rentable is in stock nowhere; an interruptible one with no minimum bid is bid at its price', () => {
        expect(toOffer({ id: 5, dph_total: 0.3, rentable: false, geolocation: 'Ohio, US', machine_id: 14 } as VastOffer, false).regions).toEqual([]);
        expect(toOffer({ id: 5, dph_total: 0.3 } as VastOffer, true)).toMatchObject({ id: '5:bid:0.3', pricePerHour: 0.3 });
    });
});

describe('Vast instances', () => {
    it('a stopped contract asked to run is starting', () => {
        expect(instanceStatus({ id: 1, cur_state: 'stopped', intended_status: 'running', actual_status: 'exited' } as VastInstance)).toBe('pending');
    });

    it('an instance that says next to nothing: no name, no GPU, no place, no price, no dates; its status words as Vast gave them', () => {
        const s = toServer({ id: 9 } as VastInstance);
        expect(s).toMatchObject({ id: '9', name: '', status: 'pending', providerStatus: 'none/?' });
        for (const k of ['gpu', 'gpuCount', 'region', 'ip', 'ports', 'mounts', 'ssh', 'pricePerHour', 'billingStartedAt', 'createdAt'] as const) expect(s[k]).toBeUndefined();
        expect(toServer({ id: 9, actual_status: 'loading', cur_state: 'running', status_msg: `pulling ${'x'.repeat(200)}` } as VastInstance).providerStatus)
            .toBe(`loading/running: pulling ${'x'.repeat(112)}`);
    });

    it('a GPU Vast names as asap-vps does not know is named as Vast names it', () => {
        expect(toServer({ id: 9, gpu_name: 'Acme_Z9' } as VastInstance).gpu).toBe('Acme_Z9');
        expect(toServer({ id: 9, gpu_name: 'RTX_4090' } as VastInstance).gpu).toBe('RTX 4090');
    });

    it('ports: a key with no protocol is tcp; one Vast has not mapped yet is left out', () => {
        const s = toServer({ id: 9, public_ipaddr: '198.51.100.7\n', ports: { '8080': [{ HostIp: '0.0.0.0', HostPort: '41234' }], '22/tcp': null, '53/udp': [{ HostIp: '0.0.0.0' }] } } as unknown as VastInstance);
        expect(s.ports).toEqual([{ privatePort: 8080, publicPort: 41234, ip: '198.51.100.7', protocol: 'tcp' }]);
    });
});

describe('Vast snapshots and keys', () => {
    const repo = { server: 'ghcr.io', repository: 'acme/snapshots', username: 'u', password: 'p' } as VastSnapshotRepository;

    it('a snapshot whose manifest lists no layers, or layers with no size, has no size', () => {
        expect(toImage(repo, 'v1', { digest: 'sha256:abc', json: {} })).toMatchObject({ id: 'ghcr.io/acme/snapshots:v1', raw: { digest: 'sha256:abc', size: 0 } });
        expect(toImage(repo, 'v1', { digest: 'sha256:abc', json: { layers: [{}, { size: 2e9 }] } }).sizeGb).toBe(2);
        expect(toImage(repo, 'v1', { digest: 'sha256:abc', json: {} }).sizeGb).toBeUndefined();
    });

    it('a key is read from `key`, else `public_key`; one with neither, or one the parser does not read, has no name and no fingerprint', () => {
        const line = testPublicKey('laptop');
        expect(toSSHKey({ id: 3, public_key: line })).toMatchObject({ id: 3, name: 'laptop', publicKey: line, fingerprint: expect.stringMatching(/^SHA256:/) });
        expect(toSSHKey({ id: 4 })).toEqual({ id: 4, name: '', publicKey: '', fingerprint: '' });
    });
});
