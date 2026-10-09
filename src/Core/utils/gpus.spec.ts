import { canonicalGpu, gpuName, gpuVendor } from './gpus';

describe('gpus', () => {
    it('one name per model whatever the provider calls it', () => {
        const cases: Record<string, string> = {
            nvidia_l40s: 'L40S', 'NVIDIA L40S': 'L40S', 'nvidia l4': 'L4', 'NVIDIA RTX 4000 Ada Generation': 'RTX 4000 Ada',
            RTX_4000Ada: 'RTX 4000 Ada', 'RTX 4000 SFF Ada': 'RTX 4000 Ada', 'NVIDIA RTX A4000': 'RTX A4000', 'NVIDIA A100-SXM4-80GB': 'A100',
            A10G: 'A10', 'A10 (24 GB PCIe)': 'A10', 'Tesla T4': 'T4', 'NVIDIA H100 80GB HBM3': 'H100', 'RTX 6000 Ada': 'RTX 6000 Ada',
            'RTX A6000': 'RTX A6000', mi300x: 'MI300X', 'NVIDIA GeForce RTX 4090': 'RTX 4090', 'GH200 (96 GB)': 'GH200', 'H200 NVL': 'H200', 'NVIDIA GB200': 'GB200', 'GB300 NVL72': 'GB300', 'NVIDIA B200': 'B200',
            'NVIDIA RTX 2000 Ada Generation': 'RTX 2000 Ada', 'NVIDIA RTX PRO 4500 Blackwell Server Edition': 'RTX PRO 4500',
            // What Scaleway's Instance types call them (gpu_info.gpu_name).
            P100: 'P100', 'Tesla P100': 'P100', L4: 'L4', L40S: 'L40S', 'H100-PCIe': 'H100', 'H100-SXM': 'H100', 'B300-SXM': 'B300',
        };
        for (const [raw, name] of Object.entries(cases)) expect([raw, canonicalGpu(raw)?.name]).toEqual([raw, name]);
        expect(canonicalGpu('gpu-l40sx1-48gb')?.name).toBe('L40S');
        expect(canonicalGpu('something new')).toBeNull();
        // Look-alikes stay apart: an Ampere A2000 is not an RTX 2000 Ada, and Lambda's Turing RTX 6000 (24 GB) is neither Ada nor A6000.
        expect([canonicalGpu('NVIDIA RTX A2000')?.name, canonicalGpu('RTX 6000 (24 GB)')]).toEqual([undefined, null]);
    });

    it('gpuName: the canonical name, else the provider\'s own, trimmed; nothing is an empty name', () => {
        expect([gpuName('NVIDIA L40S'), gpuName('  Some New GPU '), gpuName(null), gpuName(undefined)]).toEqual(['L40S', 'Some New GPU', '', '']);
    });

    it('gpuVendor: the model\'s vendor, else AMD by its marks, else NVIDIA', () => {
        expect([gpuVendor('mi300x'), gpuVendor('NVIDIA H100 80GB HBM3'), gpuVendor('Radeon Pro W7900'), gpuVendor('AMD Instinct MI210'), gpuVendor('Quadro P4000'), gpuVendor(null)])
            .toEqual(['amd', 'nvidia', 'amd', 'amd', 'nvidia', 'nvidia']);
    });
});
