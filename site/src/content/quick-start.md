# Quick start

> **Status.** These docs describe the capability-based API on the `feat/capabilities` branch ([pull request #2](https://github.com/visgotti/asap-vps/pull/2)). It replaces the initializer API of the `0.0.22` release on npm, so until a new release is published, clone the repository and build it.

## Install

```bash
git clone https://github.com/visgotti/asap-vps.git
cd asap-vps
git checkout feat/capabilities
npm install && npm run build      # dist/ holds the JavaScript and the .d.ts files this site's editors use
```

The library runs on Node (it uses the global `fetch`) and has one runtime dependency, `node-ssh`, for logging into the servers it rents.

## Keys

Each provider reads its API key from an environment variable, and `providersFromEnv` builds the ones you have. Leave the others unset.

| Provider | Class | Environment variable | Where to make the key |
|---|---|---|---|
| DigitalOcean | `DigitalOcean` | `DIGITAL_OCEAN_API_KEY` | API → Tokens → Generate New Token (Full Access) |
| Scaleway | `Scaleway` | `SCW_SECRET_KEY`, `SCW_DEFAULT_PROJECT_ID`, and `SCW_ACCESS_KEY` for image copy and import | IAM → API keys |
| Lambda Cloud | `LambdaCloud` | `LAMBDA_API_KEY` | API keys → Generate API key |
| RunPod | `RunPod` | `RUNPOD_API_KEY` | Settings → API Keys (All) |
| Vast.ai | `VastAI` | `VAST_API_KEY` | Account → API Keys |

In the sandbox on this site, `process.env` already holds a key each fake accepts: the snippets read the variables exactly as your code would.

## Your first server

One provider, from rent to delete:

```ts run title="A GPU on RunPod"
import { RunPod } from "asap-vps";

const runpod = new RunPod(process.env.RUNPOD_API_KEY!);

const [offer] = await runpod.listOffers({ minVramGb: 24, maxPricePerHour: 1 }); // cheapest first
const server = await runpod.createServer({
  name: "my-gpu",
  offer, // brings its region and GPU count
  image: "nvidia/cuda:12.8.1-base-ubuntu24.04",
  command: ["sleep", "infinity"],
});
console.log((await runpod.waitUntilRunning(server.id)).status);
await runpod.deleteServerAndWait(server.id); // deletes, then checks until it is gone
```

## The same question to every provider

Code that does not care which cloud it is on asks each configured provider the same thing, and the answers are comparable: an offer has the same fields everywhere.

```ts run title="The cheapest 24 GB GPU, across every provider with a key"
import { providersFromEnv } from "asap-vps";

const rows = [];
for (const provider of providersFromEnv(process.env)) {
  const [cheapest] = await provider.listOffers({ kind: "gpu", minVramGb: 24 });
  if (cheapest) rows.push({ provider: provider.id, gpu: cheapest.gpu, vramGb: cheapest.vramGb, usdPerHour: Math.round(cheapest.pricePerHour * 100) / 100 });
}
rows.sort((a, b) => a.usdPerHour - b.usdPerHour);
console.log(rows);
```

## Logging in

Every provider reports where its server's sshd is and as whom to log in (`root`, or `ubuntu` on Lambda), so the login is the same everywhere. This needs Node (sockets and key generation), so it is checked here but not run:

```ts
import { DigitalOcean, SSHService } from "asap-vps";

const digitalOcean = new DigitalOcean(process.env.DIGITAL_OCEAN_API_KEY!);
const { publicKey, privateKey } = await SSHService.createKeys(); // in process: nothing is written to disk
const key = await digitalOcean.addSSHKey(publicKey, "my_key"); // the same key again returns this registration

const [offer] = await digitalOcean.listOffers({ kind: "cpu" });
const server = await digitalOcean.createServer({ name: "web-1", offer, region: offer.regions[0], sshKeyIds: [key.id] });
const running = await digitalOcean.waitUntilRunning(server.id);

const ssh = await SSHService.connect({ ...running.ssh!, privateKey });
console.log((await ssh.execCommand("uname -a")).stdout);
ssh.dispose();

await digitalOcean.deleteServerAndWait(server.id);
await digitalOcean.deleteSSHKey(key.id);
```

To rent, log in and run a whole setup (Docker, a firewall, your commands) in one call, with the server deleted again if any step fails, see [Setting a server up](#/ssh).
