# RunPod

`RunPod` rents **pods**: containers on GPU (and CPU) hosts. A pod is the container, so you give it an `image`, not an OS: there is no boot script, but there are `command`, `env`, `ports` and a private-registry login. A stopped pod bills only its volume.

## A GPU pod

`listOffers` takes the same query on every provider. `minCudaVersion` matters most on container platforms: the pod runs your image on the host's driver, so only hosts whose driver runs at least that CUDA are offered.

```ts run title="Rent a GPU, read its logs, stop it, start it"
import { RunPod } from "asap-vps";

const runpod = new RunPod(process.env.RUNPOD_API_KEY!);

// what can be rented right now, cheapest first, on hosts whose driver runs the image's CUDA
const [offer] = await runpod.listOffers({ minVramGb: 24, maxPricePerHour: 1, minCudaVersion: "12.8" });
console.log(`${offer.gpuCount}x ${offer.gpu}, ${offer.vramGb} GB, $${offer.pricePerHour}/h in ${offer.regions.join(", ")}`);

// the offer brings its region, GPU count and (interruptible) bid: nothing to repeat
const server = await runpod.createServer({
  name: "my-gpu",
  offer,
  image: "nvidia/cuda:12.8.1-base-ubuntu24.04",
  command: ["sh", "-c", 'nvidia-smi -L; echo "hello from $MODEL"; sleep infinity'],
  env: { MODEL: "llama-3-8b" },
  minCudaVersion: "12.8",
});
await runpod.waitUntilRunning(server.id);
console.log(await runpod.getServerLogs(server.id)); // the container's own output

await runpod.stopServer(server.id); // a stopped pod bills only its volume
console.log("cost while stopped:", await runpod.getServerCost(server.id)); // null
await runpod.startServer(server.id);
await runpod.deleteServerAndWait(server.id);
```

A stopped pod can resume without its GPU (the host gave it to someone else): `startServer` then stops it again and throws `CapacityError`, so a retry loop knows to move on. See [Errors](#/errors).

Pods also come **without a GPU**: `listOffers({ kind: "cpu" })` returns CPU flavors, and the rest of the call is the same.

## A network volume, mounted at a path

A RunPod volume is **shared** (any pod in its data center mounts it), has a fixed size (10 to 4096 GB) and is mounted at the path you give (default `/workspace`). A pod mounts one network volume, and is placed in the volume's data center:

```ts run title="Weights that outlive the pods that use them"
import { RunPod } from "asap-vps";

const runpod = new RunPod(process.env.RUNPOD_API_KEY!);
const [offer] = await runpod.listOffers({ minVramGb: 24 });
const region = offer.regions[0];

const models = await runpod.createVolume({ name: "models", region, sizeGb: 100 }); // bills until deleteVolume
console.log(models.name, models.sizeGb, "GB in", models.region, "| shared:", models.shared);

const pod = await runpod.createServer({
  name: "worker", offer, region, image: "nvidia/cuda:12.8.1-base-ubuntu24.04", command: ["sleep", "infinity"],
  mounts: [{ volume: models, path: "/models" }],
});
console.log((await runpod.waitUntilRunning(pod.id)).mounts); // [{ volumeId, path: '/models' }]

await runpod.deleteServerAndWait(pod.id); // later, any number of pods in `region` mount the same weights
await runpod.deleteVolume(models.id);
```

## A private image

`registryAuth` is the login for the registry the image comes from. RunPod stores it on the account once (named `asap-vps:<user>@<host>:<hash>`, with no secret in the name) and every pod with the same login reuses it:

```ts run title="Pull from a private registry"
import { RunPod } from "asap-vps";

const runpod = new RunPod(process.env.RUNPOD_API_KEY!);
const [offer] = await runpod.listOffers({ minVramGb: 16 });

const pod = await runpod.createServer({
  name: "private-worker",
  offer,
  image: "ghcr.io/acme/worker:1",
  registryAuth: { username: "bot", password: process.env.GHCR_PULL_TOKEN ?? "a-token-that-can-only-pull" }, // give a token that can only pull
});
console.log((await runpod.waitUntilRunning(pod.id)).status);
await runpod.deleteServerAndWait(pod.id);
```

## Serverless endpoints

RunPod runs an image on demand behind an HTTPS URL, from zero workers (nothing billed while idle) to a cap. The image serves plain HTTP on its port, given to it as `PORT`: no platform SDK in it. These are RunPod's **load-balancing** endpoints, on a GPU or a CPU flavor:

```ts run title="An endpoint from zero workers"
import { RunPod } from "asap-vps";

const runpod = new RunPod(process.env.RUNPOD_API_KEY!);

const [cpu] = await runpod.listEndpointOffers({ kind: "cpu" }); // priced per hour while a worker runs
const e = await runpod.createEndpoint({
  name: "whoami", container: { image: "traefik/whoami" }, port: 80, offer: cpu, minWorkers: 0, maxWorkers: 2,
});
console.log(e.url, e.status);

const r = await runpod.requestEndpoint(e, "/api"); // the account's key added, a cold start waited out
console.log(r.status, await r.json());

await runpod.deleteEndpoint(e.id); // its workers stop with it
```

A note from the live API: an idle endpoint kept its worker for fifteen minutes after its last request, despite an `idleTimeoutSeconds` of 5. `deleteEndpoint` (which scales to no worker first) is what stops it. The [serverless guide](#/serverless) compares RunPod and Scaleway.

## Class hierarchy

`RunPod` is a `ComputeProvider`, which is a `BaseProvider`. Below is what each gives it, generated from the source when the site is built: the chain of classes, the capability interfaces it implements, and which of their methods are written once for every provider and which this class writes itself.

```heritage
runpod
```
