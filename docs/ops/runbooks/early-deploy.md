# Early public deploy (T-0604)

For the devops person. This puts **the public site** (`omnibridge.co.uk`, `www`) and **the eBay account deletion endpoint** (`app.omnibridge.co.uk/webhooks/ebay/account-deletion`) live on the shared netcup VPS, behind Caddy with automatic HTTPS. Nothing else runs: no database, no customer data, no main app. Expect about 2 days including DNS propagation.

Everything is in `infra/early-deploy/`:

| File | What |
|---|---|
| `compose.yaml` | site, ebay-endpoint and caddy, each with memory, CPU and PID limits and a healthcheck |
| `Caddyfile` | HTTPS, HSTS, the www redirect, and the app domain open only for the eBay path |
| `smoke.sh` | the checks to run after every deploy |
| `compose.dryrun.yaml`, `dry-run.sh` | the same stack on your machine with synthetic values (step 1) |

## 1. Dry run on your machine first

Docker must be running. From the repo root:

```bash
bash infra/early-deploy/dry-run.sh
```

It builds the images, starts the stack on `https://localhost:9444` (site) and `https://localhost:9443` (app), runs `smoke.sh` against Caddy's local certificate, posts eBay's own signed sample notice (expects 204), and stops the stack. It must end with `smoke: all checks passed` and `ok eBay's signed sample is verified and accepted (204)`.

## 2. Server basics

- Ubuntu LTS on the netcup VPS, with unattended security upgrades. Sign in with SSH keys only (password and root login off).
- Docker Engine with the Compose plugin, from Docker's apt repository.
- A non-root deploy user in the `docker` group. Clone the repo into its home directory.
- The VPS is shared: these containers join only the `ob_edge` network, and every one has limits (`scripts/check-limits.sh` checks this in CI).

## 3. Firewall

Allow inbound **22** (SSH, from your addresses only if possible), **80** and **443**. Deny everything else. Port 80 is needed for Let's Encrypt and the redirect to HTTPS.

If another app on the VPS already owns 80 and 443, do not start this Caddy. Add these sites to that app's edge instead (the routes in `Caddyfile` are all it needs), and tell Hashir.

## 4. DNS at GoDaddy (WWW-1: DNS stays at GoDaddy)

| Type | Name | Value |
|---|---|---|
| A | `@` | the VPS's fixed IPv4 |
| A | `www` | the VPS's fixed IPv4 |
| A | `app` | the VPS's fixed IPv4 |
| AAAA | `@`, `www`, `app` | the VPS's IPv6, only if the VPS has one |

The mail records (MX, SPF, DKIM, DMARC) are a separate job: see `docs/ops/mailboxes.md`. Do not delete them. Wait until `dig +short omnibridge.co.uk` returns the VPS address before step 7.

## 5. Secrets (SOPS, never in this repo)

Three secrets, stored in the **ops repo** encrypted with the production age key (secrets register):

| File in `infra/early-deploy/.secrets/` | What |
|---|---|
| `ebay_verification_token` | 32–80 letters, digits, `_` or `-`. The same value is entered in eBay's developer portal (step 8) |
| `ebay_client_id` | the production keyset's App ID (Client ID) |
| `ebay_client_secret` | the production keyset's Cert ID (Client Secret) |

On the server:

```bash
mkdir -p infra/early-deploy/.secrets && chmod 700 infra/early-deploy/.secrets
sops -d --extract '["ebay_verification_token"]' /path/to/ops/early.sops.yaml > infra/early-deploy/.secrets/ebay_verification_token
sops -d --extract '["ebay_client_id"]' /path/to/ops/early.sops.yaml > infra/early-deploy/.secrets/ebay_client_id
sops -d --extract '["ebay_client_secret"]' /path/to/ops/early.sops.yaml > infra/early-deploy/.secrets/ebay_client_secret
chmod 600 infra/early-deploy/.secrets/*
```

The directory is git-ignored. Never paste these values into chat, tickets or logs.

## 6. Settings (`infra/early-deploy/.env`, git-ignored)

```ini
OB_SITE_OPERATOR_LEGAL_NAME=<the Operator's legal name, from Hashir>
OB_SITE_OPERATOR_COMPANY_NUMBER=<company number>
OB_SITE_OPERATOR_REGISTERED_ADDRESS=<registered office>
ACME_EMAIL=developer@omnibridge.co.uk
APP_VERSION=<git short hash>
```

The site build **fails** while any Operator value is missing or still a placeholder (WWW-2). They must match the company on the Amazon developer profile.

## 7. Deploy

```bash
git pull
docker compose -f infra/early-deploy/compose.yaml --env-file infra/early-deploy/.env up -d --build --wait
```

Caddy gets the certificates on the first HTTPS request (it needs DNS from step 4). Then run the smoke checks against the real domains:

```bash
EBAY_VERIFICATION_TOKEN_FILE=infra/early-deploy/.secrets/ebay_verification_token bash infra/early-deploy/smoke.sh
```

Without `--cacert`, the checks use the system trust store, so they also prove the certificates are valid. All checks must pass:
- every page answers 200 with the Operator details
- the security headers and HSTS are set
- `www` redirects
- the eBay challenge hash is right
- an unsigned notice gets 412
- the app domain serves nothing else

## 8. Subscribe the endpoint at eBay

In the eBay developer portal, under Alerts & Notifications → Marketplace Account Deletion:
- endpoint `https://app.omnibridge.co.uk/webhooks/ebay/account-deletion`
- the verification token from step 5
- Save

eBay sends the challenge at once; the portal shows the endpoint as verified. Then use **Send test notification**. The endpoint log should show one `ebay.account_deletion.received` line (no user ids), and nothing `rejected`:

```bash
docker compose -f infra/early-deploy/compose.yaml logs ebay-endpoint --since 10m
```

`ebay.public_key_unavailable` in the log means the client ID or secret is wrong. Fix step 5, then run `up -d` again.

## Rollback

Every deploy builds from a git commit. To go back:

```bash
git checkout <previous commit>
docker compose -f infra/early-deploy/compose.yaml --env-file infra/early-deploy/.env up -d --build --wait
```

Then run the smoke checks. To take everything down:

```bash
docker compose -f infra/early-deploy/compose.yaml down
```

Keep the `caddy_data` volume, which holds the certificates, unless you have to start again.

## Later

When the full app goes live (Release 1, M22), the app's own web service serves the same eBay path and this stack is retired. The subscribed URL does not change.
