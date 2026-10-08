import { PLATFORM, PLATFORM_FAMILY, MACHINE_TYPES } from './constants';

describe('constants', () => {
    describe('MACHINE_TYPES', () => {
        it('should include UBUNTU_24', () => {
            expect(MACHINE_TYPES.UBUNTU_24).toBe('ubuntu24');
        });

        it('should retain existing values', () => {
            expect(MACHINE_TYPES.UBUNTU_20).toBe('ubuntu20');
            expect(MACHINE_TYPES.UBUNTU_22).toBe('ubuntu22');
        });
    });

    describe('PLATFORM', () => {
        it('should define all expected platforms', () => {
            const expected = [
                'ubuntu20', 'ubuntu22', 'ubuntu24',
                'debian11', 'debian12',
                'centos7', 'centos9',
                'rocky8', 'rocky9',
                'alma8', 'alma9',
                'fedora',
            ];
            const values = Object.values(PLATFORM);
            for (const p of expected) {
                expect(values).toContain(p);
            }
        });
    });

    describe('PLATFORM_FAMILY', () => {
        it('should map all Ubuntu/Debian platforms to debian family', () => {
            expect(PLATFORM_FAMILY[PLATFORM.UBUNTU_20]).toBe('debian');
            expect(PLATFORM_FAMILY[PLATFORM.UBUNTU_22]).toBe('debian');
            expect(PLATFORM_FAMILY[PLATFORM.UBUNTU_24]).toBe('debian');
            expect(PLATFORM_FAMILY[PLATFORM.DEBIAN_11]).toBe('debian');
            expect(PLATFORM_FAMILY[PLATFORM.DEBIAN_12]).toBe('debian');
        });

        it('should map all RHEL-family platforms to rhel family', () => {
            expect(PLATFORM_FAMILY[PLATFORM.CENTOS_7]).toBe('rhel');
            expect(PLATFORM_FAMILY[PLATFORM.CENTOS_9]).toBe('rhel');
            expect(PLATFORM_FAMILY[PLATFORM.ROCKY_8]).toBe('rhel');
            expect(PLATFORM_FAMILY[PLATFORM.ROCKY_9]).toBe('rhel');
            expect(PLATFORM_FAMILY[PLATFORM.ALMA_8]).toBe('rhel');
            expect(PLATFORM_FAMILY[PLATFORM.ALMA_9]).toBe('rhel');
            expect(PLATFORM_FAMILY[PLATFORM.FEDORA]).toBe('rhel');
        });

        it('should have a mapping for every PLATFORM value', () => {
            for (const p of Object.values(PLATFORM)) {
                expect([p, ['debian', 'rhel'].includes(PLATFORM_FAMILY[p])]).toEqual([p, true]);
            }
        });
    });
});
