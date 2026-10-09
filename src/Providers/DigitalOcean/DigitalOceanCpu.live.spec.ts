// DigitalOcean against the live API on its cheapest plain droplet, every method
// of the abstraction: the same lifecycle as the GPU's (src/testing/lifecycle.ts:
// create with cloud-init user data and a key, SSH as root, read and list, a real
// reboot, power off and on (a stopped droplet bills in full), a snapshot of the
// stopped droplet copied to a second region and booted, deletes verified), without
// the GPU's own checks. DigitalOcean's API is the same for both, so this proves
// every code path but the GPU's for cents, whatever GPU stock there is. Runs only
// when asked:
//   ASAP_VPS_LIVE=digitalocean-cpu npm run test:live     (or npm run test:do:cpu)
// The account needs one free droplet slot, checked first (the production account).

import { describeGpuLifecycle, liveLifecycle } from '../../testing/lifecycle';

describeGpuLifecycle(liveLifecycle('digitalocean', { cpu: true }));
