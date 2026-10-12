// RunPod against the live API: a server made with sshKeyIds is logged in to
// by each key named, and a user made over that session logs in too
// (src/testing/sshLive.ts). Rents a GPU pod for a few minutes. Runs only when
// asked, with the key in .env.test:
//   ASAP_VPS_LIVE=runpod npx jest --config jest.live.config.js RunPodSsh.live

import { describeLiveSsh } from '../../testing/sshLive';

describeLiveSsh('runpod');
