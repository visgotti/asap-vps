// What each provider's types promise, held by the compiler: ts-jest type-checks
// this file, so a `@ts-expect-error` line whose error goes away (an option a
// platform cannot honor, back in its type) fails the suite, as does a line
// below that stops compiling. Each provider's createServer offers only the
// options it honors, createVolume asks for a size only where the platform
// sizes volumes, a mount takes a path only where the platform mounts at one,
// and every record's `raw` is the platform's own: all without a cast.

import type { DigitalOcean } from './DigitalOcean/DigitalOcean';
import type { DigitalOceanNfsShare, DigitalOceanVolumeData } from './DigitalOcean/types';
import type { LambdaCloud } from './LambdaCloud/LambdaCloud';
import type { LambdaFilesystem } from './LambdaCloud/types';
import type { AnyProvider } from './registry';
import type { RunPod } from './RunPod/RunPod';
import type { RunPodNetworkVolume } from './RunPod/types';
import type { Scaleway } from './Scaleway/Scaleway';
import type { ScalewayBlockVolume, ScalewayFileSystem } from './Scaleway/types';
import type { VastImage, VastVolume } from './VastAI/types';
import type { VastAI } from './VastAI/VastAI';
import type { CreateServerOptions, ServerImage, Volume } from '../types';

type ServerOptions<P extends { createServer(o: never): unknown }> = Parameters<P['createServer']>[0];
type VolumeOptions<P extends { createVolume(o: never): unknown }> = Parameters<P['createVolume']>[0];
/** Whether A and B are the same type (not just assignable either way). */
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;

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
        // @ts-expect-error a Vast instance authorizes every account key: no choice of keys
        accepts<ServerOptions<VastAI>>({ ...base, sshKeyIds: ['k'] });
        // @ts-expect-error a droplet runs no container: no registry login
        accepts<ServerOptions<DigitalOcean>>({ ...base, registryAuth: { username: 'u', password: 'p' } });
        // @ts-expect-error Lambda's instance type fixes its disk
        accepts<ServerOptions<LambdaCloud>>({ ...base, diskGb: 100 });
        // @ts-expect-error a Scaleway Instance takes no container environment
        accepts<ServerOptions<Scaleway>>({ ...base, env: { A: 'b' } });
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
        isTrue<Equal<Awaited<ReturnType<VastAI['createImage']>>, ServerImage<VastImage>>>();
        isTrue<Equal<Awaited<ReturnType<VastAI['listImages']>>, ServerImage<VastImage>[]>>();
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

    it('records: `raw` is the platform\'s own volume, with no cast', () => {
        isTrue<Equal<Awaited<ReturnType<RunPod['createVolume']>>, Volume<RunPodNetworkVolume>>>();
        isTrue<Equal<Awaited<ReturnType<LambdaCloud['getVolume']>>, Volume<LambdaFilesystem> | null>>();
        isTrue<Equal<Awaited<ReturnType<VastAI['createVolume']>>, Volume<VastVolume>>>();
        isTrue<Equal<Awaited<ReturnType<DigitalOcean['listVolumes']>>, Volume<DigitalOceanVolumeData | DigitalOceanNfsShare>[]>>();
        // Where a platform makes both kinds, the kind asked for is the record's: inferred at the call.
        const p = {} as DigitalOcean;
        const share = () => p.createVolume({ name: 'v', region: 'atl1', sizeGb: 50, shared: true });
        const block = () => p.createVolume({ name: 'v', region: 'tor1', sizeGb: 50 });
        isTrue<Equal<Awaited<ReturnType<typeof share>>, Volume<DigitalOceanNfsShare>>>();
        isTrue<Equal<Awaited<ReturnType<typeof block>>, Volume<DigitalOceanVolumeData>>>();
        const scw = {} as Scaleway;
        const disk = () => scw.createVolume({ name: 'v', region: 'fr-par-2', sizeGb: 50 });
        const files = () => scw.createVolume({ name: 'v', region: 'fr-par', sizeGb: 25, shared: true });
        isTrue<Equal<Awaited<ReturnType<typeof disk>>['raw'], ScalewayBlockVolume>>();
        isTrue<Equal<Awaited<ReturnType<typeof files>>['raw'], ScalewayFileSystem>>();
    });

    it('code typed for any provider is offered every option, and refused at run time what a platform cannot honor', () => {
        // The default PlatformTypes refuses nothing: generic code sees every option.
        accepts<CreateServerOptions>({ ...base, userData: '#cloud-config', env: { A: 'b' }, registryAuth: { username: 'u', password: 'p' }, mounts: [{ volume: 'v', path: '/x' }] });
        // A union of providers takes what each of them is offered.
        const create = (p: AnyProvider) => p.createServer({ ...base, userData: '#cloud-config', env: { A: 'b' }, sshKeyIds: ['k'] });
        expect(typeof create).toBe('function');
    });
});
