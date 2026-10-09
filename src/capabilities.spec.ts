// What a capability descriptor says a provider can do.

import { capabilityNames } from './capabilities';

describe('capabilityNames', () => {
    it('the capabilities a descriptor declares, in CAPABILITY_METHODS order; a key left undefined declares none', () => {
        expect(capabilityNames({ imageCopy: {}, logs: {}, restart: undefined, power: { stoppedBilling: 'storage' } })).toEqual(['power', 'logs', 'imageCopy']);
        expect(capabilityNames({})).toEqual([]);
    });
});
