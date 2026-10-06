// DigitalOcean running a container (CreateServerOptions.container) from a
// private registry on its cheapest droplet with 1 GiB of memory or more: the
// run in src/testing/containerOnVm.ts (Docker installed at the first boot, the
// image pulled with a pull-only login, run, rebooted, deleted). About a cent.
// Runs only when asked, with the DigitalOcean key and the Scaleway key and
// Project (the registry's account) in .env.test:
//   ASAP_VPS_LIVE=digitalocean-cpu npx jest --config jest.live.config.js DigitalOceanContainer.live

import { describeContainerOnVm, liveKey } from '../../testing/containerOnVm';
import { liveOptions } from '../../testing/live';
import { DigitalOcean } from './DigitalOcean';

describeContainerOnVm<DigitalOcean>({
    target: 'digitalocean-cpu',
    provider: 'digitalocean',
    make: () => new DigitalOcean(liveKey('DIGITAL_OCEAN_API_KEY')),
    offers: async (p) => (await p.listOffers({ kind: 'cpu', maxPricePerHour: liveOptions().maxPricePerHour })).filter((o) => (o.memoryGb ?? 0) >= 1),
    gpu: false,
    before: async (p) => {
        const { limit, used } = await p.api.dropletUsage();
        if (used >= limit) throw new Error(`the account has no droplet to spare (${used} of ${limit}): nothing was created`);
    },
    wait: { intervalMs: 5000, timeoutMs: 15 * 60_000 },
    minutes: 60,
});
