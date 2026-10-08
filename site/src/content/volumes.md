# Volumes

Storage of your own that outlives the servers that mount it: where model weights and data stay between servers, instead of being baked into every image. A server mounts volumes when it is created and `deleteServer` leaves them. A volume bills until `deleteVolume`, mounted or not.

A volume is in **one place** (a zone, a data center, a machine): a server elsewhere cannot mount it, and is refused before anything is rented. And it is one of two kinds, its `shared` says which: a **block device** one server holds at a time, or a **filesystem** many servers mount at once.

| Provider | A volume is | Kind | Mounted at | Size |
|---|---|---|---|---|
| [DigitalOcean](#/digitalocean) | a Block Storage volume, ext4 | block: one droplet | DigitalOcean's own place, `/mnt/<name>` | fixed, 1 to 16384 GiB |
| [DigitalOcean](#/digitalocean) | a Network File Storage share | shared: droplets of its VPC | a path of yours, over NFS | fixed, 50 to 32768 GB |
| [Scaleway](#/scaleway) | a Block Storage volume | block: one server | a disk the server formats and mounts itself | fixed, from 1 GB |
| [Scaleway](#/scaleway) | a File Storage filesystem (Paris) | shared: Instances of a type that attaches one | a path of yours, with virtiofs | fixed, 25 to 50000 GB |
| [Lambda](#/lambda) | a filesystem | shared: instances of its region | a path of yours under `/home`, `/lambda/nfs` or `/data` | elastic: it grows as it fills |
| [RunPod](#/runpod) | a network volume | shared: pods of its data center | a path of yours (default `/workspace`) | fixed, 10 to 4096 GB |
| [Vast.ai](#/vast) | storage on one machine | block: one instance at a time | a path of yours (default `/data`) | fixed, from 1 GB |

Every provider says this in its `capabilities.volumes`, which is also what decides what `createVolume` asks for. Where a platform makes both kinds, `createVolume({ ..., shared: true })` picks the filesystem, and the return type follows:

```ts run title="What each provider says about its volumes"
import { PROVIDERS } from "asap-vps";

for (const [id, provider] of Object.entries(PROVIDERS)) {
  const volumes = provider.capabilities.volumes;
  if (!volumes) { console.log(id.padEnd(13), "no volumes"); continue; }
  for (const kind of ["block", "shared"] as const) {
    const t = volumes[kind];
    if (t) console.log(id.padEnd(13), kind.padEnd(7), `mount: ${t.mount}`.padEnd(14), `size: ${t.size}${t.minGb !== undefined ? `, from ${t.minGb} GB` : ""}${t.maxGb !== undefined ? ` to ${t.maxGb} GB` : ""}`);
  }
}
```

`mount` is how a server sees the volume: `'path'` (mounted at the mount's `path`), `'auto'` (the platform mounts it at its own path, the volume's `mountPath`) or `'device'` (a disk the server formats and mounts itself).

## Attaching to a running server

DigitalOcean and Scaleway also attach and detach volumes on a server that is already running (the `volumeAttach` capability: `attachVolume` and `detachVolume`). The others fix a server's volumes when it is created.

## One at a time

A block volume is held by one server at a time. A second server that asks for it is refused before it is rented, and on some providers (DigitalOcean, Vast) a deleted server releases its volumes a little later, which `deleteServerAndWait` waits for.

Walk through the volume of each provider: [DigitalOcean](#/digitalocean), [Scaleway](#/scaleway), [Lambda](#/lambda), [RunPod](#/runpod) and [Vast.ai](#/vast).
