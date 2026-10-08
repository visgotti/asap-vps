// What each provider declares it can do, read from the code: the overview page's table is generated from this at build time, so it cannot drift.
import { PROVIDERS } from '../../src/Providers/registry';

export default Object.fromEntries(Object.entries(PROVIDERS).map(([id, p]) => [id, { name: p.name, capabilities: p.capabilities }]));
