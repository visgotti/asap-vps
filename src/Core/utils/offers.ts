import { COMPUTE_KINDS, GPU_VENDORS } from '../../constants';
import { ProviderError } from '../../errors';
import type { ComputeKind, GpuVendor, Location, Offer, OfferQuery } from '../../types';
import { asCountry } from './places';

/** A value the compiler never saw, as a refusal shows it: a string quoted, any other as JavaScript writes it (never a throw: a BigInt, a symbol). */
function shown(v: unknown): string {
    if (typeof v === 'string') return JSON.stringify(v);
    if (typeof v === 'bigint') return `${v}n`;
    if (typeof v === 'function') return 'a function';
    if (typeof v === 'object' && v !== null) {
        try {
            return JSON.stringify(v);
        } catch {
            return String(v);
        }
    }
    return String(v);
}

/**
 * A query's `kind` as one of COMPUTE_KINDS: 'any' when none is given. Throws
 * on anything else, so a kind the compiler never saw (a flag, a config value,
 * 'GPU') is not read as "without GPUs".
 */
export function computeKind(kind?: unknown): ComputeKind {
    if (kind === undefined) return 'any';
    if (!(COMPUTE_KINDS as readonly unknown[]).includes(kind)) throw new ProviderError('asap-vps', `bad kind ${shown(kind)}: use one of ${COMPUTE_KINDS.join(', ')}`);
    return kind as ComputeKind;
}

/**
 * A query's `vendor` as one of GPU_VENDORS, undefined when none is given.
 * Throws on anything else ('NVIDIA', a config value), so a vendor no offer
 * names is not read as a question no offer answers.
 */
export function queryVendor(vendor?: unknown): GpuVendor | undefined {
    if (vendor === undefined) return undefined;
    if (!(GPU_VENDORS as readonly unknown[]).includes(vendor)) throw new ProviderError('asap-vps', `bad vendor ${shown(vendor)}: use one of ${GPU_VENDORS.join(', ')}`);
    return vendor as GpuVendor;
}

/** A query as every offers method reads it first, before it asks the platform anything (readOfferQuery). */
export type ReadOfferQuery = {
    kind: ComputeKind,
    vendor?: GpuVendor,
    /** The countries allowed, as ISO writes them; undefined: any. */
    countries?: Set<string>,
    minCuda?: string,
    /** No offer anywhere can match it (no country allowed): there is nothing to ask the platform for. */
    matchesNone: boolean,
};

/**
 * The one reading of a query, the same on every provider and before anything
 * is asked of a platform: its kind, its vendor, its countries and its CUDA
 * version, in that order, each refused (ProviderError) when it is none.
 */
export function readOfferQuery(q: OfferQuery = {}): ReadOfferQuery {
    const kind = computeKind(q.kind);
    const vendor = queryVendor(q.vendor);
    const countries = q.countries !== undefined ? countryCodes(q.countries) : undefined;
    const minCuda = q.minCudaVersion !== undefined ? cudaVersion(q.minCudaVersion) : undefined;
    return { kind, ...(vendor ? { vendor } : {}), ...(countries ? { countries } : {}), ...(minCuda ? { minCuda } : {}), matchesNone: countries?.size === 0 };
}

/** Whether an offer or server of this many GPUs is of `kind` (default 'any'); a kind that is none of COMPUTE_KINDS is refused (computeKind). */
export function isKind(gpuCount: number | undefined, kind?: ComputeKind): boolean {
    const asked = computeKind(kind);
    return asked === 'any' || (asked === 'gpu') === (gpuCount ?? 0) > 0;
}

/** Whether the query names anything only a GPU has: then a machine without GPUs cannot match it. */
export function asksForGpu(q: OfferQuery): boolean {
    return q.kind === 'gpu' || q.vendor !== undefined || !!q.gpus?.length || q.minVramGb !== undefined
        || (q.gpuCount !== undefined && q.gpuCount > 0) || q.minCudaVersion !== undefined;
}

/**
 * An offer's `regions` and `locations`, from the provider's names for its
 * places and what says each one's country (one of COUNTRY_TYPES; undefined
 * where its name does not say): what every provider's offers are made with,
 * so OfferQuery.countries reads them all alike.
 */
export function located<R extends string>(regions: readonly R[], countryOf: (region: string) => Location['country']): { regions: R[], locations: Array<Location<R>> } {
    return { regions: [...regions], locations: regions.map((region) => placed(region, countryOf(region))) };
}

/** A place and its country, where there is one to say. */
export function placed<R extends string>(region: R, country: Location['country']): Location<R> {
    return country ? { region, country } : { region };
}

/**
 * Country codes as ISO 3166-1 alpha-2 writes them ('us' -> 'US'), each one ISO
 * gives a country (COUNTRY_TYPES). Throws on anything else, so a typo ('USA',
 * 'UK': the United Kingdom's is GB) is not read as "nowhere".
 */
export function countryCodes(countries: readonly string[]): Set<string> {
    return new Set(countries.map((c) => {
        if (typeof c !== 'string' || !/^[A-Za-z]{2}$/.test(c)) throw new ProviderError('asap-vps', `bad country ${JSON.stringify(c)}: use an ISO 3166-1 alpha-2 code, e.g. US`);
        const country = asCountry(c.toUpperCase());
        if (!country) throw new ProviderError('asap-vps', `bad country "${c}": ISO 3166-1 gives no country that code (COUNTRY_TYPES has every one it does)`);
        return country;
    }));
}

/**
 * The one meaning of OfferQuery on every provider: providers push what they
 * can into their own search, then apply this. Cheapest first.
 */
export function filterOffers<O extends Offer<any>>(offers: O[], q: OfferQuery = {}): O[] {
    // Read once, whatever is listed: a query that is not well formed is refused of an empty list too. A list of countries
    // is the places allowed: an empty one allows none (left out, any place is).
    const { kind, vendor, countries, minCuda } = readOfferQuery(q);
    const gpuOnly = asksForGpu(q);
    // In the countries asked for: only its places there are left to it (one whose country is not known is in none).
    const there = (o: O): O => {
        const locations = (o.locations ?? []).filter((l) => l.country !== undefined && countries!.has(l.country));
        return { ...o, regions: locations.map((l) => l.region), locations };
    };
    return (countries ? offers.map(there) : offers)
        .filter((o) => (countries ? o.regions.length > 0 : q.includeUnavailable || o.regions.length > 0)
            && (q.includeInterruptible || !o.interruptible)
            && (q.maxPricePerHour === undefined || o.pricePerHour <= q.maxPricePerHour)
            && isKind(o.gpuCount, kind)
            // A machine without GPUs matches no GPU filter.
            && (o.gpuCount === 0 ? !gpuOnly : (!vendor || o.vendor === vendor)
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
