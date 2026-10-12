// Lambda against the live API: a server made with sshKeyIds is logged in to
// by each key named, and a user made over that session logs in too
// (src/testing/sshLive.ts). Rents a GPU VM for a few minutes. Runs only when
// asked, with the key in .env.test:
//   ASAP_VPS_LIVE=lambda npx jest --config jest.live.config.js LambdaSsh.live

import { describeLiveSsh } from '../../testing/sshLive';

describeLiveSsh('lambda');
