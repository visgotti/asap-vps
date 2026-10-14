// The one meaning of an offer query on every provider (CPU machines and CUDA
// floors included), and CUDA versions.

import { COMPUTE_KINDS, COUNTRY_TYPES, GPU_VENDORS } from '../../constants';
import { ProviderError } from '../../errors';
import type { ComputeKind, GpuVendor, Location, Offer } from '../../types';
import { compareCudaVersions, computeKind, countryCodes, cudaVersion, filterOffers, isKind, located, placed, queryVendor, readOfferQuery } from './offers';

describe('filterOffers', () => {
    const offer = (id: string, o: Partial<Offer> = {}): Offer =>
        ({ provider: 'p', id, gpu: 'L4', vendor: 'nvidia', gpuCount: 1, vramGb: 24, pricePerHour: 1, regions: ['r'], raw: {}, ...o });

    it('stock-only and on-demand by default, cheapest first; every field filters', () => {
        const offers = [offer('a', { pricePerHour: 2 }), offer('b', { regions: [] }), offer('c', { interruptible: true, pricePerHour: 0.1 }),
            offer('d', { pricePerHour: 0.5, vendor: 'amd', gpu: 'MI300X', vramGb: 192 }), offer('e', { gpuCount: 2, pricePerHour: 3 })];
        expect(filterOffers(offers).map((o) => o.id)).toEqual(['d', 'a', 'e']);
        expect(filterOffers(offers, { includeUnavailable: true, includeInterruptible: true }).map((o) => o.id)).toEqual(['c', 'd', 'b', 'a', 'e']);
        expect(filterOffers(offers, { vendor: 'nvidia' }).map((o) => o.id)).toEqual(['a', 'e']);
        expect(filterOffers(offers, { minVramGb: 48 }).map((o) => o.id)).toEqual(['d']);
        expect(filterOffers(offers, { gpus: ['L4'], gpuCount: 2 }).map((o) => o.id)).toEqual(['e']);
        expect(filterOffers(offers, { maxPricePerHour: 2 }).map((o) => o.id)).toEqual(['d', 'a']);
    });
});

describe('filterOffers by country: the same on every provider, whatever it calls its places', () => {
    const offer = (id: string, places: Array<[string, Location['country']?]>, o: Partial<Offer> = {}): Offer => ({
        provider: 'p', id, gpu: 'L4', vendor: 'nvidia', gpuCount: 1, vramGb: 24, pricePerHour: 1, raw: {}, ...located(places.map(([r]) => r), (r) => places.find(([x]) => x === r)?.[1]), ...o,
    });
    const offers = [
        offer('us', [['US-TX-3', 'US']], { pricePerHour: 3 }), offer('both', [['tor1', 'CA'], ['nyc1', 'US'], ['ams3', 'NL']], { pricePerHour: 2 }),
        offer('fr', [['fr-par-2', 'FR']], { pricePerHour: 1 }), offer('nowhere', [], { pricePerHour: 0.5 }), offer('unknown', [['mars-1']], { pricePerHour: 0.4 }),
    ];

    it('keeps the offers with stock in a country asked for, each left with its places there alone; cheapest first', () => {
        const us = filterOffers(offers, { countries: ['US'] });
        expect(us.map((o) => [o.id, o.regions, o.locations])).toEqual([
            ['both', ['nyc1'], [{ region: 'nyc1', country: 'US' }]], ['us', ['US-TX-3'], [{ region: 'US-TX-3', country: 'US' }]],
        ]);
        expect(filterOffers(offers, { countries: ['NL', 'FR', 'CA'] }).map((o) => [o.id, o.regions])).toEqual([['fr', ['fr-par-2']], ['both', ['tor1', 'ams3']]]);
        expect(filterOffers(offers, { countries: ['JP'] })).toEqual([]);
        // The offers given are not changed: the same list answers the next question.
        expect(offers[1].regions).toEqual(['tor1', 'nyc1', 'ams3']);
        expect(filterOffers(offers).map((o) => o.id)).toEqual(['unknown', 'fr', 'both', 'us']);
    });

    it('a code is read in either case; left out, any country is allowed; a place whose country is not known, and an offer in stock nowhere, are in no country', () => {
        // The type takes a code as ISO writes it; a caller it does not check (JavaScript, a flag) may write it in lower case.
        // @ts-expect-error: 'us' is no member of COUNTRY_TYPES
        expect(filterOffers(offers, { countries: ['us'] }).map((o) => o.id)).toEqual(['both', 'us']);
        expect(filterOffers(offers, {}).map((o) => o.id)).toEqual(['unknown', 'fr', 'both', 'us']);
        expect(filterOffers(offers, { countries: undefined }).map((o) => o.id)).toEqual(['unknown', 'fr', 'both', 'us']);
        expect(filterOffers(offers, { countries: ['US'], includeUnavailable: true }).map((o) => o.id)).toEqual(['both', 'us']);
        // An offer made without locations (another library's, an older one) is in no country either.
        const bare: Offer = { provider: 'p', id: 'bare', gpu: 'L4', vendor: 'nvidia', gpuCount: 1, vramGb: 24, pricePerHour: 1, regions: ['nyc1'], raw: {} };
        expect(filterOffers([bare], { countries: ['US'] })).toEqual([]);
        expect(filterOffers([bare])).toEqual([bare]);
    });

    it('an empty list of countries allows none: no offer, never every country (a list of places allowed that came out empty must not rent anywhere)', () => {
        expect(filterOffers(offers, { countries: [] })).toEqual([]);
        expect(filterOffers(offers, { countries: [], includeUnavailable: true })).toEqual([]);
        // The same list built by a caller: the countries it may use, of which none is left.
        const allowed = [COUNTRY_TYPES.US, COUNTRY_TYPES.FR].filter((c) => c === COUNTRY_TYPES.DE);
        expect(filterOffers(offers, { countries: allowed })).toEqual([]);
        expect([...countryCodes([])]).toEqual([]);
    });

    it('a country that is no ISO 3166-1 alpha-2 code is refused, not read as nowhere', () => {
        for (const bad of ['USA', 'U', '', 'U1', 'United States']) {
            expect(() => filterOffers(offers, { countries: [bad as COUNTRY_TYPES] })).toThrow(expect.objectContaining({ name: 'ProviderError', message: `asap-vps: bad country "${bad}": use an ISO 3166-1 alpha-2 code, e.g. US` }));
        }
        expect(() => countryCodes([42 as never])).toThrow('asap-vps: bad country 42: use an ISO 3166-1 alpha-2 code, e.g. US');
        expect([...countryCodes(['us', 'Fr', 'US'])]).toEqual(['US', 'FR']);
    });

    it('a code ISO 3166-1 gives no country is refused too: COUNTRY_TYPES is every code it gives one, and nothing else', () => {
        for (const bad of ['UK', 'EU', 'XX', 'uk', 'Zz']) {
            expect(() => countryCodes([bad])).toThrow(expect.objectContaining({ name: 'ProviderError', message: `asap-vps: bad country "${bad}": ISO 3166-1 gives no country that code (COUNTRY_TYPES has every one it does)` }));
        }
        // @ts-expect-error: the United Kingdom's code is GB
        expect(() => filterOffers(offers, { countries: ['GB', 'UK'] })).toThrow('asap-vps: bad country "UK": ISO 3166-1 gives no country that code (COUNTRY_TYPES has every one it does)');
        const every = Object.values(COUNTRY_TYPES);
        expect([...countryCodes(every)]).toEqual(every);
        expect(every).toHaveLength(249);
    });

    it('located and placed: an offer\'s regions with the country of each, where there is one to say', () => {
        expect(located(['a', 'b'], (r) => (r === 'a' ? 'US' : undefined))).toEqual({ regions: ['a', 'b'], locations: [{ region: 'a', country: 'US' }, { region: 'b' }] });
        expect(located([], () => 'US')).toEqual({ regions: [], locations: [] });
        const given = ['a'];
        expect(located(given, () => 'US').regions).not.toBe(given);
        expect([placed('a', 'US'), placed('a', undefined)]).toEqual([{ region: 'a', country: 'US' }, { region: 'a' }]);
        expect('country' in placed('a', undefined)).toBe(false);
    });
});

describe('filterOffers and CPU machines', () => {
    const gpu: Offer = { provider: 'x', id: 'g', gpu: 'L4', vendor: 'nvidia', gpuCount: 1, vramGb: 24, pricePerHour: 0.8, regions: ['r'], raw: {} };
    const cpu: Offer = { provider: 'x', id: 'c', gpu: '', vendor: null, gpuCount: 0, vramGb: 0, pricePerHour: 0.1, regions: ['r'], raw: {} };
    const soldOut: Offer = { ...cpu, id: 'c2', regions: [] };

    it('kind keeps machines with GPUs, without, or both (the default); price and stock apply to both', () => {
        expect(filterOffers([gpu, cpu]).map((o) => o.id)).toEqual(['c', 'g']);
        expect(filterOffers([gpu, cpu], { kind: 'gpu' }).map((o) => o.id)).toEqual(['g']);
        expect(filterOffers([gpu, cpu], { kind: 'cpu' }).map((o) => o.id)).toEqual(['c']);
        expect(filterOffers([gpu, cpu, soldOut], { kind: 'cpu' }).map((o) => o.id)).toEqual(['c']);
        expect(filterOffers([gpu, cpu, soldOut], { kind: 'cpu', includeUnavailable: true }).map((o) => o.id)).toEqual(['c', 'c2']);
        expect(filterOffers([gpu, cpu], { maxPricePerHour: 0.05 })).toEqual([]);
    });

    it('a GPU filter is a question about GPUs: no machine without them matches it', () => {
        for (const q of [{ vendor: 'nvidia' as const }, { gpus: ['L4'] }, { minVramGb: 1 }, { gpuCount: 1 }, { minCudaVersion: '12.0' }]) {
            expect(filterOffers([gpu, cpu], q).map((o) => o.id)).toEqual(['g']);
        }
        // Zero GPUs is a question about machines without them.
        expect(filterOffers([gpu, cpu], { gpuCount: 0 }).map((o) => o.id)).toEqual(['c']);
        expect(filterOffers([gpu, cpu], { kind: 'cpu', vendor: 'nvidia' })).toEqual([]);
    });
});

describe('kind: the library\'s three, read the same wherever one is taken', () => {
    const gpu: Offer = { provider: 'x', id: 'g', gpu: 'L4', vendor: 'nvidia', gpuCount: 1, vramGb: 24, pricePerHour: 0.8, regions: ['r'], raw: {} };
    const cpu: Offer = { ...gpu, id: 'c', gpu: '', vendor: null, gpuCount: 0, vramGb: 0, pricePerHour: 0.1 };
    /** A kind the compiler did not see: read from a flag or a config file, or passed by JavaScript. */
    const unseen = (kind: unknown) => kind as ComputeKind;

    it('COMPUTE_KINDS is the whole list, and cannot be added to at run time', () => {
        expect([...COMPUTE_KINDS]).toEqual(['gpu', 'cpu', 'any']);
        expect(Object.isFrozen(COMPUTE_KINDS)).toBe(true);
    });

    it('computeKind gives each of them back, and \'any\' for none given', () => {
        expect(COMPUTE_KINDS.map((k) => computeKind(k))).toEqual(['gpu', 'cpu', 'any']);
        expect([computeKind(), computeKind(undefined)]).toEqual(['any', 'any']);
    });

    it('anything else is refused, never read as "without GPUs": another case, a typo, a platform\'s word, null', () => {
        for (const [bad, shown] of [['GPU', '"GPU"'], ['cpuu', '"cpuu"'], ['vps', '"vps"'], ['', '""'], [' gpu', '" gpu"'], [null, 'null'], [1, '1'], [true, 'true'], [['gpu'], '["gpu"]']] as const) {
            const refusal = expect.objectContaining({ name: 'ProviderError', message: `asap-vps: bad kind ${shown}: use one of gpu, cpu, any` });
            expect(() => computeKind(bad)).toThrow(refusal);
            expect(() => isKind(1, unseen(bad))).toThrow(refusal);
            expect(() => isKind(0, unseen(bad))).toThrow(refusal);
            expect(() => filterOffers([gpu, cpu], { kind: unseen(bad) })).toThrow(refusal);
            // Of nothing to filter too: the refusal does not depend on what is listed.
            expect(() => filterOffers([], { kind: unseen(bad) })).toThrow(refusal);
        }
    });

    it('isKind: a machine is of the kind its GPU count says; none given, or \'any\', is every machine', () => {
        const table = (kind?: ComputeKind) => [isKind(2, kind), isKind(1, kind), isKind(0, kind), isKind(undefined, kind)];
        expect(table('gpu')).toEqual([true, true, false, false]);
        expect(table('cpu')).toEqual([false, false, true, true]);
        expect(table('any')).toEqual([true, true, true, true]);
        expect(table()).toEqual([true, true, true, true]);
        expect(table(undefined)).toEqual([true, true, true, true]);
    });
});

describe('CUDA versions', () => {
    it('read as major.minor and compare part by part', () => {
        expect(cudaVersion('12.8')).toBe('12.8');
        expect(cudaVersion(13)).toBe('13.0');
        expect(cudaVersion(' 12 ')).toBe('12.0');
        expect(compareCudaVersions('12.10', '12.9')).toBeGreaterThan(0);
        expect(compareCudaVersions('13.0', '12.9')).toBeGreaterThan(0);
        expect(compareCudaVersions('12.8', 12.8)).toBe(0);
        // A typo is an error, never "no constraint".
        expect(() => cudaVersion('12.x')).toThrow(ProviderError);
        expect(() => filterOffers([], { minCudaVersion: 'latest' })).toThrow(/bad CUDA version/);
    });

    it('filterOffers drops a host whose reported driver is older and every AMD offer, and keeps a VM\'s (its image brings the driver)', () => {
        const offer = (id: string, o: Partial<Offer>): Offer => ({ provider: 'p', id, gpu: 'L4', vendor: 'nvidia', gpuCount: 1, vramGb: 24, pricePerHour: 1, regions: ['r'], raw: {}, ...o });
        const offers = [offer('old', { cudaVersion: '12.2' }), offer('new', { cudaVersion: '12.9' }), offer('vm', {}), offer('amd', { vendor: 'amd', gpu: 'MI300X' })];
        expect(filterOffers(offers, { minCudaVersion: '12.8' }).map((o) => o.id)).toEqual(['new', 'vm']);
        expect(filterOffers(offers).map((o) => o.id)).toEqual(['old', 'new', 'vm', 'amd']);
    });
});

describe('readOfferQuery: a query as every offers method reads it, before it asks the platform anything', () => {
    it('reads each part the library names, and says when no offer can match', () => {
        expect(readOfferQuery()).toEqual({ kind: 'any', matchesNone: false });
        expect(readOfferQuery({ kind: 'gpu', vendor: 'amd', countries: ['us' as COUNTRY_TYPES, 'FR'], minCudaVersion: '12' }))
            .toEqual({ kind: 'gpu', vendor: 'amd', countries: new Set(['US', 'FR']), minCuda: '12.0', matchesNone: false });
        // No country allowed: no offer anywhere, and nothing to ask a platform for.
        expect(readOfferQuery({ countries: [] })).toEqual({ kind: 'any', countries: new Set(), matchesNone: true });
    });

    it('refuses the first part that is none, in order: kind, vendor, countries, CUDA', () => {
        const all = { kind: 'GPU' as ComputeKind, vendor: 'NVIDIA' as GpuVendor, countries: ['Mars' as COUNTRY_TYPES], minCudaVersion: 'x' };
        expect(() => readOfferQuery(all)).toThrow('asap-vps: bad kind "GPU": use one of gpu, cpu, any');
        expect(() => readOfferQuery({ ...all, kind: 'gpu' })).toThrow('asap-vps: bad vendor "NVIDIA": use one of nvidia, amd');
        expect(() => readOfferQuery({ ...all, kind: 'gpu', vendor: 'amd' })).toThrow('asap-vps: bad country "Mars": use an ISO 3166-1 alpha-2 code, e.g. US');
        expect(() => readOfferQuery({ ...all, kind: 'gpu', vendor: 'amd', countries: ['US'] })).toThrow('asap-vps: bad CUDA version "x": use major.minor, e.g. 12.8');
        // filterOffers reads it the same way, of an empty list too.
        expect(() => filterOffers([], { vendor: 'NVIDIA' as GpuVendor })).toThrow('asap-vps: bad vendor "NVIDIA": use one of nvidia, amd');
    });

    it('queryVendor: each of GPU_VENDORS, undefined for none; anything else is refused, never read as a vendor no offer has', () => {
        expect([...GPU_VENDORS]).toEqual(['nvidia', 'amd']);
        expect(Object.isFrozen(GPU_VENDORS)).toBe(true);
        expect([queryVendor('nvidia'), queryVendor('amd'), queryVendor(), queryVendor(undefined)]).toEqual(['nvidia', 'amd', undefined, undefined]);
        for (const [bad, shown] of [['NVIDIA', '"NVIDIA"'], ['intel', '"intel"'], ['', '""'], [null, 'null'], [['amd'], '["amd"]']] as const) {
            expect(() => queryVendor(bad)).toThrow(`asap-vps: bad vendor ${shown}: use one of nvidia, amd`);
        }
    });

    it('a value the compiler never saw is shown as JavaScript writes it, and the refusal is the library\'s, whatever the value', () => {
        const circular: Record<string, unknown> = {};
        circular.self = circular;
        for (const [bad, shown] of [[10n, '10n'], [NaN, 'NaN'], [Infinity, 'Infinity'], [Symbol('x'), 'Symbol(x)'], [() => 1, 'a function'], [{ a: 1 }, '{"a":1}'], [circular, '[object Object]']] as const) {
            expect(() => computeKind(bad)).toThrow(expect.objectContaining({ name: 'ProviderError', message: `asap-vps: bad kind ${shown}: use one of gpu, cpu, any` }));
        }
    });
});
