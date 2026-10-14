// The base class's own behaviour, on a scripted provider: waits
// through transient failures, verified deletes, the library's enums in a
// platform's names, refusing what a provider cannot honor, what capabilities
// say, and sending the key only to the provider's own API.

import { CapabilityDescriptor, requireCapability, supports } from '../capabilities';
import { CUDA_TYPES, MACHINE_TYPES, REGION_TYPES } from '../constants';
import { NotSupportedError, ProviderError, TransportError } from '../errors';
import type { ContainerSpec, CreateServerOptions, ImageChoice, ImageSpec, Offer, Server, ServerStatus, Volume, VolumeMount, WaitOptions } from '../types';
import { BaseProvider, EnumTranslations } from './BaseProvider';
import { ApiClient, containerBootScript } from './utils';

const SCRIPTED_CAPABILITIES = {
    compute: { kind: 'vm', gpu: true, cpu: false, userData: true, liveAvailability: true },
} as const satisfies CapabilityDescriptor;

/** A provider whose getServer answers from a script, for the base class's helpers. */
class ScriptedProvider extends BaseProvider {
    readonly id = 'scripted';
    readonly capabilities = SCRIPTED_CAPABILITIES;
    protected readonly enums: EnumTranslations = {
        regions: { [REGION_TYPES.FRANCE_PARIS]: 'par-1' }, machines: { [MACHINE_TYPES.UBUNTU_24]: 'noble' }, cudaMachines: { [MACHINE_TYPES.UBUNTU_24]: 'noble-gpu' },
    };
    deletes = 0;
    reads = 0;
    /** What the last create named, in the platform's names. */
    created?: { region?: string, image?: string };

    constructor(private readonly script: Array<Partial<Server> | null | Error>, sleep: (ms: number) => Promise<unknown> = async () => {}) {
        super(new ApiClient({ apiKey: 'k', sleep }, 'https://api.example.com', 'scripted'));
    }

    async listOffers(): Promise<Offer[]> {
        return [];
    }

    async createServer(o: CreateServerOptions): Promise<Server> {
        this.rejectOptions(o, ['env', 'volume']);
        this.created = { region: this.resolveOffer(o).region, image: this.imageName(o.image) };
        return this.server({ name: o.name });
    }

    async getServer(): Promise<Server | null> {
        const next = this.script[Math.min(this.reads++, this.script.length - 1)];
        if (next instanceof Error) throw next;
        return next ? this.server(next) : null;
    }

    async listServers(): Promise<Server[]> {
        return [];
    }

    /** The wait options each deleteServer call was given. */
    readonly deleteOptions: WaitOptions[] = [];

    async deleteServer(_id: string, o: WaitOptions = {}): Promise<void> {
        this.deletes++;
        this.deleteOptions.push(o);
    }

    callApi(path: string) {
        return this.api.request('GET', path);
    }

    fixedGpus(o: CreateServerOptions, known: number | undefined) {
        this.checkFixedGpuCount(o, known);
    }

    mounts(m: VolumeMount[]) {
        return this.mountsOf(m);
    }

    vmImage(image: ImageChoice | undefined, cudaMachines?: EnumTranslations['cudaMachines']) {
        return cudaMachines ? this.imageName(image, cudaMachines) : this.imageName(image);
    }

    containerImage(image: ImageChoice | undefined) {
        return this.containerImageName(image);
    }

    container(o: Parameters<ScriptedProvider['containerOf']>[0]) {
        return this.containerOf(o);
    }

    minCuda(o: { minCudaVersion?: string, image?: ImageChoice, container?: ContainerSpec }) {
        return this.minCudaOf(o);
    }

    userData(o: { userData?: string, container?: ContainerSpec }, gpu = false) {
        return this.userDataWith(o, gpu);
    }

    stopped(o?: WaitOptions) {
        return this.waitUntilStopped('s1', o);
    }

    started(o?: WaitOptions) {
        return this.waitUntilRunning('s1', { ...o, requireIp: false });
    }

    restarted(o?: WaitOptions, passing?: ServerStatus[]) {
        return this.waitUntilRestarted('s1', o, passing);
    }

    refusal(status: ServerStatus) {
        return this.notRunning('s1', status);
    }

    ports(ports?: string[]) {
        return this.portsOf(ports);
    }

    private server(o: Partial<Server>): Server {
        return { provider: this.id, id: 's1', name: 'n', status: 'pending', providerStatus: 'x', raw: {}, ...o };
    }
}

describe('BaseProvider', () => {
    const fast = { intervalMs: 0, timeoutMs: 1000 };

    it('waits through transient failures until running with an address', async () => {
        const p = new ScriptedProvider([{ status: 'pending' }, new TransportError('reset'), new ProviderError('scripted', '502', { retriable: true }),
            { status: 'running' }, { status: 'running', ip: '192.0.2.1' }]);
        expect(await p.waitUntilRunning('s1', fast)).toMatchObject({ status: 'running', ip: '192.0.2.1' });
        expect(p.reads).toBe(5);
    });

    it('stops waiting at once when the server errors, disappears, or a read fails for good', async () => {
        await expect(new ScriptedProvider([{ status: 'pending' }, { status: 'error', providerStatus: 'unhealthy' }]).waitUntilRunning('s1', fast))
            .rejects.toThrow(/is error \(unhealthy\)/);
        await expect(new ScriptedProvider([null]).waitUntilRunning('s1', fast)).rejects.toThrow(/disappeared/);
        await expect(new ScriptedProvider([new ProviderError('scripted', 'bad key')]).waitUntilRunning('s1', fast)).rejects.toThrow(/bad key/);
    });

    it('times out with the last state it saw', async () => {
        await expect(new ScriptedProvider([{ status: 'pending', providerStatus: 'booting' }]).waitForServer('s1', () => false, { intervalMs: 0, timeoutMs: 20 }))
            .rejects.toThrow(/timed out .* pending \(booting\)/);
    });

    it('times out saying the server was gone at the last read, or that no read got an answer', async () => {
        const now = { intervalMs: 0, timeoutMs: 0 };
        await expect(new ScriptedProvider([null]).waitForServer('s1', () => false, now))
            .rejects.toMatchObject({ code: 'timeout', message: 'scripted: timed out after 0 s waiting for server s1: gone' });
        await expect(new ScriptedProvider([new TransportError('reset')]).waitForServer('s1', () => true, now))
            .rejects.toMatchObject({ code: 'timeout', message: 'scripted: timed out after 0 s waiting for server s1: never read' });
    });

    it('deletes again until the server is verified gone, and says so when it never is', async () => {
        const p = new ScriptedProvider([{ status: 'running' }, { status: 'stopping' }, null]);
        expect(await p.deleteServerAndWait('s1', fast)).toBe(true);
        expect(p.deletes).toBe(3);
        const stuck = new ScriptedProvider([{ status: 'running' }]);
        expect(await stuck.deleteServerAndWait('s1', { intervalMs: 0, timeoutMs: 20 })).toBe(false);
    });

    it('a delete the provider keeps refusing is the reason the wait gives up: thrown, with the refusal as its cause', async () => {
        const refusal = new ProviderError('scripted', 'precondition_failed: the server must be stopped first', { status: 400 });
        const p = new ScriptedProvider([{ status: 'running' }]);
        p.deleteServer = async () => {
            p.deletes++;
            throw refusal;
        };
        const e = await p.deleteServerAndWait('s1', { intervalMs: 0, timeoutMs: 20 }).catch((x) => x);
        expect(e).toBeInstanceOf(ProviderError);
        expect(e).toMatchObject({ code: 'timeout', cause: refusal });
        expect(e.message).toMatch(/not deleted after .* the delete kept failing \(scripted: precondition_failed/);
        expect(p.deletes).toBeGreaterThan(1);
    });

    it('a server gone after a delete that failed for good is no verified delete: what it deleted besides is left, and that is thrown', async () => {
        // A lasting failure (Scaleway: its Block volume refused deletion) while the server itself went.
        const lasting = new ProviderError('scripted', 'server s1 is deleted, but its block volume v1 is not', { code: 'left_behind' });
        const p = new ScriptedProvider([{ status: 'running' }, null]);
        p.deleteServer = async () => {
            p.deletes++;
            throw lasting;
        };
        await expect(p.deleteServerAndWait('s1', fast)).rejects.toBe(lasting);
        // A failure that may be transient is one the server outlived or not: its being gone decides.
        const q = new ScriptedProvider([null]);
        q.deleteServer = async () => {
            throw new ProviderError('scripted', '502', { retriable: true });
        };
        await expect(q.deleteServerAndWait('s1', fast)).resolves.toBe(true);
    });

    it('a read that fails while it deletes is read again when it may be transient; any other failure is thrown', async () => {
        const blip = new ScriptedProvider([new TransportError('reset'), null]);
        await expect(blip.deleteServerAndWait('s1', fast)).resolves.toBe(true);
        expect([blip.deletes, blip.reads]).toEqual([2, 2]);
        const badKey = new ProviderError('scripted', 'bad key', { status: 401 });
        const denied = new ScriptedProvider([badKey, null]);
        await expect(denied.deleteServerAndWait('s1', fast)).rejects.toBe(badKey);
        expect([denied.deletes, denied.reads]).toEqual([1, 1]);
    });

    it('without a timeout of its own, deletes for five minutes, 5 s apart, each delete given the time left; the timeout says how long it tried', async () => {
        // A clock that moves only when the provider sleeps.
        let now = Date.parse('2026-10-09T12:00:00Z');
        jest.spyOn(Date, 'now').mockImplementation(() => now);
        try {
            const refusal = new ProviderError('scripted', 'locked', { status: 409 });
            const p = new ScriptedProvider([{ status: 'running' }], async (ms) => { now += ms; });
            p.deleteServer = async (_id, o = {}) => {
                p.deleteOptions.push(o);
                throw refusal;
            };
            await expect(p.deleteServerAndWait('s1')).rejects.toMatchObject({
                code: 'timeout', cause: refusal, message: 'scripted: server s1 is not deleted after 300 s: the delete kept failing (scripted: locked)',
            });
            expect(p.deleteOptions).toEqual(Array.from({ length: 61 }, (_, i) => ({ timeoutMs: 300_000 - i * 5000 })));
        } finally {
            jest.restoreAllMocks();
        }
    });

    it('gives each delete the time left, so a provider whose delete waits waits no longer than the caller allows', async () => {
        const p = new ScriptedProvider([{ status: 'running' }, null]);
        expect(await p.deleteServerAndWait('s1', { timeoutMs: 60_000, intervalMs: 0 })).toBe(true);
        expect(p.deleteOptions).toHaveLength(2);
        for (const o of p.deleteOptions) {
            expect(o.timeoutMs).toBeGreaterThan(55_000);
            expect(o.timeoutMs).toBeLessThanOrEqual(60_000);
            expect(o.intervalMs).toBe(0);
        }
        // Without an interval of its own, the provider keeps its own.
        const q = new ScriptedProvider([null]);
        await q.deleteServerAndWait('s1', { timeoutMs: 1000 });
        expect(q.deleteOptions[0]).not.toHaveProperty('intervalMs');
    });

    it('getServerCost: the current run, from the rate and start the provider reports; null when it reports none, or the server is gone', async () => {
        const start = Date.parse('2026-10-02T12:00:00Z');
        const running = { status: 'running' as const, pricePerHour: 1.8, billingStartedAt: start, billing: { incrementSeconds: 60, minimumSeconds: 0 } };
        expect(await new ScriptedProvider([running]).getServerCost('s1', start + 90_000)).toEqual({ usd: 0.06, pricePerHour: 1.8, from: start, to: start + 90_000, billedSeconds: 120 });
        expect(await new ScriptedProvider([{ status: 'stopped', pricePerHour: 1.8 }]).getServerCost('s1')).toBeNull();
        expect(await new ScriptedProvider([null]).getServerCost('s1')).toBeNull();
    });

    it('an option it cannot honor is refused, never dropped', async () => {
        const p = new ScriptedProvider([]);
        await expect(p.createServer({ name: 'n', offer: 'o', env: { A: 'b' } })).rejects.toThrow(/option "env"/);
        await expect(p.createServer({ name: 'n', offer: 'o', env: {} })).resolves.toMatchObject({ name: 'n' });
    });

    it('reads the library\'s region and OS enums in the platform\'s names; a member it has no name for is refused; its own names pass as they are', async () => {
        const p = new ScriptedProvider([]);
        await p.createServer({ name: 'n', offer: 'o', region: REGION_TYPES.FRANCE_PARIS, image: MACHINE_TYPES.UBUNTU_24 });
        expect(p.created).toEqual({ region: 'par-1', image: 'noble' });
        await p.createServer({ name: 'n', offer: 'o', region: 'par-9', image: 'my-image' });
        expect(p.created).toEqual({ region: 'par-9', image: 'my-image' });
        await expect(p.createServer({ name: 'n', offer: 'o', region: REGION_TYPES.US_NEW_YORK })).rejects.toThrow(NotSupportedError);
        await expect(p.createServer({ name: 'n', offer: 'o', image: MACHINE_TYPES.UBUNTU_20 })).rejects.toThrow(/MACHINE_TYPES has no scripted image/);
        // An offer's own region is the platform's already: never read as an enum.
        const offer: Offer = { provider: 'scripted', id: 'o', gpu: 'L4', vendor: 'nvidia', gpuCount: 1, vramGb: 24, pricePerHour: 1, regions: [REGION_TYPES.US_NEW_YORK], raw: {} };
        await p.createServer({ name: 'n', offer });
        expect(p.created?.region).toBe(REGION_TYPES.US_NEW_YORK);
        await expect(p.createServer({ name: 'n', offer: { ...offer, provider: 'other' } })).rejects.toThrow(/is other's, not scripted's/);
    });

    it('a create needs an offer; one with stock nowhere is no capacity, unless a region is asked for', async () => {
        const p = new ScriptedProvider([]);
        const offer: Offer = { provider: 'scripted', id: 'o', gpu: 'L4', vendor: 'nvidia', gpuCount: 1, vramGb: 24, pricePerHour: 1, regions: [], raw: {} };
        const none = 'scripted: createServer needs an offer (an offer from listOffers, or its id)';
        for (const missing of ['', undefined, { ...offer, id: '' }]) {
            await expect(p.createServer({ name: 'n', offer: missing as CreateServerOptions['offer'] })).rejects.toMatchObject({ name: 'ProviderError', message: none });
        }
        await expect(p.createServer({ name: 'n', offer })).rejects.toMatchObject({
            name: 'CapacityError', message: 'scripted: offer o has no stock anywhere right now: pick an offer with regions, or ask for a region',
        });
        await p.createServer({ name: 'n', offer, region: 'par-2' });
        expect(p.created).toEqual({ region: 'par-2', image: undefined });
    });

    it('a VM\'s image: `{ os }` is the member; `{ os, cuda }` is the platform\'s GPU image of that Ubuntu, or the one the caller has for what is rented; one it has none of is refused', () => {
        const p = new ScriptedProvider([]);
        expect(p.vmImage({ os: MACHINE_TYPES.UBUNTU_24 })).toBe('noble');
        expect(p.vmImage({ os: 'ubuntu24', cuda: CUDA_TYPES.CUDA_12_8 })).toBe('noble-gpu');
        expect(p.vmImage({ os: 'ubuntu24', cuda: '13.4' }, { [MACHINE_TYPES.UBUNTU_24]: 'noble-8gpu' })).toBe('noble-8gpu');
        // The caller's table is for images asked for with cuda only.
        expect(p.vmImage(MACHINE_TYPES.UBUNTU_24, { [MACHINE_TYPES.UBUNTU_24]: 'noble-8gpu' })).toBe('noble');
        expect(p.vmImage('my-image')).toBe('my-image');
        expect(p.vmImage(undefined)).toBeUndefined();
        expect(() => p.vmImage({ os: 'ubuntu22', cuda: '12.8' })).toThrow(expect.objectContaining({
            name: 'NotSupportedError', message: 'scripted: image "ubuntu22" with cuda (scripted has no GPU image of that Ubuntu) is not supported',
        }));
        expect(() => p.vmImage({ os: 'ubuntu24', cuda: '12.8' }, {})).toThrow(/image "ubuntu24" with cuda/);
        expect(() => p.vmImage({ os: 'ubuntu22' })).toThrow('scripted: image "ubuntu22" (MACHINE_TYPES has no scripted image by that name) is not supported');
        class NoGpuImages extends ScriptedProvider {
            protected readonly enums: EnumTranslations = { machines: { [MACHINE_TYPES.UBUNTU_24]: 'noble' } };
        }
        expect(() => new NoGpuImages([]).vmImage({ os: 'ubuntu24', cuda: '12.8' })).toThrow(NotSupportedError);
    });

    it('a spec that names what the enums do not have is this provider\'s error, for a VM and for a container', () => {
        const p = new ScriptedProvider([]);
        const bad = { os: 'ubuntu24', cuda: '12.7' } as unknown as ImageSpec;
        for (const read of [() => p.vmImage(bad), () => p.containerImage(bad), () => p.minCuda({ image: bad })]) {
            expect(read).toThrow(expect.objectContaining({ name: 'ProviderError', provider: 'scripted', message: expect.stringMatching(/^scripted: bad image cuda "12\.7": use a CUDA_TYPES member \(11\.8, /) }));
        }
    });

    it('a container\'s image: the library\'s names are Docker Hub\'s images, the same whatever the platform maps; its own reference passes as it is', () => {
        const p = new ScriptedProvider([]);
        expect(p.containerImage(MACHINE_TYPES.UBUNTU_24)).toBe('ubuntu:24.04');
        expect(p.containerImage({ os: 'ubuntu22' })).toBe('ubuntu:22.04');
        expect(p.containerImage({ os: 'ubuntu24', cuda: '12.8' })).toBe('nvidia/cuda:12.8.2-base-ubuntu24.04');
        expect(p.containerImage('ghcr.io/acme/app:1')).toBe('ghcr.io/acme/app:1');
        expect(p.containerImage(undefined)).toBeUndefined();
        // What no image exists for is not supported, as on a VM: one error class for it, whatever the platform runs.
        expect(() => p.containerImage({ os: 'ubuntu24', cuda: '12.4' })).toThrow(expect.objectContaining({
            name: 'NotSupportedError', message: 'scripted: image "ubuntu24" with cuda "12.4" (NVIDIA publishes no CUDA 12.4 image of Ubuntu 24.04: it has 20.04, 22.04) is not supported',
        }));
        expect(() => p.vmImage({ os: 'ubuntu22', cuda: '12.8' })).toThrow(NotSupportedError);
    });

    it('ports are read the same way for every provider: a number and a protocol, or this provider\'s refusal', () => {
        const p = new ScriptedProvider([]);
        expect(p.ports(['8000/tcp', '53/UDP', '8888/http', '22'])).toEqual([
            { port: 8000, protocol: 'tcp' }, { port: 53, protocol: 'udp' }, { port: 8888, protocol: 'http' }, { port: 22, protocol: 'tcp' },
        ]);
        expect(p.ports(undefined)).toEqual([]);
        expect(() => p.ports(['80/tcp', '80:8080'])).toThrow(expect.objectContaining({ name: 'ProviderError', message: 'scripted: bad port "80:8080": use <port>/<tcp|udp|http>, the port from 1 to 65535' }));
    });

    it('a container platform\'s container carries its image as a registry reference, top-level or in `container`', () => {
        const p = new ScriptedProvider([]);
        expect(p.container({ image: { os: 'ubuntu24', cuda: '12.8' }, env: { A: 'b' }, command: ['run'], ports: ['80/tcp'], registryAuth: { username: 'u', password: 'p' } })).toEqual({
            image: 'nvidia/cuda:12.8.2-base-ubuntu24.04', env: { A: 'b' }, command: ['run'], ports: ['80/tcp'], registryAuth: { username: 'u', password: 'p' },
        });
        expect(p.container({ image: 'busybox' })).toEqual({ image: 'busybox' });
        // Named by the library's enums and given no command, it is kept up, as a VM stays up.
        expect(p.container({ image: MACHINE_TYPES.UBUNTU_24 })).toEqual({ image: 'ubuntu:24.04', command: ['sleep', 'infinity'] });
        expect(p.container({ container: { image: { os: 'ubuntu24', cuda: '12.8' }, env: { A: 'b' } } })).toEqual({ image: 'nvidia/cuda:12.8.2-base-ubuntu24.04', env: { A: 'b' }, command: ['sleep', 'infinity'] });
        expect(() => p.container({ image: { os: 'ubuntu20', cuda: '13.0' } })).toThrow(expect.objectContaining({ name: 'NotSupportedError' }));
        expect(p.container({ container: { image: MACHINE_TYPES.UBUNTU_22, command: ['sleep', 'infinity'] } })).toEqual({ image: 'ubuntu:22.04', command: ['sleep', 'infinity'] });
        expect(p.container({})).toBeUndefined();
        expect(() => p.container({ image: 'busybox', env: { A: 'b' }, container: { image: 'busybox' } })).toThrow('scripted: pass "container" or "image", "env", not both');
    });

    it('a container\'s host must run the CUDA its image is asked for by, unless minCudaVersion says otherwise', () => {
        const p = new ScriptedProvider([]);
        expect(p.minCuda({ image: { os: 'ubuntu24', cuda: '12.8' } })).toBe('12.8');
        expect(p.minCuda({ image: { os: 'ubuntu24', cuda: '12.8' }, minCudaVersion: '13.0' })).toBe('13.0');
        expect(p.minCuda({ container: { image: { os: 'ubuntu22', cuda: CUDA_TYPES.CUDA_13_1 } } })).toBe('13.1');
        // A VM's OS image says nothing of the container it runs.
        expect(p.minCuda({ image: { os: 'ubuntu24', cuda: '12.8' }, container: { image: 'busybox' } })).toBeUndefined();
        for (const none of [{}, { image: MACHINE_TYPES.UBUNTU_24 }, { image: { os: MACHINE_TYPES.UBUNTU_24 } }, { image: 'nvidia/cuda:12.8.1-base-ubuntu24.04' }]) expect(p.minCuda(none)).toBeUndefined();
    });

    it('a VM runs a container whose image is named by the library\'s enums as the registry reference it stands for', () => {
        const p = new ScriptedProvider([]);
        expect(p.userData({ container: { image: { os: 'ubuntu24', cuda: '12.8' } } }, true))
            .toBe(containerBootScript({ image: 'nvidia/cuda:12.8.2-base-ubuntu24.04', command: ['sleep', 'infinity'] }, { gpu: true }));
        expect(p.userData({ container: { image: MACHINE_TYPES.UBUNTU_24 } })).toContain("docker pull 'ubuntu:24.04'\n");
        expect(() => p.userData({ container: { image: { os: 'ubuntu20', cuda: '13.0' } } })).toThrow(expect.objectContaining({
            name: 'NotSupportedError', message: 'scripted: container: image "ubuntu20" with cuda "13.0" (NVIDIA publishes no CUDA 13.0 image of Ubuntu 20.04: it has 22.04, 24.04) is not supported',
        }));
        expect(() => p.userData({ container: { image: { os: 'ubuntu26' } as never } })).toThrow(expect.objectContaining({ name: 'ProviderError', message: expect.stringMatching(/^scripted: container: bad image os "ubuntu26"/) }));
        expect(() => p.userData({ container: { image: 'busybox', ports: ['80:8080'] } })).toThrow('scripted: container: bad port "80:8080": use <port>/<tcp|udp|http>, the port from 1 to 65535');
        expect(() => p.userData({ container: { image: '' } })).toThrow('scripted: a container needs an image');
        expect(p.userData({})).toBeUndefined();
    });

    describe('what a stop, a start and a restart wait on', () => {
        const fast = { intervalMs: 0, timeoutMs: 1000 };
        const once = { intervalMs: 0, timeoutMs: 0 };

        it('a stop: until the server is stopped; one that is gone, errors or is deleted instead did not stop', async () => {
            const p = new ScriptedProvider([{ status: 'running' }, { status: 'stopping' }, { status: 'stopped', providerStatus: 'off' }]);
            expect(await p.stopped(fast)).toMatchObject({ id: 's1', status: 'stopped', providerStatus: 'off' });
            expect(p.reads).toBe(3);
            await expect(new ScriptedProvider([{ status: 'stopping' }, null]).stopped(fast))
                .rejects.toMatchObject({ name: 'NotFoundError', message: 'scripted: server s1 disappeared while it was stopping' });
            for (const status of ['error', 'terminating', 'terminated'] as const) {
                await expect(new ScriptedProvider([{ status }]).stopped(fast)).rejects.toMatchObject({ name: 'ProviderError', message: `scripted: server s1 is ${status} (x): it did not stop` });
            }
            // Anything else is not stopped yet: read until the wait runs out, which says what it read last.
            for (const status of ['running', 'pending', 'stopping', 'unknown'] as const) {
                await expect(new ScriptedProvider([{ status }]).stopped(once)).rejects.toMatchObject({ code: 'timeout', message: `scripted: timed out after 0 s waiting for server s1: ${status} (x)` });
            }
        });

        it('a start: until the server runs, with a public address or without (waitUntilRunning waits for a VM\'s); one that errors or disappears did not start', async () => {
            const p = new ScriptedProvider([{ status: 'stopped' }, { status: 'pending' }, { status: 'running' }]);
            const up = await p.started(fast);
            expect([up.status, up.ip, p.reads]).toEqual(['running', undefined, 3]);
            // The same server, to waitUntilRunning: a VM, still without its address.
            await expect(new ScriptedProvider([{ status: 'running' }]).waitUntilRunning('s1', once)).rejects.toMatchObject({ code: 'timeout' });
            await expect(new ScriptedProvider([{ status: 'error' }]).started(fast)).rejects.toThrow('scripted: server s1 is error (x)');
            // Gone is not found, to a start as to a stop and a restart.
            await expect(new ScriptedProvider([null]).started(fast)).rejects.toMatchObject({ name: 'NotFoundError', message: 'scripted: server s1 disappeared before it was running' });
            await expect(new ScriptedProvider([null]).waitUntilRunning('s1', fast)).rejects.toMatchObject({ name: 'NotFoundError', message: 'scripted: server s1 disappeared before it was running' });
            await expect(new ScriptedProvider([{ status: 'stopped' }]).started(once)).rejects.toMatchObject({ code: 'timeout', message: 'scripted: timed out after 0 s waiting for server s1: stopped (x)' });
        });

        it('a restart: until the server runs again after it was seen not to; the status of before the reboot, read first, is not its end', async () => {
            // Still reported as it was (running) for two reads, then down, then up.
            const p = new ScriptedProvider([{ status: 'running' }, { status: 'running' }, { status: 'pending' }, { status: 'stopping' }, { status: 'unknown' }, { status: 'running', providerStatus: 'up' }]);
            expect(await p.restarted(fast)).toMatchObject({ status: 'running', providerStatus: 'up' });
            expect(p.reads).toBe(6);
            // Seen down at once, it is back the first time it runs.
            const quick = new ScriptedProvider([{ status: 'pending' }, { status: 'running' }]);
            await quick.restarted(fast);
            expect(quick.reads).toBe(2);
        });

        it('a restart of a server whose status shows no reboot is over once it has read as running four times: the time a platform is given to show one', async () => {
            expect(BaseProvider.RESTART_SETTLE_READS).toBe(4);
            const slept: number[] = [];
            const steady = new ScriptedProvider([{ status: 'running' }], async (ms) => { slept.push(ms); });
            await steady.restarted();
            expect(steady.reads).toBe(4);
            // At the default pace, thirty seconds.
            expect(slept).toEqual([10_000, 10_000, 10_000]);
        });

        it('the reboot is given thirty seconds to show at whatever pace the server is read: read every second that is thirty-one reads, not four (three seconds, before a reboot has begun)', async () => {
            expect(BaseProvider.RESTART_SETTLE_MS).toBe(30_000);
            // The reads in a row as running that span thirty seconds, and four at least.
            expect([10_000, 5000, 1000, 250, 7000, 30_000, 60_000, 0].map((intervalMs) => BaseProvider.settleReads(intervalMs))).toEqual([4, 7, 31, 121, 6, 4, 4, 4]);
            for (const [intervalMs, reads] of [[1000, 31], [5000, 7], [250, 121], [20_000, 4]] as const) {
                const slept: number[] = [];
                const steady = new ScriptedProvider([{ status: 'running' }], async (ms) => { slept.push(ms); });
                await steady.restarted({ intervalMs });
                expect([intervalMs, steady.reads, slept.length, slept.every((ms) => ms === intervalMs)]).toEqual([intervalMs, reads, reads - 1, true]);
                // Thirty seconds or more went by before it was taken to be back, never less.
                expect(slept.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(30_000);
            }
            // A reboot the status does show ends the wait as soon as the server is back, at any pace.
            const shown = new ScriptedProvider([{ status: 'running' }, { status: 'pending' }, { status: 'running' }]);
            await shown.restarted({ intervalMs: 1000 });
            expect(shown.reads).toBe(3);
        });

        it('a restart whose server is gone, errors, stops or is deleted instead did not restart, and says so at once; a status the platform shows of a reboot is waited through', async () => {
            await expect(new ScriptedProvider([{ status: 'pending' }, null]).restarted(fast))
                .rejects.toMatchObject({ name: 'NotFoundError', message: 'scripted: server s1 disappeared while it was restarting' });
            for (const status of ['error', 'stopped', 'terminating', 'terminated'] as const) {
                const p = new ScriptedProvider([{ status: 'running' }, { status }]);
                await expect(p.restarted(fast)).rejects.toMatchObject({ name: 'ProviderError', message: `scripted: server s1 is ${status} (x): it did not restart` });
                expect(p.reads).toBe(2);
            }
            // A platform whose rebooting server reads as an error, or as stopped, says which: that one is no failure, the others still are.
            const unhealthy = new ScriptedProvider([{ status: 'error' }, { status: 'error' }, { status: 'running' }]);
            expect((await unhealthy.restarted(fast, ['error'])).status).toBe('running');
            expect(unhealthy.reads).toBe(3);
            await expect(new ScriptedProvider([{ status: 'stopped' }]).restarted(fast, ['error'])).rejects.toThrow('scripted: server s1 is stopped (x): it did not restart');
            const stopStart = new ScriptedProvider([{ status: 'stopped' }, { status: 'pending' }, { status: 'running' }]);
            expect((await stopStart.restarted(fast, ['stopped'])).status).toBe('running');
            await expect(new ScriptedProvider([{ status: 'error' }]).restarted(fast, ['stopped'])).rejects.toThrow('scripted: server s1 is error (x): it did not restart');
            // One that never comes back is the timeout, which says what it read last.
            await expect(new ScriptedProvider([{ status: 'error' }]).restarted(once, ['error'])).rejects.toMatchObject({ code: 'timeout', message: 'scripted: timed out after 0 s waiting for server s1: error (x)' });
            await expect(new ScriptedProvider([{ status: 'pending' }]).restarted(once)).rejects.toMatchObject({ code: 'timeout', message: 'scripted: timed out after 0 s waiting for server s1: pending (x)' });
        });

        it('the refusal of a restart of a server that does not run says what it is, and what to do', () => {
            const e = new ScriptedProvider([]).refusal('stopped');
            expect(e).toMatchObject({ name: 'ProviderError', provider: 'scripted', code: 'not_running', message: 'scripted: server s1 is stopped: only a server that runs is restarted (start it)' });
        });

        it('a stop and a start need no options: a server that is there already is read once, and a stop waits ten minutes, read every five seconds', async () => {
            const [off, on] = [new ScriptedProvider([{ status: 'stopped' }]), new ScriptedProvider([{ status: 'running', ip: '203.0.113.7' }])];
            expect([(await off.stopped()).status, (await on.started()).status]).toEqual(['stopped', 'running']);
            expect([off.reads, on.reads]).toEqual([1, 1]);
            const slept: number[] = [];
            const never = new ScriptedProvider([{ status: 'running' }], async (ms) => { slept.push(ms); });
            await expect(never.stopped()).rejects.toMatchObject({ code: 'timeout', message: 'scripted: timed out after 600 s waiting for server s1: running (x)' });
            expect(slept).toEqual(Array(120).fill(5000));
            // An option given as undefined is the default, not a wait without end.
            slept.length = 0;
            await expect(new ScriptedProvider([{ status: 'running' }], async (ms) => { slept.push(ms); }).stopped({ timeoutMs: undefined, intervalMs: undefined }))
                .rejects.toMatchObject({ code: 'timeout', message: 'scripted: timed out after 600 s waiting for server s1: running (x)' });
            expect(slept).toEqual(Array(120).fill(5000));
            await expect(new ScriptedProvider([{ status: 'running' }]).stopped({ timeoutMs: NaN })).rejects.toThrow('asap-vps: bad timeoutMs NaN: use a number of milliseconds, 0 or more');
        });

        it('each waits as long as it is told, and as often', async () => {
            for (const wait of ['stopped', 'started', 'restarted'] as const) {
                const slept: number[] = [];
                const p = new ScriptedProvider([{ status: 'pending' }, { status: 'pending' }, { status: wait === 'stopped' ? 'stopped' : 'running' }], async (ms) => { slept.push(ms); });
                await p[wait]({ intervalMs: 7, timeoutMs: 60_000 });
                expect(slept).toEqual([7, 7]);
            }
        });
    });

    it('a provider with no names for the library\'s enums refuses every member of them', async () => {
        class Unmapped extends ScriptedProvider {
            protected readonly enums: EnumTranslations = {};
        }
        const p = new Unmapped([]);
        await expect(p.createServer({ name: 'n', offer: 'o', image: MACHINE_TYPES.UBUNTU_24 }))
            .rejects.toMatchObject({ name: 'NotSupportedError', message: `scripted: image "${MACHINE_TYPES.UBUNTU_24}" (MACHINE_TYPES has no scripted image by that name) is not supported` });
        await expect(p.createServer({ name: 'n', offer: 'o', region: REGION_TYPES.FRANCE_PARIS }))
            .rejects.toMatchObject({ name: 'NotSupportedError', message: `scripted: region "${REGION_TYPES.FRANCE_PARIS}" (REGION_TYPES has no scripted region by that name) is not supported` });
    });

    it('a GPU count may be given only as the offer\'s own: an offer id whose count is unknown, or another count, is refused', () => {
        const p = new ScriptedProvider([]);
        expect(() => p.fixedGpus({ name: 'n', offer: 'o', gpuCount: 2 }, undefined))
            .toThrow(new NotSupportedError('scripted', 'createServer option "gpuCount" with an offer id (pass the offer itself, whose GPU count is fixed)'));
        expect(() => p.fixedGpus({ name: 'n', offer: 'o', gpuCount: 2 }, 1))
            .toThrow(new NotSupportedError('scripted', 'createServer option "gpuCount" 2: this offer has 1 GPU(s); pick an offer with 2'));
        expect(() => p.fixedGpus({ name: 'n', offer: 'o', gpuCount: 2 }, 2)).not.toThrow();
        expect(() => p.fixedGpus({ name: 'n', offer: 'o' }, undefined)).not.toThrow();
    });

    it('reads mounts: each volume\'s id, the volume when one was passed, and its path; a mount without a volume is refused', () => {
        const p = new ScriptedProvider([]);
        const volume: Volume = { provider: 'scripted', id: 'v2', name: 'data', region: 'par-1', shared: false, status: 'available', providerStatus: 'available', raw: {} };
        expect(p.mounts([{ volume: 'v1' }, { volume, path: '/data' } as VolumeMount])).toEqual([{ id: 'v1' }, { id: 'v2', volume, path: '/data' }]);
        expect(() => p.mounts([{ volume: '' }])).toThrow(new ProviderError('scripted', 'a mount needs a volume (a volume from listVolumes or createVolume, or its id)'));
    });

    it('says what it can do: supports() narrows to a declared capability, requireCapability() names one it lacks', () => {
        const p = new ScriptedProvider([]);
        expect(supports(p, 'compute')).toBe(true);
        expect(p.supports('compute')).toBe(true);
        expect(supports(p, 'power')).toBe(false);
        expect(p.supports('sshKeys')).toBe(false);
        expect(requireCapability(p, 'compute')).toBe(p);
        expect(() => requireCapability(p, 'power')).toThrow(/scripted: the "power" capability \(stopServer, startServer\) is not supported/);
        expect(() => requireCapability(p, 'power')).toThrow(NotSupportedError);
    });

    it('sends its key only to its own API', () => {
        expect(() => new ScriptedProvider([]).callApi('https://elsewhere.example.com/x')).toThrow(/not an API path/);
    });
});
