// The compute capability's shared logic (ICompute), for every provider that
// rents servers, with or without GPUs: waiting, deleting until verified gone,
// cost, and reading a create's options the same way everywhere (the offer, its
// region, the library's region and OS enums in the platform's own names, and
// options the platform cannot honor). A provider extends this with its
// platform's types (PlatformTypes) and implements the five calls only its API
// can make: listOffers, createServer, getServer, listServers, deleteServer.

import type { CapabilityDescriptor, ComputeTraits, ICompute } from '../capabilities';
import { MACHINE_TYPES, REGION_TYPES } from '../constants';
import { CapacityError, isRetriable, NotFoundError, NotSupportedError, ProviderError } from '../errors';
import type {
    ContainerSpec, CostEstimate, CreateServerOptions, EndpointRequestInit, ImageChoice, ImageSpec, Offer, OfferQuery, PlatformTypes, PortProtocol, RefusableOption, RegistryAuth,
    ResolvedContainer, Server, ServerListOptions, ServerStatus, Volume, VolumeMount, WaitOptions,
} from '../types';
import { BaseProvider } from './BaseProvider';
import {
    ApiClient, cloudInitParts, containerBootScript, containerImageOf, estimateServerCost, imageSpecOf, NoSuchImageError, parsePort, resolveContainer, restartWatch, sshdBootScript,
    waitOf,
} from './utils';

/** What a createServer call rents, resolved from its `offer` (an offer object or an id). */
export type ResolvedOffer<TRaw = unknown> = {
    id: string,
    /** The offer object, when the caller passed one. */
    offer?: Offer<TRaw>,
    /** The caller's region (in the platform's own name), else the offer's first region with stock. */
    region?: string,
};

/** A mount of createServer's `mounts`, read: the volume's id, the volume itself when the caller passed it, and the path asked for. */
export type ResolvedMount<TRaw = unknown> = {
    id: string,
    volume?: Volume<TRaw>,
    path?: string,
};

/**
 * How the library's enums read on a platform: the REGION_TYPES and
 * MACHINE_TYPES members it has, by its own names. A member it does not map is
 * refused (NotSupportedError), never sent as it is.
 */
export type EnumTranslations = {
    regions?: Readonly<Partial<Record<REGION_TYPES, string>>>,
    /** Its plain OS image of each MACHINE_TYPES member. */
    machines?: Readonly<Partial<Record<MACHINE_TYPES, string>>>,
    /** Its GPU image of each (the one with the NVIDIA driver installed): what an image asked for with `cuda` boots. */
    cudaMachines?: Readonly<Partial<Record<MACHINE_TYPES, string>>>,
};

const REGION_MEMBERS = new Set<string>(Object.values(REGION_TYPES));

export abstract class ComputeProvider<T extends PlatformTypes = PlatformTypes, TApi extends ApiClient = ApiClient>
    extends BaseProvider<TApi> implements ICompute<T> {
    abstract readonly capabilities: CapabilityDescriptor & { readonly compute: Readonly<ComputeTraits> };
    /** The platform's names for the library's enums (CreateServerOptions.region and .image). */
    protected readonly enums: EnumTranslations = {};
    /**
     * How long a platform's status is given to show the reboot it was asked
     * for: a server never seen other than running that long is taken to be
     * back (restartWatch).
     */
    static readonly RESTART_SETTLE_MS = 30_000;
    /** The fewest reads in a row as running that take a restart for done, however far apart they are. */
    static readonly RESTART_SETTLE_READS = 4;

    /**
     * The reads in a row as running, `intervalMs` apart, that a restart takes
     * for done: as many as span RESTART_SETTLE_MS, and RESTART_SETTLE_READS at
     * least. A time, not a count: read every second, a count of four would be
     * three seconds, less than a reboot takes to begin.
     */
    static settleReads(intervalMs: number): number {
        return Math.max(ComputeProvider.RESTART_SETTLE_READS, intervalMs > 0 ? Math.ceil(ComputeProvider.RESTART_SETTLE_MS / intervalMs) + 1 : 0);
    }

    public abstract listOffers(query?: OfferQuery): Promise<Offer<T['offer']>[]>;
    public abstract createServer(options: CreateServerOptions<T>): Promise<Server<T['server']>>;
    public abstract getServer(id: string): Promise<Server<T['server']> | null>;
    public abstract listServers(options?: ServerListOptions): Promise<Server<T['server']>[]>;
    public abstract deleteServer(id: string, o?: WaitOptions): Promise<void>;

    /**
     * Poll getServer until `done` accepts what it read (a server, or null once
     * it is gone). A failed read that may be transient is polled through.
     */
    public async waitForServer(id: string, done: (s: Server<T['server']> | null) => boolean, o: WaitOptions = {}): Promise<Server<T['server']> | null> {
        return this.poll(() => this.getServer(id), done, {
            ...o,
            what: `server ${id}`,
            describe: (s) => (s ? `${s.status} (${s.providerStatus})` : 'gone'),
        });
    }

    /**
     * Until the server is running and says where it is reached: a VM its
     * public address, and a server whose platform names them only after it
     * reads as running (`comingUp`) its SSH endpoint and its ports. So the
     * server this returns is one RemoteMachine.connect can take.
     * Throws when it errors, or disappears (NotFoundError) instead.
     */
    public async waitUntilRunning(id: string, o: WaitOptions & { requireIp?: boolean } = {}): Promise<Server<T['server']>> {
        const requireIp = o.requireIp ?? this.capabilities.compute.kind === 'vm';
        const s = await this.poll(() => this.getServer(id), (x) => !x || ['error', 'terminating', 'terminated'].includes(x.status)
            || (x.status === 'running' && (!requireIp || !!x.ip) && !this.comingUp(x)), {
            ...o,
            what: `server ${id}`,
            // A wait that runs out on a server that runs says what it was still waiting for.
            describe: (x) => (x ? `${x.status} (${x.providerStatus})${x.status === 'running' && this.comingUp(x) ? ', which has not said where it is reached yet (its SSH endpoint, its ports)' : ''}` : 'gone'),
        });
        if (!s) throw new NotFoundError(this.id, `server ${id} disappeared before it was running`);
        if (s.status !== 'running') throw new ProviderError(this.id, `server ${id} is ${s.status} (${s.providerStatus})`);
        return s;
    }

    /**
     * Whether a server that reads as running has still to say where it is
     * reached: its `ssh` endpoint, the public ports of the ports it exposes.
     * False wherever those are known as soon as the server runs; a platform
     * that names them later (it maps a container's ports only after the
     * container reads as running) says so here, and waitUntilRunning waits.
     */
    protected comingUp(_server: Server<T['server']>): boolean {
        return false;
    }

    /**
     * What a stop waits on: until the server is stopped, for ten minutes, read
     * every five seconds, unless `o` says. Throws when it is gone
     * (NotFoundError), or errors or is deleted instead of stopping.
     */
    protected async waitUntilStopped(id: string, o: WaitOptions = {}): Promise<Server<T['server']>> {
        const s = await this.waitForServer(id, (x) => !x || ['stopped', 'error', 'terminating', 'terminated'].includes(x.status),
            waitOf(o, { timeoutMs: 10 * 60_000, intervalMs: 5000 }));
        if (!s) throw new NotFoundError(this.id, `server ${id} disappeared while it was stopping`);
        if (s.status !== 'stopped') throw new ProviderError(this.id, `server ${id} is ${s.status} (${s.providerStatus}): it did not stop`);
        return s;
    }

    /**
     * What a restart waits on: until the server is running again, having been
     * seen not to be, or, where its status never shows the reboot, having read
     * as running for RESTART_SETTLE_MS (settleReads, restartWatch). One that is gone
     * (NotFoundError), errors, stops or is deleted instead did not restart,
     * and is thrown at once, but for a status in `passing`: one the platform
     * shows of a server that is rebooting (a Lambda instance reads as
     * unhealthy, a RunPod pod as stopped), which is waited through.
     */
    protected async waitUntilRestarted(id: string, o: WaitOptions = {}, passing: readonly ServerStatus[] = []): Promise<Server<T['server']>> {
        const back = restartWatch(ComputeProvider.settleReads(waitOf(o, { intervalMs: BaseProvider.POLL_INTERVAL_MS }).intervalMs));
        const failed = (['error', 'stopped', 'terminating', 'terminated'] as const).filter((x) => !passing.includes(x));
        const s = await this.waitForServer(id, (x) => !x || (failed as readonly ServerStatus[]).includes(x.status) || back(x.status === 'running'), o);
        if (!s) throw new NotFoundError(this.id, `server ${id} disappeared while it was restarting`);
        if (s.status !== 'running') throw new ProviderError(this.id, `server ${id} is ${s.status} (${s.providerStatus}): it did not restart`);
        return s;
    }

    /** The refusal of a restart of a server that does not run: the same on every provider that reads it first. */
    protected notRunning(id: string, status: ServerStatus): ProviderError {
        return new ProviderError(this.id, `server ${id} is ${status}: only a server that runs is restarted (start it)`, { code: 'not_running' });
    }

    /**
     * Delete, and keep asking (and deleting again) until the provider says it is
     * gone. true only when verified; false when the deletes were accepted but the
     * server is still there at the timeout. When the provider kept refusing the
     * delete, the timeout throws, its last refusal as the cause. A server that is
     * gone after a delete that failed for good (not isRetriable: what it deletes
     * with the server, such as Scaleway's volumes, is left) throws that failure.
     * `o.timeoutMs` bounds the whole of it, the provider's own waits included.
     */
    public async deleteServerAndWait(id: string, o: WaitOptions = {}): Promise<boolean> {
        const { timeoutMs, intervalMs } = waitOf(o, { timeoutMs: 5 * 60_000, intervalMs: 5000 });
        const end = Date.now() + timeoutMs;
        let refused: unknown;
        for (;;) {
            try {
                // The time left is the delete's too: a provider whose delete waits waits no longer.
                await this.deleteServer(id, { timeoutMs: Math.max(0, end - Date.now()), ...(o.intervalMs !== undefined ? { intervalMs: o.intervalMs } : {}) });
                refused = undefined;
            } catch (e) {
                // Only the read below may say gone: a failed delete is retried, and remembered.
                refused = e;
            }
            let gone = false;
            try {
                const s = await this.getServer(id);
                gone = !s || s.status === 'terminated';
            } catch (e) {
                if (!isRetriable(e)) throw e;
            }
            if (gone) {
                // Gone, but the delete failed for good at what it does besides (the volumes Scaleway deletes with
                // the server): not a verified delete. A failure that may be transient is one the server outlived.
                if (refused !== undefined && !isRetriable(refused)) throw refused;
                return true;
            }
            if (Date.now() >= end) {
                if (refused === undefined) return false;
                throw new ProviderError(this.id, `server ${id} is not deleted after ${Math.round(timeoutMs / 1000)} s: the delete kept failing (${(refused as Error).message})`,
                    { code: 'timeout', cause: refused });
            }
            await this.sleep(intervalMs);
        }
    }

    /**
     * What the server has cost so far in its current run, from the rate and the
     * start its provider reports (Core/utils/cost.ts): an estimate, as disks,
     * bandwidth and addresses bill on top. null when the server is gone, or its
     * provider reports no rate or start for it (a stopped server that bills only
     * its disk has no current run).
     */
    public async getServerCost(id: string, at = Date.now()): Promise<CostEstimate | null> {
        const s = await this.getServer(id);
        return s ? estimateServerCost(s, at) : null;
    }

    /**
     * The offer a create names: its id, the offer object when one was passed
     * (which must be this provider's), and the region: the caller's (a
     * REGION_TYPES member in the platform's name), else the offer's first with stock.
     */
    protected resolveOffer(o: CreateServerOptions<T>): ResolvedOffer<T['offer']> {
        const asked = o.region !== undefined ? this.regionName(o.region) : undefined;
        if (typeof o.offer === 'string') {
            if (!o.offer) throw new ProviderError(this.id, 'createServer needs an offer (an offer from listOffers, or its id)');
            return { id: o.offer, ...(asked ? { region: asked } : {}) };
        }
        if (!o.offer?.id) throw new ProviderError(this.id, 'createServer needs an offer (an offer from listOffers, or its id)');
        if (o.offer.provider !== this.id) throw new ProviderError(this.id, `offer ${o.offer.id} is ${o.offer.provider}'s, not ${this.id}'s`);
        // An offer with stock nowhere (listOffers({ includeUnavailable: true }) lists them) and no region asked for is no capacity, on every provider.
        if (asked === undefined && !o.offer.regions.length) {
            throw new CapacityError(this.id, `offer ${o.offer.id} has no stock anywhere right now: pick an offer with regions, or ask for a region`);
        }
        const region = asked ?? o.offer.regions[0];
        return { id: o.offer.id, offer: o.offer, ...(region ? { region } : {}) };
    }

    /** A region as the platform names it: a REGION_TYPES member it maps, or the caller's own name. */
    protected regionName(region: string): string {
        if (!REGION_MEMBERS.has(region)) return region;
        const mapped = this.enums.regions?.[region as REGION_TYPES];
        if (!mapped) throw new NotSupportedError(this.id, `region "${region}" (REGION_TYPES has no ${this.id} region by that name)`);
        return mapped;
    }

    /**
     * A VM's image as the platform names it: the caller's own name for one, as
     * it is; a MACHINE_TYPES member (or `{ os }`), the platform's image of that
     * Ubuntu; `{ os, cuda }`, its GPU image of it (`cudaMachines`: the
     * platform's, or the caller's where it depends on what is rented).
     * undefined stays undefined.
     */
    protected imageName(image: ImageChoice | undefined, cudaMachines: EnumTranslations['cudaMachines'] = this.enums.cudaMachines): string | undefined {
        const spec = this.imageSpec(image);
        if (!spec) return image as string | undefined;
        const mapped = (spec.cuda === undefined ? this.enums.machines : cudaMachines)?.[spec.os as MACHINE_TYPES];
        if (!mapped) {
            throw new NotSupportedError(this.id, spec.cuda === undefined
                ? `image "${spec.os}" (MACHINE_TYPES has no ${this.id} image by that name)`
                : `image "${spec.os}" with cuda (${this.id} has no GPU image of that Ubuntu)`);
        }
        return mapped;
    }

    /**
     * A container's image as a registry reference: the caller's own, as it is;
     * a MACHINE_TYPES member or `{ os, cuda }`, the image Docker Hub has for it
     * (`ubuntu`, `nvidia/cuda`), the same on every platform. undefined stays
     * undefined. A combination no image exists for is refused as a VM's is
     * (NotSupportedError).
     */
    protected containerImageName(image: ImageChoice | undefined): string | undefined {
        const spec = this.imageSpec(image);
        return spec ? this.checked(() => containerImageOf(spec)) : image as string | undefined;
    }

    /**
     * The CUDA version a container's host must run: `minCudaVersion`, else the
     * version its image is asked for by (`{ os, cuda }`: NVIDIA's CUDA image
     * does not start on an older driver). undefined when neither says.
     */
    protected minCudaOf(o: { minCudaVersion?: string, image?: ImageChoice, container?: ContainerSpec }): string | undefined {
        return o.minCudaVersion ?? this.imageSpec(o.container ? o.container.image : o.image)?.cuda;
    }

    /**
     * An image named by the library's enums, as a spec (imageSpecOf), for a
     * provider to check against what is rented; undefined for a name of the
     * platform's own, and for none. One that names what the enums do not have
     * is refused.
     */
    protected imageSpec(image: ImageChoice | undefined): ImageSpec | undefined {
        return this.checked(() => imageSpecOf(image));
    }

    /**
     * What `read` makes of a caller's option (an image named by the library's
     * enums, a port, a container), its errors as this provider's: an image no
     * such combination exists of is not supported (NotSupportedError, as an
     * option the platform cannot honor is); anything not well formed is a
     * ProviderError, `what` saying whose it is.
     */
    private checked<R>(read: () => R, what = ''): R {
        try {
            return read();
        } catch (e) {
            if (e instanceof NoSuchImageError) throw new NotSupportedError(this.id, `${what}image ${e.message}`);
            throw new ProviderError(this.id, `${what}${(e as Error).message}`);
        }
    }

    /**
     * For a provider whose offers each have a fixed GPU count: `gpuCount` may be
     * given only when it equals that count (`known`: the offer object's, or read
     * from its id). Anything else is refused rather than rented as something else.
     */
    protected checkFixedGpuCount(o: CreateServerOptions<T>, known: number | undefined): void {
        if (o.gpuCount === undefined || o.gpuCount === known) return;
        throw new NotSupportedError(this.id, known === undefined
            ? `createServer option "gpuCount" with an offer id (pass the offer itself, whose GPU count is fixed)`
            : `createServer option "gpuCount" ${o.gpuCount}: this offer has ${known} GPU(s); pick an offer with ${o.gpuCount}`);
    }

    /**
     * A provider refuses what it cannot honor, rather than dropping it silently:
     * the options its PlatformTypes.refused names, which its CreateServerOptions
     * leave out, and which code typed for any provider can still pass.
     */
    protected rejectOptions(o: object, keys: readonly RefusableOption[]): void {
        for (const k of keys) {
            const v = (o as Partial<Record<RefusableOption, unknown>>)[k];
            const empty = v === undefined || (Array.isArray(v) && v.length === 0)
                || (typeof v === 'object' && v !== null && !Array.isArray(v) && Object.keys(v).length === 0);
            if (!empty) throw new NotSupportedError(this.id, `createServer option "${String(k)}"`);
        }
    }

    /**
     * The start of a container that `publicKeys` are to log in to, on a
     * platform that gives a container no SSH server: the shell its start runs
     * first (sshdBootScript: an SSH server taking them as root's), then
     * `script` where the caller has one, then the container's own command,
     * which it becomes (`sh -c '<this>' asap-vps <command...>`). The command
     * must be known to be handed over to: a container named by the library's
     * enums has one (it is kept up), an image of the caller's own is given one,
     * or the keys are refused: its own start cannot be read from here, and
     * would be replaced by nothing.
     */
    protected sshStart(c: ResolvedContainer, publicKeys: readonly string[], script?: string): string {
        this.sshCommand(c);
        return `${this.checked(() => sshdBootScript(publicKeys))}${script ? `${script}\n` : ''}exec "$@"`;
    }

    /**
     * The command a container that is to be logged in to hands over to, once
     * its SSH server is started; one that has none is refused (sshStart says
     * why), which a provider asks before it reads anything of the account.
     */
    protected sshCommand(c: ResolvedContainer): string[] {
        if (c.command?.length) return c.command;
        throw new NotSupportedError(this.id, 'createServer option "sshKeyIds" without "command" on an image of your own (the SSH server is started before the command, which replaces the image\'s own start: say what it runs)');
    }

    /** `ports` as each is read (parsePort): its number and protocol, the same on every provider; one that is not a port is refused. */
    protected portsOf(ports: readonly string[] | undefined): Array<{ port: number, protocol: PortProtocol }> {
        return (ports ?? []).map((p) => this.checked(() => parsePort(p)));
    }

    /**
     * A container platform's container: `container`, or the top-level `image`,
     * `env`, `command`, `ports` and `registryAuth` it stands for, never both
     * (refused); undefined when neither names an image. It is as it runs
     * (resolveContainer): its image a registry reference, and one named by the
     * library's enums kept up when it is given no command.
     */
    protected containerOf(o: {
        image?: ImageChoice, env?: Record<string, string>, command?: string[], ports?: string[], registryAuth?: RegistryAuth, container?: ContainerSpec,
    }): ResolvedContainer | undefined {
        const both = o.container ? (['image', 'env', 'command', 'ports', 'registryAuth'] as const).filter((k) => o[k] !== undefined) : [];
        if (both.length) throw new ProviderError(this.id, `pass "container" or ${both.map((k) => `"${k}"`).join(', ')}, not both`);
        const c: ContainerSpec | undefined = o.container ?? (o.image === undefined ? undefined
            : { image: o.image, ...(o.env ? { env: o.env } : {}), ...(o.command ? { command: o.command } : {}), ...(o.ports ? { ports: o.ports } : {}), ...(o.registryAuth ? { registryAuth: o.registryAuth } : {}) });
        return c && this.checked(() => resolveContainer(c));
    }

    /**
     * A VM's user data: the caller's, the platform's own scripts (`own`: its
     * volumes' mounts), and, for a `container`, the first-boot script that
     * runs it with Docker (containerBootScript), its GPUs passed through where
     * it has any, in that order, as one cloud-init document.
     */
    protected userDataWith(o: { userData?: string, container?: ContainerSpec }, gpu: boolean, own: string[] = []): string | undefined {
        const c = o.container;
        if (c && !c.image) throw new ProviderError(this.id, 'a container needs an image');
        return cloudInitParts([o.userData, ...own, c ? this.checked(() => containerBootScript(c, { gpu }), 'container: ') : undefined]);
    }

    /**
     * A request to a serverless endpoint's `url`, with `auth`'s headers on top
     * of the caller's, sent again while the endpoint answers that it is cold
     * (`cold` says so of an answer: no worker up yet), or cannot be reached
     * yet (a fresh endpoint's host name resolves a while after it is deployed:
     * seen live), until `timeoutMs` (default 5 min), `intervalMs` apart
     * (default 5 s). A body that is a stream is sent once. The answer as it
     * comes, the last one (or the network's error) when the wait runs out.
     */
    protected async requestWarm(url: string, init: EndpointRequestInit, auth: Record<string, string>, cold: (r: Response) => Promise<boolean>): Promise<Response> {
        const { timeoutMs = 5 * 60_000, intervalMs = 5000, ...req } = init;
        const headers = { ...Object.fromEntries(new Headers(req.headers).entries()), ...auth };
        const send = this.api.fetchImpl ?? fetch;
        const once = req.body instanceof ReadableStream;
        const end = Date.now() + timeoutMs;
        for (;;) {
            let r: Response;
            try {
                // A redirect is answered, never followed: fetch would send the auth on to wherever it points
                // (it strips only Authorization and cookies across origins, not a key in a header of the platform's own).
                r = await send(url, { ...req, headers, redirect: 'manual' });
            } catch (e) {
                if (once || Date.now() >= end) throw e;
                await this.api.sleep(intervalMs);
                continue;
            }
            if (once || Date.now() >= end || !(await cold(r))) return r;
            await r.body?.cancel().catch(() => undefined);
            await this.api.sleep(intervalMs);
        }
    }

    /**
     * createServer's `mounts`, read: each volume's id (a volume object must be
     * this provider's), the path asked for, and the same volume twice refused.
     * Where it is and whether it is free are the platform's to check.
     */
    protected mountsOf(mounts: ReadonlyArray<VolumeMount<any>> | undefined): Array<ResolvedMount<T['volume']>> {
        const out: Array<ResolvedMount<T['volume']>> = [];
        for (const m of mounts ?? []) {
            const v = m.volume;
            if (typeof v !== 'string' && v?.provider !== this.id) throw new ProviderError(this.id, `volume ${v?.id} is ${v?.provider}'s, not ${this.id}'s`);
            const id = typeof v === 'string' ? v : v.id;
            if (!id) throw new ProviderError(this.id, 'a mount needs a volume (a volume from listVolumes or createVolume, or its id)');
            if (out.some((x) => x.id === id)) throw new ProviderError(this.id, `volume ${id} is mounted twice`);
            const path = (m as { path?: string }).path;
            out.push({ id, ...(typeof v === 'string' ? {} : { volume: v as Volume<T['volume']> }), ...(path !== undefined ? { path } : {}) });
        }
        return out;
    }
}
