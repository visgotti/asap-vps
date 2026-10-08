# Types and completion

What a provider can do is a set of **capabilities**, each an interface (`ICompute`, `IPower`, `IImages`, `IVolumes`, ...). A class implements exactly the capabilities its platform has, so you can read what it can do from its type, and the editor offers only that. Every block on this page is a live editor: that is the point.

## Try it

Click into the editor, put the cursor on a new line after `digitalOcean.` and press `Ctrl+Space`. Then do the same after `lambda.` and compare the two lists. Hover over any name for its documentation; press `Ctrl+Shift+Space` inside a call for its parameters.

```ts
import { DigitalOcean, LambdaCloud, RunPod, VastAI } from "asap-vps";

declare const key: string;
const digitalOcean = new DigitalOcean(key);
const lambda = new LambdaCloud(key);
const runpod = new RunPod(key);
const vast = new VastAI(key);

// Type `digitalOcean.` here, then `lambda.`, then `runpod.` and compare what each offers:

```

What you will find: `digitalOcean.stopServer` exists, and `lambda.stopServer` does not (Lambda cannot stop an instance); `runpod.getServerLogs` and `vast.getServerLogs` exist, because containers have logs and VMs do not; `digitalOcean.copyImage` exists and `vast.copyImage` does not.

## The compiler says it before you run it

```ts error title="Lambda has no stop"
import { LambdaCloud } from "asap-vps";

const lambda = new LambdaCloud(process.env.LAMBDA_API_KEY!);
await lambda.stopServer("instance-id");
```

Options are typed the same way. Each provider's `createServer` options leave out what its platform cannot honor, so the editor offers only what it takes. `providerOptions` are the fields of the platform's own create request, typed by it (`DigitalOceanCreateDropletParams` on DigitalOcean) and open to fields its type does not list yet:

```ts error title="providerOptions are the platform's own fields, typed"
import { DigitalOcean } from "asap-vps";

const digitalOcean = new DigitalOcean(process.env.DIGITAL_OCEAN_API_KEY!);
const [offer] = await digitalOcean.listOffers({ kind: "cpu" });
await digitalOcean.createServer({
  name: "web-1", offer, region: offer.regions[0],
  providerOptions: { backups: "yes" }, // DigitalOcean's `backups` is a boolean
});
```

`createVolume` asks for a size only where the platform sizes volumes (a RunPod volume is 10 to 4096 GB, a Lambda filesystem grows as it fills), and a platform that makes one kind of volume takes no `shared`:

```ts error title="RunPod makes one kind of volume"
import { RunPod } from "asap-vps";

const runpod = new RunPod(process.env.RUNPOD_API_KEY!);
await runpod.createVolume({ name: "models", region: "US-TX-3", sizeGb: 50, shared: false });
```

Records are typed per platform too. `raw` is what the platform itself returned, with no cast:

```ts run title="raw is the platform's own record"
import { DigitalOcean } from "asap-vps";

const digitalOcean = new DigitalOcean(process.env.DIGITAL_OCEAN_API_KEY!);
const [offer] = await digitalOcean.listOffers({ kind: "cpu" });
const created = await digitalOcean.createServer({ name: "web-1", offer, region: offer.regions[0] });
const server = await digitalOcean.waitUntilRunning(created.id);

// server.raw is a DigitalOceanDropletData: hover it, and complete `server.raw.`
console.log(server.raw.size_slug, server.raw.region?.slug, server.raw.status);
await digitalOcean.deleteServerAndWait(server.id);
```

## Code that takes any provider asks first

A union of providers (`AnyProvider`) offers only what all of them have. To use more, ask: `supports` narrows the type to the providers that have the capability, and `requireCapability` returns the capability or throws a `NotSupportedError` naming what is missing.

```ts run title="supports narrows the type"
import { providersFromEnv, supports } from "asap-vps";

for (const provider of providersFromEnv(process.env)) {
  if (supports(provider, "power")) {
    // inside here `provider` has IPower: stopServer exists, and the capability says what a stop bills
    console.log(provider.id.padEnd(12), "can stop; stopped, it bills", provider.capabilities.power.stoppedBilling);
  } else {
    console.log(provider.id.padEnd(12), "cannot stop");
  }
}
```

```ts error title="Without asking, a provider may not have it"
import { providersFromEnv } from "asap-vps";

for (const provider of providersFromEnv(process.env)) {
  await provider.stopServer("id");
}
```

```ts run title="requireCapability throws with a reason"
import { createProvider, NotSupportedError, requireCapability } from "asap-vps";

const lambda = createProvider("lambda", process.env.LAMBDA_API_KEY!); // typed: a LambdaCloud, not a union
try {
  await requireCapability(lambda, "images").listImages();
} catch (e) {
  console.log(e instanceof NotSupportedError, "-", (e as Error).message);
}
```

`createProvider("lambda", key)` is typed by its id: it is a `LambdaCloud`, with no `stopServer`. `providersWith("images", "imageCopy")` answers from the capability descriptors, without building anything:

```ts run title="Which providers have what, from the descriptors"
import { providersWith } from "asap-vps";

console.log("can copy images:", providersWith("images", "imageCopy"));
console.log("have volumes and images:", providersWith("volumes", "images"));
console.log("run serverless endpoints:", providersWith("serverless"));
```

The [capability table](#/overview) on the overview page is generated from the same descriptors, every time the site is built.
