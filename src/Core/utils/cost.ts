// What time on a server costs: its rate per hour, applied to how long it was
// billed, counted the way its provider counts (per second, per minute, per
// hour, with a minimum). An estimate: the provider's invoice is the truth, and
// disks, bandwidth and addresses bill on top of a server's rate.

import type { Billing, CostEstimate, Server } from '../../types';

/** Per second with no minimum: what an estimate counts when a provider states nothing. */
export const PER_SECOND: Billing = Object.freeze({ incrementSeconds: 1, minimumSeconds: 0 });

/**
 * What `pricePerHour` comes to from `from` to `to` (epoch ms): the time between
 * them rounded up to the billing increment, never under its minimum time or
 * minimum charge.
 */
export function estimateCost(pricePerHour: number, from: number, to: number, billing: Billing = PER_SECOND): CostEstimate {
    if (!(pricePerHour >= 0)) throw new Error(`a price per hour is a number of USD, not ${pricePerHour}`);
    if (!Number.isFinite(from) || !Number.isFinite(to)) throw new Error('a cost is estimated between two epoch-ms times');
    const step = Math.max(1, billing.incrementSeconds);
    const elapsed = Math.max(0, (to - from) / 1000);
    const billedSeconds = Math.max(billing.minimumSeconds, Math.ceil(elapsed / step) * step);
    return { usd: Math.max(billing.minimumUsd ?? 0, (pricePerHour * billedSeconds) / 3600), pricePerHour, from, to, billedSeconds };
}

/**
 * What a server's current run has cost by `at` (default now): its
 * `pricePerHour` from its `billingStartedAt`, counted by its `billing`. null
 * when its provider reports no rate or no start for it, or it is terminated (a
 * stopped server that bills only its disk has no current run, and a deleted one
 * none at all).
 */
export function estimateServerCost(server: Server, at = Date.now()): CostEstimate | null {
    if (server.status === 'terminated' || server.pricePerHour === undefined || server.billingStartedAt === undefined) return null;
    return estimateCost(server.pricePerHour, server.billingStartedAt, at, server.billing);
}
