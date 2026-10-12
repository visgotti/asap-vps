// Images by the library's names: what a MACHINE_TYPES member or `{ os, cuda }`
// reads as, and the registry reference it is for a container. The CUDA table
// is NVIDIA's tag list on Docker Hub (nvidia/cuda), read 2026-10-11.

import { CUDA_TYPES, MACHINE_TYPES } from '../../constants';
import type { ImageSpec } from '../../types';
import { containerImageOf, CUDA_IMAGES, imageSpecOf, NoSuchImageError } from './images';

const { UBUNTU_20, UBUNTU_22, UBUNTU_24 } = MACHINE_TYPES;

describe('imageSpecOf: an image named by the library\'s enums', () => {
    it('a MACHINE_TYPES member is that Ubuntu; a spec is itself; a platform\'s own name, or none, is no spec', () => {
        expect(imageSpecOf(UBUNTU_24)).toEqual({ os: 'ubuntu24' });
        expect(imageSpecOf('ubuntu22')).toEqual({ os: 'ubuntu22' });
        const spec: ImageSpec = { os: 'ubuntu24', cuda: '12.8' };
        expect(imageSpecOf(spec)).toBe(spec);
        expect(imageSpecOf({ os: UBUNTU_20 })).toEqual({ os: 'ubuntu20' });
        for (const own of ['ubuntu-24-04-x64', 'ubuntu:24.04', 'Ubuntu24', '', undefined, null]) expect(imageSpecOf(own as string | undefined)).toBeUndefined();
    });

    it('a CUDA version is read as CUDA_TYPES writes it, however a caller does: a number, or its major alone', () => {
        const read = (cuda: unknown) => imageSpecOf({ os: 'ubuntu24', cuda } as unknown as ImageSpec);
        expect([read(12.8), read('13'), read(13), read('12.8')]).toEqual([{ os: 'ubuntu24', cuda: '12.8' }, { os: 'ubuntu24', cuda: '13.0' }, { os: 'ubuntu24', cuda: '13.0' }, { os: 'ubuntu24', cuda: '12.8' }]);
        // What it does not read is refused by what was given, never by a version the list has.
        expect(() => read(12.7)).toThrow(new Error('bad image cuda 12.7: use a CUDA_TYPES member (11.8, 12.0, 12.1, 12.2, 12.3, 12.4, 12.5, 12.6, 12.8, 12.9, 13.0, 13.1, 13.2, 13.3, 13.4)'));
        for (const bad of [true, null, '12.8.1', 'latest', '', [12.8]]) expect(() => read(bad)).toThrow(/^bad image cuda /);
    });

    it('a spec naming an Ubuntu or a CUDA version the enums do not have is an error that lists them', () => {
        expect(() => imageSpecOf({ os: 'ubuntu26' } as unknown as ImageSpec)).toThrow(new Error('bad image os "ubuntu26": use a MACHINE_TYPES member (ubuntu20, ubuntu22, ubuntu24)'));
        expect(() => imageSpecOf({ os: 'ubuntu24', cuda: '12.7' } as unknown as ImageSpec)).toThrow(new Error(
            'bad image cuda "12.7": use a CUDA_TYPES member (11.8, 12.0, 12.1, 12.2, 12.3, 12.4, 12.5, 12.6, 12.8, 12.9, 13.0, 13.1, 13.2, 13.3, 13.4)',
        ));
        expect(() => imageSpecOf({ cuda: '12.8' } as unknown as ImageSpec)).toThrow(/^bad image os undefined: use a MACHINE_TYPES member/);
    });
});

describe('containerImageOf: the registry reference of a spec', () => {
    it('an Ubuntu is Docker Hub\'s ubuntu at its release', () => {
        expect([UBUNTU_20, UBUNTU_22, UBUNTU_24].map((os) => containerImageOf({ os }))).toEqual(['ubuntu:20.04', 'ubuntu:22.04', 'ubuntu:24.04']);
    });

    it('with cuda it is NVIDIA\'s base image of that version\'s newest patch, for that Ubuntu', () => {
        expect(containerImageOf({ os: UBUNTU_24, cuda: CUDA_TYPES.CUDA_12_8 })).toBe('nvidia/cuda:12.8.2-base-ubuntu24.04');
        expect(containerImageOf({ os: 'ubuntu22', cuda: '13.4' })).toBe('nvidia/cuda:13.4.2-base-ubuntu22.04');
        expect(containerImageOf({ os: 'ubuntu20', cuda: '11.8' })).toBe('nvidia/cuda:11.8.0-base-ubuntu20.04');
    });

    it('a CUDA version NVIDIA does not publish for that Ubuntu is a NoSuchImageError that names the spec and says which it has', () => {
        const none = (spec: ImageSpec) => { try { return containerImageOf(spec); } catch (e) { return e; } };
        const jammy = none({ os: UBUNTU_24, cuda: '12.4' }) as NoSuchImageError;
        expect(jammy).toBeInstanceOf(NoSuchImageError);
        expect([jammy.name, jammy.message]).toEqual(['NoSuchImageError', '"ubuntu24" with cuda "12.4" (NVIDIA publishes no CUDA 12.4 image of Ubuntu 24.04: it has 20.04, 22.04)']);
        expect((none({ os: UBUNTU_20, cuda: '13.0' }) as Error).message).toBe('"ubuntu20" with cuda "13.0" (NVIDIA publishes no CUDA 13.0 image of Ubuntu 20.04: it has 22.04, 24.04)');
    });

    it('a spec that is not well formed is refused as imageSpecOf refuses it, never made into a reference', () => {
        const bad = (spec: unknown) => { try { return containerImageOf(spec as ImageSpec); } catch (e) { return e; } };
        for (const [spec, message] of [
            [{ os: 'ubuntu26' }, /^bad image os "ubuntu26"/], [{ os: 'ubuntu24', cuda: '12.7' }, /^bad image cuda "12\.7"/], [{}, /^bad image os undefined/],
            ['ubuntu:24.04', /^bad image "ubuntu:24\.04": use \{ os, cuda\? \}$/],
        ] as const) {
            const e = bad(spec) as Error;
            expect(e).not.toBeInstanceOf(NoSuchImageError);
            expect(e.message).toMatch(message);
        }
        // A CUDA version given as a number is the reference all the same.
        expect(containerImageOf({ os: 'ubuntu24', cuda: 12.8 } as unknown as ImageSpec)).toBe('nvidia/cuda:12.8.2-base-ubuntu24.04');
    });

    it('the table: every CUDA_TYPES member, its newest patch, and the Ubuntu releases it is published for', () => {
        const old = [UBUNTU_20, UBUNTU_22];
        const all = [UBUNTU_20, UBUNTU_22, UBUNTU_24];
        const recent = [UBUNTU_22, UBUNTU_24];
        expect(CUDA_IMAGES).toEqual({
            '11.8': { version: '11.8.0', os: old },
            '12.0': { version: '12.0.1', os: old },
            '12.1': { version: '12.1.1', os: old },
            '12.2': { version: '12.2.2', os: old },
            '12.3': { version: '12.3.2', os: old },
            '12.4': { version: '12.4.1', os: old },
            '12.5': { version: '12.5.1', os: all },
            '12.6': { version: '12.6.3', os: all },
            '12.8': { version: '12.8.2', os: all },
            '12.9': { version: '12.9.2', os: all },
            '13.0': { version: '13.0.3', os: recent },
            '13.1': { version: '13.1.2', os: recent },
            '13.2': { version: '13.2.1', os: recent },
            '13.3': { version: '13.3.1', os: recent },
            '13.4': { version: '13.4.2', os: recent },
        });
        expect(Object.keys(CUDA_IMAGES).sort()).toEqual(Object.values(CUDA_TYPES).sort());
        expect(Object.isFrozen(CUDA_IMAGES)).toBe(true);
    });
});
