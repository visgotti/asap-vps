# What a server costs

Every offer and server carries its rate, `pricePerHour` (USD for the whole machine), and `billing`: how its provider counts time, in steps of `incrementSeconds` (1 per second, 60 per minute, 3600 per hour), never less than `minimumSeconds`, and never less than `minimumUsd` where the provider has a minimum charge. A server also says when its current run began billing (`billingStartedAt`, read from the provider's own record), so its cost is the time since then, counted the provider's way.

| Provider | Counted | A run bills from | While stopped |
|---|---|---|---|
| DigitalOcean | per second, at least 60 s or $0.01 | its creation, until it is deleted | the run goes on: a stopped droplet bills in full |
| Scaleway | per minute with a GPU (RENDER-S per hour), per hour without | its last change of state (an edit moves it too) | `null`: only volumes and IPs bill |
| RunPod | per second | the pod's last start | `null`: only the volume bills |
| Vast.ai | per second | the rental's start, which a stop and start does not move: after one, the estimate is an upper bound | `null`: only the disk bills |
| Lambda Cloud | per minute | its first passed health check | (no stop) |

## The bill so far

```ts run title="The cost of a run, counted the provider's way"
import { DigitalOcean } from "asap-vps";

const digitalOcean = new DigitalOcean(process.env.DIGITAL_OCEAN_API_KEY!);
const [offer] = await digitalOcean.listOffers({ kind: "cpu" });
console.log("billing:", offer.billing); // { incrementSeconds: 1, minimumSeconds: 60, minimumUsd: 0.01 }

const created = await digitalOcean.createServer({ name: "batch-1", offer, region: offer.regions[0] });
const server = await digitalOcean.waitUntilRunning(created.id);
console.log("billing since", new Date(server.billingStartedAt!).toISOString());

// the run so far: { usd, pricePerHour, from, to, billedSeconds }
console.log(await digitalOcean.getServerCost(server.id));
// or up to a given time, when the server runs for hours
console.log(await digitalOcean.getServerCost(server.id, Date.now() + 3 * 3_600_000));

await digitalOcean.deleteServerAndWait(server.id);
console.log("after delete:", await digitalOcean.getServerCost(server.id)); // null: nothing bills
```

(In the sandbox the clock runs ahead of itself while the library waits, so the run shows more than the real seconds it took.)

## Before renting

`estimateCost` counts any span at any rate the same way, so you can price a job on an offer before renting it. A 90-second job is billed 90 s on DigitalOcean and two minutes on Lambda:

```ts run title="What a 90 second job costs on each provider's cheapest GPU"
import { estimateCost, providersFromEnv } from "asap-vps";

for (const provider of providersFromEnv(process.env)) {
  const [offer] = await provider.listOffers({ kind: "gpu" });
  if (!offer) continue;
  const job = estimateCost(offer.pricePerHour, 0, 90_000, offer.billing); // from 0 to 90 s
  console.log(provider.id.padEnd(13), `$${offer.pricePerHour.toFixed(2)}/h`.padEnd(9), `billed ${job.billedSeconds} s`.padEnd(14), `= $${job.usd.toFixed(4)}`);
}
```

An estimate is the rate applied to the time: disks, bandwidth and addresses bill on top, and the provider's invoice is the truth.
