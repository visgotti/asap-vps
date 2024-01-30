
import {  DigitalOceanInitializer } from './DigitalOceanInitializer';
import { decrypt } from '../utils';
import { SSHService } from '../Core/SSHService';
const TEST_SSH_NAME = 'TEST_SSH_NAME'

let initializer: DigitalOceanInitializer;
jest.setTimeout(100000);

describe('DigitalOceanInitializer', () => {
    beforeAll(async () => {
        initializer = new DigitalOceanInitializer({ apiKey: process.env.DIGITAL_OCEAN_API_KEY as string });
        await initializer.getOptions(true, true);
    });
  beforeEach(async () => {
    expect(process.env.DIGITAL_OCEAN_API_KEY).toBeTruthy();
    initializer = new DigitalOceanInitializer({ apiKey: process.env.DIGITAL_OCEAN_API_KEY as string });
    const options = await initializer.init(true);
    expect(options.size).toBeDefined();
    expect(options.ssh).toBeDefined();
    expect(options.size?.length).toBeGreaterThan(0)
  });

  it('tests DigitalOceanInitializer.initKey and deleteKey', async () => {
    const created = await SSHService.createKeys();
    expect(!!created).toBe(true);
    expect(created.publicKey).toBeDefined();
    expect(created.privateKey).toBeDefined();

    // should have no test key
    expect( initializer.options!.ssh?.find(s => s.name === TEST_SSH_NAME)).toBeUndefined();
    const initialized = await initializer.initKey(created.publicKey!, TEST_SSH_NAME)
    expect(initialized).toBeDefined();
    expect(initialized.fingerprint).toBeDefined();
    expect(initialized.name).toBeDefined();
    expect(initialized.id).toBeDefined();
    expect(initialized.publicKey).toBe(created.publicKey);
    await initializer.getOptions(true, true);
    expect( initializer.options!.ssh?.find(s => s.name === TEST_SSH_NAME)).toBeDefined();
    await initializer.deleteKey(initialized.id)
    expect( initializer.options!.ssh?.find(s => s.name === TEST_SSH_NAME)).toBeUndefined();
    await initializer.getOptions(true, true);
    expect( initializer.options!.ssh?.find(s => s.name === TEST_SSH_NAME)).toBeUndefined();
  });
  
  it('tests DigitalOceanInitializer.create', async () => {
    const ssh = await SSHService.createKeys();
    expect(ssh?.publicKey).toBeDefined();
    const initialized = await initializer.initKey(ssh.publicKey!, TEST_SSH_NAME)
    const createdDroplet = await initializer.create({
      region: 'nyc1',
      size: 's-1vcpu-1gb',
      image: 'wordsmythcreatio-aresmush',
      ssh: initialized.id
    });
    expect(createdDroplet).toBeDefined();

    await initializer.deleteKey(initialized.id)
    await initializer.deleteDroplet(createdDroplet.internalId);
  });

  it('tests DigitalOceanInitializer.create and can ssh into it.', async () => {
    const created = await SSHService.createKeys()
    const initializedSsh = await initializer.initKey(created.publicKey!, TEST_SSH_NAME)
    const createdDroplet = await initializer.create({
      region: 'nyc1',
      size: 's-1vcpu-1gb',
      image: 'wordsmythcreatio-aresmush',
      ssh: initializedSsh.id
    });
    const ssh = await SSHService.connect(createdDroplet.ip, created);
    expect(ssh).toBeDefined();
    await ssh.dispose();
    await initializer.deleteKey(initializedSsh.id)
    await initializer.deleteDroplet(createdDroplet.internalId);
  });
});