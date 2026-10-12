import { ProviderError } from '../../errors';
import type { ComputeKind, Location, Offer, OfferQuery } from '../../types';

/** Whether an offer or server of this many GPUs is of `kind` (default 'any'). */
export function isKind(gpuCount: number | undefined, kind: ComputeKind = 'any'): boolean {
    return kind === 'any' || (kind === 'gpu') === (gpuCount ?? 0) > 0;
}

/** Whether the query names anything only a GPU has: then a machine without GPUs cannot match it. */
export function asksForGpu(q: OfferQuery): boolean {
    return q.kind === 'gpu' || q.vendor !== undefined || !!q.gpus?.length || q.minVramGb !== undefined
        || (q.gpuCount !== undefined && q.gpuCount > 0) || q.minCudaVersion !== undefined;
}

/**
 * An offer's `regions` and `locations`, from the provider's names for its
 * places and what says each one's country (ISO 3166-1 alpha-2; undefined
 * where its name does not say): what every provider's offers are made with,
 * so OfferQuery.countries reads them all alike.
 */
export function located(regions: readonly string[], countryOf: (region: string) => string | undefined): { regions: string[], locations: Location[] } {
    return { regions: [...regions], locations: regions.map((region) => placed(region, countryOf(region))) };
}

/** A place and its country, where there is one to say. */
export function placed(region: string, country: string | undefined): Location {
    return country ? { region, country } : { region };
}

/** Country codes as ISO 3166-1 alpha-2 writes them ('us' -> 'US'). Throws on anything else, so a typo ('USA') is not read as "nowhere". */
export function countryCodes(countries: readonly string[]): Set<string> {
    return new Set(countries.map((c) => {
        if (typeof c !== 'string' || !/^[A-Za-z]{2}$/.test(c)) throw new ProviderError('asap-vps', `bad country ${JSON.stringify(c)}: use an ISO 3166-1 alpha-2 code, e.g. US`);
        return c.toUpperCase();
    }));
}

/**
 * The one meaning of OfferQuery on every provider: providers push what they
 * can into their own search, then apply this. Cheapest first.
 */
export function filterOffers<O extends Offer<any>>(offers: O[], q: OfferQuery = {}): O[] {
    const minCuda = q.minCudaVersion !== undefined ? cudaVersion(q.minCudaVersion) : undefined;
    const gpuOnly = asksForGpu(q);
    const countries = q.countries?.length ? countryCodes(q.countries) : undefined;
    // In the countries asked for: only its places there are left to it (one whose country is not known is in none).
    const there = (o: O): O => {
        const locations = (o.locations ?? []).filter((l) => l.country !== undefined && countries!.has(l.country));
        return { ...o, regions: locations.map((l) => l.region), locations };
    };
    return (countries ? offers.map(there) : offers)
        .filter((o) => (countries ? o.regions.length > 0 : q.includeUnavailable || o.regions.length > 0)
            && (q.includeInterruptible || !o.interruptible)
            && (q.maxPricePerHour === undefined || o.pricePerHour <= q.maxPricePerHour)
            && isKind(o.gpuCount, q.kind)
            // A machine without GPUs matches no GPU filter.
            && (o.gpuCount === 0 ? !gpuOnly : (!q.vendor || o.vendor === q.vendor)
                && (!q.gpus?.length || q.gpus.includes(o.gpu))
                && (q.minVramGb === undefined || o.vramGb >= q.minVramGb)
                && (q.gpuCount === undefined || o.gpuCount === q.gpuCount)
                // CUDA is NVIDIA's; and only a driver the provider reports can be too old (a VM's is its image's).
                && (minCuda === undefined || (o.vendor !== 'amd'
                    && (o.cudaVersion === undefined || compareCudaVersions(o.cudaVersion, minCuda) >= 0)))))
        .sort((a, b) => a.pricePerHour - b.pricePerHour);
}

/**
 * A CUDA version as 'major.minor': '12.8', 12.8, '13' -> '13.0'. Throws on
 * anything else, so a typo is not read as "no constraint".
 */
export function cudaVersion(v: string | number): string {
    const m = /^(\d+)(?:\.(\d+))?$/.exec(String(v).trim());
    if (!m) throw new ProviderError('asap-vps', `bad CUDA version "${v}": use major.minor, e.g. 12.8`);
    return `${Number(m[1])}.${Number(m[2] ?? 0)}`;
}

/** Numeric, part by part (12.10 is above 12.9): < 0, 0 or > 0. */
export function compareCudaVersions(a: string | number, b: string | number): number {
    const [am, an] = cudaVersion(a).split('.').map(Number);
    const [bm, bn] = cudaVersion(b).split('.').map(Number);
    return am - bm || an - bn;
}
