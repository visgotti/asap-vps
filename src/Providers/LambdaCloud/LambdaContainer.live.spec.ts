// Lambda running a container (CreateServerOptions.container) from a private
// registry on its cheapest GPU in stock under ASAP_VPS_LIVE_MAX_PRICE: the run
// in src/testing/containerOnVm.ts (Lambda Stack's Docker, the GPUs passed
// through, the image pulled with a pull-only login, run, rebooted, deleted).
// Some 20 minutes of the GPU. Runs only when asked, with the Lambda key and the
// Scaleway key and Project (the registry's account) in .env.test:
//   ASAP_VPS_LIVE=lambda ASAP_VPS_LIVE_MAX_PRICE=1.5 npx jest --config jest.live.config.js LambdaContainer.live

import { describeContainerOnVm, liveKey } from '../../testing/containerOnVm';
import { liveOptions } from '../../testing/live';
import { LambdaCloud } from './LambdaCloud';

describeContainerOnVm<LambdaCloud>({
    target: 'lambda',
    provider: 'lambda',
    make: () => new LambdaCloud(liveKey('LAMBDA_API_KEY')),
    offers: (p) => p.listOffers({ maxPricePerHour: liveOptions().maxPricePerHour }),
    gpu: true,
    wait: { intervalMs: 10_000, timeoutMs: 20 * 60_000 },
    minutes: 75,
});
