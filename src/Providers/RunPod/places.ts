// RunPod's data centers: the reference its own place names, their countries and its translation of the library's regions
// are made from (RunPodRegionName, countryOf, RUNPOD_ENUMS.regions), and what `npm run places:check` holds the live API to.
// Read on 2026-10-14 from GET /v2/catalog/datacenters: each one's id, its part of the world (`region`), and the network
// volumes it makes (`networkVolumeTypes`; none: no network volume there). RunPod's `name` repeats the id, so where a data
// center is is the library's reading of the id: a US state by its USPS code (US-TX-3: Texas), Montreal by MTL (CA-MTL-1),
// else the country alone (EU-RO-1: Romania), whose region of the library's then has no place (ROMANIA_1).
// A data center RunPod opens or closes is a difference the check reports: update this list from what it says.

import { COUNTRY_TYPES, REGION_TYPES } from '../../constants';
import type { Place } from '../../Core/utils/places';

/** A data center as RunPod lists it, and the library's reading of it (its country, its regions of the library's). */
export type RunPodDataCenter = Place & { readonly id: string, readonly region: string, readonly networkVolumeTypes: readonly string[], readonly country: COUNTRY_TYPES };

export const RUNPOD_DATA_CENTERS = [
    { id: 'AP-IN-1', region: 'ASIA', networkVolumeTypes: [], country: COUNTRY_TYPES.IN, area: REGION_TYPES.INDIA, place: REGION_TYPES.INDIA_1 },
    { id: 'AP-JP-1', region: 'ASIA', networkVolumeTypes: ['STANDARD'], country: COUNTRY_TYPES.JP, area: REGION_TYPES.JAPAN, place: REGION_TYPES.JAPAN_1 },
    { id: 'CA-MTL-1', region: 'NORTH_AMERICA', networkVolumeTypes: ['HIGH_PERFORMANCE'], country: COUNTRY_TYPES.CA, area: REGION_TYPES.CANADA_MONTREAL, place: REGION_TYPES.CANADA_MONTREAL_1 },
    { id: 'CA-MTL-3', region: 'NORTH_AMERICA', networkVolumeTypes: ['STANDARD'], country: COUNTRY_TYPES.CA, area: REGION_TYPES.CANADA_MONTREAL, place: REGION_TYPES.CANADA_MONTREAL_3 },
    { id: 'CA-MTL-4', region: 'NORTH_AMERICA', networkVolumeTypes: ['HIGH_PERFORMANCE', 'STANDARD'], country: COUNTRY_TYPES.CA, area: REGION_TYPES.CANADA_MONTREAL, place: REGION_TYPES.CANADA_MONTREAL_4 },
    { id: 'EU-CZ-1', region: 'EUROPE', networkVolumeTypes: [], country: COUNTRY_TYPES.CZ, area: REGION_TYPES.CZECHIA, place: REGION_TYPES.CZECHIA_1 },
    { id: 'EU-FR-1', region: 'EUROPE', networkVolumeTypes: ['HIGH_PERFORMANCE'], country: COUNTRY_TYPES.FR, area: REGION_TYPES.FRANCE, place: REGION_TYPES.FRANCE_1 },
    { id: 'EU-NL-1', region: 'EUROPE', networkVolumeTypes: [], country: COUNTRY_TYPES.NL, area: REGION_TYPES.NETHERLANDS, place: REGION_TYPES.NETHERLANDS_1 },
    { id: 'EU-RO-1', region: 'EUROPE', networkVolumeTypes: ['STANDARD'], country: COUNTRY_TYPES.RO, area: REGION_TYPES.ROMANIA, place: REGION_TYPES.ROMANIA_1 },
    { id: 'EU-SE-1', region: 'EUROPE', networkVolumeTypes: [], country: COUNTRY_TYPES.SE, area: REGION_TYPES.SWEDEN, place: REGION_TYPES.SWEDEN_1 },
    { id: 'EUR-IS-1', region: 'EUROPE', networkVolumeTypes: [], country: COUNTRY_TYPES.IS, area: REGION_TYPES.ICELAND, place: REGION_TYPES.ICELAND_1 },
    { id: 'EUR-IS-2', region: 'EUROPE', networkVolumeTypes: [], country: COUNTRY_TYPES.IS, area: REGION_TYPES.ICELAND, place: REGION_TYPES.ICELAND_2 },
    { id: 'EUR-IS-3', region: 'EUROPE', networkVolumeTypes: ['STANDARD'], country: COUNTRY_TYPES.IS, area: REGION_TYPES.ICELAND, place: REGION_TYPES.ICELAND_3 },
    { id: 'EUR-IS-4', region: 'EUROPE', networkVolumeTypes: [], country: COUNTRY_TYPES.IS, area: REGION_TYPES.ICELAND, place: REGION_TYPES.ICELAND_4 },
    { id: 'EUR-IS-5', region: 'EUROPE', networkVolumeTypes: [], country: COUNTRY_TYPES.IS, area: REGION_TYPES.ICELAND, place: REGION_TYPES.ICELAND_5 },
    { id: 'EUR-NO-1', region: 'EUROPE', networkVolumeTypes: ['STANDARD'], country: COUNTRY_TYPES.NO, area: REGION_TYPES.NORWAY, place: REGION_TYPES.NORWAY_1 },
    { id: 'EUR-NO-2', region: 'EUROPE', networkVolumeTypes: ['HIGH_PERFORMANCE'], country: COUNTRY_TYPES.NO, area: REGION_TYPES.NORWAY, place: REGION_TYPES.NORWAY_2 },
    { id: 'OC-AU-1', region: 'OCEANIA', networkVolumeTypes: [], country: COUNTRY_TYPES.AU, area: REGION_TYPES.AUSTRALIA, place: REGION_TYPES.AUSTRALIA_1 },
    { id: 'US-CA-2', region: 'NORTH_AMERICA', networkVolumeTypes: ['HIGH_PERFORMANCE'], country: COUNTRY_TYPES.US, area: REGION_TYPES.US_CALIFORNIA, place: REGION_TYPES.US_CALIFORNIA_2 },
    { id: 'US-CO-1', region: 'NORTH_AMERICA', networkVolumeTypes: ['STANDARD'], country: COUNTRY_TYPES.US, area: REGION_TYPES.US_COLORADO, place: REGION_TYPES.US_COLORADO_1 },
    { id: 'US-GA-2', region: 'NORTH_AMERICA', networkVolumeTypes: [], country: COUNTRY_TYPES.US, area: REGION_TYPES.US_GEORGIA, place: REGION_TYPES.US_GEORGIA_2 },
    { id: 'US-IL-1', region: 'NORTH_AMERICA', networkVolumeTypes: ['STANDARD'], country: COUNTRY_TYPES.US, area: REGION_TYPES.US_ILLINOIS, place: REGION_TYPES.US_ILLINOIS_1 },
    { id: 'US-KS-2', region: 'NORTH_AMERICA', networkVolumeTypes: [], country: COUNTRY_TYPES.US, area: REGION_TYPES.US_KANSAS, place: REGION_TYPES.US_KANSAS_2 },
    { id: 'US-MD-1', region: 'NORTH_AMERICA', networkVolumeTypes: ['STANDARD'], country: COUNTRY_TYPES.US, area: REGION_TYPES.US_MARYLAND, place: REGION_TYPES.US_MARYLAND_1 },
    { id: 'US-MO-1', region: 'NORTH_AMERICA', networkVolumeTypes: ['STANDARD'], country: COUNTRY_TYPES.US, area: REGION_TYPES.US_MISSOURI, place: REGION_TYPES.US_MISSOURI_1 },
    { id: 'US-MO-2', region: 'NORTH_AMERICA', networkVolumeTypes: [], country: COUNTRY_TYPES.US, area: REGION_TYPES.US_MISSOURI, place: REGION_TYPES.US_MISSOURI_2 },
    { id: 'US-NC-1', region: 'NORTH_AMERICA', networkVolumeTypes: [], country: COUNTRY_TYPES.US, area: REGION_TYPES.US_NORTH_CAROLINA, place: REGION_TYPES.US_NORTH_CAROLINA_1 },
    { id: 'US-NC-2', region: 'NORTH_AMERICA', networkVolumeTypes: ['STANDARD'], country: COUNTRY_TYPES.US, area: REGION_TYPES.US_NORTH_CAROLINA, place: REGION_TYPES.US_NORTH_CAROLINA_2 },
    { id: 'US-NE-1', region: 'NORTH_AMERICA', networkVolumeTypes: ['STANDARD'], country: COUNTRY_TYPES.US, area: REGION_TYPES.US_NEBRASKA, place: REGION_TYPES.US_NEBRASKA_1 },
    { id: 'US-PA-1', region: 'NORTH_AMERICA', networkVolumeTypes: [], country: COUNTRY_TYPES.US, area: REGION_TYPES.US_PENNSYLVANIA, place: REGION_TYPES.US_PENNSYLVANIA_1 },
    { id: 'US-TX-3', region: 'NORTH_AMERICA', networkVolumeTypes: ['STANDARD'], country: COUNTRY_TYPES.US, area: REGION_TYPES.US_TEXAS, place: REGION_TYPES.US_TEXAS_3 },
    { id: 'US-TX-4', region: 'NORTH_AMERICA', networkVolumeTypes: [], country: COUNTRY_TYPES.US, area: REGION_TYPES.US_TEXAS, place: REGION_TYPES.US_TEXAS_4 },
    { id: 'US-WA-1', region: 'NORTH_AMERICA', networkVolumeTypes: [], country: COUNTRY_TYPES.US, area: REGION_TYPES.US_WASHINGTON, place: REGION_TYPES.US_WASHINGTON_1 },
    { id: 'US-WA-2', region: 'NORTH_AMERICA', networkVolumeTypes: [], country: COUNTRY_TYPES.US, area: REGION_TYPES.US_WASHINGTON, place: REGION_TYPES.US_WASHINGTON_2 },
] as const satisfies readonly RunPodDataCenter[];
