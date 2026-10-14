// What each provider's types promise, held by the compiler: ts-jest type-checks
// this file, so a `@ts-expect-error` line whose error goes away (an option a
// platform cannot honor, back in its type) fails the suite, as does a line
// below that stops compiling. Each provider's createServer offers only the
// options it honors, createVolume asks for a size only where the platform
// sizes volumes, a mount takes a path only where the platform mounts at one,
// every record's `raw` is the platform's own, a query's shared values (its
// kinds, GPU vendors and GPU names) are the library's on every provider, and a
// `region` is offered each provider's pick of the library's places: all
// without a cast.

import type { DigitalOcean } from './DigitalOcean/DigitalOcean';
import type { DigitalOceanNfsShare, DigitalOceanRegionName, DigitalOceanTypes, DigitalOceanVolumeData } from './DigitalOcean/types';
import type { LambdaCloud } from './LambdaCloud/LambdaCloud';
import type { LambdaFilesystem, LambdaRegionName, LambdaTypes } from './LambdaCloud/types';
import type { AnyProvider } from './registry';
import type { RunPod } from './RunPod/RunPod';
import type { RunPodNetworkVolume, RunPodRegionName, RunPodTypes } from './RunPod/types';
import type { Scaleway } from './Scaleway/Scaleway';
import type { ScalewayBlockVolume, ScalewayCountry, ScalewayFileSystem, ScalewayRegion, ScalewayRegionName, ScalewayTypes, ScalewayZone } from './Scaleway/types';
import type { VastImage, VastRegionName, VastTypes, VastVolume } from './VastAI/types';
import type { DIGITALOCEAN_DATACENTERS } from './DigitalOcean/places';
import type { LAMBDA_REGIONS } from './LambdaCloud/places';
import type { RUNPOD_DATA_CENTERS } from './RunPod/places';
import type { VastAI } from './VastAI/VastAI';
import { supports } from '../capabilities';
import type { TypesOf } from '../capabilities';
import type { BaseProvider } from '../Core/BaseProvider';
import { COMPUTE_KINDS, COUNTRY_TYPES, CUDA_TYPES, MACHINE_TYPES, REGION_COUNTRIES, REGION_TYPES } from '../constants';
import type { GpuName } from '../Core/utils';
import type { ComputeKind, CreateServerOptions, ImageSpec, OfferQuery, PlatformTypes, RegionChoice, ServerImage, ServerListOptions, Volume } from '../types';

type ServerOptions<P extends { createServer(o: never): unknown }> = Parameters<P['createServer']>[0];
type VolumeOptions<P extends { createVolume(o: never): unknown }> = Parameters<P['createVolume']>[0];
/** Whether A and B are the same type (not just assignable either way). */
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
/** Whether a call that takes `Q` takes all the library's `Shared` does: what it takes besides is its own. */
type Takes<Q, Shared> = Shared extends NonNullable<Q> ? true : false;
/**
 * Whether a provider takes at least the library's query wherever it takes one:
 * listOffers, listServers, and listEndpointOffers where it has serverless. A
 * union is read provider by provider: one that takes less makes it `boolean`.
 */
type TakesSharedQueries<P> = P extends { listOffers(q?: infer Q): unknown, listServers(o?: infer S): unknown }
    ? [Takes<Q, OfferQuery>, Takes<S, ServerListOptions>, P extends { listEndpointOffers(q?: infer E): unknown } ? Takes<E, OfferQuery> : true] extends [true, true, true] ? true : false
    : false;
/** A member of one of the library's enums, or the string it stands for. */
type Named<E extends string> = E | `${E}`;
/** What an editor offers of a type that takes any string: its members that are names. */
type Offered<U> = U extends string ? (string extends U ? never : U) : never;
/**
 * Whether every region of the library's that a platform has is in a country it
 * says it has places in (REGION_COUNTRIES). A union is read platform by
 * platform: one whose region is elsewhere makes it `boolean`.
 */
/** The library's names, of regions a platform has not, that its own names would take: none, for every platform. */
type Leaks<T> = T extends PlatformTypes ? Extract<Named<Exclude<REGION_TYPES, T['region']>>, T['regionName']> : never;
type RegionsAreInItsCountries<T> = T extends PlatformTypes ? ([T['region']] extends [never] ? true : (typeof REGION_COUNTRIES)[T['region']] extends T['country'] ? true : false) : false;

/** Takes what the type takes: a literal that does not fit is a compile error here. */
const accepts = <T>(_: T): void => undefined;
const isTrue = <T extends true>(): void => undefined;

const base = { name: 'n', offer: 'o' };

describe('types: each provider offers what its platform honors', () => {
    it('createServer: a container takes a registry login and no cloud-init; a VM the reverse', () => {
        accepts<ServerOptions<RunPod>>({ ...base, image: 'ghcr.io/acme/app:1', registryAuth: { username: 'u', password: 'p' }, env: { A: 'b' }, ports: ['8888/http'] });
        accepts<ServerOptions<VastAI>>({ ...base, image: 'ghcr.io/acme/app:1', registryAuth: { username: 'u', password: 'p', server: 'ghcr.io' } });
        accepts<ServerOptions<DigitalOcean>>({ ...base, userData: '#cloud-config', tags: ['t'] });
        accepts<ServerOptions<Scaleway>>({ ...base, userData: '#cloud-config', diskGb: 40 });
        accepts<ServerOptions<LambdaCloud>>({ ...base, userData: '#cloud-config', sshKeyIds: ['k'] });

        // @ts-expect-error a pod has no cloud-init
        accepts<ServerOptions<RunPod>>({ ...base, userData: '#cloud-config' });
        // The keys that log in are named on every provider, a container platform's included.
        accepts<ServerOptions<VastAI>>({ ...base, image: 'ghcr.io/acme/app:1', command: ['serve'], sshKeyIds: ['k'] });
        accepts<ServerOptions<RunPod>>({ ...base, image: 'ghcr.io/acme/app:1', command: ['serve'], sshKeyIds: ['k'] });
        // @ts-expect-error a Vast instance has no tags
        accepts<ServerOptions<VastAI>>({ ...base, tags: ['t'] });
        // @ts-expect-error a droplet runs no container: no registry login
        accepts<ServerOptions<DigitalOcean>>({ ...base, registryAuth: { username: 'u', password: 'p' } });
        // @ts-expect-error Lambda's instance type fixes its disk
        accepts<ServerOptions<LambdaCloud>>({ ...base, diskGb: 100 });
        // @ts-expect-error a Scaleway Instance takes no container environment
        accepts<ServerOptions<Scaleway>>({ ...base, env: { A: 'b' } });
    });

    it('image: the library\'s names on every platform, as enum members or as their values; a version the enums do not have is not one', () => {
        const spec = { os: MACHINE_TYPES.UBUNTU_24, cuda: CUDA_TYPES.CUDA_12_8 };
        accepts<ServerOptions<RunPod>>({ ...base, image: spec });
        accepts<ServerOptions<VastAI>>({ ...base, image: MACHINE_TYPES.UBUNTU_24 });
        accepts<ServerOptions<DigitalOcean>>({ ...base, image: { os: 'ubuntu24', cuda: '12.8' } });
        accepts<ServerOptions<Scaleway>>({ ...base, image: { os: 'ubuntu22' }, container: { image: spec } });
        accepts<ServerOptions<LambdaCloud>>({ ...base, image: 'lambda-stack-24-04', container: { image: MACHINE_TYPES.UBUNTU_22 } });
        accepts<CreateServerOptions>({ ...base, image: spec });
        accepts<Parameters<RunPod['createEndpoint']>[0]>({ name: 'e', container: { image: spec } });

        // @ts-expect-error there is no CUDA 12.7
        accepts<ImageSpec>({ os: 'ubuntu24', cuda: '12.7' });
        // @ts-expect-error not an Ubuntu the library names
        accepts<ImageSpec>({ os: 'ubuntu26' });
        // @ts-expect-error a spec names its Ubuntu
        accepts<ImageSpec>({ cuda: '12.8' });
        // @ts-expect-error cuda is a version, not a flag
        accepts<ServerOptions<RunPod>>({ ...base, image: { os: 'ubuntu24', cuda: true } });
    });

    it('container: one shape on every platform, its login inside it; a VM runs it with Docker beside its own user data', () => {
        const container = { image: 'ghcr.io/acme/app:1', env: { A: 'b' }, command: ['serve'], ports: ['8000/tcp'], registryAuth: { username: 'u', password: 'p' } };
        accepts<ServerOptions<RunPod>>({ ...base, container });
        accepts<ServerOptions<VastAI>>({ ...base, container });
        accepts<ServerOptions<DigitalOcean>>({ ...base, container, userData: '#cloud-config' });
        accepts<ServerOptions<Scaleway>>({ ...base, container, image: 'ubuntu_noble' });
        accepts<ServerOptions<LambdaCloud>>({ ...base, container, sshKeyIds: ['k'] });

        // @ts-expect-error a container names its image
        accepts<ServerOptions<DigitalOcean>>({ ...base, container: { env: { A: 'b' } } });
        // @ts-expect-error an env value is a string
        accepts<ServerOptions<Scaleway>>({ ...base, container: { image: 'x', env: { A: 1 } } });
        // @ts-expect-error a command is its words, not one string
        accepts<ServerOptions<LambdaCloud>>({ ...base, container: { image: 'x', command: 'serve --port 8000' } });
    });

    it('createEndpoint: only where the platform has serverless, its own fields typed', () => {
        type Create<P> = P extends { createEndpoint(o: infer O): unknown } ? O : never;
        accepts<Create<RunPod>>({ name: 'e', container: { image: 'traefik/whoami' }, port: 80, offer: 'cpu3c:2', providerOptions: { flashboot: 'FLASHBOOT' } });
        // @ts-expect-error RunPod names its FlashBoot modes
        accepts<Create<RunPod>>({ name: 'e', container: { image: 'traefik/whoami' }, providerOptions: { flashboot: 'ON' } });
        // @ts-expect-error an endpoint serves one port: `port`, not the container's `ports`
        accepts<Create<RunPod>>({ name: 'e', container: { image: 'traefik/whoami', ports: ['80/http'] } });
        isTrue<Create<DigitalOcean> extends never ? true : false>();
        isTrue<Create<LambdaCloud> extends never ? true : false>();
        isTrue<Create<VastAI> extends never ? true : false>();
    });

    it('images: each platform\'s own record, Vast\'s a snapshot in a registry of yours', () => {
        isTrue<Equal<Awaited<ReturnType<VastAI['createImage']>>, ServerImage<VastImage, VastRegionName>>>();
        isTrue<Equal<Awaited<ReturnType<VastAI['listImages']>>, ServerImage<VastImage, VastRegionName>[]>>();
        // Where snapshots go is the provider's to know: a repository and a login that can push.
        type Params = ConstructorParameters<typeof VastAI>[0];
        accepts<Params>({ apiKey: 'k', snapshots: { server: 'ghcr.io', repository: 'acme/snaps', username: 'u', password: 'p' } });
        // @ts-expect-error the repository is part of where snapshots go
        accepts<Params>({ apiKey: 'k', snapshots: { server: 'ghcr.io', username: 'u', password: 'p' } });
    });

    it('importImage: only where the platform imports a file, its own fields typed', () => {
        type Import<P> = P extends { importImage(o: infer O): unknown } ? O : never;
        accepts<Import<DigitalOcean>>({ name: 'n', url: 'https://x/disk.qcow2', region: 'tor1', providerOptions: { distribution: 'Ubuntu' } });
        // @ts-expect-error DigitalOcean names its distributions
        accepts<Import<DigitalOcean>>({ name: 'n', url: 'https://x/disk.qcow2', region: 'tor1', providerOptions: { distribution: 'Ubuntoo' } });
        isTrue<Import<RunPod> extends never ? true : false>();
        isTrue<Import<LambdaCloud> extends never ? true : false>();
        isTrue<Import<VastAI> extends never ? true : false>();
    });

    it('mounts: where the platform has volumes; a path only where it mounts at one', () => {
        accepts<ServerOptions<RunPod>>({ ...base, mounts: [{ volume: 'vol_1', path: '/models' }] });
        accepts<ServerOptions<LambdaCloud>>({ ...base, mounts: [{ volume: 'fs-1', path: '/data/models' }] });
        accepts<ServerOptions<DigitalOcean>>({ ...base, mounts: [{ volume: 'uuid' }] });
        // A path for a shared volume (an NFS share); a Block Storage volume's is refused at run time.
        accepts<ServerOptions<DigitalOcean>>({ ...base, mounts: [{ volume: 'uuid', path: '/models' }] });
        accepts<ServerOptions<Scaleway>>({ ...base, mounts: [{ volume: 'fr-par-2/uuid' }] });

        // A path for a shared volume (a File Storage filesystem); a Block Storage disk's is refused at run time.
        accepts<ServerOptions<Scaleway>>({ ...base, mounts: [{ volume: 'fr-par/uuid', path: '/models' }] });
        // A volume of the offer's machine, at a path (default /data).
        accepts<ServerOptions<VastAI>>({ ...base, mounts: [{ volume: '54535314', path: '/models' }] });
        // @ts-expect-error a mount's path is a path
        accepts<ServerOptions<VastAI>>({ ...base, mounts: [{ volume: '54535314', path: 5 }] });
    });

    it('createVolume: a size where the platform sizes volumes, none where it grows as it fills', () => {
        accepts<VolumeOptions<RunPod>>({ name: 'v', region: 'US-TX-3', sizeGb: 50 });
        accepts<VolumeOptions<DigitalOcean>>({ name: 'v', region: 'tor1', sizeGb: 50, providerOptions: { filesystem_type: 'xfs' } });
        // Where a platform makes both kinds, `shared` picks, and the kind's own request fields come with it.
        accepts<VolumeOptions<DigitalOcean>>({ name: 'v', region: 'atl1', sizeGb: 50, shared: true, providerOptions: { performance_tier: 'standard' } });
        accepts<VolumeOptions<Scaleway>>({ name: 'v', region: 'fr-par', sizeGb: 25, shared: true, providerOptions: { tags: ['team-a'] } });
        // @ts-expect-error a filesystem's tags are strings
        accepts<VolumeOptions<Scaleway>>({ name: 'v', region: 'fr-par', sizeGb: 25, shared: true, providerOptions: { tags: [1] } });
        // @ts-expect-error an NFS share's tiers are 'standard' and 'high'
        accepts<VolumeOptions<DigitalOcean>>({ name: 'v', region: 'atl1', sizeGb: 50, shared: true, providerOptions: { performance_tier: 'ultra' } });
        // @ts-expect-error a platform that makes one kind takes no `shared`
        accepts<VolumeOptions<RunPod>>({ name: 'v', region: 'US-TX-3', sizeGb: 50, shared: true });
        accepts<VolumeOptions<Scaleway>>({ name: 'v', region: 'fr-par-2', sizeGb: 50 });
        accepts<VolumeOptions<LambdaCloud>>({ name: 'v', region: 'us-east-1' });

        // @ts-expect-error a network volume is sized when it is made
        accepts<VolumeOptions<RunPod>>({ name: 'v', region: 'US-TX-3' });
        // @ts-expect-error a Lambda filesystem has no size: it grows as it fills
        accepts<VolumeOptions<LambdaCloud>>({ name: 'v', region: 'us-east-1', sizeGb: 50 });
        // @ts-expect-error providerOptions are the platform's own request fields, typed
        accepts<VolumeOptions<DigitalOcean>>({ name: 'v', region: 'tor1', sizeGb: 50, providerOptions: { filesystem_type: 'zfs' } });
        // A Vast volume is on one machine (the region an offer names it by), sized when made, of one kind.
        accepts<VolumeOptions<VastAI>>({ name: 'weights', region: 'machine:18060', sizeGb: 20 });
        // @ts-expect-error a Vast volume is sized when it is made
        accepts<VolumeOptions<VastAI>>({ name: 'weights', region: 'machine:18060' });
        // @ts-expect-error Vast makes one kind of volume: no `shared`
        accepts<VolumeOptions<VastAI>>({ name: 'weights', region: 'machine:18060', sizeGb: 20, shared: false });
    });

    it('records: `raw` is the platform\'s own volume, and a place its own name for it, with no cast', () => {
        isTrue<Equal<Awaited<ReturnType<RunPod['createVolume']>>, Volume<RunPodNetworkVolume, RunPodRegionName>>>();
        isTrue<Equal<Awaited<ReturnType<LambdaCloud['getVolume']>>, Volume<LambdaFilesystem, LambdaRegionName> | null>>();
        isTrue<Equal<Awaited<ReturnType<VastAI['createVolume']>>, Volume<VastVolume, VastRegionName>>>();
        isTrue<Equal<Awaited<ReturnType<DigitalOcean['listVolumes']>>, Volume<DigitalOceanVolumeData | DigitalOceanNfsShare, DigitalOceanRegionName>[]>>();
        // Where a platform makes both kinds, the kind asked for is the record's: inferred at the call.
        const p = {} as DigitalOcean;
        const share = () => p.createVolume({ name: 'v', region: 'atl1', sizeGb: 50, shared: true });
        const block = () => p.createVolume({ name: 'v', region: 'tor1', sizeGb: 50 });
        isTrue<Equal<Awaited<ReturnType<typeof share>>, Volume<DigitalOceanNfsShare, DigitalOceanRegionName>>>();
        isTrue<Equal<Awaited<ReturnType<typeof block>>, Volume<DigitalOceanVolumeData, DigitalOceanRegionName>>>();
        const scw = {} as Scaleway;
        const disk = () => scw.createVolume({ name: 'v', region: 'fr-par-2', sizeGb: 50 });
        const files = () => scw.createVolume({ name: 'v', region: 'fr-par', sizeGb: 25, shared: true });
        isTrue<Equal<Awaited<ReturnType<typeof disk>>['raw'], ScalewayBlockVolume>>();
        isTrue<Equal<Awaited<ReturnType<typeof files>>['raw'], ScalewayFileSystem>>();
    });

    it('queries: the library\'s kinds, vendors and GPU names on every provider; a provider may take more of its own, never fewer', () => {
        type Query<P> = P extends { listOffers(q?: infer Q): unknown } ? NonNullable<Q> : never;
        type Listing<P> = P extends { listServers(o?: infer S): unknown } ? NonNullable<S> : never;
        // The kinds are one list, which the type is made from: a kind added to it is a kind everywhere.
        isTrue<Equal<ComputeKind, (typeof COMPUTE_KINDS)[number]>>();
        isTrue<Equal<ComputeKind, 'gpu' | 'cpu' | 'any'>>();
        expect([...COMPUTE_KINDS]).toEqual(['gpu', 'cpu', 'any']);
        // Every provider registered takes them, and the rest of the library's query, in each call that takes one.
        isTrue<TakesSharedQueries<AnyProvider>>();
        for (const kind of COMPUTE_KINDS) {
            accepts<Query<DigitalOcean>>({ kind });
            accepts<Query<RunPod>>({ kind });
            accepts<Query<VastAI>>({ kind });
            accepts<Query<LambdaCloud>>({ kind });
            accepts<Query<Scaleway>>({ kind });
            accepts<Listing<AnyProvider>>({ kind });
            accepts<Parameters<RunPod['listEndpointOffers']>[0]>({ kind });
            accepts<Parameters<Scaleway['listEndpointOffers']>[0]>({ kind });
        }
        // @ts-expect-error a platform's own word for a machine is not a kind
        accepts<Query<DigitalOcean>>({ kind: 'droplet' });
        // @ts-expect-error a kind is spelled as COMPUTE_KINDS spells it
        accepts<Listing<RunPod>>({ kind: 'GPU' });
        // @ts-expect-error a serverless query's kinds are the same three
        accepts<Parameters<Scaleway['listEndpointOffers']>[0]>({ kind: 'container' });
        // @ts-expect-error the vendors are the library's two
        accepts<Query<VastAI>>({ vendor: 'intel' });
        // A GPU model goes by the library's name for it, which the type knows; one it has no name for, by the provider's own.
        accepts<Query<Scaleway>>({ gpus: ['L4', 'H100', 'RTX 4000 Ada'] });
        accepts<Query<VastAI>>({ gpus: ['Q RTX 8000'] });
        isTrue<Equal<NonNullable<Query<AnyProvider>['gpus']>[number], GpuName | (string & {})>>();
        isTrue<'L40S' | 'RTX 5090' | 'MI300X' extends GpuName ? true : false>();
        isTrue<Equal<'l40s' extends GpuName ? true : false, false>>();
        // @ts-expect-error a model is named, not numbered
        accepts<Query<LambdaCloud>>({ gpus: [4090] });
        // What a provider takes besides is its own to add: a kind of its own next to the library's is still a provider's query...
        type Wider = { listOffers(q?: Omit<OfferQuery, 'kind'> & { kind?: ComputeKind | 'spot' }): unknown, listServers(o?: ServerListOptions): unknown };
        isTrue<TakesSharedQueries<Wider>>();
        // ...and one that takes fewer kinds than the library has is not, alone or among the others.
        type Narrower = { listOffers(q?: OfferQuery): unknown, listServers(o?: { kind?: 'gpu' }): unknown };
        // @ts-expect-error it lists no servers by 'cpu' or 'any'
        isTrue<TakesSharedQueries<Narrower>>();
        // @ts-expect-error one provider that takes fewer is found among those that take all
        isTrue<TakesSharedQueries<AnyProvider | Narrower>>();
        // @ts-expect-error and so is one whose serverless query alone takes fewer
        isTrue<TakesSharedQueries<Wider & { listEndpointOffers(q?: { kind?: 'cpu' }): unknown }>>();
    });

    it('region: each provider takes its pick of the library\'s places and its own names for them, and nothing else', () => {
        // Its pick is its reference data's: each open place's region and each area's (places.ts), as members or as their values.
        isTrue<Equal<`${DigitalOceanTypes['region']}`,
            'us_new_york' | 'us_new_york_1' | 'us_new_york_2' | 'us_new_york_3' | 'us_san_francisco' | 'us_san_francisco_2' | 'us_san_francisco_3' | 'netherlands_amsterdam'
            | 'netherlands_amsterdam_3' | 'singapore' | 'singapore_1' | 'uk_london' | 'uk_london_1' | 'germany_frankfurt' | 'germany_frankfurt_1' | 'canada_toronto'
            | 'canada_toronto_1' | 'india_bangalore' | 'india_bangalore_1' | 'australia_sydney' | 'australia_sydney_1' | 'us_atlanta' | 'us_atlanta_1' | 'us_richmond'
            | 'us_richmond_1' | 'us_kansas_city' | 'us_kansas_city_1' | 'us_memphis' | 'us_memphis_1'>>();
        isTrue<Equal<`${ScalewayTypes['region']}`,
            'france_paris' | 'france_paris_1' | 'france_paris_2' | 'france_paris_3' | 'netherlands_amsterdam' | 'netherlands_amsterdam_1' | 'netherlands_amsterdam_2'
            | 'netherlands_amsterdam_3' | 'poland_warsaw' | 'poland_warsaw_1' | 'poland_warsaw_2' | 'poland_warsaw_3' | 'italy_milan' | 'italy_milan_1'>>();
        isTrue<REGION_TYPES.US_TEXAS_3 | REGION_TYPES.CANADA_MONTREAL_4 | REGION_TYPES.ICELAND_5 | REGION_TYPES.US_WASHINGTON extends RunPodTypes['region'] ? true : false>();
        isTrue<REGION_TYPES.US_WASHINGTON_DC_3 | REGION_TYPES.US_NORTH_TEXAS_2 | REGION_TYPES.JAPAN_TOKYO | REGION_TYPES.ISRAEL_1 extends LambdaTypes['region'] ? true : false>();
        isTrue<Equal<VastTypes['region'], never>>();
        // A legacy datacenter is a place of DigitalOcean's, but none of the library's regions.
        isTrue<Equal<'sfo1' | 'ams2' extends DigitalOceanRegionName ? true : false, true>>();
        isTrue<Equal<Extract<`${DigitalOceanTypes['region']}`, `${string}_1` & `us_san_francisco${string}`>, never>>();
        // A `region` takes the pick and the platform's own names for its places, the lists its data has: nothing else.
        isTrue<Equal<RegionChoice<DigitalOceanTypes>, Named<DigitalOceanTypes['region']> | DigitalOceanRegionName>>();
        isTrue<Equal<RegionChoice<ScalewayTypes>, Named<ScalewayTypes['region']> | ScalewayZone | ScalewayRegion>>();
        isTrue<Equal<RegionChoice<RunPodTypes>, Named<RunPodTypes['region']> | RunPodRegionName>>();
        isTrue<Equal<RegionChoice<LambdaTypes>, Named<LambdaTypes['region']> | LambdaRegionName>>();
        isTrue<Equal<RegionChoice<VastTypes>, VastRegionName>>();
        isTrue<Equal<DigitalOceanRegionName, (typeof DIGITALOCEAN_DATACENTERS)[number]['slug']>>();
        isTrue<Equal<RunPodRegionName, (typeof RUNPOD_DATA_CENTERS)[number]['id']>>();
        isTrue<Equal<LambdaRegionName, (typeof LAMBDA_REGIONS)[number]['name']>>();
        // No name of the library's is a platform's own: a region it has not cannot pass for one of its places.
        isTrue<Equal<Leaks<TypesOf<AnyProvider>>, never>>();
        // @ts-expect-error a platform whose own names were any string would let them all pass
        isTrue<Equal<Leaks<Omit<RunPodTypes, 'regionName'> & { regionName: string }>, never>>();
        // Code typed for any provider takes every one of the library's, and any string: a platform refuses at run time one it has not.
        isTrue<Equal<Offered<RegionChoice>, Named<REGION_TYPES>>>();
        isTrue<Equal<PlatformTypes['region'], REGION_TYPES>>();
        accepts<RegionChoice>(String(base.offer));
        // Every call that takes a place takes it so.
        isTrue<Equal<Exclude<ServerOptions<DigitalOcean>['region'], undefined>, RegionChoice<DigitalOceanTypes>>>();
        isTrue<Equal<VolumeOptions<Scaleway>['region'], RegionChoice<ScalewayTypes>>>();
        isTrue<Equal<Parameters<DigitalOcean['importImage']>[0]['region'], RegionChoice<DigitalOceanTypes>>>();
        isTrue<Equal<Parameters<Scaleway['copyImage']>[1], Array<RegionChoice<ScalewayTypes>>>>();
        isTrue<Equal<Exclude<Parameters<Scaleway['createEndpoint']>[0]['region'], undefined>, RegionChoice<ScalewayTypes>>>();
        isTrue<Equal<Exclude<Parameters<RunPod['createEndpoint']>[0]['region'], undefined>, RegionChoice<RunPodTypes>>>();
        isTrue<Equal<Parameters<VastAI['offersOn']>[0], RegionChoice<VastTypes>>>();
        accepts<ServerOptions<DigitalOcean>>({ ...base, region: REGION_TYPES.CANADA_TORONTO });
        accepts<ServerOptions<DigitalOcean>>({ ...base, region: 'canada_toronto' });
        accepts<ServerOptions<DigitalOcean>>({ ...base, region: 'tor1' });
        // A datacenter of a city the library has no member for, by its own name.
        accepts<ServerOptions<DigitalOcean>>({ ...base, region: 'sgp1' });
        accepts<ServerOptions<RunPod>>({ ...base, region: REGION_TYPES.US_TEXAS_3 });
        accepts<VolumeOptions<LambdaCloud>>({ name: 'v', region: REGION_TYPES.JAPAN_OSAKA });
        accepts<ServerOptions<Scaleway>>({ ...base, region: 'pl-waw-2' });
        accepts<ServerOptions<RunPod>>({ ...base, region: 'US-TX-3' });
        accepts<VolumeOptions<LambdaCloud>>({ name: 'v', region: 'us-east-1' });
        accepts<ServerOptions<VastAI>>({ ...base, region: 'machine:18060' });
        accepts<VolumeOptions<Scaleway>>({ name: 'v', sizeGb: 10, region: REGION_TYPES.FRANCE_PARIS_2 });
        accepts<Parameters<Scaleway['copyImage']>[1]>([REGION_TYPES.NETHERLANDS_AMSTERDAM, 'pl-waw-2']);
        // A place read from the platform's records goes back in as it is: its own name, typed so.
        type OfferOf<P extends { listOffers(): Promise<unknown[]> }> = Awaited<ReturnType<P['listOffers']>>[number];
        const back = [
            (offer: OfferOf<DigitalOcean>) => accepts<ServerOptions<DigitalOcean>>({ ...base, offer, region: offer.regions[0] }),
            (offer: OfferOf<DigitalOcean>) => accepts<ServerOptions<DigitalOcean>>({ ...base, offer, region: offer.locations![0].region }),
            (server: NonNullable<Awaited<ReturnType<Scaleway['getServer']>>>) => accepts<VolumeOptions<Scaleway>>({ name: 'v', sizeGb: 10, region: server.region! }),
            (volume: Awaited<ReturnType<RunPod['createVolume']>>) => accepts<ServerOptions<RunPod>>({ ...base, region: volume.region }),
        ];
        expect(back.map((f) => typeof f)).toEqual(['function', 'function', 'function', 'function']);
        // @ts-expect-error DigitalOcean has no Paris
        accepts<ServerOptions<DigitalOcean>>({ ...base, region: REGION_TYPES.FRANCE_PARIS });
        // @ts-expect-error nor by its value
        accepts<ServerOptions<DigitalOcean>>({ ...base, region: 'france_paris' });
        // @ts-expect-error Scaleway has no New York
        accepts<VolumeOptions<Scaleway>>({ name: 'v', sizeGb: 10, region: REGION_TYPES.US_NEW_YORK_1 });
        // @ts-expect-error RunPod has no Toronto (its Canada is Montreal)
        accepts<ServerOptions<RunPod>>({ ...base, region: REGION_TYPES.CANADA_TORONTO });
        // @ts-expect-error nor has Lambda Paris
        accepts<VolumeOptions<LambdaCloud>>({ name: 'v', region: 'france_paris_1' });
        // @ts-expect-error a datacenter DigitalOcean does not have: its own names are a list, not a pattern
        accepts<ServerOptions<DigitalOcean>>({ ...base, region: 'nyc9' });
        // @ts-expect-error a name of Lambda's is none of RunPod's
        accepts<ServerOptions<RunPod>>({ ...base, region: 'us-east-1' });
        // @ts-expect-error nor one of RunPod's Lambda's
        accepts<VolumeOptions<LambdaCloud>>({ name: 'v', region: 'US-TX-3' });
        // @ts-expect-error Vast writes a country's code in capitals
        accepts<ServerOptions<VastAI>>({ ...base, region: 'Texas, us' });
        // @ts-expect-error nor Vast
        accepts<ServerOptions<VastAI>>({ ...base, region: REGION_TYPES.POLAND_WARSAW });
        // @ts-expect-error a name of no place of the platform's
        accepts<ServerOptions<Scaleway>>({ ...base, region: 'fr-par-9' });
        // @ts-expect-error an image is copied to places the platform has
        accepts<Parameters<DigitalOcean['copyImage']>[1]>([REGION_TYPES.ITALY_MILAN]);
        // @ts-expect-error an endpoint runs in one
        accepts<Parameters<Scaleway['createEndpoint']>[0]>({ name: 'e', container: { image: 'x' }, region: REGION_TYPES.CANADA_TORONTO });
        // @ts-expect-error a string read from a flag is checked before it is a place
        accepts<ServerOptions<DigitalOcean>>({ ...base, region: String(base.offer) });
        // @ts-expect-error a place is named
        accepts<ServerOptions<DigitalOcean>>({ ...base, region: 1 });
    });

    it('places: a provider says which of the library\'s regions and countries it has, and its regions are in countries it has', () => {
        // @ts-expect-error a platform says which of the library's regions it has, if only that it has none
        accepts<CreateServerOptions<Omit<RunPodTypes, 'region'>>>(base);
        // @ts-expect-error and which countries it has places in
        accepts<CreateServerOptions<Omit<ScalewayTypes, 'country'>>>(base);
        // @ts-expect-error a region it has is one of the library's: a name of its own is no pick of them
        accepts<CreateServerOptions<Omit<RunPodTypes, 'region'> & { region: 'US-TX-3' }>>(base);
        // Its pick of the library's countries: where its own names for its places say it is.
        isTrue<Equal<`${DigitalOceanTypes['country']}`, 'US' | 'CA' | 'GB' | 'NL' | 'DE' | 'SG' | 'IN' | 'AU'>>();
        isTrue<Equal<ScalewayCountry, COUNTRY_TYPES.FR | COUNTRY_TYPES.NL | COUNTRY_TYPES.PL | COUNTRY_TYPES.IT>>();
        isTrue<Equal<ScalewayTypes['country'], ScalewayCountry>>();
        isTrue<Equal<`${LambdaTypes['country']}`, 'US' | 'JP' | 'IN' | 'AU' | 'DE' | 'IL'>>();
        isTrue<Equal<`${RunPodTypes['country']}`, 'US' | 'CA' | 'IN' | 'JP' | 'CZ' | 'FR' | 'NL' | 'RO' | 'SE' | 'IS' | 'NO' | 'AU'>>();
        // Where a place says its own country (a marketplace's machine), it may be any of them.
        isTrue<Equal<VastTypes['country'], COUNTRY_TYPES>>();
        // Each region of the library's is in one country (REGION_COUNTRIES), and every provider registered that has it has places there.
        isTrue<Equal<(typeof REGION_COUNTRIES)[REGION_TYPES.CANADA_TORONTO], COUNTRY_TYPES.CA>>();
        isTrue<RegionsAreInItsCountries<TypesOf<AnyProvider>>>();
        isTrue<Equal<TypesOf<DigitalOcean>, DigitalOceanTypes>>();
        // @ts-expect-error Paris is in France: a platform that has it has a place there
        isTrue<RegionsAreInItsCountries<Omit<ScalewayTypes, 'country'> & { country: COUNTRY_TYPES.NL }>>();
        // @ts-expect-error one such platform among the others is found
        isTrue<RegionsAreInItsCountries<TypesOf<AnyProvider> | (Omit<ScalewayTypes, 'country'> & { country: COUNTRY_TYPES.NL })>>();
        // `countries` is a question, fair to ask anywhere: the library's whole list on every provider, which is every
        // code ISO gives a country, and nothing else.
        accepts<Parameters<Scaleway['listOffers']>[0]>({ countries: [COUNTRY_TYPES.US, 'JP', 'BR'] });
        isTrue<Equal<Offered<NonNullable<OfferQuery['countries']>[number]>, Named<COUNTRY_TYPES>>>();
        isTrue<Equal<NonNullable<OfferQuery['countries']>[number], Named<COUNTRY_TYPES>>>();
        // @ts-expect-error ISO gives no country 'UK': the United Kingdom's code is GB
        accepts<Parameters<RunPod['listOffers']>[0]>({ countries: ['UK'] });
        // @ts-expect-error a code is written as ISO writes it
        accepts<OfferQuery>({ countries: ['us'] });
        // A record's country is one of them too.
        isTrue<Equal<NonNullable<NonNullable<Awaited<ReturnType<VastAI['listOffers']>>[number]['locations']>[number]['country']>, Named<COUNTRY_TYPES>>>();
        expect(REGION_COUNTRIES[REGION_TYPES.CANADA_TORONTO]).toBe(COUNTRY_TYPES.CA);
    });

    it('code typed for any provider is offered every option, and refused at run time what a platform cannot honor', () => {
        // The default PlatformTypes refuses nothing: generic code sees every option.
        accepts<CreateServerOptions>({ ...base, userData: '#cloud-config', env: { A: 'b' }, registryAuth: { username: 'u', password: 'p' }, mounts: [{ volume: 'v', path: '/x' }] });
        // A union of providers takes what each of them is offered.
        const create = (p: AnyProvider) => p.createServer({ ...base, userData: '#cloud-config', env: { A: 'b' }, sshKeyIds: ['k'] });
        expect(typeof create).toBe('function');
        // And asks any of them the same question, in the library's words.
        const list = (p: AnyProvider) => [p.listOffers({ kind: 'cpu', vendor: 'nvidia', gpus: ['L4'], countries: ['US'] }), p.listServers({ kind: 'gpu' })];
        expect(typeof list).toBe('function');
        // A place by the library's name is asked of code typed for any provider alike, and refused at run time where there is none.
        accepts<CreateServerOptions>({ ...base, region: REGION_TYPES.POLAND_WARSAW });
        const generic = (p: BaseProvider) => p.createServer({ ...base, region: REGION_TYPES.POLAND_WARSAW });
        // A union of providers takes only the places all of them have, which is none: narrow it to the one that has it.
        // @ts-expect-error DigitalOcean, among them, has no Warsaw
        const union = (p: AnyProvider) => p.createServer({ ...base, region: REGION_TYPES.POLAND_WARSAW });
        const narrowed = (p: AnyProvider) => (p.id === 'scaleway' ? p.createServer({ ...base, region: REGION_TYPES.POLAND_WARSAW }) : undefined);
        // So does a union narrowed by a capability: each of its providers keeps its own types.
        const copies = (p: AnyProvider) => {
            if (!supports(p, 'imageCopy')) return undefined;
            // @ts-expect-error Scaleway, among those that copy images, has no New York
            return p.copyImage('id', [REGION_TYPES.US_NEW_YORK_1]);
        };
        const endpoints = (p: AnyProvider) => {
            if (!supports(p, 'serverless')) return undefined;
            // @ts-expect-error RunPod, among those with serverless, has no Paris
            return p.createEndpoint({ name: 'e', container: { image: 'x' }, region: REGION_TYPES.FRANCE_PARIS });
        };
        const volumes = (p: AnyProvider) => {
            if (!supports(p, 'volumes')) return undefined;
            // @ts-expect-error a volume is made where all of them have the place: none is, so narrow first (TypeScript cannot call their overloads together)
            return p.createVolume({ name: 'v', sizeGb: 10, region: REGION_TYPES.FRANCE_PARIS });
        };
        const volumeNarrowed = (p: AnyProvider) => (p.id === 'scaleway' ? p.createVolume({ name: 'v', sizeGb: 10, region: REGION_TYPES.FRANCE_PARIS }) : undefined);
        expect([generic, union, narrowed, copies, endpoints, volumes, volumeNarrowed].map((f) => typeof f)).toEqual(Array(7).fill('function'));
    });
});
