import { CUDA_TYPES, PLATFORM, PLATFORM_FAMILY, MACHINE_TYPES } from './constants';

describe('constants', () => {
    describe('CUDA_TYPES', () => {
        it('each member is its version as major.minor, and there is no 12.7', () => {
            expect(CUDA_TYPES).toEqual({
                CUDA_11_8: '11.8', CUDA_12_0: '12.0', CUDA_12_1: '12.1', CUDA_12_2: '12.2', CUDA_12_3: '12.3', CUDA_12_4: '12.4', CUDA_12_5: '12.5', CUDA_12_6: '12.6',
                CUDA_12_8: '12.8', CUDA_12_9: '12.9', CUDA_13_0: '13.0', CUDA_13_1: '13.1', CUDA_13_2: '13.2', CUDA_13_3: '13.3', CUDA_13_4: '13.4',
            });
        });
    });

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
