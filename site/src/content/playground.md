# Playground

A blank file with the library's real types behind it, and the sandbox's fakes of all five providers behind `fetch`. Write anything, press **Run** (or `Ctrl+Enter`), and open the **Requests** tab to see the exact HTTP calls the library made. Press `Ctrl+Space` for completions.

`process.env` holds a key every fake accepts: `DIGITAL_OCEAN_API_KEY`, `RUNPOD_API_KEY`, `VAST_API_KEY`, `LAMBDA_API_KEY`, and for Scaleway `SCW_SECRET_KEY`, `SCW_DEFAULT_PROJECT_ID` and `SCW_ACCESS_KEY`. Nothing here rents anything, and nothing leaves the page.

```ts run title="Your code"
import { providersFromEnv } from "asap-vps";

// Start here. Ideas:
//   - rent something and look at `server.raw` (the platform's own record, typed)
//   - make a volume, mount it, delete the server, and see that the volume is still there
//   - ask a provider for something it cannot do, and read the error
//   - delete a line and watch the Requests tab: the library's calls change with it

for (const provider of providersFromEnv(process.env)) {
  const [offer] = await provider.listOffers();
  console.log(provider.id.padEnd(13), offer ? `${offer.id} at $${offer.pricePerHour.toFixed(3)}/h` : "no offers");
}
```

```ts run title="Every provider, constructed"
import { DigitalOcean, LambdaCloud, RunPod, Scaleway, VastAI } from "asap-vps";

const digitalOcean = new DigitalOcean(process.env.DIGITAL_OCEAN_API_KEY!);
const lambda = new LambdaCloud(process.env.LAMBDA_API_KEY!);
const runpod = new RunPod(process.env.RUNPOD_API_KEY!);
const vast = new VastAI(process.env.VAST_API_KEY!);
const scaleway = new Scaleway({
  apiKey: process.env.SCW_SECRET_KEY!,
  projectId: process.env.SCW_DEFAULT_PROJECT_ID!,
  accessKey: process.env.SCW_ACCESS_KEY,
});

// Type `digitalOcean.`, `lambda.`, `runpod.`, `vast.` or `scaleway.` below and see what each offers.
console.log(Object.keys(DigitalOcean.capabilities));
```
