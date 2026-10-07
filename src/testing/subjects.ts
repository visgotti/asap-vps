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
    /** A region to try an out-of-stock offer in. */
    anyRegion: string,
    /** An id no server has. */
    unknownId: string,
    /** An option this provider must refuse rather than drop. */
    refused: Partial<CreateServerOptions>,
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
        make(o = {}) {
            const fake = fakeDigitalOcean();
            return { fake, provider: new DigitalOcean({ apiKey: o.apiKey ?? 'do-test', fetchImpl: fake.fetchImpl, sleep: noSleep }) };
        },
        extra: async () => ({ userData: '#!/bin/bash\ntrue\n', tags: ['gpu-contract'] }),
        anyRegion: 'tor1',
        unknownId: '424242',
        refused: { env: { MODE: 'probe' } },
        elsewhere: (region) => (region === 'nyc1' ? 'tor1' : 'nyc1'),
        userDataOf: (fake) => lastBody(fake, 'POST', /^\/v2\/droplets$/)?.user_data,
    },
    {
        name: 'runpod',
        make(o = {}) {
            const fake = fakeRunPod();
            return { fake, provider: new RunPod({ apiKey: o.apiKey ?? 'rp-test', fetchImpl: fake.fetchImpl, sleep: noSleep }) };
        },
        extra: async () => ({ image: CUDA_IMAGE, env: { MODE: 'probe' }, ports: ['8888/http'], command: ['nvidia-smi', '-L'] }),
        anyRegion: 'US-TX-3',
        unknownId: 'pod_missing',
        refused: { userData: '#!/bin/bash\ntrue\n' },
        logLine: /hello from gpu-contract/,
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
        logLine: /hello from gpu-contract/,
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
