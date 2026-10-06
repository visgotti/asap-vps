// LambdaCloud against the live API, every method of the abstraction: rents one
// GPU instance (billed while it exists; Lambda has no stop), takes it through
// the lifecycle in src/testing/lifecycle.ts and deletes it, verified. Runs only
// when asked, with the key in .env.test:
//   ASAP_VPS_LIVE=lambda npm run test:live

import { describeGpuLifecycle, liveLifecycle } from '../../testing/lifecycle';

describeGpuLifecycle(liveLifecycle('lambda'));
