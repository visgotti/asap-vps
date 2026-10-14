// Holds the library's places to their sources, read-only, and fails when they drift: each provider's reference data
// (src/Providers/<Platform>/places.ts), which its own names for its places, their countries and its translation of the
// library's regions are made from, and the library's countries (COUNTRY_TYPES, src/constants.ts):
//
//   npm run places:check                          every source, each provider's key read as the live suites read it
//   npm run places:check -- runpod lambda         those only: digitalocean, runpod, lambda, scaleway, vast, countries
//
// What it compares, each with the source its data was read from:
//   - DigitalOcean: GET /v2/regions, each datacenter's slug, name and `available`;
//   - RunPod: GET /v2/catalog/datacenters, each data center's id, region and networkVolumeTypes, and that its name is its id;
//   - Lambda: GET /api/v1/regions, each region's name and description;
//   - Scaleway: its zones and regions as its Go SDK lists them (scw/locality.go: AllZones, AllRegions), the same as its
//     specs' (what its data was read from), whose site answers a datacenter's address, a CI runner's, with a challenge;
//   - Vast.ai, which lists no places (a machine is where its host is): a new sample of rentable asks, read as its data's
//     was (VAST_SAMPLE), every location in it one the library reads a country of the library's from; the countries the
//     data's sample had and this one has not, and the other way round, are listed;
//   - countries: ISO's list, as the first copy COUNTRY_TYPES was read from has it: the same codes.
// A place added, gone or changed, a location read to no country, or a source that cannot be read, is a failure (the
// others are read all the same): update the data from what this says,
// and the types, the tables and the tests follow (src/Providers/places.spec.ts). A field a source has that the data does
// not hold is listed, not failed: leaving one out is a choice, but it should be a visible one. A provider whose key is
// not set is skipped, and said to be; nothing of a key is printed.

import { COUNTRY_TYPES } from '../src/constants';
import { DigitalOceanApi } from '../src/Providers/DigitalOcean/api';
import { DIGITALOCEAN_DATACENTERS } from '../src/Providers/DigitalOcean/places';
import type { DigitalOceanRegionData } from '../src/Providers/DigitalOcean/types';
import { LambdaApi } from '../src/Providers/LambdaCloud/api';
import { LAMBDA_REGIONS } from '../src/Providers/LambdaCloud/places';
import { PROVIDERS } from '../src/Providers/registry';
import { RunPodApi } from '../src/Providers/RunPod/api';
import { RUNPOD_DATA_CENTERS } from '../src/Providers/RunPod/places';
import { SCALEWAY_PLACES } from '../src/Providers/Scaleway/places';
import { VastApi } from '../src/Providers/VastAI/api';
import { countryOf as vastCountryOf } from '../src/Providers/VastAI/mappers';
import { VAST_LOCATIONS, VAST_SAMPLE } from '../src/Providers/VastAI/places';
import { loadCredentials } from '../src/testing/live';

/** What is compared of one place (or country), by field: what the data holds of it, or what its source says now. */
export type Fields = Readonly<Record<string, unknown>>;
/** A list of places by their own names. */
export type Listing = ReadonlyMap<string, Fields>;

/** One way the data and its source differ. */
export type Drift =
    | { what: 'added', name: string, now: Fields }
    | { what: 'gone', name: string, was: Fields }
    | { what: 'changed', name: string, field: string, was: unknown, now: unknown }
    /** Vast: a location the library reads no country of its own from. */
    | { what: 'unread', name: string };

/** What a check found: what it read, how the data differs (each a failure), the fields the data does not hold, and what else it saw (said, not failed). */
export type Report = { read: string, drift: Drift[], unheld: string[], notes: string[] };

/** A list as a listing: each item by its own name, with the fields compared. */
export function listing<T>(items: readonly T[], name: (t: NoInfer<T>) => string, fields: (t: NoInfer<T>) => Fields): Listing {
    return new Map(items.map((t) => [name(t), fields(t)]));
}

/** A value as it is compared: a list as the set of its items (its order says nothing), anything else as it is. */
function canonical(v: unknown): string {
    return Array.isArray(v) ? JSON.stringify(v.map((x) => JSON.stringify(x)).sort()) : JSON.stringify(v);
}

/** The data's listing against its source's: each place the source has and the data has not, each field of a place the data holds that the source says otherwise, and each place the data has and the source has not. */
export function diffPlaces(data: Listing, source: Listing): Drift[] {
    const drift: Drift[] = [];
    for (const [name, now] of source) {
        const was = data.get(name);
        if (!was) drift.push({ what: 'added', name, now });
        else for (const field of Object.keys(was)) if (canonical(was[field]) !== canonical(now[field])) drift.push({ what: 'changed', name, field, was: was[field], now: now[field] });
    }
    for (const [name, was] of data) if (!source.has(name)) drift.push({ what: 'gone', name, was });
    return drift;
}

/** The fields the items of a source's answer have that the data does not hold (`held`), in the order they are first seen. */
export function unheld(items: readonly object[], held: readonly string[]): string[] {
    return [...new Set(items.flatMap((i) => Object.keys(i)))].filter((k) => !held.includes(k));
}

const shown = (v: unknown) => (Array.isArray(v) ? (v.length ? v.join(', ') : 'none') : JSON.stringify(v));

/** A difference as the check says it. */
export function explain(d: Drift): string {
    switch (d.what) {
        case 'added': return `${d.name}: the source has it and the data does not${Object.keys(d.now).length ? ` (${Object.entries(d.now).map(([k, v]) => `${k} ${shown(v)}`).join('; ')})` : ''}`;
        case 'gone': return `${d.name}: the data has it and the source no longer does`;
        case 'changed': return `${d.name}: its ${d.field} is ${shown(d.now)}, and the data says ${shown(d.was)}`;
        case 'unread': return `${JSON.stringify(d.name)}: a location countryOf reads no country of the library's from`;
    }
}

/** DigitalOcean: GET /v2/regions's datacenters against DIGITALOCEAN_DATACENTERS. */
export function checkDigitalOcean(regions: readonly DigitalOceanRegionData[]): Report {
    const fields = (d: { name: string, available: boolean }) => ({ name: d.name, available: d.available });
    return {
        read: `${regions.length} datacenters`,
        drift: diffPlaces(listing(DIGITALOCEAN_DATACENTERS, (d) => d.slug, fields), listing(regions, (r) => r.slug, fields)),
        unheld: unheld(regions, ['slug', 'name', 'available']),
        notes: [],
    };
}

/** A data center as GET /v2/catalog/datacenters lists it, the part of it the data holds. */
export type ListedDataCenter = { id: string, name: string, region: string, networkVolumeTypes: readonly string[] };

/** RunPod: GET /v2/catalog/datacenters against RUNPOD_DATA_CENTERS. The data's name for each is its id: RunPod's `name` repeats it, and one of its own would be news. */
export function checkRunPod(dataCenters: readonly ListedDataCenter[]): Report {
    return {
        read: `${dataCenters.length} data centers`,
        drift: diffPlaces(
            listing(RUNPOD_DATA_CENTERS, (d) => d.id, (d) => ({ name: d.id, region: d.region, networkVolumeTypes: d.networkVolumeTypes })),
            listing(dataCenters, (d) => d.id, (d) => ({ name: d.name, region: d.region, networkVolumeTypes: d.networkVolumeTypes })),
        ),
        unheld: unheld(dataCenters, ['id', 'name', 'region', 'networkVolumeTypes']),
        notes: [],
    };
}

/** Lambda: GET /api/v1/regions against LAMBDA_REGIONS. */
export function checkLambda(regions: ReadonlyArray<{ name: string, description: string }>): Report {
    const fields = (r: { description: string }) => ({ description: r.description });
    return {
        read: `${regions.length} regions`,
        drift: diffPlaces(listing(LAMBDA_REGIONS, (r) => r.name, fields), listing(regions, (r) => r.name, fields)),
        unheld: unheld(regions, ['name', 'description']),
        notes: [],
    };
}

/** Scaleway: the zones and regions its specs take against SCALEWAY_PLACES. */
export function checkScaleway(zones: readonly string[], regions: readonly string[]): Report {
    const kind = (p: { kind: string }) => ({ kind: p.kind });
    const source = [...regions.map((name) => ({ name, kind: 'region' })), ...zones.map((name) => ({ name, kind: 'zone' }))];
    return {
        read: `${regions.length} regions, ${zones.length} zones`,
        drift: diffPlaces(listing(SCALEWAY_PLACES, (p) => p.name, kind), listing(source, (p) => p.name, kind)),
        unheld: [],
        notes: [],
    };
}

/** A sample's locations (each with how many of its asks are there; null: asks whose host says nowhere) as VAST_LOCATIONS holds its own. */
export function vastSample(locations: ReadonlyMap<string | null, number>, readAt: string) {
    const said = [...locations.keys()].filter((l): l is string => l !== null);
    return {
        readAt,
        asks: [...locations.values()].reduce((a, b) => a + b, 0),
        nowhere: locations.get(null) ?? 0,
        locations: said.length,
        withoutPlace: said.filter((l) => l.startsWith(', ')).sort(),
        countries: [...new Set(said.map(vastCountryOf).filter((c): c is COUNTRY_TYPES => c !== undefined))].sort(),
    };
}

/**
 * Vast: a sample's locations against VAST_LOCATIONS. A location no country of
 * the library's is read from fails; the rest is the market moving, and is
 * said: the countries one sample has and the other has not, and, where they
 * differ, this sample as the data would hold it.
 */
export function checkVast(locations: ReadonlyMap<string | null, number>, readAt = new Date().toISOString().slice(0, 10)): Report {
    const sample = vastSample(locations, readAt);
    const known = new Set<string>(VAST_LOCATIONS.countries);
    const added = sample.countries.filter((c) => !known.has(c));
    const unseen = [...known].filter((c) => !sample.countries.includes(c as COUNTRY_TYPES));
    const moved = added.length > 0 || unseen.length > 0 || canonical(sample.withoutPlace) !== canonical(VAST_LOCATIONS.withoutPlace);
    return {
        read: `${sample.asks} asks, ${sample.locations} locations (${sample.withoutPlace.length} without a place before the code), ${sample.countries.length} countries`,
        drift: [...locations.keys()].filter((l): l is string => l !== null && vastCountryOf(l) === undefined).map((name) => ({ what: 'unread', name })),
        unheld: [],
        notes: [
            ...(sample.nowhere ? [`${sample.nowhere} asks say no location: an offer of one is in no country`] : []),
            ...(added.length ? [`countries the data's sample had not: ${added.join(', ')}`] : []),
            ...(unseen.length ? [`countries the data's sample had and this one has not: ${unseen.join(', ')}`] : []),
            ...(moved ? [`this sample as VAST_LOCATIONS: ${JSON.stringify(sample)}`] : []),
        ],
    };
}

/** Countries: ISO's list of codes against COUNTRY_TYPES. */
export function checkCountries(codes: readonly string[]): Report {
    const none = () => ({});
    return { read: `${codes.length} codes`, drift: diffPlaces(listing(Object.values(COUNTRY_TYPES), (c) => c, none), listing(codes, (c) => c, none)), unheld: [], notes: [] };
}

// ── the sources, read ────────────────────────────────────────────────────

/** The first of the two copies of ISO's list COUNTRY_TYPES was read from (src/constants.ts). */
export const ISO_COUNTRIES = 'https://raw.githubusercontent.com/lukes/ISO-3166-Countries-with-Regional-Codes/master/all/all.json';
/** Scaleway's Go SDK's list of its zones and regions: its specs' own, served to any address. */
export const SCALEWAY_LOCALITIES = 'https://raw.githubusercontent.com/scaleway/scaleway-sdk-go/master/scw/locality.go';

/**
 * The zones and regions the SDK's locality.go lists (AllZones, AllRegions), each
 * by its name ('fr-par-1'). Throws where it lists none, or names a constant it
 * gives no name: a file of another shape is not read as no places.
 */
export function sdkLocalities(go: string): { zones: string[], regions: string[] } {
    const names = new Map([...go.matchAll(/^\s*(\w+)\s*=\s*(?:Zone|Region)\("([^"]+)"\)/gm)].map((m) => [m[1], m[2]]));
    const list = (name: string) => {
        const body = new RegExp(`^var ${name} = \\[\\](?:Zone|Region)\\{([^}]*)\\}`, 'm').exec(go)?.[1];
        if (body === undefined) throw new Error(`the SDK's locality.go has no ${name}`);
        const constants = body.replace(/\/\/.*$/gm, '').split(/[\s,]+/).filter(Boolean);
        if (!constants.length) throw new Error(`the SDK's ${name} is empty`);
        return constants.map((c) => {
            const value = names.get(c);
            if (value === undefined) throw new Error(`the SDK's ${name} names ${c}, which locality.go gives no name`);
            return value;
        });
    };
    return { zones: list('AllZones'), regions: list('AllRegions') };
}

/** A public source's text: one that answers anything but a success (a challenge page, an outage) is not read. */
async function fetchText(url: string): Promise<string> {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`${url} answered ${r.status} ${r.statusText}`.trim());
    return r.text();
}

/** An error as one line of the report: its first line, at most 300 characters (an answer it quotes can be a page long). */
export function oneLine(e: unknown): string {
    return (e instanceof Error ? e.message : String(e)).split('\n')[0].slice(0, 300);
}

const args = process.argv.slice(2);

/** A new sample of Vast's asks, read as its data's was (VAST_SAMPLE): each location by how many distinct asks are there. */
async function sampleVast(api: VastApi): Promise<Map<string | null, number>> {
    const asks = new Map<number, string | null>();
    for (const order of VAST_SAMPLE.orders) {
        for (const type of VAST_SAMPLE.types) {
            const body = await api.call<{ offers?: Array<{ id: number, geolocation?: string | null }> }>('POST', '/api/v0/bundles/', { rentable: { eq: true }, type, order, limit: VAST_SAMPLE.limit }, true);
            for (const a of body.offers ?? []) asks.set(a.id, a.geolocation ?? null);
        }
    }
    const locations = new Map<string | null, number>();
    for (const l of asks.values()) locations.set(l, (locations.get(l) ?? 0) + 1);
    return locations;
}

/** A source: what the check says it reads, the key it reads it with (none: a public one), and the check of it. */
export type Source = { title: string, keyEnv?: string, check: (apiKey: string) => Promise<Report> };

export const SOURCES: Record<string, Source> = {
    digitalocean: {
        title: 'DigitalOcean: GET /v2/regions against DIGITALOCEAN_DATACENTERS', keyEnv: PROVIDERS.digitalocean.keyEnv,
        check: async (apiKey) => checkDigitalOcean(await new DigitalOceanApi({ apiKey }).all<DigitalOceanRegionData>('/v2/regions', 'regions')),
    },
    runpod: {
        title: 'RunPod: GET /v2/catalog/datacenters against RUNPOD_DATA_CENTERS', keyEnv: PROVIDERS.runpod.keyEnv,
        check: async (apiKey) => checkRunPod((await new RunPodApi({ apiKey }).call<{ dataCenters: ListedDataCenter[] }>('GET', '/v2/catalog/datacenters')).dataCenters),
    },
    lambda: {
        title: 'Lambda: GET /api/v1/regions against LAMBDA_REGIONS', keyEnv: PROVIDERS.lambda.keyEnv,
        check: async (apiKey) => checkLambda((await new LambdaApi({ apiKey }).call<{ data: Array<{ name: string, description: string }> }>('GET', '/api/v1/regions')).data),
    },
    scaleway: {
        title: 'Scaleway: its Go SDK\'s zones and regions (scw/locality.go) against SCALEWAY_PLACES',
        check: async () => {
            const { zones, regions } = sdkLocalities(await fetchText(SCALEWAY_LOCALITIES));
            return checkScaleway(zones, regions);
        },
    },
    vast: {
        title: 'Vast.ai: a new sample of POST /api/v0/bundles/ against VAST_LOCATIONS', keyEnv: PROVIDERS.vast.keyEnv,
        check: async (apiKey) => checkVast(await sampleVast(new VastApi({ apiKey }))),
    },
    countries: {
        title: `countries: ISO's list (${ISO_COUNTRIES}) against COUNTRY_TYPES`,
        check: async () => checkCountries((JSON.parse(await fetchText(ISO_COUNTRIES)) as Array<{ 'alpha-2': string }>).map((c) => c['alpha-2'])),
    },
};

async function main(): Promise<void> {
    const named = args.filter((a) => !a.startsWith('--'));
    const unknown = named.filter((n) => !SOURCES[n]);
    if (unknown.length) throw new Error(`no such source: ${unknown.join(', ')} (there are ${Object.keys(SOURCES).join(', ')})`);
    loadCredentials();
    let failures = 0;
    const skipped: string[] = [];
    const unread: string[] = [];
    for (const [name, source] of Object.entries(SOURCES).filter(([n]) => !named.length || named.includes(n))) {
        const apiKey = source.keyEnv ? process.env[source.keyEnv] : '';
        if (source.keyEnv && !apiKey) {
            skipped.push(`${name} (no ${source.keyEnv} set)`);
            continue;
        }
        console.log(`== ${source.title}`);
        let report: Report;
        try {
            report = await source.check(apiKey ?? '');
        } catch (e) {
            // A source that cannot be read is no agreement: a failure, and the others are read all the same.
            console.log(`  FAIL it could not be read: ${oneLine(e)}`);
            unread.push(name);
            continue;
        }
        for (const d of report.drift) console.log(`  FAIL ${explain(d)}`);
        failures += report.drift.length;
        console.log(`  ${report.drift.length ? '    ' : 'ok  '} read ${report.read}${report.drift.length ? '' : ': the data agrees'}`);
        for (const note of report.notes) console.log(`       ${note}`);
        if (report.unheld.length) console.log(`       fields the data does not hold (a choice, listed so it is a visible one): ${report.unheld.join(', ')}`);
    }
    if (skipped.length) console.log(`\nskipped: ${skipped.join('; ')}`);
    const said = [
        ...(failures ? [`${failures} DIFFERENCE(S): update the data from what is above`] : []),
        ...(unread.length ? [`NOT READ: ${unread.join(', ')} (nothing is known of them: read them again)`] : []),
    ];
    console.log(`\n${said.length ? said.join('\n') : 'every place read agrees with its data'}`);
    process.exit(said.length ? 1 : 0);
}

if (require.main === module) {
    main().catch((e) => {
        console.error(e);
        process.exit(2);
    });
}
