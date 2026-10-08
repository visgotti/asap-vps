# How the sandbox works

The **Run** buttons here are a **simulation**. Nothing is rented, no key is sent anywhere, and nothing leaves the page. What runs is the library itself, in your browser, with the network and the clock swapped for stand-ins.

## What is real

- **The library.** Each run bundles asap-vps's actual code (the same `DigitalOcean`, `Scaleway`, `Lambda`, `RunPod` and `VastAI` classes, their retries, polling, mapping and error handling) and executes your snippet against it.
- **The types.** The editors use the library's real `.d.ts` files, built from the source when the site is built. Completions, hover text and errors are what your own editor shows.
- **The HTTP the library makes.** Each call goes through `fetch` with the real URL, method, headers and body. The **Requests** tab lists them.

## What is simulated

- **The provider.** `fetch` is replaced by a router: each provider's real host (`api.digitalocean.com`, `api.runpod.io`, `cloud.lambda.ai`, `console.vast.ai`, `api.scaleway.com` and their relatives) goes to an in-memory fake of that API, the same fakes the library's own offline tests use. They model what the live runs taught: DigitalOcean's key lag, Vast's offers going away, Scaleway's zones and quotas. They are not the providers, though. They know a small catalog and a few regions, and a fake can be wrong where a real API surprises.
- **Time.** `setTimeout` takes a millisecond and moves a virtual clock forward by the time asked for, and `Date` follows it, so a ten-minute boot, a stop, a start and a billing hour pass in a moment. Costs are counted on the virtual clock.
- **Node.** The library uses Node's `crypto`, `fs`, `os`, `util` and `stream`. In the browser those are small stand-ins: hashing, HMAC and random bytes work, files live in memory.
- **Your environment.** `process.env` holds keys the fakes accept (`DIGITAL_OCEAN_API_KEY`, `RUNPOD_API_KEY`, `VAST_API_KEY`, `LAMBDA_API_KEY`, `SCW_SECRET_KEY`, `SCW_DEFAULT_PROJECT_ID`, `SCW_ACCESS_KEY`). Your real keys are never needed and never read.

Every run starts a fresh worker, so the fakes start empty each time: a server you created in one run is not there in the next.

## What it cannot do

Some things need a real machine or a real disk, so those blocks are type-checked but have no **Run** button: logging in over SSH, generating key pairs, and Scaleway's `importImage` (it streams a disk file into a bucket). Anything that reaches a host that is not one of the fakes fails the way an unreachable host does:

```ts run title="The sandbox reaches only its fakes"
export {}; // a module, so await works at the top level

try {
  await fetch("https://example.com/");
} catch (e) {
  console.log(String(e));
  console.log((e as { cause?: { message?: string } }).cause?.message);
}
```

And the clock really does run ahead:

```ts run title="A minute passes in no time"
export {};

const started = Date.now();
await new Promise((resolve) => setTimeout(resolve, 60_000));
console.log(`${Math.round((Date.now() - started) / 1000)} s passed on the clock`);
```

## How it is checked

Every block on the site is verified when the site is built (`npm run docs:check`): each is type-checked against the library's declarations, each **Run** block is executed in this same sandbox runner and must finish, and each block that claims a type error must really fail to compile. A headless browser then opens every page and repeats it, so what you read here is what ran.

To see what the library does against a real provider, use the [live tests](https://github.com/visgotti/asap-vps#running-tests) with your own key: they rent real machines and bill your account.
