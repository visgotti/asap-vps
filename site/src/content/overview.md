# asap-vps

Servers on any cloud, through one set of typed primitives: rent a VPS or a GPU server, log in over SSH, set it up, capture it as an image, delete it, the same way on every provider. Each provider is one class, and its type says exactly what it can do.

Every code block on this site is a real editor with the library's real types. Click into one and press `Ctrl+Space`: the completions, hover documentation and errors are the ones your editor gives you. The blocks marked **Simulated** have a **Run** button: they execute the library's actual code in your browser against in-memory fakes of each provider's API (nothing is rented, nothing leaves the page), on a clock that runs ahead so a ten-minute boot takes a moment. [How the sandbox works](#/sandbox) says exactly what is real and what is not.

```ts run title="Rent a droplet, look at the bill, delete it"
import { DigitalOcean } from "asap-vps";

const digitalOcean = new DigitalOcean(process.env.DIGITAL_OCEAN_API_KEY!);

// what can be rented right now, cheapest first
const [offer] = await digitalOcean.listOffers({ kind: "cpu" });
console.log(`${offer.id}: $${offer.pricePerHour}/h, in ${offer.regions.join(", ")}`);

const server = await digitalOcean.createServer({ name: "web-1", offer, region: offer.regions[0] });
const running = await digitalOcean.waitUntilRunning(server.id);
console.log(running.status, running.ip);

console.log(await digitalOcean.getServerCost(server.id)); // counted the way DigitalOcean counts
await digitalOcean.deleteServerAndWait(server.id); // deletes, then checks until it is gone
```

Try changing `kind: "cpu"` to `kind: "gpu"`, or put the cursor after `digitalOcean.` and look at what the type offers.

## Five providers, one interface

```capabilities
```

What a provider can do is a set of capabilities, each an interface. A class implements exactly the capabilities its platform has, so its type tells you what it can do: [Lambda](#/lambda) has no stop, so `LambdaCloud` has no `stopServer` to call. [Types and completion](#/types) shows that, and the options that are typed per platform too.

The table above is generated from the code every time the site is built.

## Where to go next

- [Quick start](#/quick-start): install, set the keys, and rent your first server.
- The providers: [DigitalOcean](#/digitalocean), [Scaleway](#/scaleway), [Lambda](#/lambda), [RunPod](#/runpod) and [Vast.ai](#/vast).
- The guides: [types and completion](#/types), [containers](#/containers), [images](#/images), [volumes](#/volumes), [serverless](#/serverless), [costs](#/costs) and [errors](#/errors).
- The [playground](#/playground): a blank file with every provider's fake behind it.
