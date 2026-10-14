// The drift check's comparisons (scripts/places-check.ts), against answers made
// from the reference data itself (no difference) and the same answers changed:
// a place added, gone or changed is found, and said as the check prints it.
// What the live sources say is the check's to read (npm run places:check), and
// the workflow that runs it (.github/workflows/places.yml) is held here to what
// it promises: weekly, by hand and on a change to what it compares, reading
// only, with the keys of the sources it reads and no other.

import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { COUNTRY_TYPES } from '../src/constants';
import { DIGITALOCEAN_DATACENTERS } from '../src/Providers/DigitalOcean/places';
import type { DigitalOceanRegionData } from '../src/Providers/DigitalOcean/types';
import { LAMBDA_REGIONS } from '../src/Providers/LambdaCloud/places';
import { RUNPOD_DATA_CENTERS } from '../src/Providers/RunPod/places';
import { SCALEWAY_PLACES } from '../src/Providers/Scaleway/places';
import { VAST_LOCATIONS } from '../src/Providers/VastAI/places';
import {
    checkCountries, checkDigitalOcean, checkLambda, checkRunPod, checkScaleway, checkVast, diffPlaces, explain, listing, SOURCES, unheld, vastSample,
} from './places-check';
import type { ListedDataCenter } from './places-check';

describe('diffPlaces: the data\'s listing against its source\'s', () => {
    const data = listing([{ id: 'a', tiers: ['x', 'y'], n: 1 }, { id: 'b', tiers: [], n: 2 }, { id: 'c', tiers: ['x'], n: 3 }], (p) => p.id, (p) => ({ tiers: p.tiers, n: p.n }));

    it('finds each place added, each field changed, then each place gone, in that order', () => {
        const source = listing([{ id: 'a', tiers: ['x', 'y'], n: 9 }, { id: 'd', tiers: ['z'], n: 4 }, { id: 'b', tiers: ['x'], n: 2 }], (p) => p.id, (p) => ({ tiers: p.tiers, n: p.n }));
        expect(diffPlaces(data, source)).toEqual([
            { what: 'changed', name: 'a', field: 'n', was: 1, now: 9 },
            { what: 'added', name: 'd', now: { tiers: ['z'], n: 4 } },
            { what: 'changed', name: 'b', field: 'tiers', was: [], now: ['x'] },
            { what: 'gone', name: 'c', was: { tiers: ['x'], n: 3 } },
        ]);
    });

    it('a list is compared as a set (its order says nothing), and only the fields the data holds are compared', () => {
        const source = listing([{ id: 'a', tiers: ['y', 'x'], n: 1, more: true }, { id: 'b', tiers: [], n: 2 }, { id: 'c', tiers: ['x'], n: 3 }], (p) => p.id, (p) => ({ ...p, id: undefined }));
        expect(diffPlaces(data, source)).toEqual([]);
        // A field the source leaves out is one it now says nothing of.
        expect(diffPlaces(data, listing([{ id: 'a' }, { id: 'b' }, { id: 'c' }], (p) => p.id, () => ({ n: 0 })))).toEqual([
            { what: 'changed', name: 'a', field: 'tiers', was: ['x', 'y'], now: undefined }, { what: 'changed', name: 'a', field: 'n', was: 1, now: 0 },
            { what: 'changed', name: 'b', field: 'tiers', was: [], now: undefined }, { what: 'changed', name: 'b', field: 'n', was: 2, now: 0 },
            { what: 'changed', name: 'c', field: 'tiers', was: ['x'], now: undefined }, { what: 'changed', name: 'c', field: 'n', was: 3, now: 0 },
        ]);
        // A list with an item twice is not the set of its items.
        expect(diffPlaces(listing([{ id: 'a', t: ['x'] }], (p) => p.id, (p) => ({ t: p.t })), listing([{ id: 'a', t: ['x', 'x'] }], (p) => p.id, (p) => ({ t: p.t }))))
            .toEqual([{ what: 'changed', name: 'a', field: 't', was: ['x'], now: ['x', 'x'] }]);
    });

    it('unheld: the fields a source\'s answer has that the data does not hold, in the order first seen, each once', () => {
        expect(unheld([{ id: 1, b: 2 }, { c: 3, id: 4, b: 5 }], ['id'])).toEqual(['b', 'c']);
        expect(unheld([{ id: 1 }], ['id'])).toEqual([]);
        expect(unheld([], [])).toEqual([]);
    });

    it('explain: says each difference as the check prints it', () => {
        expect([
            explain({ what: 'added', name: 'nyc4', now: { name: 'New York 4', available: true } }),
            explain({ what: 'added', name: 'XK', now: {} }),
            explain({ what: 'gone', name: 'sfo1', was: {} }),
            explain({ what: 'changed', name: 'ams3', field: 'available', was: true, now: false }),
            explain({ what: 'changed', name: 'EU-RO-1', field: 'networkVolumeTypes', was: ['STANDARD'], now: [] }),
            explain({ what: 'changed', name: 'EU-RO-1', field: 'networkVolumeTypes', was: [], now: ['STANDARD', 'HIGH_PERFORMANCE'] }),
            explain({ what: 'unread', name: 'London, UK' }),
        ]).toEqual([
            'nyc4: the source has it and the data does not (name "New York 4"; available true)',
            'XK: the source has it and the data does not',
            'sfo1: the data has it and the source no longer does',
            'ams3: its available is false, and the data says true',
            'EU-RO-1: its networkVolumeTypes is none, and the data says STANDARD',
            'EU-RO-1: its networkVolumeTypes is STANDARD, HIGH_PERFORMANCE, and the data says none',
            '"London, UK": a location countryOf reads no country of the library\'s from',
        ]);
    });
});

describe('each source against its data', () => {
    it('DigitalOcean: GET /v2/regions as the data has it is no difference; a datacenter opened, closed or gone is', () => {
        const regions: DigitalOceanRegionData[] = DIGITALOCEAN_DATACENTERS.map((d) => ({ slug: d.slug, name: d.name, available: d.available, features: ['backups'], sizes: ['s-1vcpu-1gb'] }));
        expect(checkDigitalOcean(regions)).toEqual({ read: '18 datacenters', drift: [], unheld: ['features', 'sizes'], notes: [] });
        const moved = [...regions.filter((r) => r.slug !== 'sfo1').map((r) => (r.slug === 'ams3' ? { ...r, available: false } : r)), { slug: 'nyc4', name: 'New York 4', available: true, features: [], sizes: [] }];
        expect(checkDigitalOcean(moved).drift).toEqual([
            { what: 'changed', name: 'ams3', field: 'available', was: true, now: false },
            { what: 'added', name: 'nyc4', now: { name: 'New York 4', available: true } },
            { what: 'gone', name: 'sfo1', was: { name: 'San Francisco 1', available: false } },
        ]);
    });

    it('RunPod: its data centers as the data has them (each one\'s name its id) are no difference, whatever order its tiers are in; a name of its own, or a tier more, is', () => {
        const listed: Array<ListedDataCenter & { compliance: string[], globalNetwork: boolean }> = RUNPOD_DATA_CENTERS.map((d) => ({
            id: d.id, name: d.id, region: d.region, networkVolumeTypes: [...d.networkVolumeTypes].reverse(), compliance: ['GDPR'], globalNetwork: true,
        }));
        expect(checkRunPod(listed)).toEqual({ read: '34 data centers', drift: [], unheld: ['compliance', 'globalNetwork'], notes: [] });
        const moved = listed.map((d) => (d.id === 'US-TX-3' ? { ...d, name: 'Dallas 3' } : d.id === 'EU-RO-1' ? { ...d, networkVolumeTypes: ['STANDARD', 'HIGH_PERFORMANCE'] } : d));
        expect(checkRunPod(moved).drift).toEqual([
            { what: 'changed', name: 'EU-RO-1', field: 'networkVolumeTypes', was: ['STANDARD'], now: ['STANDARD', 'HIGH_PERFORMANCE'] },
            { what: 'changed', name: 'US-TX-3', field: 'name', was: 'US-TX-3', now: 'Dallas 3' },
        ]);
    });

    it('Lambda: its regions as the data has them are no difference; one described otherwise, or one added, is', () => {
        const regions = LAMBDA_REGIONS.map((r) => ({ name: r.name, description: r.description }));
        expect(checkLambda(regions)).toEqual({ read: '18 regions', drift: [], unheld: [], notes: [] });
        const moved = [...regions.map((r) => (r.name === 'us-south-1' ? { ...r, description: 'Dallas, Texas, USA' } : r)), { name: 'europe-north-1', description: 'Finland' }];
        expect(checkLambda(moved).drift).toEqual([
            { what: 'changed', name: 'us-south-1', field: 'description', was: 'Texas, USA', now: 'Dallas, Texas, USA' },
            { what: 'added', name: 'europe-north-1', now: { description: 'Finland' } },
        ]);
    });

    it('Scaleway: the specs\' zones and regions as the data has them are no difference; a zone added or a region gone is', () => {
        const of = (kind: string) => SCALEWAY_PLACES.filter((p) => p.kind === kind).map((p) => p.name);
        expect(checkScaleway(of('zone'), of('region'))).toEqual({ read: '4 regions, 10 zones', drift: [], unheld: [], notes: [] });
        expect(checkScaleway([...of('zone'), 'it-mil-2'], of('region').filter((r) => r !== 'it-mil')).drift).toEqual([
            { what: 'added', name: 'it-mil-2', now: { kind: 'zone' } },
            { what: 'gone', name: 'it-mil', was: { kind: 'region' } },
        ]);
    });

    it('Vast: a sample of the data\'s countries, every location read to one, is no difference and nothing to say', () => {
        const locations = new Map<string | null, number>([...VAST_LOCATIONS.withoutPlace.map((l) => [l, 2] as const), ...VAST_LOCATIONS.countries.map((c) => [`Somewhere, ${c}`, 1] as const)]);
        const report = checkVast(locations, '2026-10-20');
        expect(report).toEqual({ read: `${VAST_LOCATIONS.countries.length + 6} asks, ${VAST_LOCATIONS.countries.length + 3} locations (3 without a place before the code), ${VAST_LOCATIONS.countries.length} countries`, drift: [], unheld: [], notes: [] });
    });

    it('Vast: a location read to no country fails; the market moving (countries, asks saying nowhere) is said, with the sample as the data would hold it', () => {
        const locations = new Map<string | null, number>([['Texas, US', 3], ['London, UK', 1], ['Nairobi, KE', 2], ['SE', 1], ['', 1], [null, 4]]);
        const report = checkVast(locations, '2026-10-20');
        expect(report.drift).toEqual([{ what: 'unread', name: 'London, UK' }, { what: 'unread', name: '' }]);
        expect(report.read).toBe('12 asks, 5 locations (0 without a place before the code), 3 countries');
        const unseen = VAST_LOCATIONS.countries.filter((c) => c !== 'US' && c !== 'SE');
        expect(report.notes).toEqual([
            '4 asks say no location: an offer of one is in no country',
            'countries the data\'s sample had not: KE',
            `countries the data's sample had and this one has not: ${unseen.join(', ')}`,
            'this sample as VAST_LOCATIONS: {"readAt":"2026-10-20","asks":12,"nowhere":4,"locations":5,"withoutPlace":[],"countries":["KE","SE","US"]}',
        ]);
        // Only the places with nothing before the code moved: said all the same.
        const shapes = new Map<string | null, number>(VAST_LOCATIONS.countries.map((c) => [`Somewhere, ${c}`, 1]));
        expect(checkVast(shapes, '2026-10-20').notes).toEqual([`this sample as VAST_LOCATIONS: ${JSON.stringify(vastSample(shapes, '2026-10-20'))}`]);
        expect(vastSample(shapes, '2026-10-20')).toMatchObject({ withoutPlace: [], nowhere: 0, countries: [...VAST_LOCATIONS.countries] });
    });

    it('countries: ISO\'s codes as COUNTRY_TYPES has them are no difference; one ISO adds or withdraws is', () => {
        const codes = Object.values<string>(COUNTRY_TYPES);
        expect(checkCountries(codes)).toEqual({ read: '249 codes', drift: [], unheld: [], notes: [] });
        expect(checkCountries([...codes.filter((c) => c !== 'AN'), 'XK'].reverse()).drift).toEqual([{ what: 'added', name: 'XK', now: {} }]);
        expect(checkCountries(codes.filter((c) => c !== 'NA')).drift).toEqual([{ what: 'gone', name: 'NA', was: {} }]);
    });
});

describe('the workflow that runs it: .github/workflows/places.yml', () => {
    const ROOT = join(__dirname, '..');
    const text = readFileSync(join(ROOT, '.github', 'workflows', 'places.yml'), 'utf8');
    /** The block of a top-level key, without its first line. */
    const block = (key: string) => new RegExp(`^${key}:\\n((?: .*\\n|\\n)*)`, 'm').exec(text)![1];
    const on = block('on');

    it('runs every Monday, by hand, and on a pull request of this repository that changes what the check compares, a fork\'s never', () => {
        expect([...on.matchAll(/^ {2}([a-z_]+):/gm)].map((m) => m[1])).toEqual(['schedule', 'workflow_dispatch', 'pull_request']);
        expect(on).toMatch(/^ {2}schedule:\n {4}- cron: '0 6 \* \* 1'\n {2}workflow_dispatch:\n/m);
        const paths = [...on.matchAll(/^ {6}- '([^']+)'$/gm)].map((m) => m[1]);
        expect(paths).toEqual([
            'src/Providers/*/places.ts', 'src/Providers/VastAI/mappers.ts', 'src/Core/utils/places.ts', 'src/constants.ts', 'scripts/places-check.ts', '.github/workflows/places.yml',
        ]);
        // Each names files there are: every provider's data, what reads Vast's locations, the countries, the check and this file.
        const matched = (glob: string) => new RegExp(`^${glob.replace(/[.]/g, '\\.').replace(/\*/g, '[^/]+')}$`);
        const data = readdirSync(join(ROOT, 'src', 'Providers')).map((d) => `src/Providers/${d}/places.ts`).filter((f) => existsSync(join(ROOT, f)));
        expect(data.filter((f) => matched(paths[0]).test(f))).toEqual(data);
        expect(data).toHaveLength(5);
        expect(paths.slice(1).filter((f) => !existsSync(join(ROOT, f)))).toEqual([]);
        expect(text).toMatch(/^ {4}if: \$\{\{ github\.event_name != 'pull_request' \|\| github\.event\.pull_request\.head\.repo\.full_name == github\.repository \}\}$/m);
    });

    it('only reads: the check and nothing else runs, with the keys of the sources it reads, each from its secret, and no other', () => {
        expect(block('permissions')).toBe('  contents: read\n\n');
        expect(text).not.toMatch(/jest|ASAP_VPS_LIVE|gpu:smoke|secrets: inherit/);
        const keys = Object.values(SOURCES).flatMap((s) => (s.keyEnv ? [s.keyEnv] : [])).sort();
        expect(keys).toEqual(['DIGITAL_OCEAN_API_KEY', 'LAMBDA_API_KEY', 'RUNPOD_API_KEY', 'VAST_API_KEY']);
        expect([...text.matchAll(/\$\{\{ secrets\.([A-Z_]+) \}\}/g)].map((m) => m[1])).toEqual(keys);
        expect(keys.every((k) => text.includes(`      ${k}: \${{ secrets.${k} }}\n`))).toBe(true);
        // What it runs, and no expression pasted into a script.
        expect([...text.matchAll(/^ {6}(?:- | {2})run: (.*)$/gm)].map((m) => m[1])).toEqual(['npm ci', 'npm run -s places:check 2>&1 | tee "$RUNNER_TEMP/places.txt"', '|']);
        expect(text).toMatch(/^ {8}shell: bash\n {8}run: npm run -s places:check/m);
        expect([...text.matchAll(/^ {10}(.*)$/gm)].map((m) => m[1]).filter((l) => l.includes('${{'))).toEqual([]);
    });
});
