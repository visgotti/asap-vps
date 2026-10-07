# GPU provider setup

Every key goes in one file outside the repo: `~/.config/asap-vps/credentials.env`.
Each key is shown **once**, so save it before leaving the page.

## 0. Create the key file (once)

```sh
mkdir -p ~/.config/asap-vps && touch ~/.config/asap-vps/credentials.env && chmod 600 ~/.config/asap-vps/credentials.env
```

Each section ends with a key on your clipboard. Save it straight from the
clipboard (it never gets pasted anywhere else):

```sh
printf 'RUNPOD_API_KEY=%s\n' "$(pbpaste)" >> ~/.config/asap-vps/credentials.env
```

To replace a key, delete its old line first: the first line of a name wins.
Pasting the keys into the repo's `.env.test` (gitignored; slots for each are
already there) works too. The smoke test and the live tests read both files,
and when both set a key, `.env.test` wins: a stale key there hides a good one
in the credentials file, so leave a key empty in `.env.test` to use the other.

## 1. RunPod: `RUNPOD_API_KEY`

1. Sign up at https://console.runpod.io
2. Add credit at https://console.runpod.io/user/billing: pick an amount (or **Other**), then pay.
3. Go to https://console.runpod.io/user/credentials, then the **API Keys** tab, then **Create API Key**.
   - Name: `asap-vps`
   - Permission: **All**
   - Click **Create**, then click the new key to copy it.
4. Save it:
   ```sh
   printf 'RUNPOD_API_KEY=%s\n' "$(pbpaste)" >> ~/.config/asap-vps/credentials.env
   ```

## 2. Vast.ai: `VAST_API_KEY`

1. Sign up at https://cloud.vast.ai
2. Add credit at https://cloud.vast.ai/billing/: click **Add Credits** ($5 minimum).
3. Turn on two-factor authentication for the account, and log in with it. Vast
   refuses account calls (list instances, SSH keys, rent) from a key made in a
   session without it: "Your key lacks proper privileges ... requires you to
   have logged in using Two Factor Authentication". Searching offers still
   works with such a key, so only the account calls fail.
4. Go to https://cloud.vast.ai/manage-keys/, find the **API Keys** section, and click **+New**.
   - Name: `asap-vps`
   - Permissions: leave the default (full access).
   - Click **Create**, then copy the key.
5. Save it:
   ```sh
   printf 'VAST_API_KEY=%s\n' "$(pbpaste)" >> ~/.config/asap-vps/credentials.env
   ```

## 3. Lambda: `LAMBDA_API_KEY`

1. Sign up at https://cloud.lambda.ai
2. Add a card at https://cloud.lambda.ai/settings/billing.
   - It must be a credit card: no debit or prepaid cards, and no VPN while adding it.
   - Lambda puts a $10 hold on the card and refunds it.
3. Go to https://cloud.lambda.ai/api-keys and click **Generate API key**.
   - Name: `asap-vps`
   - Confirm, then copy the key.
4. Save it:
   ```sh
   printf 'LAMBDA_API_KEY=%s\n' "$(pbpaste)" >> ~/.config/asap-vps/credentials.env
   ```

You don't need to add an SSH key: the smoke test registers its own and deletes it.

## 4. DigitalOcean: `DIGITAL_OCEAN_API_KEY` (you already have an account)

1. Go to https://cloud.digitalocean.com/account/api/tokens and click **Generate New Token**.
   - Name: `asap-vps`
   - Expiration: 90 days
   - Scopes: **Full Access**
   - Confirm, then copy the token.
2. Save it:
   ```sh
   printf 'DIGITAL_OCEAN_API_KEY=%s\n' "$(pbpaste)" >> ~/.config/asap-vps/credentials.env
   ```

This account also runs production and is near its droplet limit (24 of 25),
so only one GPU droplet can run at a time.

## 5. Scaleway: `SCW_SECRET_KEY` and `SCW_DEFAULT_PROJECT_ID`

1. Sign up at https://console.scaleway.com and add a payment method.
2. Verify the account's identity
   (https://www.scaleway.com/en/docs/account/setup-lifecycle/verify-identity/).
   Creating a GPU Instance fails with `QuotaError` (a `403 quotas_exceeded`: "quota(s)
   exceeded for this resource") until the identity is verified or support lifts the
   quota (https://www.scaleway.com/en/docs/account/troubleshooting/quotas-exceeded-error-message/).
   A CPU Instance needs none of that, so `ASAP_VPS_LIVE=scaleway-cpu` (the whole
   lifecycle on a STARDUST1-S, a few cents) works on a new account.
3. Find the Project's id: the console's **Project settings** (the default Project
   is named `default`). New servers and SSH keys are created in this Project, and
   Scaleway applies all of the Project's SSH keys to every server created in it.
4. Go to https://console.scaleway.com/iam/api-keys and click **Generate an API key**
   (https://www.scaleway.com/en/docs/iam/credentials/create-api-keys/).
   - Bearer: yourself (or an application with access to the Project).
   - Preferred Project: the one from step 3.
   - Copy the **secret key** (the UUID shown once). The access key (`SCW...`) is
     needed only by `copyImage` and `importImage`: an image's file goes through
     Object Storage, which signs its requests with both keys. Copy it too if
     you will use them.
5. Save them:
   ```sh
   printf 'SCW_SECRET_KEY=%s\n' "$(pbpaste)" >> ~/.config/asap-vps/credentials.env
   printf 'SCW_DEFAULT_PROJECT_ID=%s\n' "<the project id>" >> ~/.config/asap-vps/credentials.env
   printf 'SCW_ACCESS_KEY=%s\n' "<the access key>" >> ~/.config/asap-vps/credentials.env   # for copyImage and importImage only
   ```
   Optionally `SCW_ZONES=fr-par-2,pl-waw-2` (or a region such as `fr-par`) to keep
   to some zones: every Instance call is zonal, so fewer zones are fewer calls.

Scaleway bills in euros; offers are priced in USD at a fixed rate
(`eurToUsd`, default 1.15), so the `$1/h` cap of the live tests is about
EUR 0.87/h: an L4 (EUR 0.7875/h) fits. GPU stock is volatile: on 2026-10-01 the
only GPU types in stock were the L4 in Warsaw 2 and the old P100 (RENDER-S) in
Paris 2, and the H100, L40S and B300 were in shortage in every zone. `gpu:smoke`
says so when no offer under the cap is in stock.

## 6. Check the keys (free)

```sh
cd ~/source/repos/asap-vps
npm run gpu:smoke -- runpod --sweep
```

A good key prints `runpod: no smoke servers left`. The check only lists
servers; it creates nothing. A wrong key prints an auth error. Repeat with
`vast`, `lambda`, `digitalocean` and `scaleway`.

## 7. Live test

Tell Claude "run runpod" (or vast / lambda / digitalocean / scaleway). It rents
the cheapest single GPU under $1/h for a few minutes, then deletes it and checks
that it's gone. Each run costs a few cents. Scaleway's runs also check that no
Block Storage volume of their servers and no snapshot of their images is left:
`terminate` and a plain delete only detach the volumes, deleting an image leaves
its snapshots unless they are deleted too, and each bills until it is deleted.
