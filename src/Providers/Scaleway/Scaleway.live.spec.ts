// Scaleway against the live API, every method of the abstraction: rents one
// GPU Instance (billed by the minute while it exists, stopped or not for its
// volume), takes it through the lifecycle in src/testing/lifecycle.ts, and
// deletes it, verified. Runs only when asked, with the secret key and the
// Project in .env.test (or ~/.config/asap-vps/credentials.env):
//   ASAP_VPS_LIVE=scaleway npm run test:live
//   (SCW_SECRET_KEY, SCW_DEFAULT_PROJECT_ID; SCW_ZONES to keep to some zones)
// What is particular to Scaleway, and checked here on top of the shared suite:
//   - an account's GPU quota starts at 0 (`quotas_exceeded`, QuotaError): lifted
//     by verifying the account's identity or by support;
//   - poweroff releases the GPU, so powering on again may find no stock (the
//     suite accepts the documented CapacityError);
//   - terminate only detaches Block Storage volumes, and deleting an image leaves
//     its snapshots unless they are deleted too: after the run, none of the
//     volumes the run's servers held and none of the snapshots its images held
//     may be left, because each bills until deleted (src/testing/scalewayAudit.ts).

import { providerInfo, providerParams } from '../registry';
import { describeGpuLifecycle, liveLifecycle } from '../../testing/lifecycle';
import { liveOptions, liveRequested } from '../../testing/live';
import { AuditedScaleway, describeScalewayAudit } from '../../testing/scalewayAudit';

const target = liveLifecycle('scaleway');
// The suite's initializers are the audited ones: the key and the Project from the environment, `apiKey` replacing the key (the wrong-key check).
target.make = (apiKey) => new AuditedScaleway({
    ...(providerParams(providerInfo('scaleway'), process.env) ?? { apiKey: 'unset' }),
    ...(apiKey ? { apiKey } : {}),
});
describeGpuLifecycle(target);
describeScalewayAudit(liveRequested('scaleway') && !liveOptions().freeOnly, () => target.make() as AuditedScaleway);
