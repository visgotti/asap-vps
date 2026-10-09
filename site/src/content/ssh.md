# Setting a server up

`ServerProvisioner` does the whole run on any provider with `compute` and `sshKeys` whose servers are VMs (DigitalOcean, Scaleway, Lambda). It makes a fresh key, rents the offer, waits for the server, runs a `SetupPipeline` over SSH (through sudo where the login is not root), and **deletes the server again if any of it fails**. A VPS and a GPU VM go through it the same way.

This needs Node (sockets and key generation), so the blocks here are type-checked on every build but not run in the sandbox:

```ts
import { InstallDockerStep, LambdaCloud, RunCommandStep, ServerProvisioner } from "asap-vps";

const lambda = new LambdaCloud(process.env.LAMBDA_API_KEY!);
const [offer] = await lambda.listOffers({ gpus: ["A10"] });

const { server } = await new ServerProvisioner(lambda).provision({ serverOptions: { name: "worker-1", offer } }, (pipeline) => {
  pipeline.addStep(new InstallDockerStep()).addStep(new RunCommandStep(["nvidia-smi -L"], "check-gpu"));
});
console.log(server.ip);
```

The steps are small classes you can write your own of: `InstallDockerStep`, `ConfigureFirewallStep`, `InstallSSLCertificateStep`, `CreateDirectoryStep`, `RunCommandStep`, `AddAuthorizedKeyStep` and `InstallNodeStep` ship with the library.

## Mounts and options go through

`serverOptions` is the same `createServer` options any provider takes, typed per platform:

```ts
import { DigitalOcean, RunCommandStep, ServerProvisioner } from "asap-vps";

const digitalOcean = new DigitalOcean(process.env.DIGITAL_OCEAN_API_KEY!);
const [offer] = await digitalOcean.listOffers({ kind: "cpu" });
const volume = await digitalOcean.createVolume({ name: "data", region: offer.regions[0], sizeGb: 20 });

const result = await new ServerProvisioner(digitalOcean).provision(
  { serverOptions: { name: "db-1", offer, region: offer.regions[0], mounts: [{ volume }] } },
  (pipeline) => void pipeline.addStep(new RunCommandStep([`df -h ${volume.mountPath}`], "volume")),
);
console.log(result.setupResults.map((r) => r.output));
```

## A key a provider applies at every boot

Where the provider applies the account's keys at every boot (`capabilities.sshKeys.appliedAtBoot`: Scaleway), the provisioner keeps the key it registered and returns its id as `providerSshKeyId`. Deleting the key would lock the server out at its next boot, so delete it yourself once the server is gone.

## Logging in yourself

`SSHService.connect` takes the endpoint every server reports (`server.ssh`: host, port and user) and a private key. The [quick start](#/quick-start) has the full run.
