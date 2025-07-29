Work in progress, right now only a limited amount of functionality is implemented Digital Ocean

# Creating a droplet

```typescript
import { DigitalOcean, REGION_TYPES, MACHINE_TYPES } from "asap-vps";

const digitalOcean = await DigitalOcean.Init(process.env.DIGITAL_OCEAN_API_KEY);
// or const digitalOcean = await (new DigitalOcean(process.env.DIGITAL_OCEAN_API_KEY)).init();

// create a droplet
const created = await digitalOcean.createServer({
  region: REGION_TYPES.NYC1,
  size: "s-1vcpu-1gb",
  image: MACHINE_TYPES.UBUNTU_22,
});

// delete it with the id that gets returned
await digitalOcean.deleteServer(created.id);
```

# Creating Droplet with SSH keys

```typescript
import {
  DigitalOcean,
  SSHService,
  REGION_TYPES,
  MACHINE_TYPES,
} from "asap-vps";
const digitalOcean = await DigitalOcean.Init(process.env.DIGITAL_OCEAN_API_KEY);
const { publicKey, privateKey } = await SSHService.createKeys();
const initializedSsh = await digitalOcean.addSSHKey(publicKey, "my_key");
const createdDroplet = await digitalOcean.createServer({
  region: REGION_TYPES.NYC1,
  size: "s-1vcpu-1gb",
  image: MACHINE_TYPES.UBUNTU_22,
  ssh: initializedSsh.id,
});

// can delete it later
await digitalOcean.deleteSSHKey(initializedSsh.id);
```

# SSH Into droplet

```typescript
import type { NodeSSH } from "node-ssh"; // returns object from node-ssh lib
const ssh: NodeSSH = await SSHService.connect(createdDroplet.ip, privateKey);
```

# Running tests 

copy and paste the .env.template and rename it to .env.test


## digital ocean

- get an api key from digital ocean and set DIGITAL_OCEAN_API_KEY inside of the .env.test file you just created, the key should have all permissions because the automated testing creates and then destroys droplets

- go to the project in your cli and run `npm run test`

## todo

- Normalize size strings with enum same was as region and images
- Add more machine(image) type enums
- Add more region type enums
- Implement Linode Initializer
- Implement AWS Initializer
- Add setup scripts for ubuntu/git
- Add setup scripts for debian/node
- Add setup scripts for debian/forever
- Add setup scripts for debian/git
