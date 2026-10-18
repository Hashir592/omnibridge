# OmniBridge: plan review bundle (round 2)

From S1 (lead architect), 18 Oct 2026. **Note: after approval, Hashir moved all server work to the end (M22 Deploy, ADR-029); MODULES.md is now the source for build order.** This file is self-contained, so the reviewer does not need any other file. Requirement IDs refer to PRD v1.1 (now amended to v1.2 after approval). Supporting files: `docs/ARCHITECTURE.md`, `docs/DECISIONS.md`, `docs/plan/MODULES.md`, `docs/plan/requirements-index.md`, `docs/backlog.json`.

## 0. Changes since round 1

Every reviewer item is applied and recorded:

| Reviewer item | Applied as |
|---|---|
| Production server | **VPS 2000 G12.5 (16 GB)**. VPS 4000 is the upgrade target. JeezMart is planned at ≤3 GB / 2 cores (P-007). |
| Upgrade runbook | Written with 5 explicit triggers (`docs/ops/runbooks/server-upgrade.md`). |
| Fixed IP | netcup does **not** document whether the main IPv4 survives a plan change (unverified). Carrier and website egress therefore always leaves through a **netcup failover IPv4**, which netcup's docs say can be switched between servers free of charge. Re-allowlisting steps are the fallback (ADR-015). |
| Backups | **Backblaze B2 EU Central** with restic: separate buckets, keys and passwords per DB. Encryption happens on our side. The server key cannot delete; prune runs from a protected GitHub Actions environment (P-008, ADR-016). |
| Email | Zoho Mail Lite, 2 users + aliases (P-009). System mail via Scaleway TEM, which costs under €1/month at our volume; Brevo free tier is the fallback (ADR-020). |
| ClamAV | **One** clamd for the whole box, owned by the host/edge layer. The host scan uses the same daemon (P-004, ADR-021). |
| Observability | Capped at **488 MB**. cAdvisor kept at a 60 s interval and a 64 MB limit (ADR-017). |
| Budget | Redone for 16 GB, with PostgreSQL settings and a disk budget; alerts at 70% and 85% (§3). |
| Staging | **VPS 1000 G12.5 (8 GB)**. AT-25 and the first AT-24 run on production before go-live (ADR-024). |
| Walking skeleton | Now **local-only**. Staging deploy moved to M01b. |
| Module split | **M01b Ops and production host** split out of M01. |
| Build order | M01b and **M06 (public site + minimal eBay deletion endpoint) come straight after M02**, ahead of M04/M05 (§5). |
| Q-001 | Recorded as approved. |
| P-001 to P-006 | Recorded as approved. P-006's main-DB schedule is revised to 7 daily + 4 weekly + 6 monthly with an event-driven purge, because Amazon's guidance covers backups (§8). |
| PII backups | **New finding:** the same Amazon clause means PII backup copies must also be gone within 30 days of delivery, so I added **P-010 (needs approval)**. |
| Lockout | USR-5 fixes a hard lock, so it is kept. Per-IP progressive delays and alerts are added on top (ADR-008). |
| Auth audit | S5 audit of T-0203 is now **required** before M02 can be APPROVED (task T-0206). |
| CodeRabbit | CodeRabbit CLI has a **native Windows installer** (official docs); WSL is the fallback (§10). |
| External uptime check | Added as **P-011 (needs approval)**, since OPS-11 lists the allowed outside services. |
| Versions and CVEs | Pinned. Anything not confirmed from a primary source is marked *unverified* (§2). |

## 1. System summary

OmniBridge is a multi-tenant SaaS back office for UK sellers on Amazon, eBay and their own website. It covers stock, orders, shipping labels, account health, Amazon Ads, profit and a VAT ledger.

One TypeScript codebase produces four processes:

- **web**: Fastify API plus the React SPA
- **worker**: queue jobs and every outbound provider call
- **pii-vault**: the only door to buyer PII
- **site**: the static public website

There are two PostgreSQL 18 clusters:

- **db-main** holds all business data with `workspace_id` on every row, enforced by row-level security.
- **db-pii** holds buyer PII only, AES-256-GCM encrypted per field, and is reachable only by pii-vault.

All outbound calls run in workers through a durable pg-boss queue with separate Amazon and eBay rate governors. Development and CI use mock provider servers only. Everything runs in Docker Compose on one netcup VPS in Germany, which is shared with JeezMart and fully isolated from it, plus a small staging VPS. The only outside services are EU email sending, encrypted B2 backups, and (if P-011 is approved) a free uptime check.

## 2. Stack

All choices are open source and allow commercial SaaS use. Versions are exact, as of 18 Oct 2026, from the npm registry or GitHub releases unless noted. They are pinned in the lockfile or by image digest.

| Area | Choice and version | Licence | Why (rejected options) | RAM |
|---|---|---|---|---|
| Runtime | Node.js 24.22.0 LTS, TypeScript 6.0.3 | MIT / Apache-2.0 | One language for web and workers. TypeScript 7.0.2 waits until typescript-eslint supports it (its peer range is below 6.1). Move to Node 26 LTS in Q1 2027 (LTS date 28 Oct, *unverified*). | n/a |
| API | Fastify 5.12.7, @fastify/helmet 13.2.0, @fastify/rate-limit 11.2.1 | MIT | Mature, fast and lean (NestJS is heavier; Hono's plugin set is thinner). | ~120 MB/process |
| UI | React 19.3.1, Vite 8.3.4, TanStack Router 1.170.45 / Query 5.104.4 / Table 9.3.1 / Virtual 3.14.21, shadcn/ui on Base UI 1.9.0, Tailwind 4.3.3, React Hook Form 7.90.0, Recharts 3.10.1 | MIT | An SPA behind login needs no SSR server. Typed URL filters. S2 owns the components (NFR-8). (Next.js: server RAM. Mantine was the runner-up.) | 0 |
| Public site | Astro 7.4.0 + static-web-server 2.44.1 | MIT / Apache-2.0 | Stays up during app deploys (WWW-4). | 24 MB |
| Contract | Zod 4.6.7 → fastify-type-provider-zod 7.0.0 + @fastify/swagger 9.9.2 → openapi.json → openapi-typescript 7.13.0 + openapi-fetch 0.17.0 | MIT | One schema drives validation, client and docs. CI fails on drift. The JeezMart developer gets OpenAPI. (tRPC has no portable HTTP contract.) | 0 |
| Database | PostgreSQL 18.6 ×2 (19 is at RC1, per postgresql.org); Kysely 0.29.7; pg 8.23.1; kysely-codegen 0.20.0; squawk 2.70.0 | PostgreSQL / MIT / Apache-2.0 | Explicit SQL that works with RLS. Forward-only migrations. (Drizzle 1.0 still RC; Prisma heavier.) No PgBouncer: under 60 connections. | §3 |
| Queue | pg-boss 12.38.0 | MIT | Durable and transactional, with dead-letter + redrive, cron and per-key FIFO, and no extra service. (Graphile Worker 0.17 unreleased and no DLQ; BullMQ needs Valkey.) | 0 |
| Auth | In-house on @node-rs/argon2 2.2.2 + @oslojs/otp 1.1.0 | MIT | USR-3/5/6/8 need custom logic in every option. (Better Auth had a 2FA bypass, GHSA-xg6x-h9c9-2m83; Keycloak JVM is 0.5–1 GB; Zitadel is AGPL; Kratos has no lockout or password history.) | 0 |
| PDF | @cantoo/pdf-lib 2.11.1, PDFKit 0.20.2 | MIT | Pure JS. (Original pdf-lib unmaintained since 2021; Chromium-based tools need 300 MB+.) | in worker |
| Secrets | SOPS 3.13.3 + age 1.3.2 → Docker secrets; DB envelope encryption for tokens | MPL-2.0 / BSD-3 | No vault service to run or unseal. (OpenBao: extra RAM + manual unseal after each reboot.) | 0 |
| Edge | Caddy 2.11.7 + coraza-caddy 2.6.2 + OWASP CRS 4.30.0 | Apache-2.0 | Automatic TLS, WAF, one route file per app. (Traefik's Docker discovery would cross app isolation.) | 192 MB (shared) |
| Scanning | ClamAV 1.5.4 clamd, one per box | GPL-2 (separate unmodified process) | SEC-2, EXP-6. | 1.4 GB (shared) |
| Backups | restic 0.19.1 → Backblaze B2 EU Central | BSD-2 | Encrypted on our side. Hide-only keys protect against ransomware. | 384 MB nightly |
| Observability | VictoriaMetrics 1.154.0 + vmalert, VictoriaLogs 1.53.0, Alertmanager 0.34.1, fluent-bit 5.1.4, node_exporter 1.12.1, postgres_exporter 0.20.1, cAdvisor 0.60.6, docker-socket-proxy 0.5.0, Gatus 5.37.0; pino 10.4.0, prom-client 15.1.3 | Apache-2.0 / MIT | Smallest full stack. Error tracking uses fingerprinted error logs plus alerts. (Self-hosted Sentry 16 GB+; Grafana AGPL and not needed.) | 488 MB |
| Email | Scaleway TEM over SMTP (Nodemailer 10.1.2); Mailpit 1.31.6 in dev | MIT-0 / MIT | EU company and hosting. 300 emails/month free, then €0.25 per 1,000. Brevo free tier as fallback. | 0 |
| Tests | Vitest 5.0.5, Testcontainers 12.2.1, Playwright 1.64.1, fast-check 4.10.2, k6 2.3.0 | MIT / Apache-2.0 / AGPL | k6 is AGPL but used unmodified as a local dev tool and never shipped. | n/a |
| Tooling and CI | pnpm 12.14.0, ESLint 10.13.0 + typescript-eslint 8.71.2, Prettier 3.9.10, dependency-cruiser 18.6.0, lefthook 2.2.2, gitleaks 8.30.1, osv-scanner 2.7.0, Semgrep CE 1.181.0, Trivy 0.76.0; GitHub Actions + GHCR | various | All Actions pinned by SHA after the March 2026 Trivy Action tag hijack (incident confirmed by several vendors; CVE number *unverified*). | n/a |
| Host | Debian 13, Docker 29.9.1, Compose 5.6.0, WireGuard, nftables, auditd, AIDE, fail2ban | various | SEC-8 to SEC-10. | in host 1 GB |

## 3. Resource budget and server plan

**Production: netcup VPS 2000 G12.5.** 8 shared vCores, 16 GB, 256 GB SSD, €26.92/month (12-month term, excluding VAT), shared with JeezMart. **Upgrade target: VPS 4000 G12.5** (12 vCores, 32 GB, €45.36), taken only on the runbook triggers below. **Staging: VPS 1000 G12.5** (4 vCores, 8 GB, €14.50). **Add-on:** one netcup failover IPv4 (price *unverified*).

Memory and CPU limits per container:

| Item | Today | Design capacity (§9.1) |
|---|---|---|
| Host layer (OS, Docker, Caddy + WAF, WireGuard/auditd/AIDE/fail2ban) | 1.0 GB | 1.0 GB |
| Shared clamd (one signature DB) | 1.4 GB | 1.4 GB |
| JeezMart (assumption: B2B, 20–30 dropshippers, light load) | ≤3.0 GB / 2 cores | ≤3.0 GB / 2 cores |
| OB web | 1×384 MB / 1.0 | 2×448 MB / 2×1.0 |
| OB worker | 1×512 MB / 1.0 | 2×640 MB / 2×1.0 |
| OB pii-vault | 96 MB / 0.25 | 160 MB / 0.5 |
| OB db-main | 1,536 MB / 1.5 | 2,560 MB / 2.0 |
| OB db-pii | 256 MB / 0.5 | 384 MB / 0.5 |
| OB site | 24 MB / 0.1 | 24 MB / 0.1 |
| OB observability (9 containers) | 488 MB / 0.75 | 500 MB / 0.75 |
| **OmniBridge sum** | **≈3.3 GB** (target ≤5) | **≈5.7 GB** (target ≤7.5) |
| Transient (backup 384 MB + deploy overlap ≈450 MB + migration 192 MB) | ≈1.0 GB | ≈1.0 GB |
| **Combined worst-case peak** | **≈9.7 GB** | **≈12.1 GB** (target ≤14) |

The remaining RAM is page cache. There is 2 GB of swap with `swappiness=10`, and any swap use raises an alert. Every container also alerts at 80% of its limit.

The observability set (≤500 MB):

| Component | Limit |
|---|---|
| VictoriaMetrics | 112 MB |
| VictoriaLogs | 160 MB |
| vmalert | 24 MB |
| Alertmanager | 24 MB |
| fluent-bit | 32 MB |
| node_exporter | 24 MB |
| postgres_exporter (multi-target, one for both DBs) | 32 MB |
| cAdvisor (60 s housekeeping, `--docker_only`, most metric groups off) | 64 MB |
| docker-socket-proxy (read-only container list) | 16 MB |
| **Total** | **488 MB** |

PostgreSQL settings:

| Setting | db-main today | db-main design | db-pii |
|---|---|---|---|
| shared_buffers | 384 MB | 640 MB | 64 MB (96 MB at design) |
| effective_cache_size | 1 GB | 1.75 GB | 160 MB |
| work_mem | 8 MB | 12 MB | 4 MB |
| maintenance_work_mem | 96 MB | 128 MB | 32 MB |
| max_connections | 40 | 60 | 15 |

All clusters use `random_page_cost=1.1`, `effective_io_concurrency=200` and `max_wal_size=1GB`, with autovacuum tuned. App pools are web 10, worker 8 and vault 4.

Disk budget on the 256 GB SSD (design horizon):

| Item | Size |
|---|---|
| OS | 10 GB |
| Docker images (both apps, last 3 releases) | 15 GB |
| db-main (6 years at design rate, including WAL) | 45 GB |
| db-pii | 3 GB |
| Files (6 years of attachments + 30-day label cache) | 25 GB |
| VictoriaLogs (13 months) | 15 GB |
| VictoriaMetrics | 3 GB |
| restic cache and dumps | 10 GB |
| JeezMart (assumption) | 40 GB |
| **Total** | **≈166 GB (65%)** |

Use today is about 30 GB. Alerts fire at 70% and 85%.

**Upgrade triggers** (any one, after tuning is exhausted and recorded):

- host RAM above 85% for 7 days
- daily swap use
- a §9.1 target missed after tuning
- disk above 85% with all retention jobs running
- repeated OOM kills that cannot be fixed within budget

Before upgrading, confirm the failover IP and take a snapshot.

**Load test and first restore drill:** AT-25 and the first AT-24 run **on the production box before go-live**, while it holds only synthetic data. Later drills run on staging with reduced limits.

## 4. Key designs

**Tenancy (ADR-006), defence in depth:**

1. Every tenant table carries `workspace_id`, with composite foreign keys `(workspace_id, id)`.
2. PostgreSQL row-level security is ENABLE + FORCE, with a policy on `app.workspace_id` and a second policy on `app.company_ids` for child users.
3. The app role `ob_app` has no BYPASSRLS. Each request or job sets the context in one transaction with `SET LOCAL`.
4. App code must pass a `TenantContext` to every repository call.
5. Every contract route must declare its auth, tab and admin metadata, or the server will not start.

Tests:

- An RLS-coverage SQL test fails if any table lacks RLS.
- A **route walker** calls every route in the contract as workspace A against workspace B's marker data, and as a child with no ticks (AT-1, AT-2).

**PII store and deletion (ADR-007):**

- `db-pii` is a separate cluster on its own internal network. Only `pii-vault` can reach it.
- Web and worker call the vault with capability tokens:
  - `ingest`: write
  - `read-full`: label, order detail, eBay inbox (DP-7); every read is logged without values
  - `mask`: "J. S\*\*\*, G2", computed on request and never stored
  - `search`: blind-index HMACs of postcode, email, phone and name
  - `delete`
- Each field is encrypted with AES-256-GCM under a per-workspace data key. That key is wrapped by the PII master key, which exists only as pii-vault's Docker secret, with an offline escrow copy held by Hashir.
- The deletion service handles every DEL-1 trigger.
  - Deletion is a hard DELETE followed by VACUUM.
  - Tombstones are written in db-pii, in db-main (IDs only) and in an off-site journal.
  - All tombstones are re-applied after any restore, before the app starts.
- Label files contain PII. They stay in the vault's volume, are never backed up, and are deleted at the earlier of 30 days or PII expiry (P-005).

**Auth (ADR-008):**

- Passwords are hashed with argon2id. The USR-3 policy includes an **offline** breached-password filter built from HIBP data (online lookups would be a forbidden outside service).
- TOTP is mandatory before any workspace access. There are 10 recovery codes, stored as hashes.
- Lockout follows USR-5: 10 failures in 15 minutes locks for 15 minutes. On top of that, each IP gets progressive delays (after 3 failures, 1 s doubling to 30 s), and every lock raises an alert.
- Sessions store only a SHA-256 hash of the token. They expire after 30 minutes idle or 12 hours absolute, and are revoked on permission change.
- Cookies are SameSite=Strict, with an Origin check and a CSRF token.
- Platform admins are a separate flag, and `/platform` is reachable only from VPN IP addresses.
- An S5 audit is required before M02 is approved.

**Queue and governors (ADR-009, ADR-010):**

- Every job carries its workspace, channel account, idempotency key and attempt count.
- Per-account FIFO uses pg-boss `key_strict_fifo`. A PostgreSQL semaphore caps carriers and websites at 4 parallel requests (RL-4).
- **Amazon governor:** a token bucket per seller and operation. On a 429 it backs off with full jitter (1 s base, 60 s max, 8 attempts), then requeues.
- **eBay governor:** an atomic budget reservation **before** each send. Non-urgent calls stop at 80% and everything stops at 95%. Days are US/Pacific days. Listing revisions alert at 200 and are held at 240.
- The two governors are separate packages, and a lint rule forbids shared code between them (RL-3).

**Provider mocks (ADR-011):**

- One `provider-mocks` container (dev, CI and staging only) is built from the official specs:
  - Amazon and Ads models
  - eBay OpenAPI and Trading XSD
  - Evri myHermes v1.4
  - DPD, from third-party evidence
- It has scenario switches for 429 storms, INVALID parcels, `invalid_grant`, revocation and eBay cap exhaustion.
- The HTTP client refuses non-mock hosts unless `PROVIDER_MODE=live`.
- Every [Verify in testing] item becomes a verify-live task.

**Shared-server isolation (OPS-8, OPS-9, P-004):**

- OmniBridge has its own Linux user, `/srv/omnibridge` directory, Compose project, networks (`ob_edge`, `ob_app`, `ob_db`, `ob_pii`, `scan_ob`), secrets, backups and pipeline.
- Every container has memory, CPU and PID limits, and a check script enforces this.
- The shared layer is an `edge` project. It holds Caddy + WAF (one route file per app), the single clamd (each app reaches it on its own network) and the host security agents.
- JeezMart talks to OmniBridge only through the signed website contract.

**Deployment (OPS-3):**

- GitHub Actions runs `scripts/verify.sh`, the scans and the image build. Images go to GHCR.
- Staging deploys automatically. Production deploys only after Hashir approves the GitHub Environment.
- Deploys arrive over WireGuard at a forced-command deploy user.
- Each deploy runs the migration first (forward-only, expand/contract). Then the idle web colour comes up and passes health checks, and the old colour drains. Workers stop gracefully.
- Carrier and website egress leaves through the failover IPv4 via an nftables SNAT rule.

**Backups (ADR-016, P-006, P-008, P-010):**

- Nightly `pg_dump` per cluster goes to restic and then to B2 EU Central, with a separate bucket, application key and restic password for each.
- **Ransomware protection:**
  - The server's B2 keys lack `deleteFiles`, so restic can only *hide* files.
  - Lifecycle rules remove hidden files after 14 days (main) or 1 day (PII).
  - `forget`, `prune` and `check` run only from a GitHub Actions `backup-admin` environment that holds the full key. That key never sits on the server.
  - A daily check alerts if the latest snapshot is older than 26 hours or if snapshots have gone missing.
- **Main DB:** 7 daily + 4 weekly + 6 monthly snapshots.
  - Amazon's SP-API retention guidance says data must be deleted "from live data stores as well as any backups", within 30 days of revocation.
  - So each account-level deletion run (revocation, disconnect, eBay termination, workspace closure) writes a purge marker.
  - The next daily admin job takes a fresh snapshot, then forgets and prunes all older main snapshots. This finishes about 2 days after the run: by about day 23 for Amazon, and well inside eBay's 10 days.
  - Trade-off: backup history resets after these rare events.
- **PII DB:** see P-010.
- **Restore drills:** quarterly, with tombstones applied first (AT-24).

**Observability (ADR-017):**

- pino logs pass a field allowlist with redaction, then a second scrub in fluent-bit, then go to VictoriaLogs for 13 months (SEC-12).
- Metrics go to VictoriaMetrics. vmalert sends alerts through Alertmanager to email.
- OPS-4 alerts cover errors, queue depth, dead-letter growth, disk, memory, certificates, backup age and swap.
- Gatus runs on each server, watching the other. One external check runs if P-011 is approved.
- A CI **PII marker scan** checks DB dumps, logs, emails and exports for the `PIIMARK-` values planted in synthetic data (AT-9).

## 5. Modules in build order, with gates

Every PRD ID (289), plus the AT-1 to AT-25 tests and the CAP-1 to CAP-10 targets, has exactly one owner. That gives 324 IDs, with no ID unmapped.

| # | Module | Gate |
|---|---|---|
| 1 | **M01** Platform foundations (local Docker only) | none |
| 2 | **M02** Identity, tenancy and audit | exit: S4 APPROVED + S5 audit of T-0203 |
| 3 | **M01b** Ops and production host (staging, production, edge, hardening, observability, backups) | **Hashir:** both servers, failover IP, DNS, repo, B2, Scaleway |
| 4 | **M06** Public site, legal and minimal eBay deletion endpoint | **out:** site live on HTTPS, so the Amazon and eBay applications can be sent |
| 5 | M04 PII vault and deletion service | none |
| 6 | M05 Notifications, platform console and security alerts | none |
| 7 | M07 Integration framework and provider mocks | none |
| 8 | M08 Catalogue | none |
| 9 | M09 Inventory | none |
| 10 | M10 Orders and sales VAT | none |
| 11 | M11 Website connector | JeezMart side built by the dev team |
| 12 | M12 Shipping desk, Evri and tracking loop | Evri credit account + IP allowlist (verify-live) |
| 13 | M13 DPD | official DPD spec + account (verify-live) |
| 14 | M14 Reminders and Notes | none |
| 15 | M15 eBay | **in:** deletion endpoint subscribed + keyset active |
| 16 | M16 Finance I (expenses, import, recurring, payroll) | none; may move earlier if a gate stalls |
| 17 | M17 Finance II (fees, intercompany, VAT settlement, P&L, exports) | accountant answers change settings only |
| 18 | M18 Amazon SP-API | **in:** developer profile and roles approved |
| 19 | M19 Amazon Ads | **in:** Ads app approved (else ADS-5 CSV fallback) |
| 20 | M20 Profit, forecasting and Home | none |
| 21 | M21 Hardening and go-live (load test and first restore drill on production, pen test, runbooks, policies) | **to real data:** all DP-9 agreements signed |
| ∥ | M03 Design system and app shell (S2) | starts after T-0102; client picks the style from mock-ups |

**Why this order:**

- **Approvals start early.** Amazon and eBay approvals take weeks, and both need a live HTTPS site, which eBay also needs for its deletion endpoint. Putting M01b and M06 right after M02 lets the applications go out about 3 modules in.
- **The minimal eBay endpoint is compliant with no data held.** It handles the challenge hash and signature check, and acknowledges within 3 s. Because no eBay data exists yet, it records only a receipt with no identifiers. M04 adds real deletion.
- **Everything with no outside gate is built on mocks** while the approvals are pending.

## 6. First two modules: tasks (`docs/backlog.json`)

Each task has an ID, module, session, title, goal, PRD IDs, scope, out-of-scope, dependencies, acceptance (runnable commands or named tests), risk and status. A **high** risk task waits for Hashir's "go" before work starts.

**M01 Platform foundations:**

| ID | Title | PRD IDs | Risk |
|---|---|---|---|
| T-0101 | Walking skeleton, local Docker only (see below) | NFR-1, NFR-2, OPS-7, OPS-8, OPS-9, OPS-10, OPS-11, SEC-4, SEC-5, SEC-16 | normal |
| T-0102 | Shared contract pipeline: route registry with permission metadata, problem+json errors, pagination (default 50), OpenAPI diff gate, typed client, London-date helpers, cache-key helper | NFR-1, NFR-6, NFR-7, SEC-3, CAP-7 | normal |
| T-0103 | Envelope encryption (AES-256-GCM, data and master keys, rotation), two master keys, credential current/next slots, SOPS/age dev secrets, secrets register | SEC-5, SEC-6, INT-3 | **high** |
| T-0104 | pg-boss queue: job envelope, idempotency, retries, DLQ + redrive, cron, per-account FIFO and semaphore, graceful stop, progress API | NFR-3, NFR-4, OPS-10 | normal |
| T-0105 | Encrypted FileStore with signed 5-minute links, upload type/size checks + clamd scan, SMTP mail adapter (Mailpit in dev), CSP/HSTS headers | NFR-5, SEC-2, MAIL-2 | normal |

T-0101 delivers:

- the monorepo
- Compose files with limits on every service
- `/healthz` on web and pii-vault, and a worker heartbeat job
- both PostgreSQL clusters with their DB roles
- a migration runner with squawk lint
- the pino logger with redaction
- `scripts/verify.sh`: lint, typecheck, architecture rules, unit/integration/contract/e2e tests, build, gitleaks, dependency audit, limits check, requirement-ID coverage, hard-coded-name grep
- the CI workflow, pinned by SHA
- lefthook hooks
- one passing test of each kind

M01 checkpoints: halfway after T-0103, end after T-0105.

**M02 Identity, tenancy and audit:**

| ID | Title | PRD IDs | Risk |
|---|---|---|---|
| T-0201 | Workspaces and companies, RLS + composite foreign keys, TenantContext, RLS-coverage test, **route walker (AT-1)**, synthetic seed | TEN-1, TEN-2, TEN-3, TEN-4, TEN-6, TEN-10, SEC-3, AT-1 | **high** |
| T-0202 | Append-only audit log (no UPDATE/DELETE grants + trigger), PII-safe diffs, viewer/export, 6-year retention | AUD-1 to AUD-4 | **high** |
| T-0203 | argon2id + USR-3 policy, mandatory TOTP + recovery codes, lockout + per-IP delays, sessions, CSRF, reset, workspace picker, platform admin login | USR-2 to USR-7, SEC-1, AT-3 | **high** |
| T-0204 | 72-hour invites, Admin/Child with tab and company ticks enforced on the server, Combined view, immediate revocation, last-admin guard, access review task | TEN-5, TEN-7, USR-1, USR-8, USR-9, PERM-1 to PERM-7, AT-2 | **high** |
| T-0205 | `public_signup` flag (off) with email verification; first-run wizard with skip and resume | TEN-8, TEN-9 | **high** |
| T-0206 | **S5** security audit of T-0203 (Hashir runs it). Every Blocker and Major must be resolved. | USR-3 to USR-6, SEC-1 | **high** |

M02 checkpoints: halfway after T-0203, end after T-0206.

## 7. Questions

- **Q-001:** SEC-16's "second developer" review, given that the builders are AI sessions.
  - **Answer (approved):** a PR, green CI and Hashir's approval. S4 findings count as review evidence.
  - No other blocking questions are open.

## 8. Proposed PRD changes

| ID | Change | Reason | Status |
|---|---|---|---|
| P-001 | Header v1.0 → v1.1 | Matches the change log. | Approved |
| P-002 | Give the §9.1 targets IDs CAP-1 to CAP-10 | So tests can cite them. | Approved |
| P-003 | DP-7: ingestion writes; deletion deletes; DEL-4/5 search | DP-7 listed only readers. | Approved |
| P-004 | OPS-9: add the host security layer and one shared clamd | SEC-9 puts these on the host; this saves 1.4 GB. | Approved |
| P-005 | NFR-5: label files are PII and are never backed up | Labels print the buyer's name and address. | Approved |
| P-006 | PII backups and tombstones; AMZ-13 deletion at day 21; main-DB schedule 7d + 4w + 6m with event-driven purge | Amazon: delete "from live data stores as well as any backups". | Approved, main-DB part revised as asked |
| P-007 | OPS-1 and §13.2: VPS 2000 G12.5 shared; VPS 4000 is the upgrade; JeezMart ≤3 GB; failover IP; upgrade runbook | Facts from Hashir. | To apply in v1.2 |
| P-008 | SEC-11: Backblaze B2 EU Central | Fact from Hashir. Encrypted on our side. | To apply in v1.2 |
| P-009 | MAIL-1: Zoho Mail Lite, 2 users + aliases. MAIL-2: Scaleway TEM, Brevo fallback | Fact from Hashir. Under €2/month. | To apply in v1.2 |
| **P-010** | **Delete live PII at delivery (or dispatch) + 25 days instead of 30. Keep 3 daily PII snapshots; B2 deletes hidden PII files after 1 day.** Both are settings. | Amazon's 30-day limit also covers backups. With 7-day PII backups, copies would survive to about day 37. With 25 days live + 3 days of snapshots + 1 day hidden + 1 day margin, every copy is gone by day 30. It deletes earlier, so it stays within "no longer than 30 days" (client decision 13). If refused: keep 30 days live with 3-day backups, and record the residual risk. | **Needs approval** |
| **P-011** | **OPS-11: allow one free external uptime checker (UptimeRobot, terms *unverified*) on the public site and `/healthz`** | If both servers go down at once, nothing on our side can raise an alert. The checker sees no PII. | **Needs approval** |

The PRD is edited only after approval, in Phase B, as version 1.2 with a change-log line.

## 9. Top risks and how the plan handles them

| Risk | Handling |
|---|---|
| In-house auth has a flaw | Small surface built on vetted primitives. Tests are written first. OWASP ASVS L2 checklist. Required S5 audit (T-0206). Pen test before go-live. |
| A cross-tenant data leak | Three layers (app context, RLS, route metadata). The route walker runs on every route in every build. |
| A PII leak | Separate service and cluster. Log allowlist plus a second scrub. A CI marker scan of DB dumps, logs, emails and exports. Labels kept inside the boundary. |
| RAM pressure on a 16 GB shared box | Hard limits on every container. A single clamd. Alerts at 80% of each limit and on any swap use. Heavy jobs run off-peak. Clear upgrade triggers. The JeezMart share is an assumption (≤3 GB), so budget alerts will catch it if that assumption is wrong. |
| The fixed IP changes on an upgrade | The failover IPv4 is used for all carrier egress. Hashir confirms with netcup support. Re-allowlisting steps are in the runbook. |
| Ransomware or a server compromise wipes backups | Server keys can only hide, never delete. Pruning runs off-server. A daily check alerts on backup age. Quarterly restore drills. |
| Providers behave differently from their docs | Adapters, versioned parsers and mocks built from official specs. Every [Verify in testing] item is an explicit verify-live task. The DPD integration is from a third-party source and stays behind its adapter. |
| Approvals stall (Amazon, Ads, eBay) | The public site and eBay endpoint go first. Ungated modules are built meanwhile. Finance can move earlier. Ads has a CSV fallback. |
| Money or VAT errors | Integer pence. Tests written first, including property tests. AT-15 and AT-16 as fixed examples. Snapshots are immutable. |
| Supply-chain attack through CI or dependencies | Actions pinned by SHA. Lockfile. osv-scanner, `pnpm audit`, Trivy and gitleaks. Image digests pinned. |
| Single server down | RPO 24 h through backups, RTO 8 h through a rehearsed restore. Cross-monitoring by Gatus plus the external check. |

## 10. Prerequisites from Hashir

- **Before M01:** none. Docker 29.6 and Node 24 are already on the dev machine. One step:
  - Install **CodeRabbit CLI** natively on Windows (official docs): run `irm https://cli.coderabbit.ai/install.ps1 | iex` in PowerShell, then `coderabbit auth login` (add `--region eu` for an EU account).
  - Fallback on WSL: `wsl --install`, then inside Ubuntu `curl -fsSL https://cli.coderabbit.ai/install.sh | sh`.
  - If CodeRabbit is unavailable, a session stops and reports. It never skips the review.
- **For CI:** a private GitHub repository, with branch protection on `main` (PR, green CI, Hashir's approval).
- **Before M01b:**
  - netcup VPS 2000 G12.5 + failover IPv4
  - netcup VPS 1000 G12.5
  - GoDaddy DNS records for `omnibridge.co.uk`, `www`, `app` and staging hostnames
  - Backblaze B2 account (EU Central)
  - Scaleway TEM account with domain DNS records (SPF, DKIM, DMARC)
  - Zoho Mail Lite with 2 users and aliases
  - UptimeRobot (if P-011 is approved)
- **Before M06 goes public:** the Operator's legal name, company number and registered address. Placeholders are used until then.

## Sources consulted (primary unless noted)

- npm registry and GitHub releases APIs: the versions and licences above.
- postgresql.org/support/versioning: PostgreSQL 18.6 is current, 19 is at RC1.
- nodejs.org/dist/index.json: Node 24.22.0 LTS. Node 26 LTS date from secondary sources.
- netcup.com VPS and root-server pages: G12.5 specs and prices. netcup help centre: failover IPs.
- developer-docs.amazon, SP-API data retention and recovery guidance: deletion from backups, 30-day PII limit.
- docs.coderabbit.ai/cli/windows: native Windows install.
- GitHub advisory GHSA-xg6x-h9c9-2m83 (Better Auth). Trivy Action incident from several vendor reports (secondary).
- restic changelog and forum: hide-only fallback for B2 keys without `deleteFiles`.
- scaleway.com: Transactional Email pricing.
- docs.clamav.net: clamd memory and `ConcurrentDatabaseReload`.
