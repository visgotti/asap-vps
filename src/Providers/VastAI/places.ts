// Vast.ai's places, which are no list: each offer is one machine, rented where it is. A machine goes by `machine:<id>`
// (machineRegion), and Vast says where it is as "<place>, <CC>": a state, a country's name, or nothing, then the country's
// ISO 3166-1 alpha-2 code ('Texas, US', 'Japan, JP', ', US'), or the code alone ('SE', seen on 2026-10-12).
// VastRegionName is that shape, and countryOf reads the code. Read on 2026-10-14 from POST /api/v0/bundles/, as
// VAST_SAMPLE says: what is below. The market moves by the hour (two samples an hour apart that day differed by three
// countries), so the countries are one sample's, not a list of where Vast is: any country can have a machine on it
// (VastTypes.country is every one). `npm run places:check` reads a new sample, fails on a location no country of the
// library's is read from, and says what else moved.

/**
 * How `npm run places:check` reads a new sample: rentable asks on demand, a
 * page of at most `limit` in each of these orders, each ask counted once. At
 * most 512 rows, what one listOffers reads: Vast counts the rows a search
 * returns against a daily quota of the account's (429 "Daily search row quota
 * exhausted" once it is spent, for every search of the account's that day), and
 * the larger sample below, read five times that day, spent it.
 */
export const VAST_SAMPLE = Object.freeze({
    orders: [[['dph_total', 'asc']], [['reliability', 'desc']], [['dlperf', 'desc']], [['inet_down', 'desc']]],
    types: ['ondemand'],
    limit: 128,
} as const);

/**
 * The sample the shape was read from, larger than VAST_SAMPLE (the same
 * orders, interruptible asks too, up to 1000 a search): when; how many
 * distinct asks, and of them how many say no location; how many distinct
 * locations, and the ones with nothing before the code; the countries. A new
 * sample, smaller, sees fewer of them: the check says which, without failing.
 */
export const VAST_LOCATIONS = Object.freeze({
    readAt: '2026-10-14',
    asks: 1804,
    nowhere: 0,
    locations: 117,
    withoutPlace: [', CA', ', CN', ', US'],
    countries: ['AE', 'AL', 'AR', 'AT', 'AU', 'BE', 'BG', 'BR', 'CA', 'CH', 'CN', 'CZ', 'DE', 'DK', 'EE', 'ES', 'FI', 'FR', 'GB', 'GR', 'HK', 'HR', 'HU', 'ID', 'IE', 'IL', 'IN', 'IS', 'IT', 'JP', 'KR', 'LT', 'LV', 'MX', 'NL', 'NO', 'NZ', 'OM', 'PK', 'PL', 'PT', 'QA', 'RO', 'RS', 'RU', 'SA', 'SE', 'SG', 'SI', 'SK', 'TH', 'TR', 'TW', 'TZ', 'UA', 'US', 'VN', 'ZA'],
} as const);
