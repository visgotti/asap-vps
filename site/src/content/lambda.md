# Lambda Cloud

`LambdaCloud` rents **GPU VMs**. It is the smallest of the five on purpose: a Lambda instance can be restarted and deleted but not stopped, its filesystems are shared and grow as they fill, and it is GPU-only. Because the class implements exactly what the platform has, the compiler is the documentation: what Lambda cannot do is not on the type.

## Rent a GPU

Lambda takes **exactly one SSH key** at launch, and the instance's login is `ubuntu` (the library reports it as `server.ssh.username`, so you never hard-code it):

```ts run title="A GPU instance, restarted and deleted"
import { LambdaCloud } from "asap-vps";

const lambda = new LambdaCloud(process.env.LAMBDA_API_KEY!);
const key = await lambda.addSSHKey("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKd0 laptop", "laptop");

// what is in stock right now, cheapest first, each with the regions that have one
const offers = await lambda.listOffers({ minVramGb: 24, maxPricePerHour: 2 });
for (const o of offers.slice(0, 3)) console.log(`${o.gpuCount}x ${o.gpu} (${o.vramGb} GB): $${o.pricePerHour}/h in ${o.regions.join(", ")}`);

const server = await lambda.createServer({ name: "worker-1", offer: offers[0], sshKeyIds: [key.id] });
const running = await lambda.waitUntilRunning(server.id);
console.log(running.status, running.ip, "log in as", running.ssh?.username);

await lambda.restartServer(server.id);
console.log("cost so far:", (await lambda.getServerCost(server.id))?.usd);
await lambda.deleteServerAndWait(server.id);
await lambda.deleteSSHKey(key.id);
```

## What the type will not let you do

There is no stop on Lambda, so `LambdaCloud` has no `stopServer`. The editor tells you before you run anything (this block is meant to fail, and the page shows why):

```ts error title="Lambda has no stop"
import { LambdaCloud } from "asap-vps";

const lambda = new LambdaCloud(process.env.LAMBDA_API_KEY!);
await lambda.stopServer("instance-id");
```

Options are typed the same way. A Lambda instance is a VM, so it runs no container of its own: the top-level `env` that RunPod and Vast take is refused. And a filesystem grows as it fills, so asking for a size is an error too:

```ts error title="A VM takes no top-level env"
import { LambdaCloud } from "asap-vps";

const lambda = new LambdaCloud(process.env.LAMBDA_API_KEY!);
const [offer] = await lambda.listOffers();
await lambda.createServer({ name: "w", offer, sshKeyIds: ["k"], env: { MODEL: "llama" } });
```

```ts error title="A Lambda filesystem has no size"
import { LambdaCloud } from "asap-vps";

const lambda = new LambdaCloud(process.env.LAMBDA_API_KEY!);
await lambda.createVolume({ name: "models", region: "us-east-1", sizeGb: 50 });
```

Fix them and the red lines go. Code written for *any* provider (`AnyProvider`, `ICompute`) is offered every option, and each provider still refuses what it cannot honor at run time (`NotSupportedError`, before anything is rented). More in [Types and completion](#/types).

## A filesystem many instances share

A Lambda filesystem is **shared** (any number of instances of its region mount it) and **elastic** (no size), and is mounted **at launch only**, at a path under `/home`, `/lambda/nfs` or `/data`:

```ts run title="A filesystem for model weights"
import { LambdaCloud } from "asap-vps";

const lambda = new LambdaCloud(process.env.LAMBDA_API_KEY!);
const key = await lambda.addSSHKey("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKd0 laptop", "laptop");
const [offer] = await lambda.listOffers();
const region = offer.regions[0];

const weights = await lambda.createVolume({ name: "weights", region }); // no sizeGb: it grows as it fills
console.log(weights.shared, weights.sizeGb, weights.mountPath); // true undefined /lambda/nfs/weights

const server = await lambda.createServer({
  name: "trainer", offer, region, sshKeyIds: [key.id],
  mounts: [{ volume: weights, path: "/lambda/nfs/weights" }],
});
await lambda.waitUntilRunning(server.id);
console.log(server.mounts);

await lambda.deleteServerAndWait(server.id); // waits until the filesystem is let go of
await lambda.deleteVolume(weights.id);
await lambda.deleteSSHKey(key.id);
```

## A container, by cloud-init

`container` runs your image with Docker, from a script cloud-init runs at the first boot. On a machine with an NVIDIA GPU its GPUs are passed through (`--gpus all`) and the NVIDIA container toolkit is installed where the image lacks it. The image runs as the container `asap-vps`, so `docker logs asap-vps` reads it:

```ts run title="Docker from the first boot"
import { LambdaCloud } from "asap-vps";

const lambda = new LambdaCloud(process.env.LAMBDA_API_KEY!);
const key = await lambda.addSSHKey("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKd0 laptop", "laptop");
const [offer] = await lambda.listOffers();

const server = await lambda.createServer({
  name: "inference", offer, sshKeyIds: [key.id],
  container: {
    image: "ghcr.io/acme/worker:1",
    env: { MODEL: "llama-3-8b" },
    command: ["serve", "--port", "8000"],
    ports: ["8000/tcp"],
    registryAuth: { username: "bot", password: process.env.GHCR_PULL_TOKEN ?? "a-token-that-can-only-pull" },
  },
});
const running = await lambda.waitUntilRunning(server.id);
console.log(running.status, "- docker logs asap-vps, over SSH, reads the container");

await lambda.deleteServerAndWait(server.id);
await lambda.deleteSSHKey(key.id);
```

The registry login rides in the instance's user data, which the account and the server can read: give a token that can only pull. [Containers on any provider](#/containers) compares all five.

## Class hierarchy

`LambdaCloud` is a `ComputeProvider`, which is a `BaseProvider`. Below is what each gives it, generated from the source when the site is built: the chain of classes, the capability interfaces it implements, and which of their methods are written once for every provider and which this class writes itself.

```heritage
lambda
```
