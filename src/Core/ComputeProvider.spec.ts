// The compute base class's own behaviour, on a scripted provider: waits
// through transient failures, verified deletes, the library's enums in a
// platform's names, refusing what a provider cannot honor, what capabilities
// say, and sending the key only to the provider's own API.

import { CapabilityDescriptor, requireCapability, supports } from '../capabilities';
import { MACHINE_TYPES, REGION_TYPES } from '../constants';
import { NotSupportedError, ProviderError, TransportError } from '../errors';
import type { CreateServerOptions, Offer, Server, WaitOptions } from '../types';
import { ComputeProvider, EnumTranslations } from './ComputeProvider';
import { ApiClient } from './utils';

const SCRIPTED_CAPABILITIES = {
    compute: { kind: 'vm', gpu: true, cpu: false, userData: true, liveAvailability: true },
} as const satisfies CapabilityDescriptor;

/** A provider whose getServer answers from a script, for the base class's helpers. */
class ScriptedProvider extends ComputeProvider {
    readonly id = 'scripted';
    readonly capabilities = SCRIPTED_CAPABILITIES;
    protected readonly enums: EnumTranslations = { regions: { [REGION_TYPES.PARIS]: 'par-1' }, machines: { [MACHINE_TYPES.UBUNTU_24]: 'noble' } };
    deletes = 0;
    reads = 0;
    /** What the last create named, in the platform's names. */
    created?: { region?: string, image?: string };

    constructor(private readonly script: Array<Partial<Server> | null | Error>) {
        super(new ApiClient({ apiKey: 'k', sleep: async () => {} }, 'https://api.example.com', 'scripted'));
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

    private server(o: Partial<Server>): Server {
        return { provider: this.id, id: 's1', name: 'n', status: 'pending', providerStatus: 'x', raw: {}, ...o };
    }
}

describe('ComputeProvider', () => {
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
        await p.createServer({ name: 'n', offer: 'o', region: REGION_TYPES.PARIS, image: MACHINE_TYPES.UBUNTU_24 });
        expect(p.created).toEqual({ region: 'par-1', image: 'noble' });
        await p.createServer({ name: 'n', offer: 'o', region: 'par-9', image: 'my-image' });
        expect(p.created).toEqual({ region: 'par-9', image: 'my-image' });
        await expect(p.createServer({ name: 'n', offer: 'o', region: REGION_TYPES.NYC })).rejects.toThrow(NotSupportedError);
        await expect(p.createServer({ name: 'n', offer: 'o', image: MACHINE_TYPES.UBUNTU_20 })).rejects.toThrow(/MACHINE_TYPES has no scripted image/);
        // An offer's own region is the platform's already: never read as an enum.
        const offer: Offer = { provider: 'scripted', id: 'o', gpu: 'L4', vendor: 'nvidia', gpuCount: 1, vramGb: 24, pricePerHour: 1, regions: [REGION_TYPES.NYC], raw: {} };
        await p.createServer({ name: 'n', offer });
        expect(p.created?.region).toBe(REGION_TYPES.NYC);
        await expect(p.createServer({ name: 'n', offer: { ...offer, provider: 'other' } })).rejects.toThrow(/is other's, not scripted's/);
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
