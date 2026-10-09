# Scaleway

`Scaleway` rents **Instances**, with GPUs or without, and has the most Scaleway-shaped details of the five, all handled for you: everything is zonal (a server is named `zone/uuid`), creating anything needs your **Project**, and a stopped server frees its slot so only its volumes and addresses bill.

It takes the **secret key** of an API key and the Project. The **access key** is needed only where Object Storage is (image copy and import):

```ts
import { Scaleway } from "asap-vps";

const scaleway = new Scaleway({
  apiKey: process.env.SCW_SECRET_KEY!, // the secret key: sent as X-Auth-Token
  projectId: process.env.SCW_DEFAULT_PROJECT_ID!, // where servers and SSH keys are created
  accessKey: process.env.SCW_ACCESS_KEY, // only for image copy and import
  zones: "fr-par", // optional: only these zones (a region stands for its zones)
});
```

## A server in a zone

```ts run title="Rent the cheapest Instance, stop it, start it, delete it"
import { Scaleway } from "asap-vps";

const scaleway = new Scaleway({ apiKey: process.env.SCW_SECRET_KEY!, projectId: process.env.SCW_DEFAULT_PROJECT_ID! });

const [offer] = await scaleway.listOffers({ kind: "cpu" }); // cheapest first; its regions are zones with stock
console.log(`${offer.id}: $${offer.pricePerHour.toFixed(4)}/h in ${offer.regions.join(", ")}`);

const created = await scaleway.createServer({ name: "api-1", offer, region: offer.regions[0] });
const server = await scaleway.waitUntilRunning(created.id);
console.log(server.id, server.status, server.ip); // a zoned id: <zone>/<uuid>

await scaleway.stopServer(server.id); // poweroff: the slot is released
console.log("stopped, cost now:", await scaleway.getServerCost(server.id)); // null: only volumes and IPs bill
await scaleway.startServer(server.id); // needs stock again
await scaleway.deleteServerAndWait(server.id); // also deletes the volumes it made
```

Two things worth knowing, both seen on the live API: Scaleway applies **every SSH key of a Project at every boot** (so `sshKeyIds` must be the Project's keys, and deleting one locks it out at the next boot, `capabilities.sshKeys.appliedAtBoot`), and a GPU **quota starts at 0** until the account's identity is verified (`QuotaError`).

## Volumes: Block Storage and File Storage

A block volume is a disk one server holds. Scaleway attaches it but does not mount it: the server formats (when new) and mounts it (`mount: 'device'`). It outlives the server, and it can go onto a server that is already running:

```ts run title="A block volume, attached to a running server"
import { Scaleway } from "asap-vps";

const scaleway = new Scaleway({ apiKey: process.env.SCW_SECRET_KEY!, projectId: process.env.SCW_DEFAULT_PROJECT_ID! });
const [offer] = await scaleway.listOffers({ kind: "cpu" });
const zone = offer.regions[0];

const server = await scaleway.waitUntilRunning((await scaleway.createServer({ name: "db-1", offer, region: zone })).id);
const disk = await scaleway.createVolume({ name: "pgdata", region: zone, sizeGb: 50 }); // 5000 IOPS Block Storage
console.log(disk.id, disk.status); // zone/uuid, available

await scaleway.attachVolume(disk.id, server.id); // the volumeAttach capability
console.log((await scaleway.getVolume(disk.id))?.status, (await scaleway.getVolume(disk.id))?.serverIds);

await scaleway.detachVolume(disk.id, server.id);
await scaleway.deleteServerAndWait(server.id);
await scaleway.deleteVolume(disk.id);
```

`shared: true` makes a **File Storage** filesystem instead: many Instances mount one at once, with virtiofs, at a path you choose. File Storage is in Paris, and only some Instance types can attach one (`max_file_systems`: the POP2, L4, L40S and H100 families, among others):

```ts run title="A shared filesystem two Instances mount at once"
import { Scaleway } from "asap-vps";

const scaleway = new Scaleway({ apiKey: process.env.SCW_SECRET_KEY!, projectId: process.env.SCW_DEFAULT_PROJECT_ID! });
// the cheapest type, GPU or not, that can attach a filesystem and is in stock in Paris
const offer = (await scaleway.listOffers()).find(
  (o) => (o.raw.serverType.capabilities?.max_file_systems ?? 0) > 0 && o.regions.some((z) => z.startsWith("fr-par")),
)!;
const zone = offer.regions.find((z) => z.startsWith("fr-par"))!;

const share = await scaleway.createVolume({ name: "datasets", region: zone, sizeGb: 25, shared: true });
console.log(share.shared, share.region, share.status); // typed as a ScalewayFileSystem

const mounts = [{ volume: share, path: "/mnt/datasets" }];
const a = await scaleway.createServer({ name: "worker-a", offer, region: zone, mounts });
const b = await scaleway.createServer({ name: "worker-b", offer, region: zone, mounts });
await Promise.all([a, b].map((s) => scaleway.waitUntilRunning(s.id)));
console.log("attachments:", ((await scaleway.getVolume(share.id))?.raw as { number_of_attachments?: number }).number_of_attachments);

await Promise.all([a, b].map((s) => scaleway.deleteServerAndWait(s.id)));
await scaleway.deleteVolume(share.id);
```

## Images: zone-bound, copied through Object Storage

Scaleway has no copy of its own. `copyImage` exports the root snapshot as a QCOW2 to a bucket, moves it (in parts, several at a time, so this machine holds only the parts in flight), imports it in each zone asked for and images it there. A copy is an image of its zone with the same name; `createServer` boots it when given the source's id and the copy's zone, and `deleteImage` deletes the copies with the source. It needs the API key's access key:

```ts run title="Capture an image, copy it to another zone, boot it there"
import { Scaleway } from "asap-vps";

const scaleway = new Scaleway({
  apiKey: process.env.SCW_SECRET_KEY!, projectId: process.env.SCW_DEFAULT_PROJECT_ID!, accessKey: process.env.SCW_ACCESS_KEY,
});
const [offer] = await scaleway.listOffers({ kind: "cpu" });
const from = offer.regions[0];
const to = offer.regions.find((z) => z !== from) ?? "fr-par-2";

const source = await scaleway.waitUntilRunning((await scaleway.createServer({ name: "golden", offer, region: from })).id);
await scaleway.stopServer(source.id);
const image = await scaleway.createImage(source.id, { name: "golden-v1" });
console.log(image.name, "in", image.regions);

const copied = await scaleway.copyImage(image.id, [to]); // imageCopy
console.log("now in", copied.regions);

const next = await scaleway.createServer({ name: "from-image", offer, region: to, image: image.id });
console.log((await scaleway.waitUntilRunning(next.id)).region); // the copy in `to` was booted

await scaleway.deleteServerAndWait(next.id);
await scaleway.deleteServerAndWait(source.id);
await scaleway.deleteImage(image.id); // the copies go with it
```

An image built elsewhere comes in with `importImage`: a QCOW2 (unencrypted, no backing file, at most 1 TB) goes into a bucket made for it, is imported as a Block snapshot and imaged. It boots with UEFI and needs cloud-init. Where the file's server serves ranges, they stream straight into the bucket; this needs Node (it reads the network and a bucket), so the block is type-checked here, not run:

```ts
import { Scaleway } from "asap-vps";

const scaleway = new Scaleway({
  apiKey: process.env.SCW_SECRET_KEY!, projectId: process.env.SCW_DEFAULT_PROJECT_ID!, accessKey: process.env.SCW_ACCESS_KEY,
});
const noble = await scaleway.importImage({
  name: "noble-min",
  region: "fr-par-2",
  url: "https://cloud-images.ubuntu.com/minimal/releases/noble/release/ubuntu-24.04-minimal-cloudimg-amd64.img",
});
// An Ubuntu cloud image lets no key log in as root: boot it with
// userData: "#cloud-config\ndisable_root: false"
console.log(noble.id, noble.regions);
```

## Serverless containers

Scaleway Serverless Containers run one image on demand behind an HTTPS URL, from zero instances, on **CPU** only. Each endpoint gets a namespace made for it and deleted with it, and is private: the account's key goes as `X-Auth-Token`, to Scaleway's hosts only.

```ts run title="An endpoint from zero, called with the account's key"
import { Scaleway } from "asap-vps";

const scaleway = new Scaleway({ apiKey: process.env.SCW_SECRET_KEY!, projectId: process.env.SCW_DEFAULT_PROJECT_ID! });

const [offer] = await scaleway.listEndpointOffers({ kind: "cpu" }); // sizes, priced per hour while an instance runs
const endpoint = await scaleway.createEndpoint({
  name: "whoami", container: { image: "traefik/whoami" }, port: 80, offer, minWorkers: 0, maxWorkers: 2,
});
console.log(endpoint.url, endpoint.status, "private:", endpoint.private);

const response = await scaleway.requestEndpoint(endpoint, "/api"); // a cold start is waited out
console.log(response.status, await response.json());

await scaleway.deleteEndpoint(endpoint.id); // the namespace goes with it
```

See [Serverless endpoints](#/serverless) for RunPod's, the same calls on a GPU.

## Class hierarchy

`Scaleway` is a `ComputeProvider`, which is a `BaseProvider`. Below is what each gives it, generated from the source when the site is built: the chain of classes, the capability interfaces it implements, and which of their methods are written once for every provider and which this class writes itself.

```heritage
scaleway
```
