// The live suites (*.live.spec.ts): the real provider APIs, with the keys in
// .env.test or ~/.config/asap-vps/credentials.env. They rent real servers
// (billed), so each runs only when ASAP_VPS_LIVE names it:
//   ASAP_VPS_LIVE=runpod,vast npm run test:live
//   ASAP_VPS_LIVE=all ASAP_VPS_LIVE_FREE=1 npm run test:live    (only what costs nothing)
// The other knobs, and the teardown every run keeps: src/testing/live.ts.
// One suite at a time: two DigitalOcean suites at once would race for one
// free droplet slot, and a provider's rate limit is shared by its suites.
const { jest: base } = require('./package.json');

module.exports = {
    ...base,
    testRegex: '\\.live\\.spec\\.ts$',
    testPathIgnorePatterns: ['/node_modules/'],
    maxWorkers: 1,
};
