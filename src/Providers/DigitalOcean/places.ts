// DigitalOcean's datacenters: the reference its own place names, their countries and its translation of the library's
// regions are made from (DigitalOceanRegionName, countryOf, DIGITALOCEAN_ENUMS.regions), and what `npm run places:check`
// holds the live API to. Read on 2026-10-14 from:
// - GET /v2/regions: each datacenter's slug and name, and `available`, whether the account that read it can make new
//   resources there;
// - docs.digitalocean.com/platform/regional-availability: each one's city and country, and that ams2 and sfo1 are legacy
//   datacenters closed to new resources (an account with Droplets there may still add more).
// A legacy datacenter has no region of the library's: it goes by its slug. A datacenter DigitalOcean opens, closes or
// renames is a difference the check reports: update this list from what it says, and the types and the table follow.

import { COUNTRY_TYPES, REGION_TYPES } from '../../constants';
import type { Place } from '../../Core/utils/places';

/** A datacenter as DigitalOcean lists it, and the library's reading of it (its country; its regions of the library's, where it takes new resources). */
export type DigitalOceanDatacenter = Place & { readonly slug: string, readonly name: string, readonly available: boolean, readonly city: string, readonly country: COUNTRY_TYPES };

export const DIGITALOCEAN_DATACENTERS = [
    { slug: 'nyc1', name: 'New York 1', available: true, city: 'New York City', country: COUNTRY_TYPES.US, area: REGION_TYPES.US_NEW_YORK, place: REGION_TYPES.US_NEW_YORK_1 },
    { slug: 'nyc2', name: 'New York 2', available: true, city: 'New York City', country: COUNTRY_TYPES.US, area: REGION_TYPES.US_NEW_YORK, place: REGION_TYPES.US_NEW_YORK_2 },
    { slug: 'nyc3', name: 'New York 3', available: true, city: 'New York City', country: COUNTRY_TYPES.US, area: REGION_TYPES.US_NEW_YORK, place: REGION_TYPES.US_NEW_YORK_3 },
    { slug: 'ams3', name: 'Amsterdam 3', available: true, city: 'Amsterdam', country: COUNTRY_TYPES.NL, area: REGION_TYPES.NETHERLANDS_AMSTERDAM, place: REGION_TYPES.NETHERLANDS_AMSTERDAM_3 },
    { slug: 'sfo2', name: 'San Francisco 2', available: true, city: 'San Francisco', country: COUNTRY_TYPES.US, area: REGION_TYPES.US_SAN_FRANCISCO, place: REGION_TYPES.US_SAN_FRANCISCO_2 },
    { slug: 'sfo3', name: 'San Francisco 3', available: true, city: 'San Francisco', country: COUNTRY_TYPES.US, area: REGION_TYPES.US_SAN_FRANCISCO, place: REGION_TYPES.US_SAN_FRANCISCO_3 },
    { slug: 'sgp1', name: 'Singapore 1', available: true, city: 'Singapore', country: COUNTRY_TYPES.SG, area: REGION_TYPES.SINGAPORE, place: REGION_TYPES.SINGAPORE_1 },
    { slug: 'lon1', name: 'London 1', available: true, city: 'London', country: COUNTRY_TYPES.GB, area: REGION_TYPES.UK_LONDON, place: REGION_TYPES.UK_LONDON_1 },
    { slug: 'fra1', name: 'Frankfurt 1', available: true, city: 'Frankfurt', country: COUNTRY_TYPES.DE, area: REGION_TYPES.GERMANY_FRANKFURT, place: REGION_TYPES.GERMANY_FRANKFURT_1 },
    { slug: 'tor1', name: 'Toronto 1', available: true, city: 'Toronto', country: COUNTRY_TYPES.CA, area: REGION_TYPES.CANADA_TORONTO, place: REGION_TYPES.CANADA_TORONTO_1 },
    { slug: 'blr1', name: 'Bangalore 1', available: true, city: 'Bangalore', country: COUNTRY_TYPES.IN, area: REGION_TYPES.INDIA_BANGALORE, place: REGION_TYPES.INDIA_BANGALORE_1 },
    { slug: 'syd1', name: 'Sydney 1', available: true, city: 'Sydney', country: COUNTRY_TYPES.AU, area: REGION_TYPES.AUSTRALIA_SYDNEY, place: REGION_TYPES.AUSTRALIA_SYDNEY_1 },
    { slug: 'atl1', name: 'Atlanta 1', available: true, city: 'Atlanta', country: COUNTRY_TYPES.US, area: REGION_TYPES.US_ATLANTA, place: REGION_TYPES.US_ATLANTA_1 },
    { slug: 'ric1', name: 'Richmond 1', available: true, city: 'Richmond', country: COUNTRY_TYPES.US, area: REGION_TYPES.US_RICHMOND, place: REGION_TYPES.US_RICHMOND_1 },
    { slug: 'mkc1', name: 'Kansas City 1', available: true, city: 'Kansas City', country: COUNTRY_TYPES.US, area: REGION_TYPES.US_KANSAS_CITY, place: REGION_TYPES.US_KANSAS_CITY_1 },
    { slug: 'mem1', name: 'Memphis 1', available: true, city: 'Memphis', country: COUNTRY_TYPES.US, area: REGION_TYPES.US_MEMPHIS, place: REGION_TYPES.US_MEMPHIS_1 },
    { slug: 'ams2', name: 'Amsterdam 2', available: false, city: 'Amsterdam', country: COUNTRY_TYPES.NL },
    { slug: 'sfo1', name: 'San Francisco 1', available: false, city: 'San Francisco', country: COUNTRY_TYPES.US },
] as const satisfies readonly DigitalOceanDatacenter[];
