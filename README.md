# asap-vps

Rent servers on any cloud through one set of typed primitives: create a VPS or a GPU server, log in over SSH, set it up, capture it as an image, delete it. Every provider works the same way.

- One class per provider, whose type says exactly what that provider can do.
- Tested offline against fakes of every provider's API, and live against the real ones.

**[Documentation, with a live sandbox](https://visgotti.github.io/asap-vps/)**: every code block is an editor with the library's real types, and the runnable ones execute against in-memory fakes. Nothing is rented.

```sh
npm install asap-vps    # Node 18 or newer
```

[Providers](#providers) · [Quick start](#quick-start) · [Capabilities](#capabilities) · [Containers](#containers) · [Serverless](#serverless-endpoints) · [Servers](#servers) · [Cost](#cost) · [Setup](#setting-a-server-up) · [Images](#images) · [Volumes](#volumes) · [Errors](#errors) · [Platform notes](#platform-notes) · [Development](#development) · [Tests](#tests)

## Providers

| Provider | Class | Servers | Stop / start | Restart | Logs | SSH keys | Images | Volumes | Serverless |
|---|---|---|---|---|---|---|---|---|---|
| DigitalOcean | `DigitalOcean` | VMs, with or without GPUs | ✓ (bills in full while stopped) | ✓ | | ✓ | ✓ per region: copy, import from a URL | block; shared (NFS) | |
| Scaleway | `Scaleway` | VMs, with or without GPUs | ✓ (only volumes and IPs bill while stopped) | ✓ | | ✓ (Project-wide) | ✓ per zone: copy, import a QCOW2 | block; shared (File Storage, Paris) | CPU containers |
| RunPod | `RunPod` | GPU and CPU containers | ✓ (only the volume bills while stopped) | ✓ | ✓ | ✓ | | shared (network volumes) | GPU and CPU |
| Vast.ai | `VastAI` | GPU containers (a marketplace) | ✓ (only storage bills while stopped) | ✓ | ✓ | ✓ | snapshots, pushed to your registry | block, on one machine | |
| Lambda Cloud | `LambdaCloud` | GPU VMs | | ✓ | | ✓ | | shared (filesystems) | |

## Quick start

A VPS on DigitalOcean, logged into over SSH:

```typescript
import { DigitalOcean, MACHINE_TYPES, REGION_TYPES, SSHService } from "asap-vps";

const digitalOcean = new DigitalOcean(process.env.DIGITAL_OCEAN_API_KEY!);
const { publicKey, privateKey } = await SSHService.createKeys();
const key = await digitalOcean.addSSHKey(publicKey, "my_key"); // the same key again returns this one

const server = await digitalOcean.createServer({
  name: "web-1",
  offer: "s-1vcpu-1gb",          // or an offer from listOffers({ kind: "cpu" })
  region: REGION_TYPES.NYC_1,    // the library's enums, or the provider's own names ("nyc1")
  image: MACHINE_TYPES.UBUNTU_24,
  sshKeyIds: [key.id],
});
const running = await digitalOcean.waitUntilRunning(server.id);

// every provider says where its sshd is and whom to log in as (root, or ubuntu on Lambda)
const ssh = await SSHService.connect({ ...running.ssh!, privateKey });

await digitalOcean.deleteServerAndWait(server.id); // deletes, then checks until it is gone
await digitalOcean.deleteSSHKey(key.id);
```

- `SSHService.createKeys()` makes an RSA 2048 pair in memory (PEM, as `ssh-keygen -m PEM -t rsa -b 2048` does). Nothing is written to disk unless its third argument, `deleteAfter`, is false.
- `SSHService.connect(ip, privateKey)`, the positional form, logs in as root on port 22.

A GPU server is the same call with a GPU offer:

```typescript
import { RunPod } from "asap-vps";

const runpod = new RunPod(process.env.RUNPOD_API_KEY!);

// what can be rented right now, cheapest first, on hosts whose driver runs the image's CUDA
const [offer] = await runpod.listOffers({ minVramGb: 24, maxPricePerHour: 1, minCudaVersion: "12.8" });

// the offer brings its region, GPU count and (interruptible) bid: nothing to repeat
const server = await runpod.createServer({
  name: "my-gpu",
  offer,
  image: "nvidia/cuda:12.8.1-base-ubuntu24.04",
  command: ["sleep", "infinity"],
  minCudaVersion: "12.8", // RunPod places the pod by it; Vast checks the machine before renting it
});
await runpod.waitUntilRunning(server.id);
await runpod.stopServer(server.id);
await runpod.startServer(server.id);
await runpod.deleteServerAndWait(server.id);
```

Each provider has its own shape, and its class has only the methods that fit it. The documentation has a runnable page for each.

**Scaleway**: zones (a server is `zone/uuid`), a Block volume attached to a running server, and a stop that frees the slot:

```typescript
import { Scaleway } from "asap-vps";

const scaleway = new Scaleway({ apiKey: process.env.SCW_SECRET_KEY!, projectId: process.env.SCW_DEFAULT_PROJECT_ID! });
const [offer] = await scaleway.listOffers({ kind: "cpu" });          // its regions are zones with stock
const zone = offer.regions[0];
const server = await scaleway.waitUntilRunning((await scaleway.createServer({ name: "api-1", offer, region: zone })).id);

const disk = await scaleway.createVolume({ name: "pgdata", region: zone, sizeGb: 50 });
await scaleway.attachVolume(disk.id, server.id);                     // onto the running server
await scaleway.stopServer(server.id);                                // poweroff frees the slot: only volumes and IPs bill
```

**Lambda**: GPU VMs with exactly one SSH key at launch, a container run by Docker from the first boot, and no stop (so no `lambda.stopServer` to call):

```typescript
import { LambdaCloud } from "asap-vps";

const lambda = new LambdaCloud(process.env.LAMBDA_API_KEY!);
const key = await lambda.addSSHKey(publicKey, "laptop");
const [offer] = await lambda.listOffers({ gpus: ["A10"] });

const server = await lambda.createServer({
  name: "worker-1", offer, sshKeyIds: [key.id],
  container: { image: "ghcr.io/acme/worker:1", ports: ["8000/tcp"] },
});
await lambda.waitUntilRunning(server.id);
```

**Vast.ai**: every offer is one machine, a volume lives on a machine, and an image is a snapshot pushed to your registry that boots on any machine:

```typescript
import { VastAI } from "asap-vps";

const vast = new VastAI({
  apiKey: process.env.VAST_API_KEY!,
  snapshots: { server: "ghcr.io", repository: "acme/snapshots", username: "bot", password: process.env.GHCR_TOKEN! },
});
const [offer] = await vast.listOffers({ minVramGb: 16, minCudaVersion: "12.2" });   // each offer is one machine
const machine = offer.regions.find((r) => r.startsWith("machine:"))!;

const volume = await vast.createVolume({ name: "weights_v1", region: machine, sizeGb: 50 }); // lives on that machine
const server = await vast.createServer({
  name: "trainer", offer, image: "nvidia/cuda:12.8.1-base-ubuntu24.04", command: ["sleep", "infinity"], mounts: [{ volume, path: "/models" }],
});
await vast.waitUntilRunning(server.id);
const image = await vast.createImage(server.id, { name: "trained-v1" });            // ghcr.io/acme/snapshots:trained-v1
```

## Capabilities

What a provider can do is a set of capabilities, each an interface in `src/capabilities.ts`:

| Capability | Interface | Methods |
|---|---|---|
| `compute` | `ICompute` | `listOffers`, `createServer`, `getServer`, `listServers`, `deleteServer`, `waitForServer`, `waitUntilRunning`, `deleteServerAndWait`, `getServerCost` |
| `power` | `IPower` | `stopServer`, `startServer` |
| `restart` | `IRestart` | `restartServer` |
| `logs` | `ILogs` | `getServerLogs` |
| `sshKeys` | `ISSHKeys` | `listSSHKeys`, `addSSHKey`, `deleteSSHKey` |
| `images` | `IImages` | `listImages`, `getImage`, `createImage`, `deleteImage` |
| `imageCopy` | `IImageCopy` | `copyImage` |
| `imageImport` | `IImageImport` | `importImage` |
| `volumes` | `IVolumes` | `listVolumes`, `getVolume`, `createVolume`, `deleteVolume` |
| `volumeAttach` | `IVolumeAttach` | `attachVolume`, `detachVolume` |
| `serverless` | `IServerless` | `listEndpointOffers`, `listEndpoints`, `getEndpoint`, `createEndpoint`, `deleteEndpoint`, `requestEndpoint` |

A class implements exactly the capabilities its platform has, so its type tells you what it can do:

```typescript
const lambda = new LambdaCloud(key);
lambda.stopServer(id); // compile error: Lambda has no stop, so LambdaCloud has no stopServer
```

Options are typed per provider too. What a platform cannot honor is left out of its `CreateServerOptions`, and `createVolume` asks for a size only where volumes have one:

```typescript
lambda.createServer({ name, offer, env: { A: "b" } });                 // compile error: a Lambda VM runs no container
runpod.createServer({ name, offer, image, registryAuth, mounts: [{ volume, path: "/models" }] }); // fine
digitalOcean.createServer({ name, offer, mounts: [{ volume, path: "/models" }] }); // compile error: DigitalOcean picks /mnt/<name> (vol.mountPath)
lambda.createVolume({ name: "models", region: "us-east-1", sizeGb: 50 }); // compile error: a filesystem grows as it fills
```

- Code typed for any provider (`AnyProvider`, `ICompute`) sees every option. The provider then refuses what it cannot honor at run time (`NotSupportedError`), before anything is rented.
- `src/Providers/typing.spec.ts` holds these types to the compiler.
- Each class declares its capabilities, with how each behaves there. The compiler and the contract suite keep the declaration and the methods in step:

```typescript
DigitalOcean.capabilities;
// { compute: { kind: 'vm', gpu: true, cpu: true, userData: true, liveAvailability: true },
//   power: { stoppedBilling: 'full' }, restart: {}, sshKeys: { appliedAtBoot: false },
//   images: { scope: 'region' }, imageCopy: {},
//   imageImport: { formats: ['raw', 'qcow2', 'vhdx', 'vdi', 'vmdk'], compressions: ['gzip', 'bzip2'], maxGb: 100 },
//   volumes: { block: { mount: 'auto', size: 'fixed', minGb: 1, maxGb: 16384 } }, volumeAttach: {} }
```

Code that takes any provider asks first, and is typed by the answer:

```typescript
import { createProvider, requireCapability, supports } from "asap-vps";

const p = createProvider(process.env.PROVIDER!, key); // any provider
if (supports(p, "power")) {
  await p.stopServer(id);                  // typed: p has IPower now
  p.capabilities.power.stoppedBilling;     // 'storage' | 'full'
}
await requireCapability(p, "images").listImages(); // or NotSupportedError, naming what is missing
```

## Containers

`container` runs one image the same way on every provider: `{ image, env?, command?, ports?, registryAuth? }`.

```typescript
const container = {
  image: "ghcr.io/acme/worker:1",
  env: { MODEL: "llama-3-8b" },
  command: ["serve", "--port", "8000"],
  ports: ["8000/tcp"],
  registryAuth: { username: "bot", password: process.env.GHCR_PULL_TOKEN! }, // a token that can only pull
};
await runpod.createServer({ name, offer, container });        // the pod is the container
await lambda.createServer({ name, offer, sshKeyIds, container }); // a VM: Docker runs it from the first boot
```

- **RunPod and Vast**: the image is the server. `container` is the same as the top-level `image`, `env`, `command`, `ports` and `registryAuth`; giving both is refused.
- **DigitalOcean, Scaleway and Lambda (VMs)**: Docker runs it, from a script cloud-init runs at the first boot:
  - Docker is installed where the image has none (on an NVIDIA GPU machine, the NVIDIA container toolkit too).
  - The image is pulled with `registryAuth`: the password goes on stdin, and the login is logged out after.
  - It runs as the container `asap-vps` (`docker logs asap-vps`), restarts with the machine, publishes its ports on the host, and keeps its environment in a root-only file.
  - GPUs are passed through (`--gpus all`).
  - Your own `userData` still runs, first.
  - The login is in the server's user data, which the account and the server can read: use a pull-only token.
- Refused before anything is rented: an env name a shell cannot take, a value with a line break, a port Docker cannot publish.

## Serverless endpoints

An endpoint runs one image behind an HTTPS URL, from zero workers (nothing billed while idle) up to a cap. The image serves plain HTTP on `PORT`; it needs no platform SDK.

```typescript
const [cpu] = await runpod.listEndpointOffers({ kind: "cpu" });          // priced per hour while a worker runs
const e = await runpod.createEndpoint({ name: "whoami", container: { image: "traefik/whoami" }, port: 80, offer: cpu, maxWorkers: 2 });
const r = await runpod.requestEndpoint(e, "/api");                       // the account's key added, a cold start waited out
await runpod.deleteEndpoint(e.id);                                         // its workers stop with it
```

- `requestEndpoint` sends your key only to the platform's own host and never follows a redirect. It waits out a cold start up to `timeoutMs` (default 5 min).
- **RunPod**: load-balancing endpoints (`https://<id>.api.runpod.ai`) on a GPU type of a serverless pool, or a CPU flavor of 2 or more vCPUs.
  - The worker answers the health check (`/ping`) on `PORT`.
  - Seen live: an idle endpoint kept its worker for 15 minutes despite `idleTimeoutSeconds: 5`. `deleteEndpoint` is what stops it (it scales to zero first).
- **Scaleway**: Serverless Containers, CPU only.
  - Private: the key goes as `X-Auth-Token`.
  - Each runs in a namespace made for it and deleted with it.
  - Images come from any public registry or the Project's own. An idle instance stops after 15 minutes.

## Servers

A VPS and a GPU server are both servers: an offer's GPU fields say which (`gpu: ''`, `vendor: null`, `gpuCount: 0` without GPUs).

```typescript
await digitalOcean.listOffers();                  // every size
await digitalOcean.listOffers({ kind: "cpu" });   // plain droplets
await digitalOcean.listOffers({ kind: "gpu" });   // GPU droplets
await digitalOcean.listOffers({ gpus: ["H100"] }); // any GPU filter asks for GPUs
await scaleway.listServers({ kind: "gpu" });
```

| Option | What it does |
|---|---|
| `listOffers(query?)` | What can be rented now, cheapest first: GPUs and VRAM per GPU, price per hour, regions with stock. A query means the same on every provider. |
| `minCudaVersion` | Only hosts whose driver runs that CUDA version (container providers, whose offers say `cudaVersion`). A VM runs its image's driver, so VM offers aren't filtered. |
| `offer` | An offer from `listOffers`, or its id. `gpuCount` defaults to the offer's; only RunPod takes another. |
| `region`, `image` | The provider's own names, or `REGION_TYPES` / `MACHINE_TYPES`. A member a provider has no name for is refused. `image` defaults to the provider's GPU image, or plain Ubuntu. |
| `providerOptions` | Extra fields for the platform's own create request, typed per provider. |
| `registryAuth` | The login for a private image: `{ username, password, server? }`. RunPod stores it once and reuses it. On a VM it goes inside `container`. |
| `container`, `mounts` | See [Containers](#containers) and [Volumes](#volumes). |

- An option a provider cannot honor is refused (`NotSupportedError`) before anything is rented, never dropped.
- The other calls: `getServer` (null when missing), `listServers({ kind })`, `deleteServer` (idempotent), `waitForServer`, `waitUntilRunning`, `deleteServerAndWait`, `getServerCost`.
- Every record carries the platform's own as `raw`, typed per provider: `(await digitalOcean.getServer(id))?.raw` is a `DigitalOceanDropletData`.

## Cost

- Every offer and server has `pricePerHour` (USD, for the whole machine) and `billing`: steps of `incrementSeconds`, at least `minimumSeconds`, and at least `minimumUsd` where the provider has one.
- A server also has `billingStartedAt`. Its cost is the time since then, counted the provider's way.

```typescript
import { estimateCost } from "asap-vps";

// the server's current run so far: { usd, pricePerHour, from, to, billedSeconds }
const cost = await runpod.getServerCost(server.id);
const byNoon = await runpod.getServerCost(server.id, Date.parse("2026-10-02T12:00:00Z")); // or up to a given time
// null while nothing bills at its rate: a stopped server that bills only its disk, or a deleted one

// any span at any rate, counted the same way: a 90 s job on an offer, before renting it
const job = estimateCost(offer.pricePerHour, 0, 90_000, offer.billing); // billed 90 s on DigitalOcean, 2 min on Lambda
```

| Provider | Counted | A run bills from | While stopped |
|---|---|---|---|
| DigitalOcean | per second, at least 60 s or $0.01 | its creation, until deleted | the run goes on (bills in full) |
| Scaleway | per minute with a GPU (RENDER-S per hour), per hour without | its last change of state | `null` (only volumes and IPs bill) |
| RunPod | per second | its last start | `null` (only the volume bills) |
| Vast.ai | per second | the rental's start; a stop and start doesn't move it, so the estimate is then an upper bound | `null` (only the disk bills) |
| Lambda Cloud | per minute | its first passed health check | no stop |

Estimates cover the server's rate only. Disks, bandwidth and addresses bill on top, and the invoice is the truth.

## Setting a server up

`ServerProvisioner` works on any provider whose servers are VMs (with `compute` and `sshKeys`):

1. It makes a fresh key and rents the offer.
2. It waits for the server.
3. It runs a `SetupPipeline` over SSH, through sudo where the login isn't root.
4. If anything fails, it deletes the server again.

```typescript
import { InstallDockerStep, LambdaCloud, RunCommandStep, ServerProvisioner } from "asap-vps";

const lambda = new LambdaCloud(process.env.LAMBDA_API_KEY!);
const [offer] = await lambda.listOffers({ gpus: ["A10"] });
const { server } = await new ServerProvisioner(lambda).provision({ serverOptions: { name: "worker-1", offer } }, (pipeline) => {
  pipeline.addStep(new InstallDockerStep()).addStep(new RunCommandStep(["nvidia-smi -L"], "check-gpu"));
});
```

On Scaleway, the Project's keys are applied at every boot, so the provisioner keeps the key it registered and returns it as `providerSshKeyId`. Delete it yourself once the server is gone.

## Images

Capture a set-up server as an image, so the next one boots with everything installed:

```typescript
await digitalOcean.stopServer(server.id);                                       // for a consistent disk
const image = await digitalOcean.createImage(server.id, { name: "my-gpu-ready" }); // waits until available
await digitalOcean.copyImage(image.id, ["nyc2"]);                               // imageCopy: snapshots are region-bound
const next = await digitalOcean.createServer({ name: "my-gpu-2", offer, region: "nyc2", image: image.id });
```

Bring in an image built elsewhere (Packer, a distribution's cloud image) with `importImage`:

```typescript
const noble = await digitalOcean.importImage({
  name: "noble-min", region: "ams3", providerOptions: { distribution: "Ubuntu" },
  url: "https://cloud-images.ubuntu.com/minimal/releases/noble/release/ubuntu-24.04-minimal-cloudimg-amd64.img",
});                                                                           // waits until it can boot (default 1 h)
```

- `listImages()` returns every image of the account, not just yours: pick yours by name.
- An import that can't be read, or outlasts its wait, is deleted and its failure thrown.

### DigitalOcean

- Copies natively, per region.
- Import fetches the file itself: raw, qcow2, vhdx, vdi or vmdk (gzip or bzip2 too), under 100 GB, from a host that answers HEAD.
- The image needs cloud-init and BIOS boot, and a droplet made from it needs an SSH key.

### Scaleway

Scaleway has no copy of its own, so `copyImage` and `importImage` go through Object Storage. That needs the API key's access key (`accessKey`, `SCW_ACCESS_KEY`).

- A copy exports the root snapshot as a QCOW2 and imports it in each zone asked for. Across regions, the file streams through this machine in parts.
- A copy is an image of its zone, tagged with its source:
  - `createServer` boots it when given the source's id and the copy's zone.
  - `deleteImage` deletes the copies with the source.
  - The source's `regions` list every zone it boots in.
- Only the root disk is copied: an image with more volumes is refused.
- Import takes a QCOW2 (unencrypted, no backing file, at most 1 TB). It streams in ranges where the file's server serves them, else it is downloaded first.
- An imported image boots with UEFI and needs cloud-init. An Ubuntu cloud image lets no key log in as root: boot it with the user data `#cloud-config\ndisable_root: false`.

### Vast

Vast keeps no images. Give `VastAI` a `snapshots` registry, and its snapshots become images (the repository's tags):

```typescript
const vast = new VastAI({ apiKey, snapshots: { server: "ghcr.io", repository: "acme/snapshots", username: "bot", password: process.env.GHCR_TOKEN! } });
const image = await vast.createImage(instance.id, { name: "trained-v1" }); // ghcr.io/acme/snapshots:trained-v1
await vast.createServer({ name: "next", offer, image: image.id, command });  // any machine; pulled with the snapshot login
```

- It works on a running or a stopped instance.
- Vast reports no progress, so `createImage` waits until the tag is in the repository (a 90 MB image took under a minute).
- `deleteImage` deletes every tag of the image through the registry's API. Docker Hub and ghcr.io don't allow that; a Scaleway registry (`rg.<region>.scw.cloud`) is deleted through Scaleway's own API.

## Volumes

Storage that outlives the servers that mount it: keep model weights and data between servers instead of baking them into images. A server mounts volumes when it is created, and `deleteServer` leaves them.

```typescript
const models = await runpod.createVolume({ name: "models", region: "US-TX-3", sizeGb: 100 }); // bills until deleteVolume
const pod = await runpod.createServer({ name: "worker", offer, image, mounts: [{ volume: models, path: "/models" }] });
// ... later, any number of pods in US-TX-3 mount the same weights
await runpod.deleteServerAndWait(pod.id);
await runpod.deleteVolume(models.id);
```

- A volume is in one region (a zone, a data center). A server elsewhere can't mount it, and is refused before anything is rented.
- A volume is either a block device that one server holds, or a filesystem that many servers mount; its `shared` says which.
- `capabilities.volumes` says which kinds a platform makes and how they behave (`mount`, `size`, `minGb`, `maxGb`). Where a platform makes both, `createVolume({ shared: true })` picks the filesystem.
- `listVolumes()` returns every volume of the account: pick yours by name.

| Platform | What a volume is | Kind | Mount | Size |
|---|---|---|---|---|
| RunPod | a network volume (one per pod, which is placed in its data center) | shared: many pods | `path` (default `/workspace`) | 10-4096 GB |
| Lambda | a filesystem, mounted at launch only | shared: many instances | `path` under /home, /lambda/nfs or /data (default `/lambda/nfs/<name>`) | grows as it fills |
| DigitalOcean | a Block Storage volume, formatted ext4 | block: one droplet | auto: `/mnt/<name>`, dashes as underscores | 1-16384 GiB |
| DigitalOcean | a Network File Storage share (nyc2, ams3, atl1, ric1, mkc1, mem1), in the region's default VPC | shared: droplets of its VPC | `path` (default `/mnt/<name>`), mounted over NFS | 50-32768 GB |
| Scaleway | a Block Storage volume (5000 IOPS) | block: one server | a device the server formats and mounts itself | from 1 GB |
| Scaleway | a File Storage filesystem (Paris) | shared: Instances whose type attaches one (POP2, L4, L40S, H100, ...) | `path` (default `/mnt/<name>`), mounted with virtiofs | 25-50000 GB |
| Vast | storage on one machine (its region is `machine:<id>`, which offers name too) | block: one instance, rented on that machine | `path` (default `/data`), one volume per instance | from 1 GB, up to the machine's free space |

A Vast volume is on one machine: make it where you will rent, and rent there again to mount it later:

```typescript
const [offer] = await vast.listOffers({ gpus: ["RTX 4090"] });
const data = await vast.createVolume({ name: "weights_v1", region: offer.regions.find((r) => r.startsWith("machine:"))!, sizeGb: 50 });
const a = await vast.createServer({ name: "a", offer, image, command, mounts: [{ volume: data, path: "/models" }] });
await vast.deleteServerAndWait(a.id);                     // its volume is free again some 30 s after it is gone
const [again] = await vast.offersOn(data.region);         // [] while someone else rents that machine
```

## Providers by id

For code that is configured rather than written per provider:

```typescript
import { createProvider, providersFromEnv, providersWith, PROVIDERS } from "asap-vps";

const vast = createProvider("vast", process.env.VAST_API_KEY!); // typed: a VastAI
const all = providersFromEnv(process.env);                      // every provider whose key (PROVIDERS[id].keyEnv) is set
providersWith("images", "imageCopy");                           // ['digitalocean', 'scaleway']: read from the descriptors, nothing built
providersWith("volumes");                                       // ['digitalocean', 'runpod', 'vast', 'lambda', 'scaleway']
```

## Errors

| Error | Means |
|---|---|
| `CapacityError` | No stock for this offer or region right now: try another. |
| `QuotaError` | An account limit or balance. |
| `AuthError` | The key was refused. |
| `NotFoundError` | There is no such thing. |
| `NotSupportedError` | The provider can't do this. It is refused before anything is rented. |
| `TransportError` | No answer at all, or one cut off. |

- All but `TransportError` extend `ProviderError`, whose message starts with the provider's id.
- A create that fails after making something deletes what it made. If that delete fails too, the error's `code` is `left_behind`, and it names what is left: that bills until you delete it.
- `isRetriable(e)` says whether a failure is safe to try again as it is: a read or an idempotent request that got no answer or a temporary error, or a rate limit.
- A create is never retriable after a server error or a lost answer, because it may already have made a billed machine: look for it by its name.

## Platform notes

The behaviors that shape the primitives. Each is a test in `src/Providers/<Platform>/*.spec.ts`, checked against the provider's API reference (2026-09-29).

<details>
<summary><b>DigitalOcean</b></summary>

- GPU droplets are listed only with `?type=gpus`, so `listServers` reads whichever lists `kind` asks for.
- For seconds after a key is added, the key list doesn't show it, and the duplicate check lets it in again (seen live):
  - `createServer` sends key ids and MD5 fingerprints without looking them up.
  - `addSSHKey` remembers its own registrations for a minute. Another process may still register the same key twice in that window.
- A droplet takes one action at a time, its create included. An action asked for meanwhile gets a 422 "pending event" and is asked again until the wait ends.
- `stopServer` shuts the droplet down cleanly, and powers it off only if that fails.
- 8-GPU sizes boot the 8-GPU image.
- Volumes:
  - A droplet attaches volumes of its region that no droplet holds.
  - `createVolume` formats them ext4, mounted at `/mnt/<name>` with dashes as underscores (`models-v2` is `/mnt/models_v2`, the volume's `mountPath`).
  - Deleting a droplet detaches its volumes a while after it is gone: `deleteServerAndWait` waits for that.
  - An attached volume can't be deleted. The volume list lags a create by seconds; `getVolume` doesn't.

</details>

<details>
<summary><b>Scaleway</b></summary>

- Instance API v1.
- `SCALEWAY_ENDPOINTS` lists every endpoint called, with its page of [the API reference](https://www.scaleway.com/en/developers/api/instance/v1).
- `npm run scaleway:spec` holds them to Scaleway's OpenAPI specs.
- Every call is zonal: a server and an image are named `zone/<uuid>` (`zonedId`, `parseZonedId`).
- A server is created powered off. `createServer` sets its user data (a `PATCH` of the `cloud-init` key, as `text/plain`), then powers it on.
- A type in `shortage` is refused as a `CapacityError`, and the server made for it is deleted.
- A GPU type boots from Block Storage (`sbs_volume`, sized by `diskGb`):
  - `terminate` only detaches that volume, which bills until deleted, so `deleteServer` deletes it once detached.
  - A stopped server has no `terminate`, so it is deleted directly, volumes included.
- `poweroff` releases the slot, so `startServer` needs stock again.
- Stock is `available`, `scarce` or `shortage` per type and zone; `shortage` leaves the zone out of an offer's `regions`.
- Prices are in euros, converted by `eurToUsd` (default 1.15); the euro price stays in an offer's `raw`.
- SSH keys belong to a Project, and Scaleway applies every key of the Project to every server at every boot. `sshKeyIds` must be keys of the Project, and can't exclude the others.
- Creating anything needs the Project (`projectId`, `SCW_DEFAULT_PROJECT_ID`): the library never guesses one.
- Images are zone-bound snapshots, and `deleteImage` deletes the snapshots too.
- Volumes are Block Storage, named `zone/<uuid>`:
  - A server is created with them attached after its image's own volumes, and carries an `asap-vps-volume:<uuid>` tag for each.
  - `deleteServer` keeps them, and `createImage` leaves them out.
  - A zoned volume id fixes the zone of a create that names none.
- GPU quota starts at 0: `QuotaError` until the account's identity is verified, or support lifts it.

</details>

<details>
<summary><b>RunPod</b></summary>

- MIG slices are GPU types of their own, named card and profile (`RTX PRO 6000 MIG 1g.24gb`), so asking for a card never rents a slice.
- Pods take no UDP.
- RunPod's own SSH setup would authorize every key on the account, so `sshKeyIds` sends exactly the keys named (as `PUBLIC_KEY`) and exposes `22/tcp` for sshd's direct endpoint.
- A stopped pod can resume without its GPU: `startServer` then stops it again and throws `CapacityError`.
- A pod mounts at most one network volume, or a disk of its own (`volume`), never both.
- A registry login's username and password are write-only, with no update: a new password is stored as a new login.

</details>

<details>
<summary><b>Vast.ai</b></summary>

- Offers:
  - A search returns at most 64 offers, so `listOffers` asks Vast for the vendor and the models' compute capability, then pages by price.
  - Paging is by price alone: past 64 offers at one exact price, the rest at that price are skipped, but no dearer offer is. A model filter avoids such a tie.
  - Each offer is one machine, whose `regions` are its location and its `machine:<id>`. A `region` asked for must be one of the offer's.
  - An interruptible offer's id carries its bid.
- Ports are mapped to random public ports: read them from the server's `ports`.
- Price:
  - An offer's `pricePerHour` counts 8 GB of disk; an interruptible offer's is its minimum bid, with no disk.
  - The disk (`diskGb`) bills on top, at the machine's `raw.storage_cost` (USD per GB per month, billed hourly over 720 hours).
  - 100 GB at $0.20 is about $0.028 an hour: as much as a cheap GPU.
  - A server's own `pricePerHour` includes its disk.
- `env` values can't contain spaces or quotes, nor can a `registryAuth`'s parts: Vast takes the login as one string of `docker login` arguments.
- A bad key is answered 404, not 401.
- Volumes:
  - Storage on one machine, rented from that machine's storage offer.
  - Names hold only letters, digits and underscores, at most 64.
  - One per instance, set when it is rented. A volume on another machine, or held by another instance, is refused before anything is rented.
  - It lives until deleted, or until its host's listing ends (`raw.end_date`).
  - A deleted instance keeps its volume `in-use` for about 30 s; `deleteServerAndWait` waits for that.
  - Vast's single read of an instance doesn't show its volume, so `getServer` reads it from the instance list.
  - Network volumes, withdrawn in July 2026, are left out of `listVolumes`.
- Snapshots (`snapshots`):
  - The instance goes in the call's URL only (an `id` in the body too is a 400).
  - The repository needs its registry's host (without it, Vast pushes to Docker Hub) and no tag: Vast appends its own (`instance_<id>_at_<time>`).
  - The image keeps the instance's command.
  - Scaleway's registry refuses every manifest DELETE through the Registry API (checked 2026-10-07).

</details>

<details>
<summary><b>Lambda Cloud</b></summary>

- Exactly one SSH key at launch.
- Names are at most 64 characters; tag keys are 2-55 characters (`a-z 0-9 - :`, starting with a letter).
- Filesystems are mounted at launch only, never on a running instance, by any number of instances of their region. One in use can't be deleted.
- Lambda reads filesystems only as a list, so `getVolume` looks one up in it.

</details>

## Development

```
src/types.ts                    the shared shapes: offers, servers, images, volumes, create options, SSH, PlatformTypes
src/capabilities.ts             the capability interfaces, their traits, supports() / requireCapability()
src/errors.ts, constants.ts     the typed errors; the enums (MACHINE_TYPES, REGION_TYPES, PLATFORM)
src/Core/BaseProvider.ts        what every provider shares: id, capabilities, the platform's API client
src/Core/ComputeProvider.ts     the compute capability's shared logic: waits, verified deletes, cost, offers, enum names
src/Core/ServerProvisioner.ts   SetupPipeline over SSH on any VM provider; SetupPipeline.ts, steps/, SSHService.ts
src/Core/utils/                 pure helpers: http (ApiClient), offers, gpus, cost, ssh (key formats), async, crypto
src/Providers/<Platform>/       one folder per platform:
    <Platform>.ts                 the provider class: its capabilities, implemented from the two below
    api.ts                        its API client: auth, what counts as success, its errors as typed errors (toError)
    mappers.ts                    its records as asap-vps's (toServer, toOffer, ...), status words, billing, enum names
    types.ts                      its wire format, its params, and <Platform>Types (what records carry as `raw`)
    endpoints.ts                  every endpoint it calls, with its operation and reference page
src/Providers/registry.ts       every provider by id, typed
src/testing/                    fakes of each platform's REST API, the contract and lifecycle suites, live-run safety
```

Specs sit next to the code they test.

**Adding a provider**

1. Make a folder `src/Providers/<Platform>/` with the files above.
2. Name its records in a `<Platform>Types` bundle: its server, offer, image, volume and create requests, the options it refuses, and what a volume size and a mount take there.
3. Extend `ComputeProvider<<Platform>Types, <Platform>Api>` and declare its capabilities as a `const` descriptor.
4. `implements ProviderCapabilities<<Platform>Types, typeof CAPABILITIES>`: the compiler then asks for every method of every capability declared.
5. Write a fake of its API in `src/testing/fakes`, and add it to `src/testing/subjects.ts` and `PROVIDERS`.

The contract suite (`src/Providers/contract.spec.ts`) and the lifecycle suite then hold it to the same behavior as every other provider.

**Adding a capability** (object storage, firewalls, ...)

1. Add an interface in `src/capabilities.ts`, its traits in `CapabilityTraits`, an entry in `CapabilityInterfaces`, and its methods in `CAPABILITY_METHODS`.
2. Implement and declare it on the providers whose platforms have it.

A provider with no servers at all extends `BaseProvider` instead of `ComputeProvider`.

## Documentation site

- [`site/`](site) holds the documentation: markdown pages in [`site/src/content`](site/src/content), built with [esbuild](https://esbuild.github.io).
- Every push to `master` publishes it to [GitHub Pages](https://visgotti.github.io/asap-vps/).

- Every `ts` block is a [Monaco](https://microsoft.github.io/monaco-editor/) editor with the library's real declarations: completions, hovers and errors as in your own editor.
- A block's info string says what it is:

| Info string | What it does |
|---|---|
| `ts run` | A **Run** button executes it in a Web Worker, against the fakes, on a virtual clock. Nothing leaves the page. |
| `ts` | Type-checked. |
| `ts error` | Must fail to compile: it shows what the types refuse. |
| `ts static` | Highlighted only. |

```
npm run docs:install   # once: the site has its own dependencies
npm run docs:dev       # build, serve on http://localhost:8765, rebuild on change
npm run docs:build     # site/dist
npm run docs:check     # type-check every block of every page; run each `run`; require each `error` to fail
```

- `docs:check` is the docs' test suite; `site/scripts/e2e.mjs` repeats it in headless Chrome against the built site.
- [.github/workflows/docs.yml](.github/workflows/docs.yml) runs the check and the build on pull requests that touch `site/` or `src/`, and deploys `master`.

## Tests

| Command | What it does |
|---|---|
| `npm test` | Every spec, against fakes of the providers' APIs: no account, no key, nothing rented. |
| `npm run test:coverage` | The same with coverage of the library. Fails below 90% of statements, branches, functions or lines, or below 100% on any Scaleway file. |
| `npm run api:spec` | Holds each provider's endpoint table to the live OpenAPI specs and reference pages ([scripts/api-spec-check.ts](scripts/api-spec-check.ts)). |
| `npm run scaleway:spec` | Holds the Scaleway provider to Scaleway's OpenAPI specs: endpoints, enums, fields and reference pages (`-- --live` also reads the public catalog). |

- CI ([.github/workflows/ci.yml](.github/workflows/ci.yml)) runs a type-check, the build and `test:coverage` on Node 18, 22 and 24 for every pull request. `master` takes only pull requests whose runs all passed.
- CI runs on GitHub's runners, or on the self-hosted ones the repository variable `CI_RUNS_ON` names. A fork's pull request never runs on those.
- Each provider's API client refuses a request its endpoint table (`endpoints.ts`) doesn't describe, before sending it, so every test that drives a provider holds it to the table.
- A call that departs from the spec is sent as the platform's own CLI sends it, or as seen live, and its entry says which.

### Live tests

The `*.live.spec.ts` suites take every method of each provider through the real API. They rent real servers, so each runs only when asked, one suite at a time.

- Keys come from `.env.test` (copy `.env.template`), falling back to `~/.config/asap-vps/credentials.env`.
- [docs/GPU_PROVIDER_SETUP.md](docs/GPU_PROVIDER_SETUP.md) says where each key comes from.

```sh
ASAP_VPS_LIVE=runpod npm run test:live                     # one provider
ASAP_VPS_LIVE=runpod,vast,lambda npm run test:live          # several
ASAP_VPS_LIVE=all ASAP_VPS_LIVE_FREE=1 npm run test:live    # every check that rents nothing
npm run test:do                                             # DigitalOcean as a VPS host: one s-1vcpu-1gb droplet
npm run test:scw                                            # Scaleway as a VPS host: one STARDUST1-S Instance
npm run test:do:cpu                                         # DigitalOcean's whole lifecycle on its cheapest droplet (cents)
npm run test:scw:cpu                                        # Scaleway's whole lifecycle on a STARDUST1-S Instance (cents)
npm run test:scw:volumes                                    # Scaleway volumes: Block Storage mounted on STARDUST1-S Instances (cents)
```

| Variable | What it does |
|---|---|
| `ASAP_VPS_LIVE` | Which suites run. `digitalocean`, `runpod`, `vast`, `lambda` or `scaleway`: the provider's lifecycle on a GPU. `digitalocean-cpu`, `scaleway-cpu`: the same lifecycle on the cheapest CPU server, every code path but the GPU's, for cents. `digitalocean-vps`, `scaleway-vps`: each as a VPS host. Or `all`. |
| `ASAP_VPS_LIVE_FREE=1` | Only what rents nothing: the key, offers and their filters, listings, ids nothing has, SSH keys (one is added and deleted), and every refusal. |
| `ASAP_VPS_LIVE_MAX_PRICE` | The most a rented GPU may cost, in USD per hour (default 1). |
| `ASAP_VPS_LIVE_IMAGES=0` | Skip the image phase of DigitalOcean and Scaleway (tens of minutes). |

Scaleway needs `SCW_SECRET_KEY` and `SCW_DEFAULT_PROJECT_ID`.

A lifecycle run ([src/testing/lifecycle.ts](src/testing/lifecycle.ts)) rents the cheapest single NVIDIA GPU in stock under the price cap and checks:

- create, get, list and both waits, and the cost: a run begins no earlier than the create, none bills while stopped, and a new one starts after a start
- a container's log shows its GPU and environment; on a VM, an SSH login checks the GPU, the cloud-init user data and root (through sudo on Lambda)
- restart (a VM must really boot again: its boot id changes), stop and start
- images where the provider has them: create, get, list, copy, boot from it, delete
- a delete verified by fresh lists

- The same lifecycle runs against every fake in `npm test` ([lifecycle.spec.ts](src/Providers/lifecycle.spec.ts)): a broken step shows up before any money is spent.
- Volumes, registry logins and containers have their own live suites: `*Volumes.live`, `*Registry.live`, `*Container.live`, `ScalewayDisks.live`.

Nothing is left behind. Everything a run creates is named `asap-vps-smoke-<run>` ([src/testing/live.ts](src/testing/live.ts)):

- The run first deletes what earlier runs left. A DigitalOcean run also checks the account has room for a droplet.
- A detached watchdog is armed before anything is rented. It deletes the run's servers, keys, volumes and images if the run dies or overruns.
- At the end, the run deletes everything of its name and everything it recorded by id. It then checks with fresh lists that all of it is gone: a leftover of any kind fails the run.
- `npm run gpu:smoke -- <provider> --sweep` deletes leftovers by hand.

## Todo

- Normalize size strings with enums, the same way as regions and images
- More machine (image) type enums
- More region type enums
- Linode and AWS providers
- An object storage capability (DigitalOcean Spaces, Scaleway Object Storage)
- Setup scripts for ubuntu/git, debian/node, debian/forever and debian/git
