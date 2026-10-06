import { ProviderError } from '../../errors';
import type { ComputeKind, Offer, OfferQuery } from '../../types';

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
 * The one meaning of OfferQuery on every provider: providers push what they
 * can into their own search, then apply this. Cheapest first.
 */
export function filterOffers<O extends Offer<any>>(offers: O[], q: OfferQuery = {}): O[] {
    const minCuda = q.minCudaVersion !== undefined ? cudaVersion(q.minCudaVersion) : undefined;
    const gpuOnly = asksForGpu(q);
    return offers
        .filter((o) => (q.includeUnavailable || o.regions.length > 0)
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
