import type { Server } from '../../types';
import { estimateCost, estimateServerCost, PER_SECOND } from './cost';

const T0 = Date.parse('2026-10-02T12:00:00Z');
const at = (seconds: number) => T0 + seconds * 1000;

describe('estimateCost', () => {
    it('rate times billed time, counted per second by default', () => {
        expect(estimateCost(3.6, T0, at(90))).toEqual({ usd: 0.09, pricePerHour: 3.6, from: T0, to: at(90), billedSeconds: 90 });
        expect(estimateCost(1, T0, at(3600)).usd).toBeCloseTo(1, 12);
        // A moment before its start bills nothing (clocks differ).
        expect(estimateCost(1, T0, at(-5))).toMatchObject({ usd: 0, billedSeconds: 0 });
    });

    it('rounds up to the increment, and never bills under the minimum time or charge', () => {
        const perMinute = { incrementSeconds: 60, minimumSeconds: 0 };
        expect(estimateCost(1.2, T0, at(61), perMinute)).toMatchObject({ billedSeconds: 120, usd: 0.04 });
        expect(estimateCost(1.2, T0, at(120), perMinute).billedSeconds).toBe(120);
        const perHour = { incrementSeconds: 3600, minimumSeconds: 0 };
        expect(estimateCost(0.5, T0, at(1), perHour)).toMatchObject({ billedSeconds: 3600, usd: 0.5 });
        // DigitalOcean: per second, at least 60 s or $0.01.
        const droplet = { incrementSeconds: 1, minimumSeconds: 60, minimumUsd: 0.01 };
        expect(estimateCost(0.76, T0, at(10), droplet).billedSeconds).toBe(60);
        expect(estimateCost(0.009, T0, at(600), droplet).usd).toBe(0.01);
        expect(PER_SECOND).toEqual({ incrementSeconds: 1, minimumSeconds: 0 });
    });

    it('refuses what is not a price or a time', () => {
        expect(() => estimateCost(-1, T0, at(1))).toThrow(/price per hour/);
        expect(() => estimateCost(Number.NaN, T0, at(1))).toThrow(/price per hour/);
        expect(() => estimateCost(1, Number.NaN, at(1))).toThrow(/epoch-ms/);
    });
});

describe('estimateServerCost', () => {
    const server = (o: Partial<Server>): Server => ({ provider: 'p', id: 's', name: 'n', status: 'running', providerStatus: 'x', raw: {}, ...o });

    it('the current run: from when its billing started, at its rate, counted its provider\'s way', () => {
        const s = server({ pricePerHour: 2.4, billingStartedAt: T0, billing: { incrementSeconds: 60, minimumSeconds: 0 } });
        expect(estimateServerCost(s, at(30))).toEqual({ usd: 0.04, pricePerHour: 2.4, from: T0, to: at(30), billedSeconds: 60 });
    });

    it('null when the provider reports no rate or no start (a stopped server billing only its disk has no run)', () => {
        expect(estimateServerCost(server({ pricePerHour: 1 }), at(10))).toBeNull();
        expect(estimateServerCost(server({ billingStartedAt: T0 }), at(10))).toBeNull();
        // A deleted server bills nothing, whatever start it still reports (Lambda lists terminated instances a while).
        expect(estimateServerCost(server({ status: 'terminated', pricePerHour: 1, billingStartedAt: T0 }), at(10))).toBeNull();
    });
});
