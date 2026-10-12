// What `import { ... } from 'asap-vps'` gives (src/index.ts): every name it
// exports at run time is something (a re-export of nothing would be
// undefined), the names 0.0.22 exported that this version keeps are still
// there, and every provider the registry builds is exported as its class.

import * as api from './index';

describe('the package entry', () => {
    it('every name it exports is defined', () => {
        const names = Object.keys(api);
        expect(names.length).toBeGreaterThan(50);
        expect(names.filter((n) => (api as Record<string, unknown>)[n] === undefined)).toEqual([]);
    });

    it('keeps the names of 0.0.22 this version still offers', () => {
        for (const name of [
            'SSHService', 'SetupPipeline', 'ServerProvisioner', 'encrypt', 'decrypt', 'DigitalOcean', 'MACHINE_TYPES', 'REGION_TYPES', 'SETUP_SCRIPTS',
            'InstallDockerStep', 'ConfigureFirewallStep', 'InstallSSLCertificateStep', 'CreateDirectoryStep', 'RunCommandStep', 'AddAuthorizedKeyStep', 'InstallNodeStep',
        ]) expect(api).toHaveProperty(name);
    });

    it('exports the SSH layer: the machine, its error, the user steps and the scripts they send', () => {
        expect([typeof api.RemoteMachine, typeof api.RemoteMachine.connect, typeof api.RemoteCommandError, typeof api.AddUserStep, typeof api.AddAuthorizedKeyStep])
            .toEqual(['function', 'function', 'function', 'function', 'function']);
        const key = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIB2h04uLAaWyLHTRRBP775DMblS1LK+wSdC6ytS+iWjk a@laptop';
        expect(api.addUserScript('deploy', { publicKeys: [key] })).toContain(`asap_vps_keys "$user" '${key}'`);
        expect(api.authorizeKeysScript([key], 'ubuntu')).toContain(`asap_vps_keys 'ubuntu' '${key}'`);
        expect(api.sshdBootScript([key])).toContain(`asap_vps_keys root '${key}'`);
    });

    it('exports every provider the registry builds, as the class it builds', () => {
        const classes: Record<string, abstract new (...args: never[]) => unknown> = {
            digitalocean: api.DigitalOcean, runpod: api.RunPod, vast: api.VastAI, lambda: api.LambdaCloud, scaleway: api.Scaleway,
        };
        expect(Object.keys(api.PROVIDERS).sort()).toEqual(Object.keys(classes).sort());
        for (const id of Object.keys(api.PROVIDERS)) expect(api.createProvider(id, `${id}-key`)).toBeInstanceOf(classes[id]);
    });
});
