// Scaleway against the live API on the cheapest Instance (a CPU one,
// STARDUST1-S: about EUR 0.0006 an hour), every method of the abstraction:
// the same lifecycle as the GPU's (src/testing/lifecycle.ts: create with user
// data and a key, SSH, read and list, reboot, poweroff and power-on, an image
// of the stopped server, a server booted from it, deletes verified), without the
// GPU's own checks. Scaleway's API is the same for both, so this proves every
// code path of Scaleway for cents, while a GPU needs a verified account's
// quota. Runs only when asked:
//   ASAP_VPS_LIVE=scaleway-cpu npm run test:live     (or npm run test:scw:cpu)
// The run's volumes and snapshots are audited as the GPU run's are.

import { providerInfo, providerParams } from '../registry';
import { describeGpuLifecycle, liveLifecycle } from '../../testing/lifecycle';
import { liveOptions, liveRequested } from '../../testing/live';
import { AuditedScaleway, describeScalewayAudit } from '../../testing/scalewayAudit';

const target = liveLifecycle('scaleway', { cpu: true });
target.make = (apiKey) => new AuditedScaleway({
    ...(providerParams(providerInfo('scaleway'), process.env) ?? { apiKey: 'unset' }),
    ...(apiKey ? { apiKey } : {}),
});
describeGpuLifecycle(target);
describeScalewayAudit(liveRequested('scaleway-cpu') && !liveOptions().freeOnly, () => target.make() as AuditedScaleway);
