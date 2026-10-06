// Scaleway's Serverless Containers against the live API: a private container
// of a plain HTTP image on the smallest size, from zero, in a namespace made
// for it, called through its public endpoint with the account's key (as
// X-Auth-Token), refused without it, and deleted with its namespace: the run in
// src/testing/serverlessLive.ts. An instance bills per second while it runs
// (within the monthly free tier for a run this short). Runs only when asked:
//   ASAP_VPS_LIVE=scaleway-cpu npx jest --config jest.live.config.js ScalewayServerless.live

import { liveKey } from '../../testing/containerOnVm';
import { describeServerlessLive } from '../../testing/serverlessLive';
import { Scaleway } from './Scaleway';

describeServerlessLive<Scaleway>({
    target: 'scaleway-cpu',
    provider: 'scaleway',
    make: () => new Scaleway({ apiKey: liveKey('SCW_SECRET_KEY'), projectId: liveKey('SCW_DEFAULT_PROJECT_ID'), zones: process.env.SCW_ZONES?.trim() || undefined }),
    deniedStatus: 403,
});
