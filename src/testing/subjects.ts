// The providers the contract suite (src/Providers/contract.spec.ts) runs, each
// against a fake of its platform's REST API. Adding a provider = its class in
// src/Providers/<Platform>, a fake in ./fakes, and one entry here; the contract
// then holds it to the same scenario, for each capability it declares.

import { DigitalOcean } from '../Providers/DigitalOcean/DigitalOcean';
import { LambdaCloud } from '../Providers/LambdaCloud/LambdaCloud';
import type { AnyProvider } from '../Providers/registry';
import { RunPod } from '../Providers/RunPod/RunPod';
import { Scaleway } from '../Providers/Scaleway/Scaleway';
import { VastAI } from '../Providers/VastAI/VastAI';
import type { ContainerSpec, CreateServerOptions, Offer, RegistryAuth } from '../types';
import type { ScalewayOfferRaw } from '../Providers/Scaleway/types';
import { fakeDigitalOcean } from './fakes/digitalocean';
import { fakeLambda } from './fakes/lambda';
import { fakeRunPod } from './fakes/runpod';
import { FAKE_SCALEWAY_PROJECT, fakeScaleway } from './fakes/scaleway';
import type { FakeApi } from './fakes/util';
import { FAKE_SNAPSHOTS, fakeVast } from './fakes/vast';

/** The body of the last request `fake` was sent for `method` `path` (a pattern). */
const lastBody = (fake: FakeApi, method: string, path: RegExp) => [...fake.calls].reverse().find((c) => c.method === method && path.test(c.path))?.body;

export type ContractSubject = {
    name: string,
    make(o?: { apiKey?: string }): { provider: AnyProvider, fake: FakeApi },
    /** What createServer needs on this provider beyond a name, an offer and a region. */
    extra(provider: AnyProvider): Promise<Partial<CreateServerOptions>>,
    /**
     * Its cheapest GPU offer in stock, field by field as listOffers gives it
     * (raw aside), each value checked against the fake's catalog record: what
     * the provider makes of its platform's units, prices and places.
     */
    cheapestGpuOffer: Omit<Offer, 'raw'>,
    /** Whom a VM's ssh endpoint logs in as (VM providers). */
    sshUser?: string,
    /** A region to try an out-of-stock offer in. */
    anyRegion: string,
    /** An id no server has. */
    unknownId: string,
    /** An option this provider must refuse rather than drop. */
    refused: Partial<CreateServerOptions>,
    /** createServer rents an offer's GPU type at any GPU count asked (a RunPod pod); elsewhere an offer's count is fixed, and another is refused. */
    anyGpuCount?: boolean,
    /** What a running server of the fake prints (providers with logs). */
    logLine?: RegExp,
    /** A region other than `region` where a volume of `kind` can be made (providers with volumes): a server in `region` cannot mount it; undefined where the kind is in one region only. */
    elsewhere?: (region: string, kind: 'block' | 'shared') => string | undefined,
    /** Where the servers that mount a volume of `kind` go, where the cheapest GPU offer is no place for it (default: that offer, in its first region). */
    volumePlace?: (provider: AnyProvider, kind: 'block' | 'shared') => Promise<{ offer: Offer, region: string } | undefined>,
    /** A volume's name as the platform takes it, where it takes fewer characters than a test name has (default: as it is). */
    volumeName?: (name: string) => string,
    /** The registry login the platform was given with its last server create (container providers): what it will pull with. */
    loginOf?: (fake: FakeApi) => Partial<RegistryAuth> | undefined,
    /** The user data the platform was given with its last server create (VM providers): what cloud-init runs. */
    userDataOf?: (fake: FakeApi) => string | undefined,
    /** What the platform was told to run with its last server create (container providers), in the library's terms. */
    runOf?: (fake: FakeApi) => Omit<ContainerSpec, 'registryAuth'> | undefined,
};

const noSleep = async () => {};
const CUDA_IMAGE = 'nvidia/cuda:12.8.1-base-ubuntu24.04';

export const CONTRACT_SUBJECTS: ContractSubject[] = [
    {
        name: 'digitalocean',
        // Size gpu-4000adax1-20gb: price_hourly 0.76, in tor1 only, 8 vCPUs, 32768 MB, 500 GB, one nvidia_rtx4000_ada of 20 GiB.
        cheapestGpuOffer: { provider: 'digitalocean', id: 'gpu-4000adax1-20gb', gpu: 'RTX 4000 Ada', vendor: 'nvidia', gpuCount: 1, vramGb: 20, pricePerHour: 0.76,
            billing: { incrementSeconds: 1, minimumSeconds: 60, minimumUsd: 0.01 }, regions: ['tor1'], vcpus: 8, memoryGb: 32, diskGb: 500, interruptible: false },
        sshUser: 'root',
        make(o = {}) {
            const fake = fakeDigitalOcean();
            return { fake, provider: new DigitalOcean({ apiKey: o.apiKey ?? 'do-test', fetchImpl: fake.fetchImpl, sleep: noSleep }) };
        },
        extra: async () => ({ userData: '#!/bin/bash\ntrue\n', tags: ['gpu-contract'] }),
        anyRegion: 'tor1',
        unknownId: '424242',
        refused: { env: { MODE: 'probe' } },
        // Network File Storage is in a few regions only (none of them the cheapest GPU's): NYC2 and ATL1 among them.
        elsewhere: (region, kind) => (kind === 'shared' ? (region === 'nyc2' ? 'atl1' : 'nyc2') : region === 'nyc1' ? 'tor1' : 'nyc1'),
        volumePlace: async (p, kind) => {
            if (kind !== 'shared') return undefined;
            const offer = (await p.listOffers({ kind: 'gpu' })).find((o) => o.regions.includes('nyc2'));
            return offer && { offer, region: 'nyc2' };
        },
        userDataOf: (fake) => lastBody(fake, 'POST', /^\/v2\/droplets$/)?.user_data,
    },
    {
        name: 'runpod',
        // NVIDIA RTX A5000 on the secure cloud: 0.27 a GPU, 24 GB, stock in US-TX-3 only (EU-RO-1 has none), CUDA 12.8 free (12.4 not).
        cheapestGpuOffer: { provider: 'runpod', id: 'NVIDIA RTX A5000', gpu: 'RTX A5000', vendor: 'nvidia', gpuCount: 1, vramGb: 24, pricePerHour: 0.27,
            billing: { incrementSeconds: 1, minimumSeconds: 0 }, regions: ['US-TX-3'], cudaVersion: '12.8' },
        make(o = {}) {
            const fake = fakeRunPod();
            return { fake, provider: new RunPod({ apiKey: o.apiKey ?? 'rp-test', fetchImpl: fake.fetchImpl, sleep: noSleep }) };
        },
        extra: async () => ({ image: CUDA_IMAGE, env: { MODE: 'probe' }, ports: ['8888/http'], command: ['nvidia-smi', '-L'] }),
        anyRegion: 'US-TX-3',
        unknownId: 'pod_missing',
        refused: { userData: '#!/bin/bash\ntrue\n' },
        anyGpuCount: true,
        // What its command, nvidia-smi -L, prints.
        logLine: /^GPU 0: NVIDIA /m,
        elsewhere: (region) => (region === 'EU-RO-1' ? 'US-TX-3' : 'EU-RO-1'),
        // The pod names a stored login: what RunPod holds under it (RunPod reads the host from the image).
        loginOf: (fake) => {
            const id = lastBody(fake, 'POST', /^\/v2\/pods$/)?.registry;
            const stored = id ? (fake as ReturnType<typeof fakeRunPod>).state.registries.get(id) : undefined;
            return stored ? { username: stored.username, password: stored.password } : undefined;
        },
        runOf: (fake) => {
            const b = lastBody(fake, 'POST', /^\/v2\/pods$/);
            return b && { image: b.image, env: b.env, command: b.cmd, ports: b.ports };
        },
    },
    {
        name: 'vast',
        // Ask 104: a Tesla T4 with 15360 MB usable (a 16 GB card), dph_total 0.1, in Ohio on machine 14, 4 cores, 16384 MB, 100 GB, CUDA 12.2.
        cheapestGpuOffer: { provider: 'vast', id: '104', gpu: 'T4', vendor: 'nvidia', gpuCount: 1, vramGb: 16, pricePerHour: 0.1, billing: { incrementSeconds: 1, minimumSeconds: 0 },
            regions: ['Ohio, US', 'machine:14'], interruptible: false, vcpus: 4, memoryGb: 16, diskGb: 100, cudaVersion: '12.2' },
        make(o = {}) {
            const fake = fakeVast();
            // Snapshots go to a registry of the account's.
            return { fake, provider: new VastAI({ apiKey: o.apiKey ?? 'vast-test', fetchImpl: fake.fetchImpl, sleep: noSleep, snapshots: FAKE_SNAPSHOTS }) };
        },
        extra: async () => ({ image: CUDA_IMAGE, env: { MODE: 'probe' }, ports: ['8080/tcp'], command: ['nvidia-smi', '-L'] }),
        anyRegion: 'Sweden, SE',
        unknownId: '1',
        // An instance has no tags (its userData is a script run before its command).
        refused: { tags: ['contract'] },
        logLine: /^GPU 0: NVIDIA /m,
        // A volume is on one machine: its servers are rented there (the cheapest GPU offer's machine); another machine is elsewhere.
        volumePlace: async (p) => {
            const [offer] = await p.listOffers({ kind: 'gpu' });
            return { offer, region: offer.regions.find((r) => r.startsWith('machine:'))! };
        },
        elsewhere: (region) => (region === 'machine:11' ? 'machine:12' : 'machine:11'),
        // Vast names a volume with letters, digits and underscores only.
        volumeName: (name) => name.replace(/-/g, '_'),
        // The rental carries the login as docker login arguments.
        loginOf: (fake) => {
            const m = /^-u (\S+) -p (\S+) (\S+)$/.exec(lastBody(fake, 'PUT', /^\/api\/v0\/asks\/\d+\/$/)?.image_login ?? '');
            return m ? { username: m[1], password: m[2], server: m[3] } : undefined;
        },
        // Ports ride in the env as "-p" keys; a boot script (onstart) runs the command after itself.
        runOf: (fake) => {
            const b = lastBody(fake, 'PUT', /^\/api\/v0\/asks\/\d+\/$/);
            if (!b) return undefined;
            const entries = Object.entries((b.env ?? {}) as Record<string, string>);
            const ports = entries.flatMap(([k]) => {
                const p = /^-p (\d+):\d+(\/udp)?$/.exec(k);
                return p ? [`${p[1]}/${p[2] ? 'udp' : 'tcp'}`] : [];
            });
            return { image: b.image, env: Object.fromEntries(entries.filter(([k]) => !k.startsWith('-p '))), command: b.onstart ? b.args?.slice(3) : b.args, ports };
        },
    },
    {
        name: 'lambda',
        // gpu_1x_a10: 75 cents an hour, 'A10 (24 GB PCIe)', capacity in us-east-1, 30 vCPUs, 200 GiB, 1400 GiB.
        cheapestGpuOffer: { provider: 'lambda', id: 'gpu_1x_a10', gpu: 'A10', vendor: 'nvidia', gpuCount: 1, vramGb: 24, pricePerHour: 0.75,
            billing: { incrementSeconds: 60, minimumSeconds: 0 }, regions: ['us-east-1'], vcpus: 30, memoryGb: 200, diskGb: 1400 },
        sshUser: 'ubuntu',
        make(o = {}) {
            const fake = fakeLambda();
            return { fake, provider: new LambdaCloud({ apiKey: o.apiKey ?? 'lambda-test', fetchImpl: fake.fetchImpl, sleep: noSleep }) };
        },
        // Lambda requires a key: the fake account has one.
        extra: async (p) => ({ sshKeyIds: [(await (p as LambdaCloud).listSSHKeys())[0].id], userData: '#cloud-config\n' }),
        anyRegion: 'us-east-1',
        unknownId: 'f'.repeat(32),
        refused: { env: { MODE: 'probe' } },
        elsewhere: (region) => (region === 'us-west-1' ? 'us-east-1' : 'us-west-1'),
        userDataOf: (fake) => lastBody(fake, 'POST', /\/instance-operations\/launch$/)?.user_data,
    },
    {
        name: 'scaleway',
        // L4-1-24G: 0.7875 EUR an hour (USD at 1.15), stock in pl-waw-2, 8 vCPUs, 48 GiB, one L4 of 24 GiB.
        cheapestGpuOffer: { provider: 'scaleway', id: 'L4-1-24G', gpu: 'L4', vendor: 'nvidia', gpuCount: 1, vramGb: 24, pricePerHour: 0.7875 * 1.15,
            billing: { incrementSeconds: 60, minimumSeconds: 0 }, regions: ['pl-waw-2'], vcpus: 8, memoryGb: 48 },
        sshUser: 'root',
        make(o = {}) {
            const fake = fakeScaleway();
            return { fake, provider: new Scaleway({ apiKey: o.apiKey ?? 'scw-test', projectId: FAKE_SCALEWAY_PROJECT, accessKey: 'SCWFAKEACCESSKEY0000', fetchImpl: fake.fetchImpl, sleep: noSleep }) };
        },
        extra: async () => ({ userData: '#cloud-config\n' }),
        // Where the fake's H100 has no stock: the type exists there, and a create is refused for want of it.
        anyRegion: 'fr-par-2',
        // A server id is a UUID, asked of every zone.
        unknownId: '00000000-0000-4000-8000-ffffffffffff',
        refused: { env: { MODE: 'probe' } },
        // File Storage is in Paris only: no other region to make one in.
        elsewhere: (zone, kind) => (kind === 'shared' ? undefined : zone === 'fr-par-2' ? 'pl-waw-2' : 'fr-par-2'),
        // A filesystem: a GPU type that attaches one, in a Paris zone.
        volumePlace: async (p, kind) => {
            if (kind !== 'shared') return undefined;
            const offer = (await p.listOffers({ kind: 'gpu' })).find((o) => ((o.raw as ScalewayOfferRaw).serverType.capabilities?.max_file_systems ?? 0) > 0 && o.regions.some((r) => r.startsWith('fr-par')));
            return offer && { offer, region: offer.regions.find((r) => r.startsWith('fr-par'))! };
        },
        // Set after the create, as the server's cloud-init user data.
        userDataOf: (fake) => lastBody(fake, 'PATCH', /\/user_data\/cloud-init$/),
    },
];
