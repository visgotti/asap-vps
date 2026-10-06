// The one meaning of an offer query on every provider (CPU machines and CUDA
// floors included), and CUDA versions.

import { ProviderError } from '../../errors';
import type { Offer } from '../../types';
import { compareCudaVersions, cudaVersion, filterOffers } from './offers';

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
