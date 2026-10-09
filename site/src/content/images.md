# Images

A server set up once can be captured as an image, so the next one boots with everything already installed. Three of the five can capture one, and each does it the way its platform allows:

| Provider | An image is | Boots | Copy to other regions | Import a disk file |
|---|---|---|---|---|
| [DigitalOcean](#/digitalocean) | a snapshot | in its region (and the regions it was copied to) | `copyImage` | from a URL: raw, qcow2, vhdx, vdi, vmdk; up to 100 GB |
| [Scaleway](#/scaleway) | a snapshot, in a zone | in its zone (and the zones it was copied to) | `copyImage`, through Object Storage | a QCOW2, up to 1 TB, through Object Storage |
| [Vast.ai](#/vast) | a snapshot pushed to **a registry of yours** | on any machine | not needed: a registry image pulls anywhere | not needed |
| [Lambda](#/lambda) | none: Lambda has no snapshot or image API | | | |
| [RunPod](#/runpod) | none: a pod is not committed; build the image in CI and push it | | | |

`capabilities.images.scope` says where an image boots: `'region'` (DigitalOcean, Scaleway) or `'global'` (Vast). `listImages()` returns every image of the account, not just yours: pick yours by name before booting or deleting one.

## Capture, copy, boot

The same three calls on DigitalOcean and on Scaleway; only the names of places differ:

```ts run title="DigitalOcean and Scaleway, side by side"
import { DigitalOcean, Scaleway } from "asap-vps";

const digitalOcean = new DigitalOcean(process.env.DIGITAL_OCEAN_API_KEY!);
const scaleway = new Scaleway({
  apiKey: process.env.SCW_SECRET_KEY!, projectId: process.env.SCW_DEFAULT_PROJECT_ID!, accessKey: process.env.SCW_ACCESS_KEY,
});

const [doOffer] = await digitalOcean.listOffers({ kind: "cpu" });
const [scwOffer] = await scaleway.listOffers({ kind: "cpu" });

const droplet = await digitalOcean.waitUntilRunning((await digitalOcean.createServer({ name: "golden", offer: doOffer, region: doOffer.regions[0] })).id);
const instance = await scaleway.waitUntilRunning((await scaleway.createServer({ name: "golden", offer: scwOffer, region: scwOffer.regions[0] })).id);

await digitalOcean.stopServer(droplet.id); // stop first: a consistent disk
await scaleway.stopServer(instance.id);

const a = await digitalOcean.createImage(droplet.id, { name: "golden-v1" });
const b = await scaleway.createImage(instance.id, { name: "golden-v1" });
console.log("digitalocean:", a.regions, "| scaleway:", b.regions); // regions it boots in (zones, on Scaleway)

const a2 = await digitalOcean.copyImage(a.id, [doOffer.regions.find((r) => r !== doOffer.regions[0])!]);
const b2 = await scaleway.copyImage(b.id, [scwOffer.regions.find((z) => z !== scwOffer.regions[0]) ?? "fr-par-2"]);
console.log("copied:", a2.regions, b2.regions);

for (const [p, s, i] of [[digitalOcean, droplet, a], [scaleway, instance, b]] as const) {
  await p.deleteServerAndWait(s.id);
  await p.deleteImage(i.id); // Scaleway also deletes the snapshots, and the copies
}
```

## Importing an image

An image built elsewhere (Packer, a distribution's cloud image) comes in with `importImage` on DigitalOcean and Scaleway, and is then one of the account's images like any other. The two handle the file differently: DigitalOcean fetches it itself, from a URL; Scaleway has it put in a bucket made for the occasion (streamed in parts when the file's server serves ranges, so this machine holds only the parts in flight), imported as a snapshot and imaged. Both are shown on their pages: [DigitalOcean](#/digitalocean), [Scaleway](#/scaleway).

## Vast: a registry is the image store

Vast pushes a snapshot to a registry you give it, and the registry's tags are the account's images. Because a registry image pulls on any machine, it boots anywhere. See [Vast.ai](#/vast) for the run, and `deleteImage` for how each registry deletes (Docker Hub and ghcr.io offer no delete through their APIs, and the error says where to delete).
