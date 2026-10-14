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

## Shared values are the library's own

A value that means the same thing on every provider is declared once, in the library, and every provider takes that same type: a query's `kind` (`COMPUTE_KINDS`: `"gpu"`, `"cpu"`, `"any"`), its `vendor`, the GPU models in `gpus`, its `countries`, an image's `os` and `cuda`. Below, delete `cpu` or `L4` (keep the quotes) and press `Ctrl+Space`: the list is the same after `digitalOcean.` as after `runpod.`. A name of the platform's own (an image slug, a region, a GPU model the library has no name for) is still taken where one makes sense.

```ts
import { DigitalOcean, RunPod } from "asap-vps";

declare const key: string;
const digitalOcean = new DigitalOcean(key);
const runpod = new RunPod(key);

await digitalOcean.listOffers({ kind: "cpu" });
await runpod.listOffers({ kind: "gpu", gpus: ["L4"] });
```

```ts error title="A kind is one of the library's three, on every provider"
import { DigitalOcean } from "asap-vps";

const digitalOcean = new DigitalOcean(process.env.DIGITAL_OCEAN_API_KEY!);
await digitalOcean.listOffers({ kind: "vps" });
```

A value the compiler never saw (a flag, a config file) is refused at run time, with the same message on every provider, rather than read as some other kind:

```ts run title="...and is refused at run time where the compiler did not see it"
import { COMPUTE_KINDS, providersFromEnv } from "asap-vps";
import type { ComputeKind } from "asap-vps";

const asked = "GPU"; // read from a flag: not one of COMPUTE_KINDS
for (const provider of providersFromEnv(process.env)) {
  try {
    await provider.listOffers({ kind: asked as ComputeKind });
  } catch (e) {
    console.log(provider.id.padEnd(12), (e as Error).message);
  }
}
console.log("the kinds:", COMPUTE_KINDS.join(", "));
```

## A place is what each provider picks

Places are named two ways in the library, the same on every provider. A **country** (`COUNTRY_TYPES`: every code ISO 3166-1 gives a country, each named on its hover) is a question any provider can answer: `listOffers({ countries })` narrows each offer's `regions` to the ones there, and a server rented from such an offer is in that country. A **region** (`REGION_TYPES`: the country, the place in it as finely as the provider's own data says, a city or else a state, and a number, as in `FRANCE_PARIS_2` or `US_TEXAS_3`) is a place only some providers have, so each provider picks. It translates the members it has into its own names (`FRANCE_PARIS_2` is Scaleway's `fr-par-2`, `US_TEXAS_3` RunPod's `US-TX-3`), and its `region` options take those members and its own names for its places, and nothing else.

Delete `france_paris_2` below (keep the quotes) and press `Ctrl+Space`, then do the same with `canada_toronto`, `us_texas_3` and `japan_osaka`. Each provider is offered its own: Scaleway its 4 regions and 10 zones, DigitalOcean its 16 open datacenters and their cities, RunPod its 34 data centers (by US state, by Montreal, else by country), Lambda its 18 regions. Vast is offered none: each offer is one machine, where its host is, and a region there is the offer's own.

```ts
import { DigitalOcean, LambdaCloud, REGION_TYPES, RunPod, Scaleway } from "asap-vps";

declare const key: string;
const scaleway = new Scaleway(key);
const digitalOcean = new DigitalOcean(key);
const runpod = new RunPod(key);
const lambda = new LambdaCloud(key);

// The same zone three ways on Scaleway: REGION_TYPES.FRANCE_PARIS_2, its value, or Scaleway's own "fr-par-2"
await scaleway.createVolume({ name: "models", sizeGb: 50, region: REGION_TYPES.FRANCE_PARIS_2 });
await scaleway.createVolume({ name: "models", sizeGb: 50, region: "france_paris_2" });
await digitalOcean.createVolume({ name: "models", sizeGb: 50, region: "canada_toronto" });
await runpod.createVolume({ name: "models", sizeGb: 50, region: "us_texas_3" });
await lambda.createVolume({ name: "models", region: "japan_osaka" });

// A place an offer lists goes back in as it is: the provider's own name for it, typed so
const [offer] = await digitalOcean.listOffers({ kind: "cpu" });
await digitalOcean.createServer({ name: "web-1", offer, region: offer.regions[0] });
```

A region the provider does not have is a compile error, and so is a string that names none of its places:

```ts error title="DigitalOcean has no Paris"
import { DigitalOcean, REGION_TYPES } from "asap-vps";

const digitalOcean = new DigitalOcean(process.env.DIGITAL_OCEAN_API_KEY!);
await digitalOcean.createVolume({ name: "models", sizeGb: 50, region: REGION_TYPES.FRANCE_PARIS });
```

On a union of providers (what `providersFromEnv` returns), a region would have to be one that every one of them has, and none is: narrow to the provider first, by its `id`. Code typed for any provider (`ICompute`) takes any region, and a provider refuses at run time one it does not have, before anything is asked of the platform and without sending it as it is:

```ts run title="One region by the library's name, asked of every provider"
import { NotSupportedError, providersFromEnv, REGION_COUNTRIES, REGION_TYPES } from "asap-vps";
import type { ICompute } from "asap-vps";

const region = REGION_TYPES.POLAND_WARSAW_2;
for (const provider of providersFromEnv(process.env)) {
  const any: ICompute = provider; // as code typed for any provider: any region compiles
  const [offer] = await any.listOffers({ kind: "gpu" });
  try {
    const server = await any.createServer({ name: "probe", offer: offer.id, region });
    console.log(provider.id.padEnd(12), "rented in", server.region, "which is in", REGION_COUNTRIES[region]);
    await any.deleteServerAndWait(server.id);
  } catch (e) {
    if (!(e instanceof NotSupportedError)) throw e;
    console.log(provider.id.padEnd(12), "refused:", e.message);
  }
}
```

A provider's types say what it picked: `TypesOf<Scaleway>["region"]` is its regions, `TypesOf<Scaleway>["regionName"]` its own names for its places, and `TypesOf<Scaleway>["country"]` the countries it has places in. A new provider does not compile until it says all three. The test suite holds every region it claims to a country it claims (`REGION_COUNTRIES` says where each region is), and checks that no name of the library's passes for one of its own.

All three are made from one list, the provider's places as its own API lists them (`src/Providers/<Platform>/places.ts`, which says where and when each was read), and so is its translation table. `npm run places:check` reads the same listings again (DigitalOcean's, RunPod's and Lambda's own, Scaleway's SDK's, a new sample of Vast's offers, and ISO's list of countries) and fails on a place opened, closed or renamed since.

A country is one of ISO's codes, and nothing else compiles:

```ts error title="ISO gives no country UK: the United Kingdom's code is GB"
import { COUNTRY_TYPES, RunPod } from "asap-vps";

const runpod = new RunPod(process.env.RUNPOD_API_KEY!);
await runpod.listOffers({ countries: [COUNTRY_TYPES.GB, "UK"] });
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

`createProvider("lambda", key)` is typed by its id: it is a `LambdaCloud`, with no `stopServer`. Its settings are typed by the id too: `createProvider("scaleway", { apiKey, projectId })` takes Scaleway's Project, and Lambda's does not. `providersWith("images", "imageCopy")` answers from the capability descriptors, without building anything:

```ts run title="Which providers have what, from the descriptors"
import { providersWith } from "asap-vps";

console.log("can copy images:", providersWith("images", "imageCopy"));
console.log("have volumes and images:", providersWith("volumes", "images"));
console.log("run serverless endpoints:", providersWith("serverless"));
```

The [capability table](#/overview) on the overview page is generated from the same descriptors, every time the site is built.
