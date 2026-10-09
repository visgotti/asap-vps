// Scaleway running a container (CreateServerOptions.container) from a private
// registry on its cheapest Instance with 1 GiB of memory or more: the run in
// src/testing/containerOnVm.ts (Docker installed at the first boot, the image
// pulled with a pull-only login, run, rebooted, deleted). Cents. Runs only when
// asked, with the Scaleway key and Project in .env.test (the registry is in the
// same account):
//   ASAP_VPS_LIVE=scaleway-cpu npx jest --config jest.live.config.js ScalewayContainer.live
// The run's volumes are audited as the other Scaleway runs' are.

import { describeContainerOnVm, liveKey } from '../../testing/containerOnVm';
import { liveOptions, liveRequested } from '../../testing/live';
import { AuditedScaleway, describeScalewayAudit } from '../../testing/scalewayAudit';

let made: AuditedScaleway | undefined;
const scaleway = () => (made ??= new AuditedScaleway({
    apiKey: liveKey('SCW_SECRET_KEY'), projectId: liveKey('SCW_DEFAULT_PROJECT_ID'), zones: process.env.SCW_ZONES?.trim() || undefined,
}));

describeContainerOnVm<AuditedScaleway>({
    target: 'scaleway-cpu',
    provider: 'scaleway',
    make: scaleway,
    offers: async (p) => (await p.listOffers({ kind: 'cpu', maxPricePerHour: liveOptions().maxPricePerHour })).filter((o) => (o.memoryGb ?? 0) >= 1),
    gpu: false,
    wait: { intervalMs: 3000, timeoutMs: 10 * 60_000 },
    minutes: 60,
});
describeScalewayAudit(liveRequested('scaleway-cpu') && !liveOptions().freeOnly, scaleway);
