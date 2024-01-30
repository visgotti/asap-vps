
import { DigitalOcean } from './DigitalOceanInitializer';
import { asyncTimeout } from '../../utils';
import { SSHService } from '../../Core/SSHService';
import { MACHINE_TYPES } from '../../constants';
import type { NodeSSH } from 'node-ssh';

const TEST_SSH_NAME = 'TEST_SSH_NAME'

let initializer: DigitalOcean;
jest.setTimeout(100000);

describe('DigitalOcean', () => {
  beforeAll(async () => {
      initializer = new DigitalOcean(process.env.DIGITAL_OCEAN_API_KEY as string);
      await initializer.getOptions(true, true);
      await initializer.deleteKeysWithName(TEST_SSH_NAME);
      await asyncTimeout(500);
  });
  beforeEach(async () => {
    expect(process.env.DIGITAL_OCEAN_API_KEY).toBeTruthy();
    initializer = new DigitalOcean(process.env.DIGITAL_OCEAN_API_KEY as string);
    const options = await initializer.init(true);
    expect(options.size).toBeDefined();
    expect(options.ssh).toBeDefined();
    expect(options.size?.length).toBeGreaterThan(0)
  });

  it('tests DigitalOcean.addSSHKey and deleteSSHKey', async () => {
    const created = await SSHService.createKeys();
    expect(!!created).toBe(true);
    expect(created.publicKey).toBeDefined();
    expect(created.privateKey).toBeDefined();

    // should have no test key
    expect( initializer.options!.ssh?.find(s => s.name === TEST_SSH_NAME)).toBeUndefined();
    const initialized = await initializer.addSSHKey(created.publicKey!, TEST_SSH_NAME)
    expect(initialized).toBeDefined();
    expect(initialized.fingerprint).toBeDefined();
    expect(initialized.name).toBeDefined();
    expect(initialized.id).toBeDefined();
    expect(initialized.publicKey).toBe(created.publicKey);
    await initializer.getOptions(true, true);
    expect( initializer.options!.ssh?.find(s => s.name === TEST_SSH_NAME)).toBeDefined();
    await initializer.deleteSSHKey(initialized.id)
    expect( initializer.options!.ssh?.find(s => s.name === TEST_SSH_NAME)).toBeUndefined();
    await initializer.getOptions(true, true);
    expect( initializer.options!.ssh?.find(s => s.name === TEST_SSH_NAME)).toBeUndefined();
  });
  
  it('tests DigitalOcean.createServer', async () => {
    const ssh = await SSHService.createKeys();
    expect(ssh?.publicKey).toBeDefined();
    const initialized = await initializer.addSSHKey(ssh.publicKey!, TEST_SSH_NAME)
    const createdDroplet = await initializer.createServer({
      region: 'nyc1',
      size: 's-1vcpu-1gb',
      image: MACHINE_TYPES.UBUNTU_22,
      ssh: initialized.id
    });
    expect(createdDroplet).toBeDefined();

    await initializer.deleteSSHKey(initialized.id)
    await initializer.deleteServer(createdDroplet.id);
  });

  it('tests DigitalOcean.createServer and can ssh into it.', async () => {
    const created = await SSHService.createKeys();
    const initializedSsh = await initializer.addSSHKey(created.publicKey!, TEST_SSH_NAME)
    const createdDroplet = await initializer.createServer({
      region: 'nyc1',
      size: 's-1vcpu-1gb',
      image: MACHINE_TYPES.UBUNTU_22,
      ssh: initializedSsh.id
    });
    const ssh : NodeSSH = await SSHService.connect(createdDroplet.ip, created.privateKey);
    expect(ssh).toBeDefined();
    await ssh.dispose();
    await initializer.deleteSSHKey(initializedSsh.id)
    await initializer.deleteServer(createdDroplet.id);
  });
});