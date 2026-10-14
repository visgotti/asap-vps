// A platform's places as the library reads them: each one's own name, the
// regions of the library's (REGION_TYPES) that stand for it, and the country it
// is in (one of COUNTRY_TYPES, never a code ISO gives none: asCountry). Each
// provider's reference data (src/Providers/<Platform>/places.ts) is a list of
// these, and its translation table and its type of the regions it has are made
// from that list, so the three cannot disagree.

import { COUNTRY_TYPES, REGION_TYPES } from '../../constants';
import { ProviderError } from '../../errors';

/**
 * One of a platform's places, as the library reads it: the country it is in,
 * its own region of the library's (`place`), and the area it is in (`area`: its
 * city, state or country), where it has them: a place no new resource can be
 * made in has none.
 */
export type Place = { readonly country: COUNTRY_TYPES, readonly place?: REGION_TYPES, readonly area?: REGION_TYPES };

const COUNTRIES = new Set<string>(Object.values(COUNTRY_TYPES));

/** `code` as a country of the library's, where ISO 3166-1 alpha-2 gives a country that code ('US'); undefined for any other ('UK', 'EU', 'us'). */
export function asCountry(code: string | null | undefined): COUNTRY_TYPES | undefined {
    return COUNTRIES.has(code ?? '') ? code as COUNTRY_TYPES : undefined;
}

/** The regions of the library's that a platform has: every place's own and every area's. */
export type RegionPick<P extends Place> = (P extends { readonly place: infer M extends REGION_TYPES } ? M : never) | (P extends { readonly area: infer A extends REGION_TYPES } ? A : never);

/**
 * A platform's translation of the library's regions, made from its places: a
 * place's own region is that place, and an area's region is the area's first
 * place in the list (which lists them in the platform's own order).
 */
export function regionTable<P extends Place, O extends string>(places: readonly P[], own: (p: P) => O): Readonly<Record<RegionPick<P>, O>> {
    const table: Partial<Record<REGION_TYPES, O>> = {};
    for (const p of places) {
        if (p.place !== undefined) table[p.place] = own(p);
        if (p.area !== undefined && table[p.area] === undefined) table[p.area] = own(p);
    }
    return Object.freeze(table) as Readonly<Record<RegionPick<P>, O>>;
}

/**
 * The library's names for its regions before 0.1.0, each by the region that is
 * that place now (null: no region of the library's is: DigitalOcean's sfo1 is a
 * legacy datacenter, closed to new resources). 'nyc1' to 'nyc3' were the
 * library's names too, and are DigitalOcean's own for the same places: those
 * still go through.
 */
export const RETIRED_REGIONS: Readonly<Record<string, REGION_TYPES | null>> = Object.freeze({
    nyc: REGION_TYPES.US_NEW_YORK,
    toronto: REGION_TYPES.CANADA_TORONTO,
    san_francisco: REGION_TYPES.US_SAN_FRANCISCO,
    san_francisco_1: null,
    san_francisco_2: REGION_TYPES.US_SAN_FRANCISCO_2,
    san_francisco_3: REGION_TYPES.US_SAN_FRANCISCO_3,
    paris: REGION_TYPES.FRANCE_PARIS,
    paris_1: REGION_TYPES.FRANCE_PARIS_1,
    paris_2: REGION_TYPES.FRANCE_PARIS_2,
    paris_3: REGION_TYPES.FRANCE_PARIS_3,
    amsterdam: REGION_TYPES.NETHERLANDS_AMSTERDAM,
    amsterdam_1: REGION_TYPES.NETHERLANDS_AMSTERDAM_1,
    amsterdam_2: REGION_TYPES.NETHERLANDS_AMSTERDAM_2,
    amsterdam_3: REGION_TYPES.NETHERLANDS_AMSTERDAM_3,
    warsaw: REGION_TYPES.POLAND_WARSAW,
    warsaw_1: REGION_TYPES.POLAND_WARSAW_1,
    warsaw_2: REGION_TYPES.POLAND_WARSAW_2,
    warsaw_3: REGION_TYPES.POLAND_WARSAW_3,
    milan: REGION_TYPES.ITALY_MILAN,
    milan_1: REGION_TYPES.ITALY_MILAN_1,
});

const MEMBER_NAMES = new Map<string, string>(Object.entries(REGION_TYPES).map(([name, value]) => [value, name]));

/**
 * Refuses a name the library's regions had before 0.1.0 (a config written for
 * 0.0.x), naming the region it is now, before anything is asked of a platform:
 * sent as the platform's own name, it would read as a place with no stock.
 */
export function refuseRetiredRegion(region: string): void {
    if (!Object.prototype.hasOwnProperty.call(RETIRED_REGIONS, region)) return;
    const now = RETIRED_REGIONS[region];
    throw new ProviderError('asap-vps', now
        ? `region "${region}" is REGION_TYPES.${MEMBER_NAMES.get(now)} ("${now}") since 0.1.0`
        : `region "${region}" was DigitalOcean's sfo1, a legacy datacenter closed to new resources: no region of the library's is it now, so name it "sfo1"`);
}
