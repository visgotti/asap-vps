// Scaleway's regions and zones: the reference its translation of the library's regions is made from
// (SCALEWAY_ENUMS.regions), and what `npm run places:check` holds Scaleway's own list to. Read on 2026-10-14: the zones
// from the instance v1 OpenAPI spec's `zone` parameter, the regions from the containers v1 spec's `region`, and each
// region's city from scaleway.com/en/docs/console/account/reference-content/products-availability. Its Go SDK lists the
// same (scaleway-sdk-go scw/locality.go: AllZones, AllRegions), and that is what the check reads: the specs' site answers
// a datacenter's address, as a CI runner's is, with a challenge page. A region's member is the
// region itself (FRANCE_PARIS: fr-par), a zone's its own (FRANCE_PARIS_2: fr-par-2); where a call makes something in a zone,
// a region stands for its first zone this provider reads (Scaleway.zoneOf). SCALEWAY_ZONES and SCALEWAY_REGIONS (types.ts)
// are these names, and npm run scaleway:spec holds them to the specs too.

import { COUNTRY_TYPES, REGION_TYPES } from '../../constants';
import type { Place } from '../../Core/utils/places';

/** A region or a zone of Scaleway's, and the library's reading of it (its country, its region of the library's). */
export type ScalewayPlace = Place & { readonly name: string, readonly kind: 'region' | 'zone', readonly city?: string, readonly region?: string };

export const SCALEWAY_PLACES = [
    { name: 'fr-par', kind: 'region', city: 'Paris', country: COUNTRY_TYPES.FR, area: REGION_TYPES.FRANCE_PARIS },
    { name: 'nl-ams', kind: 'region', city: 'Amsterdam', country: COUNTRY_TYPES.NL, area: REGION_TYPES.NETHERLANDS_AMSTERDAM },
    { name: 'pl-waw', kind: 'region', city: 'Warsaw', country: COUNTRY_TYPES.PL, area: REGION_TYPES.POLAND_WARSAW },
    { name: 'it-mil', kind: 'region', city: 'Milan', country: COUNTRY_TYPES.IT, area: REGION_TYPES.ITALY_MILAN },
    { name: 'fr-par-1', kind: 'zone', region: 'fr-par', country: COUNTRY_TYPES.FR, place: REGION_TYPES.FRANCE_PARIS_1 },
    { name: 'fr-par-2', kind: 'zone', region: 'fr-par', country: COUNTRY_TYPES.FR, place: REGION_TYPES.FRANCE_PARIS_2 },
    { name: 'fr-par-3', kind: 'zone', region: 'fr-par', country: COUNTRY_TYPES.FR, place: REGION_TYPES.FRANCE_PARIS_3 },
    { name: 'nl-ams-1', kind: 'zone', region: 'nl-ams', country: COUNTRY_TYPES.NL, place: REGION_TYPES.NETHERLANDS_AMSTERDAM_1 },
    { name: 'nl-ams-2', kind: 'zone', region: 'nl-ams', country: COUNTRY_TYPES.NL, place: REGION_TYPES.NETHERLANDS_AMSTERDAM_2 },
    { name: 'nl-ams-3', kind: 'zone', region: 'nl-ams', country: COUNTRY_TYPES.NL, place: REGION_TYPES.NETHERLANDS_AMSTERDAM_3 },
    { name: 'pl-waw-1', kind: 'zone', region: 'pl-waw', country: COUNTRY_TYPES.PL, place: REGION_TYPES.POLAND_WARSAW_1 },
    { name: 'pl-waw-2', kind: 'zone', region: 'pl-waw', country: COUNTRY_TYPES.PL, place: REGION_TYPES.POLAND_WARSAW_2 },
    { name: 'pl-waw-3', kind: 'zone', region: 'pl-waw', country: COUNTRY_TYPES.PL, place: REGION_TYPES.POLAND_WARSAW_3 },
    { name: 'it-mil-1', kind: 'zone', region: 'it-mil', country: COUNTRY_TYPES.IT, place: REGION_TYPES.ITALY_MILAN_1 },
] as const satisfies readonly ScalewayPlace[];
