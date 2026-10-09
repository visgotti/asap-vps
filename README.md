Servers on any cloud, through one set of typed primitives: rent a VPS or a GPU server, log in over SSH, set it up, capture it as an image, delete it, the same way on every provider. Each provider is one class, and its type says exactly what it can do.

**[Documentation, with a live sandbox](https://visgotti.github.io/asap-vps/)**: every code block is an editor with this library's real types (completions, hovers and errors, as in your own editor), and the runnable ones execute the library's code in your browser against in-memory fakes of each provider's API. Nothing is rented. The site is built from [`site/`](site) (see [Documentation site](#documentation-site)).

| Provider | Class | Servers | Power (stop / start) | Restart | Logs | SSH keys | Images | Volumes | Serverless |
|---|---|---|---|---|---|---|---|---|---|
| DigitalOcean | `DigitalOcean` | VMs, with or without GPUs | yes (a stopped droplet bills in full) | yes | | yes | yes, per region, with copy and import from a URL | block, and shared (NFS) | |
| Scaleway | `Scaleway` | VMs, with or without GPUs | yes (`poweroff` frees the slot: only volumes and IPs bill) | yes | | yes (the Project's, applied at every boot) | yes, per zone, with copy and import of a QCOW2 (both through Object Storage) | block, and shared (File Storage, Paris) | CPU containers |
| RunPod | `RunPod` | GPU and CPU containers | yes (only the volume bills) | yes | yes | yes | | shared (network volumes) | GPU and CPU, plain HTTP |
| Vast.ai | `VastAI` | GPU containers, a marketplace | yes (only storage bills) | yes | yes | yes | snapshots, pushed to a registry of yours | block, on one machine | |
| Lambda Cloud | `LambdaCloud` | GPU VMs | | yes | | yes | | shared (filesystems) | |

# Quick start

A VPS on DigitalOcean, logged into over SSH:

```typescript
import { DigitalOcean, MACHINE_TYPES, REGION_TYPES, SSHService } from "asap-vps";

const digitalOcean = new DigitalOcean(process.env.DIGITAL_OCEAN_API_KEY!);
const { publicKey, privateKey } = await SSHService.createKeys();
const key = await digitalOcean.addSSHKey(publicKey, "my_key"); // the same key again returns this one

const server = await digitalOcean.createServer({
  name: "web-1",
  offer: "s-1vcpu-1gb",          // or an offer from listOffers({ kind: "cpu" })
  region: REGION_TYPES.NYC_1,    // the library's enums, in each provider's own names (or its own: "nyc1")
  image: MACHINE_TYPES.UBUNTU_24,
  sshKeyIds: [key.id],
});
const running = await digitalOcean.waitUntilRunning(server.id);

// every provider reports where its sshd is and as whom to log in (root, or ubuntu on Lambda)
const ssh = await SSHService.connect({ ...running.ssh!, privateKey });

await digitalOcean.deleteServerAndWait(server.id); // deletes, then checks until it is gone
await digitalOcean.deleteSSHKey(key.id);
```

`SSHService.createKeys()` generates the pair in-process (RSA 2048, the private key in PEM, as `ssh-keygen -m PEM -t rsa -b 2048` makes it): nothing is written to disk unless you pass `deleteAfter` false. `SSHService.connect(ip, privateKey)` still logs in as root on port 22.

A GPU is the same call with a GPU offer:

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

Each provider has its own shape, and its class has the methods that fit it. In a few lines each (the documentation has a runnable page for every one):

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

**Vast.ai**: every offer is one machine, a volume lives on a machine, and an image is a snapshot pushed to a registry of yours that boots on any machine:

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

# Capabilities

What a provider can do is a set of capabilities, each an interface (`src/capabilities.ts`):

| Capability | Interface | Methods |
|---|---|---|
| `compute` | `ICompute` | `listOffers`, `createServer`, `getServer`, `listServers`, `deleteServer`, `waitForServer`, `waitUntilRunning`, `deleteServerAndWait`, `getServerCost` |
| `power` | `IPower` | `stopServer`, `startServer` |
| `restart` | `IRestart` | `restartServer` |
| `logs` | `ILogs` | `getServerLogs` |
| `sshKeys` | `ISSHKeys` | `listSSHKeys`, `addSSHKey`, `deleteSSHKey` |
| `images` | `IImages` | `listImages`, `getImage`, `createImage`, `deleteImage` |
| `imageCopy` | `IImageCopy` | `copyImage` |
| `volumes` | `IVolumes` | `listVolumes`, `getVolume`, `createVolume`, `deleteVolume` |

A class implements exactly the capabilities its platform has, so you know what it can do from its type:

```typescript
const lambda = new LambdaCloud(key);
lambda.stopServer(id); // compile error: Lambda has no stop, so LambdaCloud has no stopServer
```

Options are typed the same way. Each provider's `CreateServerOptions` leave out what its platform cannot honor (its `<Platform>Types['refused']`), so an editor offers only what it takes, and `createVolume` asks for a size only where the platform sizes volumes:

```typescript
lambda.createServer({ name, offer, env: { A: "b" } });                 // compile error: a Lambda VM runs no container
runpod.createServer({ name, offer, image, registryAuth, mounts: [{ volume, path: "/models" }] }); // fine
digitalOcean.createServer({ name, offer, mounts: [{ volume, path: "/models" }] }); // compile error: DigitalOcean picks /mnt/<name> (vol.mountPath)
lambda.createVolume({ name: "models", region: "us-east-1", sizeGb: 50 }); // compile error: a filesystem grows as it fills
```

Code typed for any provider (`AnyProvider`, `ICompute`) is offered every option, and each provider still refuses at run time (`NotSupportedError`, before anything is rented) what it cannot honor. `src/Providers/typing.spec.ts` holds these promises to the compiler.

Each class declares them in its `capabilities`, whose keys are the capabilities and whose values say how each behaves there. The compiler holds the two together: a class that declares a capability without its methods does not compile, and the contract suite fails a class that has a capability's methods without declaring it.

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

# Containers, on any provider

`container` runs one image the same way everywhere: `{ image, env?, command?, ports?, registryAuth? }`.

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

- **RunPod and Vast** run the image as the server itself; `container` is the same as the top-level `image`, `env`, `command`, `ports` and `registryAuth` (one or the other: both are refused).
- **DigitalOcean, Scaleway and Lambda** (VMs) run it with Docker, from a script cloud-init runs once at the first boot: Docker is installed where the image has none, the image is pulled (logged in with `registryAuth`, the password on stdin, and logged out again), and it runs as the container `asap-vps` (`VM_CONTAINER_NAME`: `docker logs asap-vps`), restarted with the machine (`--restart unless-stopped`), its ports published on the host's, its environment in a root-only file (`VM_CONTAINER_ENV_FILE`). On a machine with an NVIDIA GPU its GPUs are passed through (`--gpus all`; the NVIDIA container toolkit is installed where the image lacks it). Your own `userData` still runs, first: both go to cloud-init as one multipart document. The login rides in the server's user data, which the account and the server can read: give a token that can only pull.
- An env name a shell cannot take, a value with a line break, or a port Docker cannot publish is refused before anything is rented.

# Serverless endpoints

An endpoint runs one image on demand behind an HTTPS URL, from zero workers (nothing billed while idle) to a cap. The image serves plain HTTP on its port (given to it as `PORT`): no platform SDK in it.

```typescript
const [cpu] = await runpod.listEndpointOffers({ kind: "cpu" });          // priced per hour while a worker runs
const e = await runpod.createEndpoint({ name: "whoami", container: { image: "traefik/whoami" }, port: 80, offer: cpu, maxWorkers: 2 });
const r = await runpod.requestEndpoint(e, "/api");                       // the account's key added, a cold start waited out
await runpod.deleteEndpoint(e.id);                                         // its workers stop with it
```

- `requestEndpoint` sends the account's key only to the platform's own host: RunPod's URL is made from the endpoint's id, Scaleway's read from the platform and held to `*.scw.cloud`. A redirect is not followed: its answer is returned, as fetch would otherwise send the key on to wherever it points. It waits out a cold start (no worker up yet, a fresh host name that does not resolve yet) up to `timeoutMs` (default 5 min).
- **RunPod**: load-balancing endpoints (`https://<id>.api.runpod.ai`), on a GPU type of a serverless pool (the offer's type, the pool's others left out) or a CPU flavor at 2 or more vCPUs. A private image's login is stored as for pods. A worker answers the health check (`/ping`) on `PORT`. Seen live: an idle endpoint kept its worker (IDLE) for 15 minutes after its last request despite an `idleTimeoutSeconds` of 5; `deleteEndpoint` (which scales to no worker first) is what stops it.
- **Scaleway**: Serverless Containers (CPU only), private (the key goes as `X-Auth-Token`), each in a namespace made for it and deleted with it. A public image from any registry, or one of the Project's own registry (no other login); an idle instance stops after 15 minutes.

# Servers, with GPUs or without

A VPS and a GPU server are both servers: an offer's GPU fields say which (`gpu: ''`, `vendor: null`, `gpuCount: 0` for a machine without GPUs). `kind` picks them:

```typescript
await digitalOcean.listOffers();                  // every size
await digitalOcean.listOffers({ kind: "cpu" });   // plain droplets
await digitalOcean.listOffers({ kind: "gpu" });   // GPU droplets
await digitalOcean.listOffers({ gpus: ["H100"] }); // any GPU filter asks for GPUs
await scaleway.listServers({ kind: "gpu" });
```

- `listOffers(query?)`: what can be rented (GPUs and VRAM per GPU where it has them, price per hour, regions with stock now), cheapest first. The same query means the same on every provider (`filterOffers`).
- `minCudaVersion` (on `listOffers` and `createServer`): only hosts whose driver runs at least that CUDA version, which is what a CUDA image needs of a machine it does not install the driver on. Container providers apply it, and their offers say `cudaVersion`. A VM runs the driver of the image it boots, so VM offers are not filtered by it (AMD offers are left out either way).
- `createServer({ name, offer, ... })`: `offer` is an offer from `listOffers` or an offer's id. `gpuCount` defaults to the offer's; only RunPod, whose pods take any count, accepts another. `region` and `image` take the provider's own names, or the library's `REGION_TYPES` and `MACHINE_TYPES`, which each provider maps onto its own names. A member it has no name for is refused, never sent as it is. `image` defaults to the provider's image for the offer: its GPU image for a GPU, plain Ubuntu otherwise.
- `providerOptions`: fields merged into the platform's own create request, typed by it (`Partial<DigitalOceanCreateDropletParams>` on DigitalOcean, and so on) and open to fields its type does not list yet.
- `registryAuth` (containers): the login for a private image's registry, `{ username, password, server? }` (the host defaults to the one the image names, else Docker Hub). RunPod stores it on the account once, named `asap-vps:<user>@<host>:<hash>` (no secret in the name), and every pod with the same login reuses it; Vast sends it with the rental. On a VM it goes inside `container` (below): at the top level it is refused.
- `container`: one image to run, the same option on every provider (see Containers, on any provider).
- `mounts`: volumes of the account to mount (see Volumes).
- A create option the provider cannot honor is refused (`NotSupportedError`) before anything is rented, never dropped.
- `getServer(id)` (null when it does not exist), `listServers({ kind? })`, `deleteServer(id)` (idempotent), `waitForServer`, `waitUntilRunning`, `deleteServerAndWait`, `getServerCost`.
- Every record carries the platform's own as `raw`, typed per provider: `(await digitalOcean.getServer(id))?.raw` is a `DigitalOceanDropletData`.

# What a server costs

Every offer and server carries its rate, `pricePerHour` (USD for the whole machine), and `billing`: how its provider counts time, in steps of `incrementSeconds` (1 per second, 60 per minute, 3600 per hour), never less than `minimumSeconds`, and never less than `minimumUsd` where the provider has a minimum charge. A server also says when its current run began billing (`billingStartedAt`, epoch ms, read from the provider's own record), so its cost is the time since then, counted the provider's way:

```typescript
import { estimateCost } from "asap-vps";

// the server's current run so far: { usd, pricePerHour, from, to, billedSeconds }
const cost = await runpod.getServerCost(server.id);
const byNoon = await runpod.getServerCost(server.id, Date.parse("2026-10-02T12:00:00Z")); // or up to a given time
// null while nothing bills at its rate: a stopped server that bills only its disk, or a deleted one

// any span at any rate, counted the same way: a 90 s job on an offer, before renting it
const job = estimateCost(offer.pricePerHour, 0, 90_000, offer.billing); // billed 90 s on DigitalOcean, 2 min on Lambda
```

| Provider | Counted | A run bills from (`billingStartedAt`) | While stopped |
|---|---|---|---|
| DigitalOcean | per second, at least 60 s or $0.01 | its creation, until it is deleted | the run goes on (a stopped droplet bills in full) |
| Scaleway | per minute with a GPU (RENDER-S per hour), per hour without | its last change of state (an edit moves it too) | `null` (only volumes and IPs bill) |
| RunPod | per second | the pod's last start | `null` (only the volume bills) |
| Vast.ai | per second | the rental's start, which a stop and start does not move: after one, the estimate is an upper bound | `null` (only the disk bills) |
| Lambda Cloud | per minute | its first passed health check | (no stop) |

An estimate is the rate applied to the time: disks, bandwidth and addresses bill on top, and the provider's invoice is the truth.

# Setting a server up

`ServerProvisioner` does the whole run on any provider with `compute` and `sshKeys` whose servers are VMs. It makes a fresh key, rents the offer, waits for the server, runs a `SetupPipeline` over SSH (through sudo where the login is not root), and deletes the server again if any of it fails. A VPS and a GPU VM go through it the same way:

```typescript
import { InstallDockerStep, LambdaCloud, RunCommandStep, ServerProvisioner } from "asap-vps";

const lambda = new LambdaCloud(process.env.LAMBDA_API_KEY!);
const [offer] = await lambda.listOffers({ gpus: ["A10"] });
const { server } = await new ServerProvisioner(lambda).provision({ serverOptions: { name: "worker-1", offer } }, (pipeline) => {
  pipeline.addStep(new InstallDockerStep()).addStep(new RunCommandStep(["nvidia-smi -L"], "check-gpu"));
});
```

Where the provider applies the account's keys at every boot (`capabilities.sshKeys.appliedAtBoot`: Scaleway), the provisioner keeps the key it registered and returns its id as `providerSshKeyId`. Deleting the key would lock the server out at its next boot, so delete it yourself once the server is gone.

# Images

A server set up once can be captured as an image, so the next one boots with everything already installed:

```typescript
await digitalOcean.stopServer(server.id);                                       // for a consistent disk
const image = await digitalOcean.createImage(server.id, { name: "my-gpu-ready" }); // waits until available
await digitalOcean.copyImage(image.id, ["nyc2"]);                               // imageCopy: snapshots are region-bound
const next = await digitalOcean.createServer({ name: "my-gpu-2", offer, region: "nyc2", image: image.id });
```

`listImages()` returns every image of the account, not just yours: pick yours by name before booting or deleting one.

Scaleway's images stay in their zone, and Scaleway has no copy of its own: `copyImage` exports the image's root snapshot as a QCOW2 to a bucket of its region, imports it in each zone asked for, and images it there. For a zone of another region the file goes through this machine (Object Storage copies nothing across regions). It goes in parts: ranges of it are read from the first bucket and written as the parts of a multipart upload to the other, several at once, so this machine holds only the parts in flight, and a copy takes about as long as the slower of its download and upload. A copy is an image of its zone, with the same name and a tag that names the source. `createServer` boots the copy when given the source's id and the copy's zone, and `deleteImage` deletes the copies with the source. The source's `regions` are every zone it boots in, its copies' with its own, whether it is read alone (`getImage`) or listed (`listImages`, which lists the copies too, each in its zone). Only the root disk is copied: an image with more volumes is refused. Object Storage needs the API key's access key (`accessKey`, SCW_ACCESS_KEY).

Vast keeps no images. Its snapshot commits an instance's container and pushes it to a registry of yours, so a `VastAI` given `snapshots` (a repository and a login that can push to it) has images: the repository's tags.

```typescript
const vast = new VastAI({ apiKey, snapshots: { server: "ghcr.io", repository: "acme/snapshots", username: "bot", password: process.env.GHCR_TOKEN! } });
const image = await vast.createImage(instance.id, { name: "trained-v1" }); // ghcr.io/acme/snapshots:trained-v1
await vast.createServer({ name: "next", offer, image: image.id, command });  // any machine; pulled with the snapshot login
```

Vast pushes the snapshot, of a running or a stopped instance, under a tag of its own that names the instance (`instance_<id>_at_<time>`). It reports no progress, so `createImage` waits until the tag is in the repository (a 90 MB image took under a minute), then names the same image. `listImages` lists each image once, under its name. `deleteImage` deletes the image with every tag of it: through the registry's API where it deletes (Docker Hub and ghcr.io do not), and through Scaleway's own API for a Scaleway registry (`rg.<region>.scw.cloud`, whose login is a Scaleway API key).

An image built elsewhere (Packer, a distribution's cloud image) comes in with `importImage` (`imageImport`), and is then one of the account's images like any other:

```typescript
const noble = await digitalOcean.importImage({
  name: "noble-min", region: "ams3", providerOptions: { distribution: "Ubuntu" },
  url: "https://cloud-images.ubuntu.com/minimal/releases/noble/release/ubuntu-24.04-minimal-cloudimg-amd64.img",
});                                                                           // waits until it can boot (default 1 h)
```

DigitalOcean fetches the file itself: raw, qcow2, vhdx, vdi or vmdk, gzip or bzip2 too, under 100 GB, from a host that answers HEAD; the image needs cloud-init and BIOS boot, and a droplet made from it an SSH key. An import DigitalOcean cannot read, or one that outlasts the wait, is deleted, and its failure thrown.

Scaleway takes a QCOW2 (unencrypted, no backing file, at most 1 TB), put in a bucket made for it in the zone's region (`accessKey` again). Where the file's server serves ranges of it, they go straight into the bucket as the parts of a multipart upload, several at once (this machine holds only the parts in flight); from any other server, the file is downloaded to a temporary file first. Scaleway imports it as a Block snapshot and images it, and the bucket is then deleted. The image boots with UEFI and needs cloud-init. An Ubuntu cloud image lets no key log in as root, so boot it with user data `#cloud-config\ndisable_root: false`. A file Scaleway cannot read is an error and leaves nothing behind.

# Volumes

Storage of the account's own that outlives the servers that mount it: where model weights and data stay between servers, instead of being baked into every image. A server mounts volumes when it is created, and `deleteServer` leaves them:

```typescript
const models = await runpod.createVolume({ name: "models", region: "US-TX-3", sizeGb: 100 }); // bills until deleteVolume
const pod = await runpod.createServer({ name: "worker", offer, image, mounts: [{ volume: models, path: "/models" }] });
// ... later, any number of pods in US-TX-3 mount the same weights
await runpod.deleteServerAndWait(pod.id);
await runpod.deleteVolume(models.id);
```

A volume is in one region (a zone, a data center): a server elsewhere cannot mount it, and is refused before anything is rented. A volume is one of two kinds, its `shared` says which: a block device one server holds at a time, or a filesystem many servers mount at once. `capabilities.volumes` holds the kinds a platform makes, and how each behaves (`mount`, `size`, `minGb`, `maxGb`); where a platform makes both, `createVolume({ ..., shared: true })` picks the filesystem (default: the block device).

| Platform | What a volume is | kind | `mount` | `size` |
|---|---|---|---|---|
| RunPod | a network volume (one per pod; the pod is placed in its data center) | `shared`: many pods | `path` (default `/workspace`) | `fixed`, 10-4096 GB |
| Lambda | a filesystem (mounted at launch only) | `shared`: many instances | `path` under /home, /lambda/nfs or /data (default `/lambda/nfs/<name>`) | `elastic`: it grows as it fills |
| DigitalOcean | a Block Storage volume, formatted ext4 | `block`: one droplet | `auto`: DigitalOcean mounts it at `/mnt/<name>`, dashes as underscores | `fixed`, 1-16384 GiB |
| Scaleway | a Block Storage volume (5000 IOPS) | `block`: one server | `device`: a disk the server formats and mounts itself | `fixed`, from 1 GB |
| DigitalOcean | a Network File Storage share (nyc2, ams3, atl1, ric1, mkc1, mem1), in the region's default VPC | `shared`: droplets of its VPC | `path` (default `/mnt/<name>`): the library mounts it over NFS (cloud-init, fstab) | `fixed`, 50-32768 GB |
| Scaleway | a File Storage filesystem (Paris) | `shared`: Instances of a type that attaches one (`max_file_systems`: POP2, L4, L40S, H100...) | `path` (default `/mnt/<name>`): attached before it boots, mounted with virtiofs by the library | `fixed`, 25-50000 GB |
| Vast | storage on one machine: its region is the machine, `machine:<id>`, which an offer's `regions` name too | `block`: one instance at a time, rented on that machine | `path` (default `/data`), one volume per instance | `fixed`, from 1 GB, as much as the machine has free |

`listVolumes()` returns every volume of the account: pick yours by name.

A Vast volume is on one machine, so make it where you will rent, and rent there again to mount it later:

```typescript
const [offer] = await vast.listOffers({ gpus: ["RTX 4090"] });
const data = await vast.createVolume({ name: "weights_v1", region: offer.regions.find((r) => r.startsWith("machine:"))!, sizeGb: 50 });
const a = await vast.createServer({ name: "a", offer, image, command, mounts: [{ volume: data, path: "/models" }] });
await vast.deleteServerAndWait(a.id);                     // its volume is free again some 30 s after it is gone
const [again] = await vast.offersOn(data.region);         // [] while someone else rents that machine
```

# Providers by id

For code that is configured rather than written per provider:

```typescript
import { createProvider, providersFromEnv, providersWith, PROVIDERS } from "asap-vps";

const vast = createProvider("vast", process.env.VAST_API_KEY!); // typed: a VastAI
const all = providersFromEnv(process.env);                      // every provider whose key (PROVIDERS[id].keyEnv) is set
providersWith("images", "imageCopy");                           // ['digitalocean', 'scaleway']: read from the descriptors, nothing built
providersWith("volumes");                                       // ['digitalocean', 'runpod', 'vast', 'lambda', 'scaleway']
```

# Errors

Failures are typed, all extending `ProviderError`:

- `CapacityError`: this offer or region has no stock right now, so try another.
- `QuotaError`: an account limit or balance.
- `AuthError`.
- `NotFoundError`.
- `NotSupportedError`.
- `TransportError`: no answer at all, or one cut off.

A create that fails once it has made something deletes what it made (Scaleway: an image, a volume, a filesystem, a snapshot, an endpoint whose wait runs out or ends in an error). Where that delete fails too, the error has the code `left_behind` and names what is left: it bills until you delete it, and nothing else would find it.

`isRetriable(e)` says whether a failure is safe to try again as it is: a read or an idempotent request that got no answer or a temporary error, or a refusal such as a rate limit. A create is never retried after a server error or a lost answer, and `isRetriable` is false for those, because it may already have made a (billed) machine: find it by its name instead.

# What each platform does

These are the behaviours that shape the primitives, checked against each provider's current API reference (2026-09-29). Each one is a test in `src/Providers/<Platform>/*.spec.ts`.

- **DigitalOcean** lists GPU droplets only with `?type=gpus` (its plain list is the other droplets), so `listServers` reads the lists `kind` asks for. For seconds after a key is added, its key list does not show the key and its duplicate check lets the same key in again (seen live), so `createServer` sends key ids and MD5 fingerprints without looking them up, and `addSSHKey` remembers what it registered for a minute: the same key added again through the same provider returns that registration, while another process may register it twice in that window. A droplet takes one action at a time (its create too, until it is active): an action asked for meanwhile is refused with a 422 "pending event" and nothing done, so it is asked again until the wait ends, and every action is waited for. `stopServer` shuts the droplet down cleanly, and powers it off only if that fails. 8-GPU sizes boot the 8-GPU image.
- **DigitalOcean** volumes: a droplet attaches volumes of its region that no droplet holds (each is read just before the create, as its state changes); `createVolume` formats them ext4, so they are mounted at `/mnt/<name>` with each dash an underscore (`models-v2` -> `/mnt/models_v2`: the volume's `mountPath`). Deleting a droplet detaches its volumes, a while after the droplet is gone (seen live): `deleteServerAndWait` waits for that too, and a create or `attachVolume` that takes a volume a deleted droplet still holds waits for it to be let go of. An attached volume cannot be deleted. The volume list lags a create by seconds; `getVolume` does not.
- **Lambda** takes exactly one SSH key at launch, names up to 64 characters, and tag keys of 2-55 characters (`a-z 0-9 - :`, starting with a letter). Its filesystems are mounted at launch only (never on a running instance), by any number of instances of their region, and one in use cannot be deleted. Lambda reads filesystems only as a list: `getVolume` looks one up in it.
- **Scaleway** (Instance API v1). `SCALEWAY_ENDPOINTS` lists every endpoint called, each with its page of [Scaleway's API reference](https://www.scaleway.com/en/developers/api/instance/v1), and `npm run scaleway:spec` holds them to Scaleway's OpenAPI specs.
  - Every call is zonal, so a server and an image are named `zone/<uuid>` (`zonedId`, `parseZonedId`).
  - A server is created powered off. `createServer` sets its user data (a `PATCH` of the `cloud-init` key, as `text/plain`) and then sends `poweron`. A type in `shortage` is refused at the power-on (or the create) as a `CapacityError`, and the server it made is deleted again.
  - A GPU type boots from Block Storage (`sbs_volume`, sized by `diskGb`). `terminate` only detaches that volume, and it bills until deleted, so `deleteServer` deletes it as soon as it is detached. A stopped server has no `terminate`, so it is deleted directly, volumes included.
  - `poweroff` releases the slot, so `startServer` needs stock again.
  - Stock is `available`, `scarce` or `shortage` per type and zone; `shortage` leaves a zone out of an offer's `regions`. Prices are euros (`eurToUsd` converts them, default 1.15, and the euro price stays in an offer's `raw`).
  - SSH keys belong to a Project, and Scaleway applies every key of a Project to every server of it at every boot (checked live). So `sshKeyIds` must be keys of the Project and cannot exclude the others.
  - Creating anything needs the Project (`projectId`, SCW_DEFAULT_PROJECT_ID): asap-vps never guesses one.
  - Images are zone-bound snapshots, and `deleteImage` deletes its snapshots too.
  - Volumes are Block Storage, named `zone/<uuid>` too. A server is created with them attached after its image's own volumes (`'1'..'n'` are an account image's extra volumes), and carries an `asap-vps-volume:<uuid>` tag for each: `deleteServer` deletes every Block Storage volume of the server but those, and `createImage` leaves them out of the image. A zoned volume id fixes the zone of a create that names none.
  - A GPU quota starts at 0: `QuotaError` until the account's identity is verified, or support lifts it.
- **Vast** snapshots go to a registry of yours (`snapshots`):
  - The snapshot call takes the instance in its URL only (an `id` in the body as well is a 400).
  - It takes a repository with its registry's host (without the host, Vast pushes to Docker Hub) and no tag: Vast appends its own.
  - The image keeps the instance's command.
  - Scaleway's registry refuses every manifest DELETE through the Registry API, whatever the key and the scope (checked 2026-10-07).
- **Vast** volumes are storage on one machine:
  - Each is rented from that machine's storage offer.
  - Its name may hold only letters, digits and underscores (at most 64; anything else is a 422).
  - It lives until it is deleted, or until its host's listing ends (`raw.end_date`).
  - An instance mounts one volume, set when it is rented, so a volume on another machine, or one another instance holds, is refused before anything is rented.
  - An offer is one machine, rented where it is: a `region` asked for must be one of the offer's (its location, or its `machine:<id>`), and another is refused before anything is rented.
  - Vast's single read of an instance does not show the volume it mounts, but its instance list does. So `getServer` reads the instance from that list, and its `mounts` give each volume's path.
  - A deleted instance keeps its volume `in-use` for about 30 s (observed), and `deleteServerAndWait` waits for it to be let go.
  - Vast withdrew its network volumes in July 2026: `listVolumes` leaves them out.
- **Vast** returns at most 64 offers per search, so `listOffers` asks Vast itself for the vendor and the models' compute capability, then pages by price. Vast pages by price alone, so where more offers than a page (64) share one price, the search goes on above it: no dearer offer is lost, but those of that price past the first page are (a model filter, which Vast applies itself, avoids such a tie). Each offer is one machine, which its `regions` name after its location (`machine:<id>`). An interruptible offer's id carries its bid, and each port is mapped to a random public port (read it from the server's `ports`). An offer's `pricePerHour` is the price Vast's search gives it, which counts 8 GB of disk (an interruptible offer's is its minimum bid, no disk counted). The disk a server is rented with (`diskGb`) bills on top, at the machine's `raw.storage_cost` (USD per GB per month, by the hour over 720 hours: 100 GB at $0.20 is about $0.028 an hour, which on a cheap GPU can match the GPU's own price). A server's own `pricePerHour` includes its disk. `env` values cannot hold spaces or quotes, nor can a `registryAuth`'s parts (Vast takes the login as one string of `docker login` arguments). A bad key is answered 404, not 401 (observed).
- **RunPod** lists MIG slices as GPU types of their own, named card and profile (`RTX PRO 6000 MIG 1g.24gb`), so asking for a card never rents a slice. Pods take no UDP. RunPod's own SSH setup would authorize every key on the account, so `sshKeyIds` sends exactly the keys named (as `PUBLIC_KEY`) and exposes `22/tcp` for sshd's direct endpoint. A stopped pod can resume without its GPU: `startServer` then stops it again and throws `CapacityError`. A pod mounts at most one network volume, or a disk of its own (`volume`), never both. RunPod keeps a registry login's username and password write-only and has no update for one: a new password is stored as a new login.

# Layout, and adding to it

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
src/Providers/registry.ts       every provider by id, typed
src/testing/                    fakes of each platform's REST API, the contract and lifecycle suites, live-run safety
```

**A new provider** goes in a folder of those four files. Name the platform's records in a `<Platform>Types` bundle (its server, offer, image, volume, create requests, the options it refuses, and what a volume size and a mount take there). Extend `ComputeProvider<<Platform>Types, <Platform>Api>`, declare its capabilities as a `const` descriptor, and `implements ProviderCapabilities<<Platform>Types, typeof CAPABILITIES>`; the compiler then asks for every method of every capability declared. Then write a fake of its API in `src/testing/fakes` and add it to `src/testing/subjects.ts` and `PROVIDERS`. The contract suite (`src/Providers/contract.spec.ts`) and the lifecycle suite hold it to the same behaviour as every other provider, capability by capability.

**A new capability** (object storage, firewalls, ...) is an interface in `src/capabilities.ts`, its traits in `CapabilityTraits`, an entry in `CapabilityInterfaces` and its methods in `CAPABILITY_METHODS`. Then the providers whose platforms have it implement and declare it. A provider with no servers at all extends `BaseProvider` instead of `ComputeProvider`.

Specs sit next to the code they test.

# Documentation site

[`site/`](site) is the documentation, published to GitHub Pages: pages of markdown in [`site/src/content`](site/src/content), built with [esbuild](https://esbuild.github.io). Every `ts` block on it is a [Monaco](https://microsoft.github.io/monaco-editor/) editor that has this library's real declarations (`tsc` emits them from `src/`, and the editors resolve `asap-vps` to them, with Node's types), so completions, hovers, signature help and errors are the ones your editor gives you.

A block's info string says what it is: `ts run` has a **Run** button that executes it in a Web Worker, `ts` is type-checked, `ts error` must fail to compile (it shows what the type system refuses), `ts static` is only highlighted. A run uses the library's own code, bundled with small shims for Node's built-ins, with `fetch` routed by each provider's real host to its fake (`src/testing/fakes`), `process.env` holding a key each fake accepts, and a virtual clock (a wait of ten seconds takes a moment but moves `Date.now()` ten seconds). Nothing leaves the page.

```
npm run docs:install   # once: the site has its own dependencies (esbuild, monaco-editor, marked, @noble/hashes, ...)
npm run docs:dev       # build, serve on http://localhost:8765 and rebuild on change
npm run docs:build     # site/dist
npm run docs:check     # type-check the site, then every block of every page: each compiled against the declarations, each `run` executed in the sandbox, each `error` required to fail
```

`docs:check` is the docs' test suite, so a page cannot show code that no longer compiles or a run that no longer works; `site/scripts/e2e.mjs` repeats it in headless Chrome, against the built site. [.github/workflows/docs.yml](.github/workflows/docs.yml) runs the check and the build on every pull request that touches `site/` or `src/`, and deploys `master` to Pages (the repository's Settings, Pages, Source: GitHub Actions).

# Running tests

`npm test` runs every spec against fakes of the providers' APIs: no account, no key, nothing rented.

`npm run test:coverage` runs them with coverage of the library (`src`, without its specs and its test harness, `src/testing`), and fails below 90% of statements, branches, functions or lines, and below 100% of each on any Scaleway source file (`coverageThreshold` in `package.json`, applied only when coverage is collected: plain `npm test` does not enforce it). CI ([.github/workflows/ci.yml](.github/workflows/ci.yml)) runs it on every pull request, after a type-check and a build, on Node 18, 22 and 24 (on GitHub's runners, or on the self-hosted ones the repository variable `CI_RUNS_ON` names; never a fork's pull request on those), and master takes only a pull request whose runs all passed. `npm run scaleway:spec` holds the Scaleway provider to Scaleway's own OpenAPI specs, read from scaleway.com: every endpoint's method, path, operation id, query parameters and reference page, every enum's members, every field's name and kind, and that each type cites a reference page that documents it (`-- --live` also reads the public catalog answers; [scripts/scaleway-spec-check.ts](scripts/scaleway-spec-check.ts) says what it checks and what it leaves out on purpose). DigitalOcean, RunPod, Vast and Lambda each have a table of the endpoints they call too (`DIGITALOCEAN_ENDPOINTS`, `RUNPOD_ENDPOINTS`, `VAST_ENDPOINTS`, `LAMBDA_ENDPOINTS`, in `src/Providers/<Platform>/endpoints.ts`): each endpoint's operation in the platform's OpenAPI spec, the query parameters it is sent with, and its page in the platform's API reference. Their API clients refuse a request no entry describes, before it is sent, so every test that drives a provider holds it to its table. `npm run api:spec` holds those tables to the live specs and reference pages ([scripts/api-spec-check.ts](scripts/api-spec-check.ts)): every operation, operationId and query parameter, and that each reference page documents its operation. A call that departs from the spec (an operation it does not have, a query parameter it does not declare) is sent as the platform's own CLI sends it, or as seen live, and its entry says which.

## Live tests

The `*.live.spec.ts` suites take every method of each provider through the real API, with the keys in `.env.test` (copy `.env.template`; a key it leaves empty is read from `~/.config/asap-vps/credentials.env`; [docs/GPU_PROVIDER_SETUP.md](docs/GPU_PROVIDER_SETUP.md) says where each key comes from). They rent real servers, so each runs only when asked, one suite at a time:

```sh
ASAP_VPS_LIVE=runpod npm run test:live                     # one provider
ASAP_VPS_LIVE=runpod,vast,lambda npm run test:live          # several
ASAP_VPS_LIVE=all ASAP_VPS_LIVE_FREE=1 npm run test:live    # every check that rents nothing
npm run test:do                                             # DigitalOcean as a VPS host: one s-1vcpu-1gb droplet
npm run test:scw                                            # Scaleway as a VPS host: one STARDUST1-S Instance
npm run test:do:cpu                                         # DigitalOcean's whole lifecycle on its cheapest droplet (cents)
npm run test:scw:cpu                                        # Scaleway's whole lifecycle on a STARDUST1-S Instance (cents)
npm run test:scw:volumes                                    # Scaleway volumes: a Block Storage volume mounted on STARDUST1-S Instances, kept when they are deleted (cents)
```

- `ASAP_VPS_LIVE`: `digitalocean`, `runpod`, `vast`, `lambda` and `scaleway` (each provider's lifecycle on a GPU), `digitalocean-cpu` and `scaleway-cpu` (the provider's lifecycle on its cheapest CPU server: the API is the same as for a GPU, so this proves every code path but the GPU's own for cents, whatever GPU stock or quota there is), `digitalocean-vps` and `scaleway-vps` (each as a VPS host), or `all`. Scaleway needs `SCW_SECRET_KEY` and `SCW_DEFAULT_PROJECT_ID`; its runs also check that no Block Storage volume of their servers and no snapshot of their images is left.
- `ASAP_VPS_LIVE_FREE=1`: only what rents nothing: the key, offers and their filters, listings, ids nothing has, SSH keys (one is added and deleted), and every call or option the provider refuses up front.
- `ASAP_VPS_LIVE_MAX_PRICE`: the most a rented GPU may cost, in USD per hour (default 1).
- `ASAP_VPS_LIVE_IMAGES=0`: skip the image phase of DigitalOcean and Scaleway (a snapshot, a copy to another region where there is one, a boot from it: tens of minutes).

Each lifecycle suite ([src/testing/lifecycle.ts](src/testing/lifecycle.ts)) rents the cheapest single NVIDIA GPU in stock under the price cap and takes it through `createServer`, `getServer`, `listServers`, `waitForServer` and `waitUntilRunning`, and checks its cost: `getServerCost` reports a run begun no earlier than the create, none while it is stopped (where only its disk bills), and a new run once it starts again. A container's log must show its GPU and the environment it was given. On a VM, the provisioner logs in over SSH and checks the GPU, the cloud-init user data and root (through sudo on Lambda). Then come `restartServer` (a VM must really boot again: its boot id changes) and `stopServer` / `startServer`, then the images where the provider has them (`createImage`, `getImage`, `listImages`, `copyImage` where it has `imageCopy`, a server booted from the image, `deleteImage`), and finally `deleteServerAndWait`, verified. Volumes, registry logins and containers are held to their contract against every fake (`src/Providers/contract.spec.ts`), and have their own live suites (`*Volumes.live`, `*Registry.live`, `*Container.live`, `ScalewayDisks.live`): a private registry is made for each run in the Scaleway account (`src/testing/privateRegistry.ts`, with a pull-only key that expires in hours), and deleted with it. A capability the provider does not declare must have no methods on its class. The same lifecycle runs against every fake in `npm test` ([src/Providers/lifecycle.spec.ts](src/Providers/lifecycle.spec.ts)), so a broken step shows up there before any money is spent.

Every server, SSH key, volume and image a live run creates is named `asap-vps-smoke-<run>`, and nothing is left behind ([src/testing/live.ts](src/testing/live.ts)):

- the run first deletes what earlier runs left;
- a DigitalOcean run first checks the account has room for a droplet;
- a detached watchdog is armed before anything is rented, and deletes the run's servers, keys, volumes and images if the run dies or overruns;
- at the end the run deletes everything of its name, and every key and volume it recorded by id (an account's list can lag its writes by seconds), and proves with fresh lists that it is gone: a leftover of any kind fails the run.

`npm run gpu:smoke -- <provider> --sweep` deletes leftovers by hand.

## todo

- Normalize size strings with enum same was as region and images
- Add more machine(image) type enums
- Add more region type enums
- Linode and AWS providers
- An object storage capability (DigitalOcean Spaces, Scaleway Object Storage)
- Add setup scripts for ubuntu/git
- Add setup scripts for debian/node
- Add setup scripts for debian/forever
- Add setup scripts for debian/git
