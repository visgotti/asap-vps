# Errors and retries

Failures are typed, all extending `ProviderError`, so code can tell "try another offer" from "your key is wrong" without reading messages:

| Error | Means | Usually |
|---|---|---|
| `CapacityError` | this offer or region has no stock right now | try another offer |
| `QuotaError` | an account limit or balance | raise it, or pay |
| `AuthError` | the key is wrong or may not do this | fix the key |
| `NotFoundError` | there is no such thing | check the id |
| `NotSupportedError` | the platform cannot do this | pick another provider |
| `TransportError` | no answer at all, or one cut off | retry (a read) or find the server by name (a create) |

## "Next offer" on a CapacityError

Marketplaces and GPU clouds sell out in seconds. The idiom is a loop over offers that moves on when one is gone:

```ts run title="Rent the first offer that is still there"
import { CapacityError, VastAI } from "asap-vps";

const vast = new VastAI(process.env.VAST_API_KEY!);
// the listing says which machines are rented out right now, when asked
const offers = await vast.listOffers({ kind: "gpu", includeUnavailable: true });
const soldOut = offers.find((o) => o.regions.length === 0)!; // no stock anywhere
const candidates = [soldOut, ...offers.filter((o) => o.regions.length > 0)];

for (const offer of candidates) {
  try {
    const server = await vast.createServer({ name: "w", offer, image: "ubuntu:24.04", command: ["sleep", "infinity"] });
    console.log("rented", offer.id, "->", (await vast.waitUntilRunning(server.id)).status);
    await vast.deleteServerAndWait(server.id);
    break;
  } catch (e) {
    if (!(e instanceof CapacityError)) throw e; // only "no stock" moves on
    console.log("no stock for", offer.id, "-", e.message);
  }
}
```

An offer object that has stock nowhere, given with no region, is a `CapacityError` on every provider, so this loop works unchanged on all five.

## A wrong key, and a missing capability

```ts run title="AuthError and NotSupportedError"
import { AuthError, DigitalOcean, NotSupportedError, createProvider, requireCapability } from "asap-vps";

try {
  await new DigitalOcean("not-a-real-key").listServers();
} catch (e) {
  console.log(e instanceof AuthError, "-", (e as Error).message);
}

try {
  requireCapability(createProvider("runpod", process.env.RUNPOD_API_KEY!), "images");
} catch (e) {
  console.log(e instanceof NotSupportedError, "-", (e as Error).message);
}
```

A create option a provider cannot honor is refused with `NotSupportedError` before anything is rented, never silently dropped.

## Retries

`isRetriable(e)` says whether a failure is safe to try again as it is: a read, or an idempotent request, that got no answer or a temporary error, or a refusal such as a rate limit. A **create is never retried** after a server error or a lost answer, because it may already have made a billed machine: find it by its name instead.

## What is left behind

A create that fails once it has made something deletes what it made. Where that delete fails too, the error has the code `left_behind` and names what is left: it bills until you delete it, and nothing else would find it. On Scaleway, deleting a server or an image reports what it left behind the same way: the volumes of a server, the snapshots of an image.
