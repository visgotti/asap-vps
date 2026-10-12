# Logging in and setting up

Every provider's servers are logged in to the same way, a VM or a container. Create the server with `sshKeyIds`, wait until it runs, and the server itself says where its sshd is, on which port, and whom to log in as:

```ts run title="The same three facts, whatever rents the server"
import { CUDA_TYPES, LambdaCloud, MACHINE_TYPES, RunPod } from "asap-vps";

const publicKey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKd0 laptop";

// a VM: Lambda installs the key, and its login is ubuntu
const lambda = new LambdaCloud(process.env.LAMBDA_API_KEY!);
const lambdaKey = await lambda.addSSHKey(publicKey, "laptop");
const vm = await lambda.createServer({ name: "vm-1", offer: (await lambda.listOffers())[0], sshKeyIds: [lambdaKey.id] });
console.log("lambda:", (await lambda.waitUntilRunning(vm.id)).ssh);

// a container: the library starts an SSH server in it, ahead of its command
const runpod = new RunPod(process.env.RUNPOD_API_KEY!);
const runpodKey = await runpod.addSSHKey(publicKey, "laptop");
const pod = await runpod.createServer({
  name: "pod-1",
  offer: (await runpod.listOffers())[0],
  image: { os: MACHINE_TYPES.UBUNTU_24, cuda: CUDA_TYPES.CUDA_12_8 },
  sshKeyIds: [runpodKey.id],
});
console.log("runpod:", (await runpod.waitUntilRunning(pod.id)).ssh);

await lambda.deleteServerAndWait(vm.id);
await runpod.deleteServerAndWait(pod.id);
await lambda.deleteSSHKey(lambdaKey.id);
await runpod.deleteSSHKey(runpodKey.id);
```

## Working on a machine

`RemoteMachine.connect` takes that server and the private key. This needs Node (sockets and key generation), so the blocks from here on are type-checked on every build but not run in the sandbox:

```ts
import { CUDA_TYPES, MACHINE_TYPES, RemoteMachine, RunPod, SSHService } from "asap-vps";

const runpod = new RunPod(process.env.RUNPOD_API_KEY!);
const { publicKey, privateKey } = await SSHService.createKeys(); // in process: nothing is written to disk
const key = await runpod.addSSHKey(publicKey, "laptop");
const [offer] = await runpod.listOffers({ gpus: ["RTX 4090"] });
const server = await runpod.createServer({
  name: "worker-1", offer, image: { os: MACHINE_TYPES.UBUNTU_24, cuda: CUDA_TYPES.CUDA_12_8 }, sshKeyIds: [key.id],
});

const machine = await RemoteMachine.connect(await runpod.waitUntilRunning(server.id), { privateKey });
console.log((await machine.run("nvidia-smi -L")).stdout);   // as the login; an exit other than 0 throws RemoteCommandError
await machine.sudo("apt-get update");                        // as root: as it is for a root login, through sudo for any other
await machine.writeFile("/etc/app.env", "PORT=8080\n", { mode: "600" });
console.log(await machine.readFile("/etc/app.env"));
await machine.close();
```

The same lines work with a `DigitalOcean`, `Scaleway`, `LambdaCloud` or `VastAI` in place of the `RunPod`.

| Call | What it does |
|---|---|
| `RemoteMachine.connect(server, { privateKey, username?, decryptionKey?, retry? })` | A session to a running server, or to an `{ host, port, username }` given as it is. As the server's own login unless `username` names another. A server with no `ssh` endpoint (not running yet, or made with no key) says so. |
| `run(command, { cwd?, env?, stdin?, check? })` | The command as the login: `{ stdout, stderr, code }`. One that does not exit 0 throws `RemoteCommandError` (who ran what where, its status, all it wrote) unless `check` is false. |
| `sudo(command, o?)` | The command as root: as it is where the login is root, through passwordless `sudo` where it is not. |
| `readFile(path, { sudo? })`, `writeFile(path, text, { mode?, owner?, sudo? })` | A text file, as it is. The text goes over the session's input, never into a command line. |
| `upload(local, remote)`, `download(remote, local)` | A file over SFTP, as the login. |
| `addUser(name, { publicKeys?, sudo?, shell? })` | Makes a user, or brings one that exists to what is asked. |
| `authorizeKeys(publicKeys, user?)` | Adds keys to the ones that log in as `user` (default: the login itself), each once. |
| `as(name, { privateKey })` | A second session to the same machine, as another user. |
| `root`, `ssh` | The session with everything done as root (what a `SetupPipeline`'s steps run on), and the bare session (node-ssh's). |
| `close()` | Ends the session. |

## Not only root

`addUser` makes an ordinary user: a home, no password, the keys that log in as it, and with `sudo: true` the right to run anything as root with no password (`sudo: false` takes it back). It is the same call on a Debian, an Alpine or a RHEL family image, a VM or a container, and done again it changes nothing.

```ts
import { DigitalOcean, RemoteMachine, SSHService } from "asap-vps";

const digitalOcean = new DigitalOcean(process.env.DIGITAL_OCEAN_API_KEY!);
const server = (await digitalOcean.getServer("123456"))!;
const rootKey = process.env.ROOT_PRIVATE_KEY!;

const machine = await RemoteMachine.connect(server, { privateKey: rootKey });
const deployKeys = await SSHService.createKeys();
await machine.addUser("deploy", { publicKeys: [deployKeys.publicKey], sudo: true });

const deploy = await machine.as("deploy", { privateKey: deployKeys.privateKey });
console.log((await deploy.run("whoami")).stdout); // deploy
await deploy.sudo("systemctl restart app");       // through its sudo
await deploy.close();
await machine.close();

// later, from anywhere: the user is the machine's, not the session's
const again = await RemoteMachine.connect(server, { privateKey: deployKeys.privateKey, username: "deploy" });
await again.close();
```

To have the user from a VM's first boot, with no login at all, pass the same script as user data: `userData: "#!/bin/sh\n" + addUserScript("deploy", { publicKeys, sudo: true })`. In a pipeline it is `new AddUserStep("deploy", { publicKeys, sudo: true })`.

## What differs underneath

How the keys get in differs by platform. What you call does not.

| Provider | Login | Where (`server.ssh`) | How `sshKeyIds` gets its keys in |
|---|---|---|---|
| DigitalOcean | `root` | the droplet's address, port 22 | DigitalOcean, at the create |
| Scaleway | `root` | the Instance's address, port 22 | Scaleway, at every boot: every key of the Project besides the ones named (`capabilities.sshKeys.atCreate` is `'account'`) |
| Lambda | `ubuntu`, which has sudo | the instance's address, port 22 | Lambda takes the first; the others are added at the first boot. At least one must be named |
| RunPod | `root` | the pod's public address and the port mapped to its 22 | an SSH server the library starts in the container, before its command |
| Vast | `root` | the machine's address and the port mapped to the container's 22 | the same SSH server, started the same way |

A container platform gives a container no SSH server, so `sshKeyIds` there starts one: OpenSSH, taking exactly the keys named and no password, with the container's own `PATH` and `LD_LIBRARY_PATH` in a session (so `nvidia-smi` and `python` are found as the image's own processes find them). It runs before the container's command and then hands over to it. Three things follow:

- **The container needs a command to hand over to.** An image named by the library (`MACHINE_TYPES`, `{ os, cuda }`) is given one that keeps it up. With an image of your own, pass `command`, as the whole command line (`["python", "serve.py"]`, not arguments to the image's entrypoint): the SSH server's start takes the entrypoint's place and then runs the command. Without one the create is refused before anything is rented.
- **The image must start as root**, and have either `sshd` or a package manager to install it with (apt-get, apk, dnf or yum; an install adds some seconds to the first boot). Where neither holds, the container does not start, and its log says why, rather than run where nobody can log in.
- **To use an image's own SSH setup instead**, leave `sshKeyIds` out and use the platform's way: on RunPod `providerOptions: { startSsh: true }` with `env: { PUBLIC_KEY }` and `ports: ["22/tcp"]`, in an image built for it; on Vast `providerOptions: { runtype: "ssh" }`.

```ts run title="An image of your own needs a command to hand over to"
import { NotSupportedError, RunPod } from "asap-vps";

const runpod = new RunPod(process.env.RUNPOD_API_KEY!);
const key = await runpod.addSSHKey("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKd0 laptop", "laptop");
const [offer] = await runpod.listOffers();
const pod = { name: "pod-1", offer, image: "ghcr.io/acme/model:latest", sshKeyIds: [key.id] };

try {
  await runpod.createServer(pod); // refused before anything is rented
} catch (e) {
  console.log(e instanceof NotSupportedError, (e as Error).message);
}

// say what the container runs, and it is rented with its SSH server ahead of that
const server = await runpod.createServer({ ...pod, command: ["python", "serve.py"] });
console.log((await runpod.waitUntilRunning(server.id)).ssh);
await runpod.deleteServerAndWait(server.id);
await runpod.deleteSSHKey(key.id);
```

## Renting and setting up in one call

`ServerProvisioner` does the whole run on any provider with `compute` and `sshKeys`, a VM or a container. It makes a fresh key, rents the offer, waits for the server, runs a `SetupPipeline` over SSH (through sudo where the login is not root), and **deletes the server again if any of it fails**. A VPS, a GPU VM and a GPU container go through it the same way.

```ts
import { AddUserStep, InstallDockerStep, LambdaCloud, RunCommandStep, ServerProvisioner } from "asap-vps";

const lambda = new LambdaCloud(process.env.LAMBDA_API_KEY!);
const [offer] = await lambda.listOffers({ gpus: ["A10"] });
const deployKey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKd0 deploy@laptop";

const { server } = await new ServerProvisioner(lambda).provision({ serverOptions: { name: "worker-1", offer } }, (pipeline) => {
  pipeline
    .addStep(new InstallDockerStep())
    .addStep(new RunCommandStep(["nvidia-smi -L"], "check-gpu"))
    .addStep(new AddUserStep("deploy", { publicKeys: [deployKey], sudo: true }));
});
console.log(server.ip);
```

The steps are small classes you can write your own of: `InstallDockerStep`, `ConfigureFirewallStep`, `InstallSSLCertificateStep`, `CreateDirectoryStep`, `RunCommandStep`, `AddUserStep`, `AddAuthorizedKeyStep` and `InstallNodeStep` ship with the library.

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
