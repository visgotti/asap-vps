// Vast's records as asap-vps reads them, where they are sparse or say
// something unexpected: a field Vast leaves out is left out (or a stated
// default), never NaN or a crash.

import { testPublicKey } from '../../testing/fakes/util';
import { countryOf, instanceStatus, machineOf, toImage, toOffer, toServer, toSSHKey, toVolume } from './mappers';
import type { VastInstance, VastOffer, VastSnapshotRepository, VastVolume } from './types';

describe('Vast places', () => {
    it('the country a machine is in is the code its location ends with, as Vast writes it (seen 2026-10-12); none where it gives none', () => {
        expect(['Texas, US', 'United Kingdom, GB', 'South Korea, KR', 'Quebec, CA', 'Czechia, CZ', 'New Zealand, NZ', 'SE'].map(countryOf)).toEqual(['US', 'GB', 'KR', 'CA', 'CZ', 'NZ', 'SE']);
        expect(['unknown', '', null, undefined, 'Texas, us', 'Texas,US', 'Texas, USA', 'US, Texas'].map(countryOf)).toEqual(Array(8).fill(undefined));
    });

    it('an offer is in its machine\'s country by both of its names: where it is, and the machine it is', () => {
        const o = toOffer({ id: 1, gpu_name: 'RTX 4090', num_gpus: 1, gpu_ram: 24000, dph_total: 0.4, geolocation: 'Japan, JP', machine_id: 7 } as VastOffer, false);
        expect([o.regions, o.locations]).toEqual([['Japan, JP', 'machine:7'], [{ region: 'Japan, JP', country: 'JP' }, { region: 'machine:7', country: 'JP' }]]);
        const nowhere = toOffer({ id: 2, gpu_name: 'RTX 4090', num_gpus: 1, gpu_ram: 24000, dph_total: 0.4, machine_id: 8 } as VastOffer, false);
        expect(nowhere.locations).toEqual([{ region: 'unknown' }, { region: 'machine:8' }]);
        expect(toServer({ id: 5, actual_status: 'running', geolocation: 'Norway, NO' } as VastInstance).country).toBe('NO');
        expect('country' in toServer({ id: 5, actual_status: 'running' } as VastInstance)).toBe(false);
    });
});

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
        // A binding that is null among the port's bindings is no binding.
        expect(toServer({ id: 9, ports: { '443/tcp': [null, { HostIp: '0.0.0.0', HostPort: '41000' }] } } as unknown as VastInstance).ports)
            .toEqual([{ privatePort: 443, publicPort: 41000, ip: undefined, protocol: 'tcp' }]);
    });

    it('where to log in: the machine\'s address and the port mapped to the container\'s 22; Vast\'s own proxy where none is mapped; nowhere where it gives neither', () => {
        const mapped = { '22/tcp': [{ HostIp: '0.0.0.0', HostPort: '41022' }], '8080/tcp': [{ HostIp: '0.0.0.0', HostPort: '41080' }], '22/udp': [{ HostIp: '0.0.0.0', HostPort: '41999' }] };
        const ssh = (i: object) => toServer({ id: 9, ...i } as unknown as VastInstance).ssh;
        // The mapped port wins over the proxy, which carries no scp or port forwarding; port 22 itself, over tcp, and no other.
        expect(ssh({ public_ipaddr: '198.51.100.7\n', ports: mapped, ssh_host: 'ssh5.vast.ai', ssh_port: 20009 })).toEqual({ host: '198.51.100.7', port: 41022, username: 'root' });
        expect(ssh({ public_ipaddr: '198.51.100.7', ports: { '8080/tcp': mapped['8080/tcp'], '22/udp': mapped['22/udp'] }, ssh_host: 'ssh5.vast.ai', ssh_port: '20009' }))
            .toEqual({ host: 'ssh5.vast.ai', port: 20009, username: 'root' });
        // A mapped port with no address to reach it at is no endpoint: the proxy, where there is one.
        expect(ssh({ ports: mapped, ssh_host: 'ssh5.vast.ai', ssh_port: 20009 })).toEqual({ host: 'ssh5.vast.ai', port: 20009, username: 'root' });
        expect([ssh({ ports: mapped }), ssh({ ssh_host: 'ssh5.vast.ai' }), ssh({ ssh_port: 20009 }), ssh({}), 'ssh' in toServer({ id: 9 } as unknown as VastInstance)]).toEqual([undefined, undefined, undefined, undefined, false]);
    });
});

describe('Vast volumes and machines', () => {
    it('a region names a machine when the whole of it, blank space aside, is machine:<id>', () => {
        expect(['machine:14', ' machine:14\n', 'xmachine:14', 'machine:14x', 'machine:', 'Ohio, US'].map((r) => machineOf(r))).toEqual([14, 14, undefined, undefined, undefined, undefined]);
    });

    it('a volume that says next to nothing: no size where Vast gives null, no status word, and an instance entry that is null is no instance', () => {
        const v = toVolume({ id: 5, machine_id: 3, disk_space: null, instances: [null, 9] } as unknown as VastVolume);
        expect(v).toMatchObject({ id: '5', region: 'machine:3', status: 'attached', providerStatus: '', serverIds: ['9'] });
        expect(v.sizeGb).toBeUndefined();
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
