// RunPod's serverless endpoints against the live API: a load-balancing
// endpoint of a plain HTTP image (no RunPod SDK in it) on the cheapest CPU
// worker in stock, from zero, called through its own URL with the account's
// key, refused without it, and deleted (its workers with it): the run in
// src/testing/serverlessLive.ts. Not held to: scaling back to no worker. With
// workers.min 0 and idleTimeout 5 s, RunPod kept the worker of an idle
// endpoint (IDLE, now and then INITIALIZING) for 15 minutes after its last
// request (probed live 2026-10-06), so deleteEndpoint is what stops it. A
// worker bills per second while it runs: a few minutes of a CPU worker. Runs only when asked:
//   ASAP_VPS_LIVE=runpod npx jest --config jest.live.config.js RunPodServerless.live

import { liveKey } from '../../testing/containerOnVm';
import { describeServerlessLive } from '../../testing/serverlessLive';
import { RunPod } from './RunPod';

describeServerlessLive<RunPod>({
    target: 'runpod',
    provider: 'runpod',
    make: () => new RunPod(liveKey('RUNPOD_API_KEY')),
    extra: { idleTimeoutSeconds: 5 },
    deniedStatus: 401,
});
