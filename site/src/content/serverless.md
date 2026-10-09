# Serverless endpoints

An endpoint runs one image on demand behind an HTTPS URL, from zero workers (nothing billed while idle) to a cap. The image serves plain HTTP on its port (given to it as `PORT`): no platform SDK goes in it. Two providers have this, and one interface covers both:

| | RunPod | Scaleway |
|---|---|---|
| What it is | load-balancing endpoints (`https://<id>.api.runpod.ai`) | Serverless Containers, one namespace per endpoint |
| Workers | a GPU type of a serverless pool, or a CPU flavor (2 vCPU or more) | CPU only |
| A private image | `registryAuth`, stored once on the account | the Project's own registry, or a public image |
| Idle | a worker may stay for fifteen minutes | an instance stops after 15 minutes |
| Authentication | the account key, as a bearer token | the account key, as `X-Auth-Token` |

Vast's serverless needs its Python agent in the worker, and DigitalOcean and Lambda have none, so `providersWith("serverless")` is RunPod and Scaleway.

## The same calls on both

```ts run title="An endpoint on every provider that has them"
import { providersFromEnv, supports } from "asap-vps";

for (const provider of providersFromEnv(process.env)) {
  if (!supports(provider, "serverless")) continue; // narrows provider to those with IServerless

  const [offer] = await provider.listEndpointOffers({ kind: "cpu" });
  const endpoint = await provider.createEndpoint({
    // across providers an offer is passed by its id: the offer objects are typed per platform
    name: `whoami-${provider.id}`, container: { image: "traefik/whoami" }, port: 80, offer: offer.id, minWorkers: 0, maxWorkers: 2,
  });
  const response = await provider.requestEndpoint(endpoint, "/api"); // the account's key added, a cold start waited out
  console.log(provider.id.padEnd(9), endpoint.url, "->", response.status, (await response.json()).method);

  await provider.deleteEndpoint(endpoint.id); // its workers stop with it
}
```

`requestEndpoint` sends the account's key only to the platform's own host: RunPod's URL is made from the endpoint's id, and Scaleway's is read from the platform and held to `*.scw.cloud`. A redirect is **not followed**: its answer is returned, since `fetch` would otherwise send the key on to wherever it points. It waits out a cold start (no worker up yet, a fresh host name that does not resolve yet) up to `timeoutMs`, five minutes by default.

The provider pages show each in turn, with their own options: [RunPod](#/runpod) and [Scaleway](#/scaleway).
