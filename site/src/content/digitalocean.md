# DigitalOcean

`DigitalOcean` rents **droplets**, with or without GPUs. It has the widest set of capabilities of the five: stop and start, restart, SSH keys, images with copy across regions and import from a URL, block volumes and shared NFS file storage, and attaching a volume to a running droplet.

```ts run title="A droplet with cloud-init, from rent to delete"
import { DigitalOcean } from "asap-vps";

const digitalOcean = new DigitalOcean(process.env.DIGITAL_OCEAN_API_KEY!);

// An SSH key of the account, registered once: the same key again returns this registration.
const key = await digitalOcean.addSSHKey("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKd0 laptop", "laptop");

const [offer] = await digitalOcean.listOffers({ kind: "cpu", maxPricePerHour: 0.2 });
const server = await digitalOcean.createServer({
  name: "web-1",
  offer, // brings its own regions: nothing to repeat
  region: offer.regions[0],
  sshKeyIds: [key.id],
  userData: "#cloud-config\npackages: [nginx]\n", // cloud-init, run at the first boot
  tags: ["web"],
});

const running = await digitalOcean.waitUntilRunning(server.id);
console.log(`${running.name} is ${running.status} at ${running.ip}, in ${running.region}`);
console.log("ssh:", running.ssh); // where its sshd is, and as whom to log in

await digitalOcean.deleteServerAndWait(server.id);
await digitalOcean.deleteSSHKey(key.id);
```

`createServer` takes an `offer` from `listOffers`, or just an offer's id. Every record carries what DigitalOcean itself returned as `raw`, typed: `running.raw` is a `DigitalOceanDropletData`.

## A stopped droplet still bills

DigitalOcean keeps the droplet's CPU and memory reserved while it is off, so it bills as if it ran. The capability says so, and `getServerCost` follows it:

```ts run title="Stop, start, and what it costs"
import { DigitalOcean } from "asap-vps";

const digitalOcean = new DigitalOcean(process.env.DIGITAL_OCEAN_API_KEY!);
const [offer] = await digitalOcean.listOffers({ kind: "cpu" });
const server = await digitalOcean.createServer({ name: "batch-1", offer, region: offer.regions[0] });
await digitalOcean.waitUntilRunning(server.id);

console.log(DigitalOcean.capabilities.power); // { stoppedBilling: 'full' }

await digitalOcean.stopServer(server.id);
console.log((await digitalOcean.getServer(server.id))?.status);
console.log("cost while stopped:", await digitalOcean.getServerCost(server.id)); // the run goes on

await digitalOcean.startServer(server.id);
await digitalOcean.restartServer(server.id);
await digitalOcean.deleteServerAndWait(server.id);
```

## Images: capture once, boot many

Capture a server's disk as an image, copy it to another region (a snapshot is region-bound), and boot a new server from it:

```ts run title="Snapshot, copy to another region, boot from it"
import { DigitalOcean } from "asap-vps";

const digitalOcean = new DigitalOcean(process.env.DIGITAL_OCEAN_API_KEY!);
const [offer] = await digitalOcean.listOffers({ kind: "cpu" });
const source = await digitalOcean.createServer({ name: "golden", offer, region: offer.regions[0] });
await digitalOcean.waitUntilRunning(source.id);

await digitalOcean.stopServer(source.id); // for a consistent disk
const image = await digitalOcean.createImage(source.id, { name: "my-gpu-ready" }); // waits until available
console.log(image.name, image.status, "in", image.regions);

const other = offer.regions.find((r) => !image.regions.includes(r))!;
const copied = await digitalOcean.copyImage(image.id, [other]); // imageCopy
console.log("now in", copied.regions);

const next = await digitalOcean.createServer({ name: "from-image", offer, region: other, image: image.id });
console.log((await digitalOcean.waitUntilRunning(next.id)).status);

await digitalOcean.deleteServerAndWait(next.id);
await digitalOcean.deleteServerAndWait(source.id);
await digitalOcean.deleteImage(image.id); // idempotent
```

An image built elsewhere (Packer, a distribution's cloud image) comes in with `importImage`. DigitalOcean fetches the file itself: raw, qcow2, vhdx, vdi or vmdk, gzip or bzip2 too, under 100 GB, from a host that answers HEAD. The image needs cloud-init and BIOS boot.

```ts run title="Import Ubuntu's cloud image from its URL"
import { DigitalOcean } from "asap-vps";

const digitalOcean = new DigitalOcean(process.env.DIGITAL_OCEAN_API_KEY!);
const [offer] = await digitalOcean.listOffers({ kind: "cpu" });
const noble = await digitalOcean.importImage({
  name: "noble-min",
  region: offer.regions[0], // the region droplets from it will run in
  url: "https://cloud-images.ubuntu.com/minimal/releases/noble/release/ubuntu-24.04-minimal-cloudimg-amd64.img",
  providerOptions: { distribution: "Ubuntu" }, // typed: DigitalOcean's own distribution names
});
console.log(noble.name, noble.status, noble.regions, noble.raw.type);
await digitalOcean.deleteImage(noble.id);
```

## Volumes: block, and shared over NFS

DigitalOcean makes both kinds. `createVolume` makes a block volume (one droplet at a time, formatted ext4, mounted by DigitalOcean at `/mnt/<name>`); `shared: true` makes an NFS share many droplets of its VPC mount at once, at a path of your choosing. The return type follows the option:

```ts run title="A block volume, outliving the droplet that mounts it"
import { DigitalOcean } from "asap-vps";

const digitalOcean = new DigitalOcean(process.env.DIGITAL_OCEAN_API_KEY!);
const [offer] = await digitalOcean.listOffers({ kind: "cpu" });
const region = offer.regions[0];

const disk = await digitalOcean.createVolume({ name: "models", region, sizeGb: 100 });
console.log(disk.name, disk.sizeGb, "GB, mounted at", disk.mountPath, "| shared:", disk.shared);

const server = await digitalOcean.createServer({ name: "trainer", offer, region, mounts: [{ volume: disk }] });
await digitalOcean.waitUntilRunning(server.id);
console.log((await digitalOcean.getVolume(disk.id))?.status); // attached

await digitalOcean.deleteServerAndWait(server.id); // the volume outlives it
console.log((await digitalOcean.getVolume(disk.id))?.status); // available
await digitalOcean.deleteVolume(disk.id);
```

A volume on a running droplet is `attachVolume` / `detachVolume` (the `volumeAttach` capability).

An NFS share exists in `nyc2`, `ams3`, `atl1`, `ric1`, `mkc1` and `mem1`, so a droplet that mounts one is rented there. The library mounts it over NFS (cloud-init, fstab) at the path you give:

```ts run title="An NFS share two droplets can mount"
import { DigitalOcean } from "asap-vps";

const digitalOcean = new DigitalOcean(process.env.DIGITAL_OCEAN_API_KEY!);
const region = "nyc2";
const offer = (await digitalOcean.listOffers({ kind: "gpu" })).find((o) => o.regions.includes(region))!;

const share = await digitalOcean.createVolume({ name: "weights", region, sizeGb: 50, shared: true });
console.log(share.shared, share.sizeGb, "GB, status", share.status); // typed as an NFS share: share.raw.host, share.raw.mount_path

const mounts = [{ volume: share, path: "/models" }];
const a = await digitalOcean.createServer({ name: "worker-a", offer, region, mounts });
const b = await digitalOcean.createServer({ name: "worker-b", offer, region, mounts });
await Promise.all([a, b].map((s) => digitalOcean.waitUntilRunning(s.id)));
console.log(a.mounts, b.mounts); // [{ volumeId, path: '/models' }]

await Promise.all([a, b].map((s) => digitalOcean.deleteServerAndWait(s.id)));
await digitalOcean.deleteVolume(share.id);
```

## Containers

A droplet is a VM, so `container` runs your image with Docker from cloud-init at the first boot, GPUs passed through where there are any. [Containers on any provider](#/containers) shows the same option on all five.

## Class hierarchy

`DigitalOcean` is a `ComputeProvider`, which is a `BaseProvider`. Below is what each gives it, generated from the source when the site is built: the chain of classes, the capability interfaces it implements, and which of their methods are written once for every provider and which this class writes itself.

```heritage
digitalocean
```
