// DigitalOceanApi against the fake of DigitalOcean's API v2
// (src/testing/fakes/digitalocean.ts): what the client does beyond one request.
// The account's droplets counted against its limit (GPU droplets are listed
// apart), a key the account came to hold meanwhile, and a rate limit.

import { ProviderError } from '../../errors';
import { fakeDigitalOcean } from '../../testing/fakes/digitalocean';
import { json, testPublicKey } from '../../testing/fakes/util';
import { DigitalOceanApi, sshKeyRef } from './api';
import { DigitalOcean } from './DigitalOcean';

const noSleep = async () => {};

describe('DigitalOceanApi', () => {
    const make = (o: Parameters<typeof fakeDigitalOcean>[0] = {}, wrap: (f: typeof fetch) => typeof fetch = (f) => f) => {
        const fake = fakeDigitalOcean(o);
        const params = { apiKey: 'do-test', fetchImpl: wrap(fake.fetchImpl), sleep: noSleep };
        return { fake, api: new DigitalOceanApi(params), p: new DigitalOcean(params) };
    };

    it('dropletUsage: the account\'s limit, and every droplet against it, GPU ones too', async () => {
        const { api, p, fake } = make({ dropletLimit: 7 });
        const before = await api.dropletUsage();
        expect(before).toEqual({ limit: 7, used: fake.state.droplets.size });
        const [cpu] = await p.listOffers({ kind: 'cpu' });
        await p.createServer({ name: 'cpu-1', offer: cpu, region: cpu.regions[0] });
        await p.createServer({ name: 'gpu-1', offer: 'gpu-4000adax1-20gb', region: 'tor1' });
        expect(await api.dropletUsage()).toEqual({ limit: 7, used: before.used + 2 });
    });

    it('a key the account holds already ("already in use") is that key; one it still does not list is the refusal, and other refusals pass through', async () => {
        const { api } = make();
        const pub = testPublicKey('laptop');
        const first = await api.registerSSHKey(pub, 'laptop');
        expect(await api.registerSSHKey(pub, 'laptop-again')).toMatchObject({ id: first.id, publicKey: pub });

        // DigitalOcean says the key is in use, but its list does not show it (yet): the refusal is what is thrown.
        const unlisted = make({}, (f) => (async (url: string | URL | Request, init?: RequestInit) =>
            init?.method === 'POST' && new URL(String(url)).pathname === '/v2/account/keys'
                ? json(422, { id: 'unprocessable_entity', message: 'SSH Key is already in use on your account' }) : f(url, init)) as typeof fetch);
        await expect(unlisted.api.registerSSHKey(pub, 'laptop')).rejects.toMatchObject({ status: 422, message: expect.stringMatching(/already in use/) });
        await expect(api.registerSSHKey('not a key', 'x')).rejects.toMatchObject({ status: 422, message: expect.stringMatching(/Key invalid/) });
    });

    it('a list that names a next page forever is refused after 200 pages, not read without end', async () => {
        let pages = 0;
        const { api } = make({}, (f) => (async (url: string | URL | Request, init?: RequestInit) => {
            if (new URL(String(url)).pathname !== '/v2/sizes') return f(url, init);
            pages++;
            return json(200, { sizes: [], links: { pages: { next: 'https://api.digitalocean.com/v2/sizes?page=2' } }, meta: { total: 1e9 } });
        }) as typeof fetch);
        const e = await api.all('/v2/sizes', 'sizes').catch((x) => x);
        expect(e).toBeInstanceOf(ProviderError);
        expect(e.message).toBe('digitalocean: /v2/sizes has more than 200 pages');
        expect(pages).toBe(200);
    });

    it('a key reference a droplet create takes: all digits is an id, sent as a number; anything else (a fingerprint, a name) as it is', () => {
        expect(sshKeyRef('5001')).toBe(5001);
        expect(sshKeyRef(5001)).toBe(5001);
        const md5 = '3b:21:6f:0a:9c:84:12:5e:77:d0:4a:b3:c8:19:e6:42';
        expect(sshKeyRef(md5)).toBe(md5);
        expect(sshKeyRef('laptop-2')).toBe('laptop-2');
    });

    it('a rate limit is a ProviderError worth sending again, after the client has waited it out a few times', async () => {
        let asked = 0;
        const { api } = make({}, (f) => (async (url: string | URL | Request, init?: RequestInit) => {
            if (new URL(String(url)).pathname !== '/v2/account') return f(url, init);
            asked++;
            return json(429, { id: 'too_many_requests', message: 'API Rate limit exceeded.' });
        }) as typeof fetch);
        const e = await api.dropletUsage().catch((x) => x);
        expect(e).toBeInstanceOf(ProviderError);
        expect(e).toMatchObject({ status: 429, code: 'too_many_requests', retriable: true });
        expect(asked).toBeGreaterThan(1);
    });
});
