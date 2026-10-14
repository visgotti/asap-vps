// Lambda's regions: the reference its own place names and its translation of the library's regions are made from
// (LambdaRegionName, LAMBDA_ENUMS.regions), and what `npm run places:check` holds the live API to. Read on 2026-10-14 from
// GET /api/v1/regions: each region's name and description. Where one is is its description: a city or a state, then the
// country ('Osaka, Japan', 'Virginia, USA'), or the country alone ('Germany'). Its capacity is no part of this: an instance
// type's offer says where it can be rented now. A region Lambda adds or retires is a difference the check reports.

import { COUNTRY_TYPES, REGION_TYPES } from '../../constants';
import type { Place } from '../../Core/utils/places';

/** A region as Lambda lists it, and the library's reading of it (its country, its regions of the library's). */
export type LambdaRegion = Place & { readonly name: string, readonly description: string, readonly country: COUNTRY_TYPES };

export const LAMBDA_REGIONS = [
    { name: 'us-east-1', description: 'Virginia, USA', country: COUNTRY_TYPES.US, area: REGION_TYPES.US_VIRGINIA, place: REGION_TYPES.US_VIRGINIA_1 },
    { name: 'us-east-2', description: 'Washington DC, USA', country: COUNTRY_TYPES.US, area: REGION_TYPES.US_WASHINGTON_DC, place: REGION_TYPES.US_WASHINGTON_DC_2 },
    { name: 'us-east-3', description: 'Washington DC, USA', country: COUNTRY_TYPES.US, area: REGION_TYPES.US_WASHINGTON_DC, place: REGION_TYPES.US_WASHINGTON_DC_3 },
    { name: 'us-west-1', description: 'California, USA', country: COUNTRY_TYPES.US, area: REGION_TYPES.US_CALIFORNIA, place: REGION_TYPES.US_CALIFORNIA_1 },
    { name: 'us-west-2', description: 'Arizona, USA', country: COUNTRY_TYPES.US, area: REGION_TYPES.US_ARIZONA, place: REGION_TYPES.US_ARIZONA_2 },
    { name: 'us-west-3', description: 'Utah, USA', country: COUNTRY_TYPES.US, area: REGION_TYPES.US_UTAH, place: REGION_TYPES.US_UTAH_3 },
    { name: 'us-midwest-1', description: 'Illinois, USA', country: COUNTRY_TYPES.US, area: REGION_TYPES.US_ILLINOIS, place: REGION_TYPES.US_ILLINOIS_1 },
    { name: 'us-midwest-2', description: 'Ohio, USA', country: COUNTRY_TYPES.US, area: REGION_TYPES.US_OHIO, place: REGION_TYPES.US_OHIO_2 },
    { name: 'us-southeast-1', description: 'Georgia, USA', country: COUNTRY_TYPES.US, area: REGION_TYPES.US_GEORGIA, place: REGION_TYPES.US_GEORGIA_1 },
    { name: 'us-south-1', description: 'Texas, USA', country: COUNTRY_TYPES.US, area: REGION_TYPES.US_TEXAS, place: REGION_TYPES.US_TEXAS_1 },
    { name: 'us-south-2', description: 'North Texas, USA', country: COUNTRY_TYPES.US, area: REGION_TYPES.US_NORTH_TEXAS, place: REGION_TYPES.US_NORTH_TEXAS_2 },
    { name: 'us-south-3', description: 'Central Texas, USA', country: COUNTRY_TYPES.US, area: REGION_TYPES.US_CENTRAL_TEXAS, place: REGION_TYPES.US_CENTRAL_TEXAS_3 },
    { name: 'asia-northeast-1', description: 'Osaka, Japan', country: COUNTRY_TYPES.JP, area: REGION_TYPES.JAPAN_OSAKA, place: REGION_TYPES.JAPAN_OSAKA_1 },
    { name: 'asia-northeast-2', description: 'Tokyo, Japan', country: COUNTRY_TYPES.JP, area: REGION_TYPES.JAPAN_TOKYO, place: REGION_TYPES.JAPAN_TOKYO_2 },
    { name: 'asia-south-1', description: 'India', country: COUNTRY_TYPES.IN, area: REGION_TYPES.INDIA, place: REGION_TYPES.INDIA_1 },
    { name: 'australia-east-1', description: 'Sydney, Australia', country: COUNTRY_TYPES.AU, area: REGION_TYPES.AUSTRALIA_SYDNEY, place: REGION_TYPES.AUSTRALIA_SYDNEY_1 },
    { name: 'europe-central-1', description: 'Germany', country: COUNTRY_TYPES.DE, area: REGION_TYPES.GERMANY, place: REGION_TYPES.GERMANY_1 },
    { name: 'me-west-1', description: 'Israel', country: COUNTRY_TYPES.IL, area: REGION_TYPES.ISRAEL, place: REGION_TYPES.ISRAEL_1 },
] as const satisfies readonly LambdaRegion[];
