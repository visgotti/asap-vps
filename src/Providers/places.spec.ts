// Places, in the library's words, as each provider's reference data has them
// (src/Providers/<Platform>/places.ts): every region of the library's is some
// provider's, and in one country, the one every provider's data says; each
// provider's translation table is its data's; its own reading of a place's
// country agrees with its data; and a name the library's regions had before
// 0.1.0 is refused, never sent as a platform's own. What a provider does with
// them through its calls is the contract's (contract.spec.ts); what its types
// take, typing.spec.ts's. Whether the data is still the providers' is
// `npm run places:check`'s.

import { COUNTRY_TYPES, REGION_COUNTRIES, REGION_TYPES } from '../constants';
import { asCountry, refuseRetiredRegion, RETIRED_REGIONS } from '../Core/utils/places';
import { countryOf as digitalOceanCountryOf, DIGITALOCEAN_ENUMS } from './DigitalOcean/mappers';
import { DIGITALOCEAN_DATACENTERS } from './DigitalOcean/places';
import { countryOf as lambdaCountryOf, LAMBDA_ENUMS } from './LambdaCloud/mappers';
import { LAMBDA_REGIONS } from './LambdaCloud/places';
import { countryOf as runPodCountryOf, RUNPOD_ENUMS } from './RunPod/mappers';
import { RUNPOD_DATA_CENTERS } from './RunPod/places';
import { countryOf as scalewayCountryOf, SCALEWAY_ENUMS } from './Scaleway/mappers';
import { SCALEWAY_PLACES } from './Scaleway/places';
import { SCALEWAY_REGIONS, SCALEWAY_ZONES } from './Scaleway/types';
import { countryOf as vastCountryOf } from './VastAI/mappers';
import { VAST_LOCATIONS } from './VastAI/places';

/** A place of a provider's data, read the same way for each: its own name, its country, its regions of the library's. */
type Read = { own: string, country: string, place?: string, area?: string };
type Provider = { name: string, places: Read[], table: Readonly<Record<string, string>>, countryOf: (own: string) => string | undefined };

const PROVIDERS: Provider[] = [
    { name: 'DigitalOcean', places: DIGITALOCEAN_DATACENTERS.map((d) => ({ ...d, own: d.slug })), table: DIGITALOCEAN_ENUMS.regions, countryOf: digitalOceanCountryOf },
    { name: 'RunPod', places: RUNPOD_DATA_CENTERS.map((d) => ({ ...d, own: d.id })), table: RUNPOD_ENUMS.regions, countryOf: runPodCountryOf },
    {
        name: 'Lambda', places: LAMBDA_REGIONS.map((r) => ({ ...r, own: r.name })), table: LAMBDA_ENUMS.regions,
        countryOf: (own) => lambdaCountryOf(LAMBDA_REGIONS.find((r) => r.name === own)),
    },
    { name: 'Scaleway', places: SCALEWAY_PLACES.map((p) => ({ ...p, own: p.name })), table: SCALEWAY_ENUMS.regions, countryOf: scalewayCountryOf },
];

/** A member's name in REGION_TYPES ('FRANCE_PARIS_2'), by its value ('france_paris_2'). */
const NAMES = new Map<string, string>(Object.entries(REGION_TYPES).map(([name, value]) => [value, name]));

describe('places: the library\'s regions', () => {
    it('every region is some provider\'s place or area, and every place or area of a provider\'s data is a region', () => {
        const used = new Set(PROVIDERS.flatMap((p) => p.places.flatMap((r) => [r.place, r.area]).filter((m): m is string => m !== undefined)));
        expect([...used].sort()).toEqual(Object.values<string>(REGION_TYPES).sort());
        expect(used.size).toBe(124);
    });

    it('each is in one country, the one every provider\'s data says for it; no other key, and none added at run time', () => {
        const strays = PROVIDERS.flatMap((p) => p.places.flatMap((r) => [r.place, r.area]
            .filter((m): m is string => m !== undefined && REGION_COUNTRIES[m as REGION_TYPES] !== r.country)
            .map((m) => [p.name, r.own, m, REGION_COUNTRIES[m as REGION_TYPES], r.country])));
        expect(strays).toEqual([]);
        expect(Object.keys(REGION_COUNTRIES).sort()).toEqual(Object.values<string>(REGION_TYPES).sort());
        expect(Object.values<string>(REGION_COUNTRIES).filter((c) => !Object.values<string>(COUNTRY_TYPES).includes(c))).toEqual([]);
        expect(Object.isFrozen(REGION_COUNTRIES)).toBe(true);
    });

    it('a member\'s value is its name in lower case, and a numbered member\'s area is a member too, in the same country', () => {
        expect(Object.entries(REGION_TYPES).filter(([name, value]) => value !== name.toLowerCase())).toEqual([]);
        const numbered = Object.keys(REGION_TYPES).filter((name) => /_\d+$/.test(name));
        const orphans = numbered.filter((name) => {
            const area = REGION_TYPES[name.replace(/_\d+$/, '') as keyof typeof REGION_TYPES];
            return area === undefined || REGION_COUNTRIES[area] !== REGION_COUNTRIES[REGION_TYPES[name as keyof typeof REGION_TYPES]];
        });
        expect(orphans).toEqual([]);
        expect(numbered.length).toBeGreaterThan(0);
    });

    it('countries are every ISO 3166-1 alpha-2 code that is a country\'s, each its own value, in order', () => {
        expect(Object.entries(COUNTRY_TYPES).filter(([name, value]) => name !== value || !/^[A-Z]{2}$/.test(value))).toEqual([]);
        const codes = Object.values<string>(COUNTRY_TYPES);
        expect(codes).toHaveLength(249);
        expect(codes).toEqual([...codes].sort());
        // Codes ISO gives no country: reserved for the United Kingdom (whose code is GB) or the European Union, or never given.
        expect(['UK', 'EU', 'XK', 'ZZ'].filter((c) => codes.includes(c))).toEqual([]);
        // Israel, which Lambda's regions name: a country a provider reports is one the library has.
        expect(lambdaCountryOf({ description: 'Israel' })).toBe(COUNTRY_TYPES.IL);
    });

    it('asCountry: a code as a member where ISO gives a country it, else undefined (never the code back)', () => {
        expect([asCountry('US'), asCountry('KR'), asCountry('NA'), asCountry('ZW')]).toEqual([COUNTRY_TYPES.US, COUNTRY_TYPES.KR, COUNTRY_TYPES.NA, COUNTRY_TYPES.ZW]);
        expect([asCountry('UK'), asCountry('us'), asCountry('USA'), asCountry(''), asCountry(null), asCountry(undefined), asCountry('toString')]).toEqual([undefined, undefined, undefined, undefined, undefined, undefined, undefined]);
    });
});

describe('places: each provider\'s reference data', () => {
    describe.each(PROVIDERS)('$name', (p) => {
        it('names each place once, and gives each region of the library\'s to one place at most', () => {
            const owns = p.places.map((r) => r.own);
            expect(new Set(owns).size).toBe(owns.length);
            const members = p.places.map((r) => r.place).filter((m) => m !== undefined);
            expect(new Set(members).size).toBe(members.length);
        });

        it('its translation table is its data\'s: a place\'s region is that place, an area\'s the first place there in the data\'s order', () => {
            const expected: Record<string, string> = {};
            for (const r of p.places) {
                if (r.place) expected[r.place] = r.own;
                if (r.area && p.places.find((x) => x.area === r.area) === r) expected[r.area] = r.own;
            }
            expect(p.table).toEqual(expected);
            expect(Object.isFrozen(p.table)).toBe(true);
            // Every key is a member, every value a place of the data.
            expect(Object.keys(p.table).filter((k) => !NAMES.has(k))).toEqual([]);
            expect(Object.values(p.table).filter((v) => !p.places.some((r) => r.own === v))).toEqual([]);
        });

        it('reads every place of its data in the country its data says', () => {
            expect(p.places.map((r) => [r.own, p.countryOf(r.own)])).toEqual(p.places.map((r) => [r.own, r.country]));
        });
    });

    it('DigitalOcean: a legacy datacenter (no new resources) has no region of the library\'s; every open one has its own and its city\'s', () => {
        expect(DIGITALOCEAN_DATACENTERS.filter((d) => !d.available).map((d) => [d.slug, 'place' in d, 'area' in d])).toEqual([['ams2', false, false], ['sfo1', false, false]]);
        expect(DIGITALOCEAN_DATACENTERS.filter((d) => d.available && !('place' in d && 'area' in d))).toEqual([]);
        // A datacenter the data does not have yet is in its city's country, by its slug's letters; another city is in none.
        expect([digitalOceanCountryOf('nyc4'), digitalOceanCountryOf('tor2'), digitalOceanCountryOf('xyz1'), digitalOceanCountryOf(undefined)]).toEqual(['US', 'CA', undefined, undefined]);
    });

    it('RunPod: where a data center is is read from its id: a US state, Montreal, or the country alone', () => {
        const at = (id: string) => RUNPOD_DATA_CENTERS.find((d) => d.id === id)!;
        expect([at('US-TX-3'), at('CA-MTL-4'), at('EU-RO-1'), at('EUR-IS-5')].map((d) => [d.area, d.place])).toEqual([
            ['us_texas', 'us_texas_3'], ['canada_montreal', 'canada_montreal_4'], ['romania', 'romania_1'], ['iceland', 'iceland_5'],
        ]);
        // An id the data does not have yet is read by its shape.
        expect([runPodCountryOf('US-ZZ-9'), runPodCountryOf('EU-PT-1'), runPodCountryOf('XX-NOWHERE-1'), runPodCountryOf(null)]).toEqual(['US', 'PT', undefined, undefined]);
        // Of that shape, but a code ISO gives no country: in none, never a code the library does not have.
        expect([runPodCountryOf('EU-UK-1'), runPodCountryOf('AP-XX-1'), runPodCountryOf('EU')]).toEqual([undefined, undefined, undefined]);
    });

    it('Lambda: where a region is is its description: a city or state before the country, or the country alone', () => {
        const at = (name: string) => LAMBDA_REGIONS.find((r) => r.name === name)!;
        expect([at('us-east-2'), at('us-east-3'), at('asia-northeast-1'), at('europe-central-1')].map((r) => [r.description, r.area, r.place])).toEqual([
            ['Washington DC, USA', 'us_washington_dc', 'us_washington_dc_2'], ['Washington DC, USA', 'us_washington_dc', 'us_washington_dc_3'],
            ['Osaka, Japan', 'japan_osaka', 'japan_osaka_1'], ['Germany', 'germany', 'germany_1'],
        ]);
    });

    it('Scaleway: its places are its zones and regions, each zone in one of them, each region its city\'s region of the library\'s', () => {
        expect(['fr-par-2', 'it-mil', 'xx-abc-1'].map(scalewayCountryOf)).toEqual(['FR', 'IT', undefined]);
        expect(SCALEWAY_PLACES.filter((p) => p.kind === 'zone').map((p) => p.name)).toEqual([...SCALEWAY_ZONES]);
        expect(SCALEWAY_PLACES.filter((p) => p.kind === 'region').map((p) => [p.name, 'area' in p ? p.area : undefined])).toEqual([
            ['fr-par', 'france_paris'], ['nl-ams', 'netherlands_amsterdam'], ['pl-waw', 'poland_warsaw'], ['it-mil', 'italy_milan'],
        ]);
        expect([...SCALEWAY_REGIONS]).toEqual(['fr-par', 'nl-ams', 'pl-waw', 'it-mil']);
        expect(SCALEWAY_PLACES.filter((p) => p.kind === 'zone' && !SCALEWAY_REGIONS.some((r) => 'region' in p && p.region === r))).toEqual([]);
    });

    it('Vast: its sample\'s countries are ISO codes, and its locations\' shapes read to them', () => {
        expect(VAST_LOCATIONS.countries.filter((c) => !/^[A-Z]{2}$/.test(c))).toEqual([]);
        expect(VAST_LOCATIONS.countries.length).toBeGreaterThan(20);
        expect([...VAST_LOCATIONS.countries]).toEqual([...new Set(VAST_LOCATIONS.countries)].sort());
        expect([VAST_LOCATIONS.readAt, VAST_LOCATIONS.locations > 0, VAST_LOCATIONS.asks >= VAST_LOCATIONS.locations + VAST_LOCATIONS.nowhere]).toEqual(['2026-10-14', true, true]);
        // The locations with nothing before the code are of the shape the type has, and read to their country.
        expect(VAST_LOCATIONS.withoutPlace.map(vastCountryOf)).toEqual(['CA', 'CN', 'US']);
        expect(['Texas, US', ', US', 'Japan, JP', 'SE'].map(vastCountryOf)).toEqual(['US', 'US', 'JP', 'SE']);
        // A code ISO gives no country is none: never one the library does not have.
        expect(['London, UK', 'EU', 'Texas', '', null].map(vastCountryOf)).toEqual([undefined, undefined, undefined, undefined, undefined]);
        // Every country of the sample is one of the library's.
        expect(VAST_LOCATIONS.countries.filter((c) => asCountry(c) === undefined)).toEqual([]);
        expect(Object.isFrozen(VAST_LOCATIONS)).toBe(true);
    });
});

describe('places: the names before 0.1.0', () => {
    it('each is refused, naming the region it is now, before anything is sent as a platform\'s own', () => {
        expect(() => refuseRetiredRegion('toronto')).toThrow(expect.objectContaining({ name: 'ProviderError', message: 'asap-vps: region "toronto" is REGION_TYPES.CANADA_TORONTO ("canada_toronto") since 0.1.0' }));
        expect(() => refuseRetiredRegion('paris_2')).toThrow('asap-vps: region "paris_2" is REGION_TYPES.FRANCE_PARIS_2 ("france_paris_2") since 0.1.0');
        expect(() => refuseRetiredRegion('san_francisco_1')).toThrow('asap-vps: region "san_francisco_1" was DigitalOcean\'s sfo1, a legacy datacenter closed to new resources: no region of the library\'s is it now, so name it "sfo1"');
        // Every one names a region of the library's now, or none (sfo1), and none is a name of the library's now.
        expect(Object.values(RETIRED_REGIONS).filter((m) => m !== null && !NAMES.has(m))).toEqual([]);
        expect(Object.keys(RETIRED_REGIONS).filter((old) => NAMES.has(old))).toEqual([]);
        expect(Object.keys(RETIRED_REGIONS)).toHaveLength(20);
        expect(Object.isFrozen(RETIRED_REGIONS)).toBe(true);
    });

    it('a name that is the library\'s now, a platform\'s own, or one that only looks retired goes through', () => {
        for (const ok of ['canada_toronto', 'nyc1', 'nyc3', 'fr-par-2', 'US-TX-3', 'toString', 'constructor']) expect(() => refuseRetiredRegion(ok)).not.toThrow();
    });
});
