# Quick start

## Install

```bash
npm install asap-vps      # Node 18 or newer
```

The library runs on Node (it uses the global `fetch`) and has one runtime dependency, `node-ssh`, for logging into the servers it rents.

## Keys

Each provider reads its API key from an environment variable, and `providersFromEnv` builds the ones you have. Leave the others unset.

| Provider | Class | Environment variable | Where to make the key |
|---|---|---|---|
| DigitalOcean | `DigitalOcean` | `DIGITAL_OCEAN_API_KEY` | API → Tokens → Generate New Token (Full Access) |
| Scaleway | `Scaleway` | `SCW_SECRET_KEY`, `SCW_DEFAULT_PROJECT_ID`, and `SCW_ACCESS_KEY` for image copy and import | IAM → API keys |
| Lambda Cloud | `LambdaCloud` | `LAMBDA_API_KEY` | API keys → Generate API key |
| RunPod | `RunPod` | `RUNPOD_API_KEY` | Settings → API Keys (All) |
| Vast.ai | `VastAI` | `VAST_API_KEY` | Account → API Keys |

In the sandbox on this site, `process.env` already holds a key each fake accepts: the snippets read the variables exactly as your code would.

## Your first server

One provider, from rent to delete:

```ts run title="A GPU on RunPod"
import { CUDA_TYPES, MACHINE_TYPES, RunPod } from "asap-vps";

const runpod = new RunPod(process.env.RUNPOD_API_KEY!);
const cuda = CUDA_TYPES.CUDA_12_8;

const [offer] = await runpod.listOffers({ minVramGb: 24, maxPricePerHour: 1, minCudaVersion: cuda }); // cheapest first
const server = await runpod.createServer({
  name: "my-gpu",
  offer, // brings its region and GPU count
  image: { os: MACHINE_TYPES.UBUNTU_24, cuda }, // the library's names: the same on every provider
  command: ["sleep", "infinity"],
});
console.log((await runpod.waitUntilRunning(server.id)).status);
await runpod.deleteServerAndWait(server.id); // deletes, then checks until it is gone
```

## One name for an image

`image` takes the library's names, and each provider sends its own for them: a `MACHINE_TYPES` member is that Ubuntu, and `{ os, cuda }` is that Ubuntu for a machine that runs CUDA software.

| `image` | RunPod, Vast, and any `container` | DigitalOcean | Scaleway | Lambda |
|---|---|---|---|---|
| `MACHINE_TYPES.UBUNTU_24` | `ubuntu:24.04` | `ubuntu-24-04-x64` | `ubuntu_noble` (types without GPUs) | `ubuntu-24-04` |
| `{ os: MACHINE_TYPES.UBUNTU_24, cuda: CUDA_TYPES.CUDA_12_8 }` | `nvidia/cuda:12.8.2-base-ubuntu24.04` | `gpu-h100x1-base` (`gpu-h100x8-base` on an x8 size) | `ubuntu_noble_gpu_os_13_nvidia` (GPU types) | `lambda-stack-24-04` |

A container gets NVIDIA's `base` image of that CUDA version's newest patch, and `minCudaVersion` defaults to the version, so it lands only on a host whose driver runs it. Given no command it runs `sleep infinity`, so it stays up as a VM does.

A VM gets the provider's GPU image of that Ubuntu: the one with the NVIDIA driver, which is what CUDA software needs of the machine. What else it carries is the provider's (DigitalOcean's the CUDA toolkit, Lambda's CUDA and the frameworks, Scaleway's Docker with NVIDIA's runtime), and the CUDA version asked for is not checked there.

What no image exists for is refused with `NotSupportedError` before anything is sent, never sent as it is: a CUDA version NVIDIA does not publish for that Ubuntu, an Ubuntu a provider has no image of, or a pair a provider cannot boot (Scaleway's plain Ubuntu on a GPU type, its GPU OS on a type without GPUs).

A provider's own name still passes as it is (a slug, an image id, a registry reference, an image from `listImages`): that is what an image of your own needs.

## The same question to every provider

Code that does not care which cloud it is on asks each configured provider the same thing, and the answers are comparable: an offer has the same fields everywhere.

```ts run title="The cheapest 24 GB GPU, across every provider with a key"
import { providersFromEnv } from "asap-vps";

const rows = [];
for (const provider of providersFromEnv(process.env)) {
  const [cheapest] = await provider.listOffers({ kind: "gpu", minVramGb: 24 });
  if (cheapest) rows.push({ provider: provider.id, gpu: cheapest.gpu, vramGb: cheapest.vramGb, usdPerHour: Math.round(cheapest.pricePerHour * 100) / 100 });
}
rows.sort((a, b) => a.usdPerHour - b.usdPerHour);
console.log(rows);
```

Where a machine is reads the same everywhere too. Each provider names its places its own way (`tor1`, `fr-par-2`, `us-east-1`, `EU-RO-1`, `Texas, US`), so every offer carries `locations`, its regions with the country each is in, and `countries` narrows a question to them:

```ts run title="GPUs in the United States or Canada, on every provider"
import { COUNTRY_TYPES, providersFromEnv } from "asap-vps";

for (const provider of providersFromEnv(process.env)) {
  const offers = await provider.listOffers({ kind: "gpu", countries: [COUNTRY_TYPES.US, COUNTRY_TYPES.CA] });
  const [cheapest] = offers;
  // its regions are only the ones in those countries: pass the offer to createServer and it is rented there
  if (cheapest) console.log(provider.id, cheapest.gpu, cheapest.locations);
}
```

## Logging in

Every provider's server says where its sshd is and whom to log in as (`root`, or `ubuntu` on Lambda), a VM or a container, so the login is the same everywhere. This needs Node (sockets and key generation), so it is checked here but not run:

```ts
import { DigitalOcean, RemoteMachine, SSHService } from "asap-vps";

const digitalOcean = new DigitalOcean(process.env.DIGITAL_OCEAN_API_KEY!);
const { publicKey, privateKey } = await SSHService.createKeys(); // in process: nothing is written to disk
const key = await digitalOcean.addSSHKey(publicKey, "my_key"); // the same key again returns this registration

const [offer] = await digitalOcean.listOffers({ kind: "cpu" });
const server = await digitalOcean.createServer({ name: "web-1", offer, region: offer.regions[0], sshKeyIds: [key.id] });
const running = await digitalOcean.waitUntilRunning(server.id);

const machine = await RemoteMachine.connect(running, { privateKey });
console.log((await machine.run("uname -a")).stdout);
await machine.close();

await digitalOcean.deleteServerAndWait(server.id);
await digitalOcean.deleteSSHKey(key.id);
```

What a `RemoteMachine` does once you are in (commands as the login or as root, files, a user of its own with its keys), and how to rent, log in and run a whole setup in one call, is under [Logging in and setting up](#/ssh).
