# Secrets register

Every secret OmniBridge uses: what it is, who owns it, where it lives, which containers get it, and when it is rotated (SEC-5, SEC-6, ADR-014). Last updated: 18 Oct 2026 by S3 (T-0103).

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
| `ob_app_password` | db-main app role `ob_app` (no BYPASSRLS) | Hashir | `dev.sops.yaml` | ops repo → tmpfs | db-main, web, worker | 12 months | set in M22 |
| `ob_platform_password` | db-main scheduler fan-out role `ob_platform` | Hashir | `dev.sops.yaml` | ops repo → tmpfs | db-main | 12 months | set in M22 |
| `db_pii_superuser_password` | PostgreSQL superuser of db-pii (init only) | Hashir | `dev.sops.yaml` | ops repo → tmpfs | db-pii | 12 months | set in M22 |
| `vault_owner_password` | db-pii migration role `vault_owner` | Hashir | `dev.sops.yaml` | ops repo → tmpfs | db-pii, migrate-pii | 12 months | set in M22 |
| `vault_app_password` | db-pii app role `vault_app` | Hashir | `dev.sops.yaml` | ops repo → tmpfs | db-pii, pii-vault | 12 months | set in M22 |
| `secrets_kek` | Secrets master key: wraps the data keys of `app.credentials` in db-main | Hashir | `dev.sops.yaml` | ops repo → tmpfs | web, worker | 12 months | set in M22 |
| `pii_kek` | PII master key: wraps the per-workspace PII data keys (used from M04) | Hashir | `dev.sops.yaml` | ops repo → tmpfs | pii-vault | 12 months | set in M22 |

The master keys are never in a database, an image or a backup (SEC-6, invariant 9). The main backups hold only wrapped data keys, so a backup alone cannot decrypt anything.

## Keys that unlock the secrets files

| Secret | What | Owner | Dev | Production | Containers | Rotation | Next rotation |
|---|---|---|---|---|---|---|---|
| `dev.age.key` | DEV ONLY age identity for `dev.sops.yaml`; committed on purpose, synthetic values only (PS-007) | Hashir | repo `infra/secrets/` | never used | none | when a dev value changes, or never | n/a |
| `prod age key` | age identity for the production SOPS files | Hashir | never on a dev machine | Hashir's password manager + server root only | none | 12 months | set in M22 |

## Credentials in the database (envelope-encrypted, `app.credentials`)

These are not Docker secrets. Each value is encrypted with AES-256-GCM under a per-workspace data key, which is wrapped by `secrets_kek` (T-0103). The table has `current` and `next` slots.

| Secret | What | Owner | Dev | Production | Containers | Rotation | Next rotation |
|---|---|---|---|---|---|---|---|
| `amazon.refresh_token` | SP-API LWA refresh token per seller account | workspace admin | mock only | `app.credentials` | worker (web stores it at OAuth return) | on re-authorisation; old one kept inactive 7 days then deleted (AMZ-8) | per account |
| `ads.refresh_token` | Amazon Ads refresh token per profile | workspace admin | mock only | `app.credentials` | worker, web | on re-authorisation | per account |
| `ebay.refresh_token` | eBay user refresh token per account | workspace admin | mock only | `app.credentials` | worker, web | 18-month eBay expiry; re-authorise before it | per account |
| `evri.api_key`, `dpd.api_key` | Carrier API credentials per account | workspace admin | mock only | `app.credentials` | worker | 12 months | per account |

## Planned (not created yet)

| Secret | What | Owner | Dev | Production | Containers | Rotation | Next rotation |
|---|---|---|---|---|---|---|---|
| `amazon.lwa_client_secret` | LWA client ID/secret, `current` + `next` during Amazon's 7-day overlap (PLAT-4, AMZ-10); platform-level, table added in M05 | Hashir | mock only | platform credential store (M05) | worker, web | 180 days; reminders on day 150, 165, 173 | set in M07 |
| `ads.client_secret`, `ebay.keyset` | Ads client secret and eBay app keyset (PLAT-4) | Hashir | mock only | platform credential store (M05) | worker, web | 12 months | set in M15/M18 |
| `pii_vault_service_tokens` | Capability tokens for web and worker calling pii-vault (ADR-007) | Hashir | `dev.sops.yaml` (M04) | ops repo → tmpfs | web, worker, pii-vault | 12 months | set in M04 |
| `file_link_hmac_key` | HMAC key for 5-minute signed download links (NFR-5) | Hashir | `dev.sops.yaml` (T-0105) | ops repo → tmpfs | web | 12 months | set in T-0105 |
| `smtp_password` | Scaleway TEM SMTP credentials | Hashir | Mailpit needs none | ops repo → tmpfs | web, worker | 12 months | set in M22 |
| `b2_main_key`, `b2_pii_key`, `restic_main_password`, `restic_pii_password` | Backblaze B2 application keys (no delete) and restic passwords, separate for main and PII (ADR-016) | Hashir | local restic repo (M01b) | ops repo → tmpfs | backup jobs | 12 months | set in M22 |

## Procedures

**Add or change a dev secret.** Decrypt, edit and re-encrypt with the pinned SOPS image (`SOPS_IMAGE` in `scripts/lib/images.sh`). Keep values synthetic, add the compose `secrets:` entry and a row above, then run `bash scripts/dev-secrets.sh`. If an existing file changes, the script stops. Run `docker compose … down -v`, then `bash scripts/dev-secrets.sh --reset`.

**Rotate a master key (KEK).** A keyring file has one `<version>:<base64 32 bytes>` line per version; the last line is active.

1. Append a new line (`generateKekLine(n + 1)` from `@omnibridge/crypto`) to the secret and redeploy. New data keys are wrapped under the new version, and old ones still open.
2. Run `CredentialRepository.rewrapDataKeys` for every workspace. It re-wraps each data key; credential rows are not re-encrypted. (The all-workspace job arrives with the workspace list in T-0201 and the queue in T-0104.)
3. Check that no `app.data_keys` row still has the old `kek_version`, then remove the old line and redeploy.

**Suspected leak.** Rotate the affected secret at once, then record the incident and the new next-rotation date here.
