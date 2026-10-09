// RunPod against the live API, every method of the abstraction: rents one GPU
// pod (billed while it exists), takes it through the lifecycle in
// src/testing/lifecycle.ts and deletes it, verified. Runs only when asked, with
// the key in .env.test:
//   ASAP_VPS_LIVE=runpod npm run test:live

import { describeGpuLifecycle, liveLifecycle } from '../../testing/lifecycle';

describeGpuLifecycle(liveLifecycle('runpod'));
