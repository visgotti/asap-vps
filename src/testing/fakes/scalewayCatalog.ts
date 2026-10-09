// Real answers of Scaleway's public catalog endpoints, captured 2026-10-01 (no key is needed to read them), trimmed to what the specs use:
//   GET https://api.scaleway.com/instance/v1/zones/{fr-par-1,fr-par-2,nl-ams-1,pl-waw-2}/products/servers   (hourly_price is EUR, gpu_memory and ram are bytes)
//   GET https://api.scaleway.com/marketplace/v2/images
// Kept as captured, mig_profile and the capabilities the spec does not list included, so the specs read the wire format and not a paraphrase of it.

/** Instance types by commercial type. A GPU type allows no local volume (volumes_constraint 0): it boots from Block Storage; RENDER-S (P100) allows both. */
export const SERVER_TYPES: Record<string, any> = {
    "L4-1-24G": {"alt_names":[],"arch":"x86_64","ncpus":8,"ram":51539607552,"gpu":1,"gpu_info":{"gpu_manufacturer":"NVIDIA","gpu_name":"L4","gpu_memory":25769803776},"mig_profile":null,"volumes_constraint":{"min_size":0,"max_size":0},"per_volume_constraint":{"l_ssd":{"min_size":0,"max_size":0}},"scratch_storage_max_size":0,"scratch_storage_max_volumes_count":0,"monthly_price":574.875,"hourly_price":0.7875,"capabilities":{"boot_types":["local","rescue"],"placement_groups":true,"block_storage":true,"hot_snapshots_local_volume":false,"private_network":8,"max_file_systems":2},"network":{"ipv6_support":true,"sum_internal_bandwidth":2500000000,"sum_internet_bandwidth":2500000000,"interfaces":[{"internal_bandwidth":2500000000,"internet_bandwidth":2500000000}]},"block_bandwidth":1048576000,"end_of_service":false},
    "L4-2-24G": {"alt_names":[],"arch":"x86_64","ncpus":16,"ram":103079215104,"gpu":2,"gpu_info":{"gpu_manufacturer":"NVIDIA","gpu_name":"L4","gpu_memory":25769803776},"mig_profile":null,"volumes_constraint":{"min_size":0,"max_size":0},"per_volume_constraint":{"l_ssd":{"min_size":0,"max_size":0}},"scratch_storage_max_size":0,"scratch_storage_max_volumes_count":0,"monthly_price":1149.75,"hourly_price":1.575,"capabilities":{"boot_types":["local","rescue"],"placement_groups":true,"block_storage":true,"hot_snapshots_local_volume":false,"private_network":8,"max_file_systems":4},"network":{"ipv6_support":true,"sum_internal_bandwidth":5000000000,"sum_internet_bandwidth":5000000000,"interfaces":[{"internal_bandwidth":5000000000,"internet_bandwidth":5000000000}]},"block_bandwidth":1572864000,"end_of_service":false},
    "L40S-1-48G": {"alt_names":[],"arch":"x86_64","ncpus":8,"ram":103079215104,"gpu":1,"gpu_info":{"gpu_manufacturer":"NVIDIA","gpu_name":"L40S","gpu_memory":51539607552},"mig_profile":null,"volumes_constraint":{"min_size":0,"max_size":0},"per_volume_constraint":{"l_ssd":{"min_size":0,"max_size":0}},"scratch_storage_max_size":1600000000000,"scratch_storage_max_volumes_count":1,"monthly_price":1073.03868,"hourly_price":1.469916,"capabilities":{"boot_types":["local","rescue"],"placement_groups":true,"block_storage":true,"hot_snapshots_local_volume":false,"private_network":8,"max_file_systems":2},"network":{"ipv6_support":true,"sum_internal_bandwidth":2500000000,"sum_internet_bandwidth":2500000000,"interfaces":[{"internal_bandwidth":2500000000,"internet_bandwidth":2500000000}]},"block_bandwidth":1048576000,"end_of_service":false},
    "H100-1-80G": {"alt_names":[],"arch":"x86_64","ncpus":24,"ram":257698037760,"gpu":1,"gpu_info":{"gpu_manufacturer":"NVIDIA","gpu_name":"H100-PCIe","gpu_memory":85899345920},"mig_profile":null,"volumes_constraint":{"min_size":0,"max_size":0},"per_volume_constraint":{"l_ssd":{"min_size":0,"max_size":0}},"scratch_storage_max_size":3000000000000,"scratch_storage_max_volumes_count":1,"monthly_price":2092.545,"hourly_price":2.8665,"capabilities":{"boot_types":["local","rescue"],"placement_groups":true,"block_storage":true,"hot_snapshots_local_volume":false,"private_network":8,"max_file_systems":2},"network":{"ipv6_support":true,"sum_internal_bandwidth":10000000000,"sum_internet_bandwidth":10000000000,"interfaces":[{"internal_bandwidth":10000000000,"internet_bandwidth":10000000000}]},"block_bandwidth":2097152000,"end_of_service":false},
    "H100-SXM-8-80G": {"alt_names":[],"arch":"x86_64","ncpus":128,"ram":1030792151040,"gpu":8,"gpu_info":{"gpu_manufacturer":"NVIDIA","gpu_name":"H100-SXM","gpu_memory":85899345920},"mig_profile":null,"volumes_constraint":{"min_size":0,"max_size":0},"per_volume_constraint":{"l_ssd":{"min_size":0,"max_size":0}},"scratch_storage_max_size":12800000000000,"scratch_storage_max_volumes_count":1,"monthly_price":18491.484,"hourly_price":25.3308,"capabilities":{"boot_types":["local","rescue"],"placement_groups":true,"block_storage":true,"hot_snapshots_local_volume":false,"private_network":8,"max_file_systems":16},"network":{"ipv6_support":true,"sum_internal_bandwidth":20000000000,"sum_internet_bandwidth":20000000000,"interfaces":[{"internal_bandwidth":20000000000,"internet_bandwidth":20000000000}]},"block_bandwidth":5242880000,"end_of_service":false},
    "B300-SXM-8-288G": {"alt_names":[],"arch":"x86_64","ncpus":224,"ram":4123168604160,"gpu":8,"gpu_info":{"gpu_manufacturer":"NVIDIA","gpu_name":"B300-SXM","gpu_memory":309237645312},"mig_profile":null,"volumes_constraint":{"min_size":0,"max_size":0},"per_volume_constraint":{"l_ssd":{"min_size":0,"max_size":0}},"scratch_storage_max_size":24000000000000,"scratch_storage_max_volumes_count":1,"monthly_price":43800,"hourly_price":60,"capabilities":{"boot_types":["local","rescue"],"placement_groups":true,"block_storage":true,"hot_snapshots_local_volume":false,"private_network":8,"max_file_systems":16},"network":{"ipv6_support":true,"sum_internal_bandwidth":20000000000,"sum_internet_bandwidth":20000000000,"interfaces":[{"internal_bandwidth":20000000000,"internet_bandwidth":20000000000}]},"block_bandwidth":5242880000,"end_of_service":false},
    "RENDER-S": {"alt_names":[],"arch":"x86_64","ncpus":10,"ram":45097156608,"gpu":1,"gpu_info":{"gpu_manufacturer":"NVIDIA","gpu_name":"P100","gpu_memory":17179869184},"mig_profile":null,"volumes_constraint":{"min_size":0,"max_size":400000000000},"per_volume_constraint":{"l_ssd":{"min_size":1000000000,"max_size":800000000000}},"scratch_storage_max_size":0,"scratch_storage_max_volumes_count":0,"monthly_price":891.33,"hourly_price":1.221,"capabilities":{"boot_types":["local","rescue"],"placement_groups":true,"block_storage":true,"hot_snapshots_local_volume":true,"private_network":8,"max_file_systems":0},"network":{"ipv6_support":true,"sum_internal_bandwidth":2000000000,"sum_internet_bandwidth":2000000000,"interfaces":[{"internal_bandwidth":2000000000,"internet_bandwidth":2000000000}]},"block_bandwidth":2147483648,"end_of_service":false},
    "DEV1-S": {"alt_names":[],"arch":"x86_64","ncpus":2,"ram":2147483648,"gpu":0,"gpu_info":null,"mig_profile":null,"volumes_constraint":{"min_size":0,"max_size":20000000000},"per_volume_constraint":{"l_ssd":{"min_size":1000000000,"max_size":800000000000}},"scratch_storage_max_size":0,"scratch_storage_max_volumes_count":0,"monthly_price":6.55248,"hourly_price":0.008976,"capabilities":{"boot_types":["local","rescue"],"placement_groups":true,"block_storage":true,"hot_snapshots_local_volume":true,"private_network":8,"max_file_systems":0},"network":{"ipv6_support":true,"sum_internal_bandwidth":200000000,"sum_internet_bandwidth":200000000,"interfaces":[{"internal_bandwidth":200000000,"internet_bandwidth":200000000}]},"block_bandwidth":104857600,"end_of_service":false},
    "PLAY2-NANO": {"alt_names":[],"arch":"x86_64","ncpus":2,"ram":4294967296,"gpu":0,"gpu_info":null,"mig_profile":null,"volumes_constraint":{"min_size":0,"max_size":0},"per_volume_constraint":{"l_ssd":{"min_size":0,"max_size":0}},"scratch_storage_max_size":0,"scratch_storage_max_volumes_count":0,"monthly_price":20.1042,"hourly_price":0.02754,"capabilities":{"boot_types":["local","rescue"],"placement_groups":true,"block_storage":true,"hot_snapshots_local_volume":false,"private_network":8,"max_file_systems":0},"network":{"ipv6_support":true,"sum_internal_bandwidth":200000000,"sum_internet_bandwidth":200000000,"interfaces":[{"internal_bandwidth":200000000,"internet_bandwidth":200000000}]},"block_bandwidth":83886080,"end_of_service":false},
    "STARDUST1-S": {"alt_names":[],"arch":"x86_64","ncpus":1,"ram":1073741824,"gpu":0,"gpu_info":null,"mig_profile":null,"volumes_constraint":{"min_size":0,"max_size":10000000000},"per_volume_constraint":{"l_ssd":{"min_size":1000000000,"max_size":800000000000}},"scratch_storage_max_size":0,"scratch_storage_max_volumes_count":0,"monthly_price":0.438,"hourly_price":0.0006,"capabilities":{"boot_types":["local","rescue"],"placement_groups":true,"block_storage":true,"hot_snapshots_local_volume":true,"private_network":8,"max_file_systems":0},"network":{"ipv6_support":true,"sum_internal_bandwidth":100000000,"sum_internet_bandwidth":100000000,"interfaces":[{"internal_bandwidth":100000000,"internet_bandwidth":100000000}]},"block_bandwidth":52428800,"end_of_service":false},
    "BASIC2-A2C-4G": {"alt_names":[],"arch":"arm64","ncpus":2,"ram":4294967296,"gpu":0,"gpu_info":null,"mig_profile":null,"volumes_constraint":{"min_size":0,"max_size":0},"per_volume_constraint":{"l_ssd":{"min_size":0,"max_size":0}},"scratch_storage_max_size":0,"scratch_storage_max_volumes_count":0,"monthly_price":16.79,"hourly_price":0.023,"capabilities":{"boot_types":["local","rescue"],"placement_groups":true,"block_storage":true,"hot_snapshots_local_volume":false,"private_network":8,"max_file_systems":0},"network":{"ipv6_support":true,"sum_internal_bandwidth":200000000,"sum_internet_bandwidth":200000000,"interfaces":[{"internal_bandwidth":200000000,"internet_bandwidth":200000000}]},"block_bandwidth":83886080,"end_of_service":false},
};

/** Marketplace images: the label is what an Instance create takes as its `image`. */
export const MARKETPLACE_IMAGES: any[] = [
    {
        id: '3f1b9623-71ba-4fe3-b994-27fcdaa850ba',
        name: 'Ubuntu 20.04 Focal Fossa',
        label: 'ubuntu_focal',
        description: 'Ubuntu is the ideal distribution for scale-out computing, Ubuntu Server helps you make the most of your infrastructure.',
        categories: [
            'distribution'
        ],
        valid_until: null
    },
    {
        id: '1123148c-7660-4cb2-9fd3-7b5b4896f72f',
        name: 'Ubuntu 22.04 Jammy Jellyfish',
        label: 'ubuntu_jammy',
        description: 'Ubuntu is the ideal distribution for scale-out computing, Ubuntu Server helps you make the most of your infrastructure.',
        categories: [
            'distribution'
        ],
        valid_until: null
    },
    {
        id: '607b12c2-685d-45f7-905f-57bc23863834',
        name: 'Ubuntu 24.04 Noble Numbat',
        label: 'ubuntu_noble',
        description: 'Ubuntu is the ideal distribution for scale-out computing, Ubuntu Server helps you make the most of your infrastructure.',
        categories: [
            'distribution'
        ],
        valid_until: null
    },
    {
        id: '63cb3ba6-570a-48f8-a5b8-29c9650e6980',
        name: 'Ubuntu 26.04 Resolute Raccoon',
        label: 'ubuntu_resolute',
        description: 'Ubuntu is the ideal distribution for scale-out computing, Ubuntu Server helps you make the most of your infrastructure.',
        categories: [
            'distribution'
        ],
        valid_until: null
    },
    {
        id: '741cfd27-a822-4c82-b80f-973b562743ad',
        name: 'Ubuntu Noble GPU OS 13 (Nvidia)',
        label: 'ubuntu_noble_gpu_os_13_nvidia',
        description: 'Ubuntu 24.04 Noble Numbat for Nvidia GPU and Machine Learning (GPU passthrough)',
        categories: [
            'Machine Learning'
        ],
        valid_until: null
    },
    {
        id: '61916874-cf88-417d-83e8-c7933b848c6a',
        name: 'Ubuntu Noble GPU OS 12',
        label: 'ubuntu_noble_gpu_os_12',
        description: 'Ubuntu 24.04 Noble Numbat for Nvidia GPU and Machine Learning (GPU passthrough)',
        categories: [
            'Machine Learning'
        ],
        valid_until: null
    },
    {
        id: 'a6c68db3-5613-4b08-acaa-2c92d8baf26c',
        name: 'Ubuntu Jammy GPU OS 12',
        label: 'ubuntu_jammy_gpu_os_12',
        description: 'Ubuntu 22.04 Jammy Jellyfish for Nvidia GPU and Machine Learning (GPU passthrough)',
        categories: [
            'Machine Learning'
        ],
        valid_until: null
    },
    {
        id: 'fd6931c1-5326-4f8d-8fdf-57867b2830e3',
        name: 'Debian 12 (Bookworm)',
        label: 'debian_bookworm',
        description: 'Debian is a free operating system, developed by thousands of volunteers from all over the world who collaborate via the ',
        categories: [
            'distribution'
        ],
        valid_until: null
    },
    {
        id: 'c1b530d8-0ca0-45c4-80db-ba06608287b2',
        name: 'Docker',
        label: 'docker',
        description: 'Docker is an open platform for developers and sysadmins to build, ship, and run distributed applications.',
        categories: [
            'instantapp'
        ],
        valid_until: null
    }
];
