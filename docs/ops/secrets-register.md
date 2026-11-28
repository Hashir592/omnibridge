# Secrets register

Every secret OmniBridge uses: what it is, who owns it, where it lives, which containers get it, and when it is rotated (SEC-5, SEC-6, ADR-014). Last updated: 20 Nov 2026 by S3 (T-0505 app secrets store).

**Rules**

- No secret is ever in the repo, an image, a log or chat. Containers get secrets only as Docker secret files under `/run/secrets/`, through `<NAME>_FILE` variables (invariant 22).
- Each secret is mounted only into the containers that need it. The config test `[SEC-5] containers receive secrets only as /run/secrets files` enforces this.
- **Dev:** every value is synthetic. They are SOPS-encrypted in `infra/secrets/dev.sops.yaml` with the committed **DEV ONLY** age key `infra/secrets/dev.age.key`. `bash scripts/dev-secrets.sh` writes them to `infra/compose/.secrets/` (git-ignored).
- **Production (M22):** values live in the private ops repo, SOPS + age encrypted under a production age key that never touches this repo. On the server they are decrypted into Docker secrets on tmpfs.
- Programmatic credentials are rotated at least every 12 months, and Amazon's LWA client secret every 180 days (SEC-6).
- Owner of every secret is **Hashir** until the ops handover says otherwise.

## Infrastructure secrets (Docker secrets)

Production dates are set when each secret is first created in M22. "Next rotation" is then that date plus the interval.

| Secret | What | Owner | Dev | Production | Containers | Rotation | Next rotation |
|---|---|---|---|---|---|---|---|
| `db_main_superuser_password` | PostgreSQL superuser of db-main (init only) | Hashir | `dev.sops.yaml` | ops repo → tmpfs | db-main | 12 months | set in M22 |
| `ob_owner_password` | db-main migration role `ob_owner` | Hashir | `dev.sops.yaml` | ops repo → tmpfs | db-main, migrate-main | 12 months | set in M22 |
| `ob_app_password` | db-main web role `ob_app`: groups `ob_tenant_rw` and `ob_auth` (ADR-051), no BYPASSRLS | Hashir | `dev.sops.yaml` | ops repo → tmpfs | db-main, web | 12 months | set in M22 |
| `ob_worker_password` | db-main worker role `ob_worker`: group `ob_tenant_rw`, the reset-link definer and the audit purge (ADR-049, ADR-051), no BYPASSRLS | Hashir | `dev.sops.yaml` | ops repo → tmpfs | db-main, worker | 12 months | set in M22 |
| `ob_ops_password` | db-main role `ob_ops` for the one-off jobs (rewrap-keys, dev seed): group `ob_tenant_rw` plus the platform-key and seed definers, never sessions (ADR-051), no BYPASSRLS | Hashir | `dev.sops.yaml` | ops repo → tmpfs | db-main, rewrap-keys (ops job), seed (dev only) | 12 months | set in M22 |
| `ob_platform_password` | db-main fan-out role `ob_platform`: reads workspace ids only | Hashir | `dev.sops.yaml` | ops repo → tmpfs | db-main, worker (scheduled fan-out), rewrap-keys (ops job) | 12 months | set in M22 |
| `auth_hmac_key` | Sign-in HMAC key: keys the lockout counters (no plaintext email of an unknown address is stored) and the recovery-code hashes (T-0203, ADR-048, ADR-050). Rotating it unlocks every counter and voids every recovery code: users re-enrol their codes | Hashir | `dev.sops.yaml` | ops repo → tmpfs | web | 12 months | set in M22 |
| `ebay_verification_token` | eBay account deletion endpoint verification token, 32–80 characters; the same value is entered in eBay's developer portal (EBAY-2, T-0602) | Hashir | dry run: synthetic, made by `infra/early-deploy/dry-run.sh` | ops repo → `infra/early-deploy/.secrets/` (early deploy), later tmpfs | ebay-endpoint (early deploy), later web | when changed at eBay | set at the early deploy |
| `ebay_client_id`, `ebay_client_secret` | eBay production keyset App ID and Cert ID, used by the endpoint to read eBay's public keys (client credentials) | Hashir | dry run: synthetic; dev and CI use provider-mocks | ops repo → `infra/early-deploy/.secrets/` (early deploy), later tmpfs | ebay-endpoint (early deploy), later web and worker | at eBay's keyset rotation | set at the early deploy |
| `db_pii_superuser_password` | PostgreSQL superuser of db-pii (init only) | Hashir | `dev.sops.yaml` | ops repo → tmpfs | db-pii | 12 months | set in M22 |
| `vault_owner_password` | db-pii migration role `vault_owner` | Hashir | `dev.sops.yaml` | ops repo → tmpfs | db-pii, migrate-pii | 12 months | set in M22 |
| `vault_app_password` | db-pii app role `vault_app` | Hashir | `dev.sops.yaml` | ops repo → tmpfs | db-pii, pii-vault | 12 months | set in M22 |
| `secrets_kek` | Secrets master key: wraps the data keys of `app.credentials` in db-main and the file keys on the files volume | Hashir | `dev.sops.yaml` | ops repo → tmpfs | web, worker, rewrap-keys (ops job) | 12 months | set in M22 |
| `file_link_hmac_key` | HMAC key for 5-minute signed download links (NFR-5, T-0105) | Hashir | `dev.sops.yaml` | ops repo → tmpfs | web | 12 months | set in M22 |
| `pii_kek` | PII master key: wraps the per-workspace PII data keys (used from M04) | Hashir | `dev.sops.yaml` | ops repo → tmpfs | pii-vault | 12 months | set in M22 |
| `vault_token_web` | pii-vault service token for web: ingest, read-full (order detail, inbox), mask, search, match (T-0402, invariant 8) | Hashir | `dev.sops.yaml` | ops repo → tmpfs | web, pii-vault | 12 months | set in M22 |
| `vault_token_worker` | pii-vault service token for the worker: ingest, read-full (label, inbox), mask, match (T-0402) | Hashir | `dev.sops.yaml` | ops repo → tmpfs | worker, pii-vault | 12 months | set in M22 |
| `vault_token_deletion` | pii-vault service token for the deletion jobs only: delete (T-0402, DEL-1) | Hashir | `dev.sops.yaml` | ops repo → tmpfs | worker (deletion jobs), pii-vault | 12 months | set in M22 |

The master keys are never in a database, an image or a backup (SEC-6, invariant 9). The main backups hold only wrapped data keys, so a backup alone cannot decrypt anything.

## Keys that unlock the secrets files

| Secret | What | Owner | Dev | Production | Containers | Rotation | Next rotation |
|---|---|---|---|---|---|---|---|
| `dev.age.key` | DEV ONLY age identity for `dev.sops.yaml`; committed on purpose, synthetic values only (PS-007) | Hashir | repo `infra/secrets/` | never used | none | when a dev value changes, or never | n/a |
| `prod age key` | age identity for the production SOPS files | Hashir | never on a dev machine | Hashir's password manager + server root only | none | 12 months | set in M22 |

## Credentials in the database (envelope-encrypted, `app.credentials`)

These are not Docker secrets. Each value is encrypted with AES-256-GCM under a per-workspace data key, which is wrapped by `secrets_kek` (T-0103). The table has `current` and `next` slots. Each row also names the provider environment it belongs to (`mock`, `sandbox` or `live`, T-0701, INT-3): a token is read only in its own environment, so a copied or restored database cannot send it anywhere else.

| Secret | What | Owner | Dev | Production | Containers | Rotation | Next rotation |
|---|---|---|---|---|---|---|---|
| `amazon.refresh_token` | SP-API LWA refresh token per seller account | workspace admin | mock only | `app.credentials` | worker (web stores it at OAuth return) | on re-authorisation; old one kept inactive 7 days then deleted (AMZ-8) | per account |
| `ads.refresh_token` | Amazon Ads refresh token per profile | workspace admin | mock only | `app.credentials` | worker, web | on re-authorisation | per account |
| `ebay.refresh_token` | eBay user refresh token per account | workspace admin | mock only | `app.credentials` | worker, web | 18-month eBay expiry; re-authorise before it | per account |
| `evri.api_key`, `dpd.api_key` | Carrier API credentials per account | workspace admin | mock only | `app.credentials` | worker | 12 months | per account |
| `website.api_key` | Website connector API key per account (M11) | workspace admin | mock only | `app.credentials` | worker | 12 months | per account |
| `website.signing_secret` | Website connector HMAC signing secret per account, both directions (WEB-2, M11); shown once when issued | workspace admin | mock only | `app.credentials` | web (checks pushes), worker (signs calls) | on demand (new keys) | per account |

## App secrets (platform store, `app.app_secrets`)

OmniBridge's own app credentials (PLAT-4, T-0505). They are set only in the platform console (`PUT /platform/app-secrets/:name/:slot`) and are write-only: the console shows each name with the set-on date of its `current` and `next` slot, never a value. Each value is AES-256-GCM ciphertext under the platform data key, wrapped by `secrets_kek` and sealed to its name. The audit row (`app.platform_audit_events`) holds the name and slot only. Promoting `next` to `current` deletes the old value. The typed reader is `AppSecretStore.get` in `@omnibridge/db`: the worker uses it for provider calls, and web only for the OAuth code exchange.

| Secret | What | Owner | Dev | Production | Containers | Rotation | Next rotation |
|---|---|---|---|---|---|---|---|
| `amazon.lwa_client_id` | SP-API LWA client ID (public identifier, stored with its secret) | Hashir | mock only | `app.app_secrets` | worker, web (OAuth exchange) | with the secret | set in M07 |
| `amazon.lwa_client_secret` | SP-API LWA client secret; `next` holds Amazon's 7-day overlap (AMZ-10); its 180-day expiry is on the console's credential calendar | Hashir | mock only | `app.app_secrets` | worker, web (OAuth exchange) | 180 days; reminders on day 150, 165, 173 (M18) | set in M07 |
| `ads.client_id`, `ads.client_secret` | Amazon Ads API client credentials | Hashir | mock only | `app.app_secrets` | worker, web (OAuth exchange) | 12 months | set in M15 |
| `ebay.client_id`, `ebay.client_secret`, `ebay.dev_id` | eBay production keyset (App ID, Cert ID, Dev ID) | Hashir | mock only | `app.app_secrets` | worker, web (OAuth exchange) | 12 months or at eBay's keyset rotation | set in M08 |
| `ebay.verification_token` | eBay account deletion endpoint verification token (EBAY-2); the early deploy still reads the Docker secret of the same name until M15 moves the endpoint to the store | Hashir | mock only | `app.app_secrets` | web | when changed at eBay | set in M15 |
| `evri.client_id`, `evri.client_secret` | Evri Business Accounts (myHermes) platform client credentials, the same for every Evri account (EVRI-1, EVRI-2); used only to exchange an admin's authorisation code. Evri's documents hold the values; they are entered in the console and nowhere else (never the repo, a log, a fixture or chat) | Hashir | mock only (synthetic) | `app.app_secrets` | web (code exchange) | when Evri issues new ones | set before the Evri verify-live task (M12) |

## Planned (not created yet)

| Secret | What | Owner | Dev | Production | Containers | Rotation | Next rotation |
|---|---|---|---|---|---|---|---|
| `pii_vault_service_tokens` | Capability tokens for web and worker calling pii-vault (ADR-007) | Hashir | `dev.sops.yaml` (M04) | ops repo → tmpfs | web, worker, pii-vault | 12 months | set in M04 |
| `smtp_password` | Scaleway TEM SMTP credentials | Hashir | Mailpit needs none | ops repo → tmpfs | web, worker | 12 months | set in M22 |
| `b2_main_key`, `b2_pii_key`, `restic_main_password`, `restic_pii_password` | Backblaze B2 application keys (no delete) and restic passwords, separate for main and PII (ADR-016) | Hashir | local restic repo (M01b) | ops repo → tmpfs | backup jobs | 12 months | set in M22 |

## Procedures

**Add or change a dev secret.** Decrypt, edit and re-encrypt with the pinned SOPS image (`SOPS_IMAGE` in `scripts/lib/images.sh`). Keep values synthetic, add the compose `secrets:` entry and a row above, then run `bash scripts/dev-secrets.sh`. If an existing file changes, the script stops. Run `docker compose … down -v`, then `bash scripts/dev-secrets.sh --reset`.

**Rotate a master key (KEK).** A keyring file has one `<version>:<base64 32 bytes>` line per version; the last line is active.

1. Append a new line (`generateKekLine(n + 1)` from `@omnibridge/crypto`) to the secret and redeploy. New data keys are wrapped under the new version, and old ones still open.
2. **`secrets_kek`: run the all-workspace re-wrap job** (T-0201) with the new keyring:

   ```bash
   docker compose -f infra/compose/compose.yaml --profile ops run --rm rewrap-keys
   ```

   It lists every workspace as `ob_platform` (ids only), then re-wraps each workspace's data keys as `ob_ops` inside that workspace's own tenant transaction (credential rows are not re-encrypted). Then it re-wraps every file key on the files volume (`<FILES_DIR>/<workspace>/keys/v<n>.json`; file bodies are untouched) and counts the keys left. It runs as the one-off `rewrap-keys` container (web image). That container is the only one that holds `ob_platform`, `ob_ops`, `secrets_kek` and a writable files volume (the worker also holds `ob_platform`, for the scheduled fan-out, but mounts the volume read-only). (`pii_kek`: the vault's re-wrap arrives in M04.)
3. **It must exit 0 and log `key_rotation.done`** before you remove the old line. It exits 1 while any data key or file key is under a KEK other than the active one:
   - `data_keys.stale` or `file_keys.stale`: run it again.
   - `data_keys.newer_kek` or `file_keys.newer_kek`: the job ran with an older keyring than the rest of the stack (R2-02). Run it with the new keyring.

   Removing the line while any key remains under it makes every credential or file in that workspace undecryptable (`no KEK version …`), which is data loss (F-M01-halfway-03, F-M01-end-03).

   An independent check of the database part: every app role is filtered by row-level security, and FORCE RLS applies to `ob_owner` too. Only the db-main superuser sees every workspace. As `postgres`, with `<N>` as the new active version, this must return no rows:

   ```bash
   docker compose -f infra/compose/compose.yaml exec db-main psql -U postgres -d omnibridge -c "SELECT kek_version, count(*) FROM app.data_keys WHERE kek_version <> <N> GROUP BY kek_version"
   ```
4. Remove the old line and redeploy.

**Suspected leak.** Rotate the affected secret at once, then record the incident and the new next-rotation date here.
