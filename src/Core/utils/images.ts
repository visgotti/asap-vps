// Images by the library's own names (MACHINE_TYPES, CUDA_TYPES): what an
// `image` may be besides a platform's name for one, read as a spec, and the
// registry reference it is wherever a container runs. A VM provider's own
// names for the same spec are its EnumTranslations (ComputeProvider).

import { CUDA_TYPES, MACHINE_TYPES } from '../../constants';
import type { ImageChoice, ImageSpec } from '../../types';

const MACHINES = new Set<string>(Object.values(MACHINE_TYPES));
const CUDAS = new Set<string>(Object.values(CUDA_TYPES));

/** Each Ubuntu's release, as image tags write it. */
const UBUNTU_RELEASES: Readonly<Record<`${MACHINE_TYPES}`, string>> = Object.freeze({
    [MACHINE_TYPES.UBUNTU_20]: '20.04',
    [MACHINE_TYPES.UBUNTU_22]: '22.04',
    [MACHINE_TYPES.UBUNTU_24]: '24.04',
});

const U20_22 = [MACHINE_TYPES.UBUNTU_20, MACHINE_TYPES.UBUNTU_22] as const;
const U20_24 = [MACHINE_TYPES.UBUNTU_20, MACHINE_TYPES.UBUNTU_22, MACHINE_TYPES.UBUNTU_24] as const;
const U22_24 = [MACHINE_TYPES.UBUNTU_22, MACHINE_TYPES.UBUNTU_24] as const;

/**
 * NVIDIA's CUDA images on Docker Hub (nvidia/cuda), by CUDA version: its
 * newest patch release and the Ubuntu releases it is published for, as the
 * registry's tag list had them on 2026-10-11.
 */
export const CUDA_IMAGES: Readonly<Record<`${CUDA_TYPES}`, { readonly version: string, readonly os: readonly MACHINE_TYPES[] }>> = Object.freeze({
    [CUDA_TYPES.CUDA_11_8]: { version: '11.8.0', os: U20_22 },
    [CUDA_TYPES.CUDA_12_0]: { version: '12.0.1', os: U20_22 },
    [CUDA_TYPES.CUDA_12_1]: { version: '12.1.1', os: U20_22 },
    [CUDA_TYPES.CUDA_12_2]: { version: '12.2.2', os: U20_22 },
    [CUDA_TYPES.CUDA_12_3]: { version: '12.3.2', os: U20_22 },
    [CUDA_TYPES.CUDA_12_4]: { version: '12.4.1', os: U20_22 },
    [CUDA_TYPES.CUDA_12_5]: { version: '12.5.1', os: U20_24 },
    [CUDA_TYPES.CUDA_12_6]: { version: '12.6.3', os: U20_24 },
    [CUDA_TYPES.CUDA_12_8]: { version: '12.8.2', os: U20_24 },
    [CUDA_TYPES.CUDA_12_9]: { version: '12.9.2', os: U20_24 },
    [CUDA_TYPES.CUDA_13_0]: { version: '13.0.3', os: U22_24 },
    [CUDA_TYPES.CUDA_13_1]: { version: '13.1.2', os: U22_24 },
    [CUDA_TYPES.CUDA_13_2]: { version: '13.2.1', os: U22_24 },
    [CUDA_TYPES.CUDA_13_3]: { version: '13.3.1', os: U22_24 },
    [CUDA_TYPES.CUDA_13_4]: { version: '13.4.2', os: U22_24 },
});

/**
 * No image exists for a spec that is well formed: its message names the spec
 * and says why, worded to follow "image " (a provider's NotSupportedError).
 * A spec that is not well formed (a typo) is a plain Error instead.
 */
export class NoSuchImageError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'NoSuchImageError';
    }
}

/** A CUDA version as CUDA_TYPES writes one, from how a caller may ('12.8', 12.8, '13', 13 -> '13.0'); undefined for anything else. */
function cudaMember(v: unknown): string | undefined {
    const m = typeof v === 'string' || typeof v === 'number' ? /^(\d+)(?:\.(\d+))?$/.exec(String(v)) : null;
    return m ? `${Number(m[1])}.${Number(m[2] ?? 0)}` : undefined;
}

/**
 * An image named by the library's enums, as a spec: a MACHINE_TYPES member is
 * that Ubuntu, an ImageSpec itself (its `cuda` as CUDA_TYPES writes it).
 * undefined for a platform's own name (any other string) and for no image. A
 * spec whose `os` or `cuda` the enums do not have throws, so a typo is not
 * read as some other image.
 */
export function imageSpecOf(image: ImageChoice | undefined | null): ImageSpec | undefined {
    if (image === undefined || image === null) return undefined;
    if (typeof image !== 'object') return MACHINES.has(image) ? { os: image as MACHINE_TYPES } : undefined;
    if (!MACHINES.has(image.os)) throw new Error(`bad image os ${JSON.stringify(image.os)}: use a MACHINE_TYPES member (${[...MACHINES].join(', ')})`);
    if (image.cuda === undefined) return image;
    const cuda = cudaMember(image.cuda);
    if (!cuda || !CUDAS.has(cuda)) throw new Error(`bad image cuda ${JSON.stringify(image.cuda)}: use a CUDA_TYPES member (${[...CUDAS].join(', ')})`);
    return cuda === image.cuda ? image : { ...image, cuda: cuda as `${CUDA_TYPES}` };
}

/**
 * The registry reference of a spec, for anything that runs containers:
 * Docker Hub's `ubuntu:<release>`, or with `cuda` NVIDIA's
 * `nvidia/cuda:<newest patch>-base-ubuntu<release>` (`base`: the CUDA
 * runtime and nothing else). A spec that is not well formed throws as
 * imageSpecOf does; a CUDA version NVIDIA does not publish for that Ubuntu
 * is a NoSuchImageError.
 */
export function containerImageOf(spec: ImageSpec): string {
    const { os, cuda } = imageSpecOf(spec) ?? spec;
    const release = UBUNTU_RELEASES[os];
    if (!release) throw new Error(`bad image ${JSON.stringify(spec)}: use { os, cuda? }`);
    if (cuda === undefined) return `ubuntu:${release}`;
    const published = CUDA_IMAGES[cuda];
    if (!published.os.some((x) => x === os)) {
        throw new NoSuchImageError(`"${os}" with cuda "${cuda}" (NVIDIA publishes no CUDA ${cuda} image of Ubuntu ${release}: it has ${published.os.map((x) => UBUNTU_RELEASES[x]).join(', ')})`);
    }
    return `nvidia/cuda:${published.version}-base-ubuntu${release}`;
}
