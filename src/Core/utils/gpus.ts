// One name per GPU model, whatever each provider calls it ("nvidia_l40s",
// "NVIDIA L40S", "L40S", "RTX 4000 Ada Generation", "RTX_4000Ada"), so offers
// from different providers can be compared and filtered by one rule.

import type { GpuVendor } from '../../types';

export type GpuModel = { name: string, vendor: GpuVendor, vramGb: number, arch: string };

const MODELS: Array<GpuModel & { re: RegExp }> = [
    { name: 'RTX 2000 Ada', vendor: 'nvidia', vramGb: 16, arch: 'sm89', re: /rtx[\s_-]*2000[\s_-]*(sff[\s_-]*)?ada/i },
    { name: 'RTX 4000 Ada', vendor: 'nvidia', vramGb: 20, arch: 'sm89', re: /rtx[\s_-]*4000[\s_-]*(sff[\s_-]*)?ada/i },
    { name: 'RTX 6000 Ada', vendor: 'nvidia', vramGb: 48, arch: 'sm89', re: /rtx[\s_-]*6000[\s_-]*ada/i },
    { name: 'RTX PRO 4500', vendor: 'nvidia', vramGb: 32, arch: 'sm120', re: /rtx[\s_-]*pro[\s_-]*4500/i },
    { name: 'RTX PRO 6000', vendor: 'nvidia', vramGb: 96, arch: 'sm120', re: /rtx[\s_-]*pro[\s_-]*6000/i },
    { name: 'RTX A4000', vendor: 'nvidia', vramGb: 16, arch: 'sm86', re: /(rtx[\s_-]*)?a4000/i },
    { name: 'RTX A5000', vendor: 'nvidia', vramGb: 24, arch: 'sm86', re: /(rtx[\s_-]*)?a5000/i },
    { name: 'RTX A6000', vendor: 'nvidia', vramGb: 48, arch: 'sm86', re: /(rtx[\s_-]*)?a6000/i },
    { name: 'RTX 3090', vendor: 'nvidia', vramGb: 24, arch: 'sm86', re: /rtx[\s_-]*3090/i },
    { name: 'RTX 4090', vendor: 'nvidia', vramGb: 24, arch: 'sm89', re: /rtx[\s_-]*4090/i },
    { name: 'RTX 5090', vendor: 'nvidia', vramGb: 32, arch: 'sm120', re: /rtx[\s_-]*5090/i },
    { name: 'L4', vendor: 'nvidia', vramGb: 24, arch: 'sm89', re: /(^|[^a-z0-9])l4($|[^0-9a-z])/i },
    { name: 'L40S', vendor: 'nvidia', vramGb: 48, arch: 'sm89', re: /l40[\s_-]*s/i },
    { name: 'L40', vendor: 'nvidia', vramGb: 48, arch: 'sm89', re: /(^|[^a-z0-9])l40($|[^0-9a-z])/i },
    { name: 'A10', vendor: 'nvidia', vramGb: 24, arch: 'sm86', re: /(^|[^a-z0-9])a10g?($|[^0-9a-z])/i },
    { name: 'A16', vendor: 'nvidia', vramGb: 16, arch: 'sm86', re: /(^|[^a-z0-9])a16($|[^0-9a-z])/i },
    { name: 'A40', vendor: 'nvidia', vramGb: 48, arch: 'sm86', re: /(^|[^a-z0-9])a40($|[^0-9a-z])/i },
    { name: 'A100', vendor: 'nvidia', vramGb: 80, arch: 'sm80', re: /a100/i },
    { name: 'T4', vendor: 'nvidia', vramGb: 16, arch: 'sm75', re: /(^|[^a-z0-9])t4($|[^0-9a-z])/i },
    { name: 'V100', vendor: 'nvidia', vramGb: 16, arch: 'sm70', re: /v100/i },
    { name: 'P100', vendor: 'nvidia', vramGb: 16, arch: 'sm60', re: /(^|[^a-z0-9])p100($|[^0-9a-z])/i },
    { name: 'H100', vendor: 'nvidia', vramGb: 80, arch: 'sm90', re: /h100/i },
    // Before H200: "GH200" contains "h200".
    { name: 'GH200', vendor: 'nvidia', vramGb: 96, arch: 'sm90', re: /gh200/i },
    { name: 'H200', vendor: 'nvidia', vramGb: 141, arch: 'sm90', re: /h200/i },
    // Before B200 / B300: "GB200" and "GB300" contain them (a Grace-Blackwell superchip's GPU).
    { name: 'GB200', vendor: 'nvidia', vramGb: 186, arch: 'sm100', re: /gb200/i },
    { name: 'GB300', vendor: 'nvidia', vramGb: 279, arch: 'sm103', re: /gb300/i },
    { name: 'B200', vendor: 'nvidia', vramGb: 180, arch: 'sm100', re: /b200/i },
    { name: 'B300', vendor: 'nvidia', vramGb: 288, arch: 'sm103', re: /b300/i },
    { name: 'MI300X', vendor: 'amd', vramGb: 192, arch: 'gfx942', re: /mi[\s_-]*300[\s_-]*x/i },
    { name: 'MI325X', vendor: 'amd', vramGb: 256, arch: 'gfx942', re: /mi[\s_-]*325[\s_-]*x/i },
    { name: 'MI350X', vendor: 'amd', vramGb: 288, arch: 'gfx950', re: /mi[\s_-]*350[\s_-]*x/i },
    { name: 'MI355X', vendor: 'amd', vramGb: 288, arch: 'gfx950', re: /mi[\s_-]*355[\s_-]*x/i },
];

export function canonicalGpu(raw: string | null | undefined): GpuModel | null {
    const s = String(raw ?? '').trim();
    if (!s) return null;
    const hit = MODELS.find((m) => m.re.test(s));
    return hit ? { name: hit.name, vendor: hit.vendor, vramGb: hit.vramGb, arch: hit.arch } : null;
}

/** The canonical name, or the provider's own string when the model is unknown. */
export function gpuName(raw: string | null | undefined): string {
    return canonicalGpu(raw)?.name ?? String(raw ?? '').trim();
}

export function gpuVendor(raw: string | null | undefined): GpuVendor {
    const c = canonicalGpu(raw);
    if (c) return c.vendor;
    return /amd|radeon|instinct|mi\d/i.test(String(raw)) ? 'amd' : 'nvidia';
}
