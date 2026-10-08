# Vast.ai

`VastAI` rents containers on a **marketplace**: every offer is one machine, listed by its host, so renting it twice answers "no longer available" and the offers change in seconds. A machine's place is where it is, a volume lives on one machine, and an image is a snapshot pushed to a registry of yours.

## Rent a machine

`listOffers` searches Vast for you (its API returns at most 64 offers a page, so the library pages by price). Each offer is one machine, and says where it is:

```ts run title="Rent the cheapest machine that runs your CUDA"
import { VastAI } from "asap-vps";

const vast = new VastAI(process.env.VAST_API_KEY!);

const offers = await vast.listOffers({ minVramGb: 16, minCudaVersion: "12.2", maxPricePerHour: 1 });
const [offer] = offers;
console.log(`${offer.gpuCount}x ${offer.gpu}, ${offer.vramGb} GB, $${offer.pricePerHour}/h`);
console.log("regions:", offer.regions); // its location, and the machine itself: machine:<id>

const server = await vast.createServer({
  name: "trainer",
  offer,
  image: "nvidia/cuda:12.8.1-base-ubuntu24.04",
  command: ["sh", "-c", 'nvidia-smi -L; echo "PORT is $PORT"; sleep infinity'],
  env: { PORT: "8080" },
  ports: ["8080/tcp"], // mapped to a random public port
});
const running = await vast.waitUntilRunning(server.id);
console.log(running.status, running.ports); // { privatePort: 8080, publicPort: <random>, ip, protocol }
console.log(await vast.getServerLogs(running.id));

await vast.stopServer(server.id); // a stopped instance bills only its disk
await vast.deleteServerAndWait(server.id);
```

`includeInterruptible: true` adds the **interruptible** offers (a bid price instead of the on-demand one: the offer's id carries the bid). `minCudaVersion` is checked against the machine's driver before anything is rented.

## One machine, one place

A Vast offer is one machine, so a `region` you ask for must be one of the offer's (its location, or its `machine:<id>`). Anything else is refused before anything is rented:

```ts run title="A region that is not the offer's is refused"
import { VastAI } from "asap-vps";

const vast = new VastAI(process.env.VAST_API_KEY!);
const [offer] = await vast.listOffers();

try {
  await vast.createServer({ name: "x", offer, region: "Mars", image: "ubuntu:24.04" });
} catch (e) {
  console.log((e as Error).message);
}
console.log("servers rented:", (await vast.listServers()).filter((s) => s.name === "x").length);
```

## Volumes live on one machine

A Vast volume is storage on **one machine**: its region *is* the machine (`machine:<id>`, which an offer's `regions` names too), and only an instance rented on that machine mounts it, one at a time, at a path you give (default `/data`). `offersOn(region)` finds the offers on the volume's machine, so you can rent where it is later:

```ts run title="A volume, and a second instance on the same machine"
import { VastAI } from "asap-vps";

const vast = new VastAI(process.env.VAST_API_KEY!);
const [offer] = await vast.listOffers({ kind: "gpu" });
const machine = offer.regions.find((r) => r.startsWith("machine:"))!;

const data = await vast.createVolume({ name: "weights_v1", region: machine, sizeGb: 50 }); // letters, digits and underscores only
console.log(data.name, data.sizeGb, "GB on", data.region, "| mounts at", data.mountPath);

const base = { image: "nvidia/cuda:12.8.1-base-ubuntu24.04", command: ["sleep", "infinity"] };
const a = await vast.createServer({ name: "a", offer, ...base, mounts: [{ volume: data, path: "/models" }] });
console.log((await vast.waitUntilRunning(a.id)).mounts); // [{ volumeId, path: '/models' }]
await vast.deleteServerAndWait(a.id); // its volume is free again some 30 s later

const [again] = await vast.offersOn(machine); // [] while someone else rents that machine
const b = await vast.createServer({ name: "b", offer: again, ...base, mounts: [{ volume: data.id }] });
console.log((await vast.waitUntilRunning(b.id)).mounts); // default path: /data
await vast.deleteServerAndWait(b.id);
await vast.deleteVolume(data.id);
```

## Images: snapshots in a registry of yours

Vast keeps no images. Its snapshot commits an instance's container and pushes it to a registry, so a `VastAI` given `snapshots` (a repository and a login that can push to it) has images: the repository's tags. The image boots on **any** machine, pulled with the snapshot login.

In the sandbox the registry is `registry.fake`; in your code it is `ghcr.io`, Docker Hub, or a Scaleway registry. Vast pushes under a tag of its own (`instance_<id>_at_<time>`), takes a minute, reports no progress, and works on a running or a stopped instance: `createImage` waits until the tag is there, then names the image:

```ts run title="Snapshot an instance, boot the image on another machine"
import { VastAI } from "asap-vps";

const vast = new VastAI({
  apiKey: process.env.VAST_API_KEY!,
  snapshots: { server: "registry.fake", repository: "acme/snapshots", username: "pusher", password: "push-secret" }, // ghcr.io, in real code
});
const [first, second] = await vast.listOffers({ kind: "gpu" });

const a = await vast.createServer({ name: "golden", offer: first, image: "ubuntu:24.04", command: ["sleep", "infinity"] });
await vast.waitUntilRunning(a.id);

const image = await vast.createImage(a.id, { name: "trained-v1" }); // registry.fake/acme/snapshots:trained-v1
console.log(image.id, image.status, "boots anywhere:", image.regions.length === 0);
console.log((await vast.listImages()).map((i) => i.name)); // each image once, under its name

const b = await vast.createServer({ name: "from-image", offer: second, image: image.id, command: ["sleep", "infinity"] });
console.log((await vast.waitUntilRunning(b.id)).status); // pulled with the snapshot login

await vast.deleteServerAndWait(b.id);
await vast.deleteServerAndWait(a.id);
await vast.deleteImage(image.id); // every tag of it
```

`deleteImage` deletes through the registry's API where it deletes (Docker Hub and ghcr.io do not, and say so), and through Scaleway's own API for a Scaleway registry.

## Class hierarchy

`VastAI` is a `ComputeProvider`, which is a `BaseProvider`. Below is what each gives it, generated from the source when the site is built: the chain of classes, the capability interfaces it implements, and which of their methods are written once for every provider and which this class writes itself.

```heritage
vast
```
