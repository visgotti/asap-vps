// DigitalOcean against the live API, every method of the abstraction: rents
// one GPU droplet (billed while it exists), takes it through the lifecycle in
// src/testing/lifecycle.ts and deletes it, verified. Runs only when asked, with
// the key in .env.test:
//   ASAP_VPS_LIVE=digitalocean npm run test:live
// The longest of the live suites: its image phase snapshots the droplet, copies
// the snapshot to another region and boots from it (ASAP_VPS_LIVE_IMAGES=0
// skips that). The account needs one free droplet slot, checked first.

import { describeGpuLifecycle, liveLifecycle } from '../../testing/lifecycle';

describeGpuLifecycle(liveLifecycle('digitalocean'));
