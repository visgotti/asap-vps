# Containers, on any provider

`container` runs one image the same way everywhere: `{ image, env?, command?, ports?, registryAuth? }`. What differs is how the platform runs it, and the library hides that:

- **RunPod and Vast** run the image as the server itself. `container` is the same as the top-level `image`, `env`, `command`, `ports` and `registryAuth` (one or the other: both are refused).
- **DigitalOcean, Scaleway and Lambda** are VMs. They run it with Docker, from a script cloud-init runs once at the first boot.

```ts run title="One container, five providers"
import { DigitalOcean, LambdaCloud, RunPod, Scaleway, VastAI } from "asap-vps";

const container = {
  image: "ghcr.io/acme/worker:1",
  env: { MODEL: "llama-3-8b" },
  command: ["serve", "--port", "8000"],
  ports: ["8000/tcp"],
  registryAuth: { username: "bot", password: "a-token-that-can-only-pull" }, // never your own password
};

// Containers: the pod or instance is the container.
const runpod = new RunPod(process.env.RUNPOD_API_KEY!);
const pod = await runpod.createServer({ name: "worker", offer: (await runpod.listOffers())[0], container });

const vast = new VastAI(process.env.VAST_API_KEY!);
const instance = await vast.createServer({ name: "worker", offer: (await vast.listOffers())[0], container });

// VMs: Docker runs it from the first boot.
const digitalOcean = new DigitalOcean(process.env.DIGITAL_OCEAN_API_KEY!);
const [doOffer] = await digitalOcean.listOffers({ kind: "cpu" });
const droplet = await digitalOcean.createServer({ name: "worker", offer: doOffer, region: doOffer.regions[0], container });

const scaleway = new Scaleway({ apiKey: process.env.SCW_SECRET_KEY!, projectId: process.env.SCW_DEFAULT_PROJECT_ID! });
const [scwOffer] = await scaleway.listOffers({ kind: "cpu" });
const scwServer = await scaleway.createServer({ name: "worker", offer: scwOffer, region: scwOffer.regions[0], container });

const lambda = new LambdaCloud(process.env.LAMBDA_API_KEY!);
const key = await lambda.addSSHKey("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKd0 laptop", "laptop");
const vm = await lambda.createServer({ name: "worker", offer: (await lambda.listOffers())[0], sshKeyIds: [key.id], container });

for (const [name, p, s] of [["runpod", runpod, pod], ["vast", vast, instance], ["digitalocean", digitalOcean, droplet], ["scaleway", scaleway, scwServer], ["lambda", lambda, vm]] as const) {
  console.log(name.padEnd(13), (await p.waitUntilRunning(s.id)).status);
  await p.deleteServerAndWait(s.id);
}
await lambda.deleteSSHKey(key.id);
```

## What a VM runs

For the three VMs the library writes the script. Docker is installed where the image has none, the image is pulled (logged in with `registryAuth`, the password on stdin, and logged out again), and it runs as the container `asap-vps`, so `docker logs asap-vps` reads it. It restarts with the machine (`--restart unless-stopped`), its ports are published on the host's, and its environment is in a root-only file. On a machine with an NVIDIA GPU its GPUs are passed through (`--gpus all`), and the NVIDIA container toolkit is installed where the image lacks it. See exactly what it is:

```ts run title="The boot script a VM gets"
import { containerBootScript } from "asap-vps";

const script = containerBootScript({
  image: "ghcr.io/acme/worker:1",
  env: { MODEL: "llama-3-8b" },
  command: ["serve", "--port", "8000"],
  ports: ["8000/tcp"],
}, { gpu: true });
console.log(script.split("\n").filter((l) => /docker (run|login|pull)|--gpus|--restart/.test(l)).join("\n"));
```

Your own `userData` still runs first: both go to cloud-init as one multipart document. An env name a shell cannot take, a value with a line break, or a port Docker cannot publish is refused before anything is rented.

> The registry login rides in the server's user data, which the account and the server can read: give a token that can only pull.

Where a platform cannot take part of the spec, the compiler says so: a VM's top-level `env` is a type error, since its container is `container`. See [Types and completion](#/types).
