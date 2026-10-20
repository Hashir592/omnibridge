# M01 end checkpoint report (T-0101 to T-0106)

From S3, 20 Oct 2026. For S4. This is the one module-end review (ADR-044): the whole of M01, plus the halfway carry-over below. Up to 2 fix rounds, then S1.

## Tasks done

| Task | Title | PR | Status |
|---|---|---|---|
| T-0101 | Walking skeleton (local Docker only) | #1, #2 | done |
| T-0102 | Shared API contract pipeline | #3 | done |
| T-0103 | Envelope encryption and secrets handling (HIGH risk) | #5 | done |
| M01 halfway fixes | F-01 to F-08 (F-04 later) | #9 | merged |
| T-0104 | Durable job queue and scheduler | #12 (batch, merged at `202e4f2`) | done |
| T-0105 | File storage, upload scanning and system email | #12 (batch) | done |
| T-0106 | Numbered-page lists, CI speed-ups and tooling follow-ups | #12 (batch) | done |

T-0101 to T-0103 were described in `docs/reviews/M01-halfway-report.md`; the halfway findings and their resolutions are in `docs/reviews/M01-halfway-findings.md`. This report adds T-0104 to T-0106.

## How each was built

**T-0104, the queue.**

- `packages/queue` has a `defineJob` registry and a Zod-checked envelope (workspace, optional channel account, idempotency key, attempt, type and payload; invariant 19), checked on send and on receive.
- Retries use pg-boss with backoff. Each type has its own `<type>.dlq`, plus a redrive API. An invalid envelope goes straight to the dead-letter queue without burning retries.
- Serial-per-account types use pg-boss `key_strict_fifo`.
- **Per-account caps:** pg-boss `groupConcurrency` overshot (7 of 4) under concurrent fetches. So capped jobs also take a slot in `app.job_leases`, a PostgreSQL semaphore with expiring, renewed leases. There is also a global per-worker cap across queues.
- Platform cron jobs are registered on Europe/London time, and heavy jobs only inside a 01:00 to 05:00 window.
- `app.job_records` (migration 0003, forced RLS) holds idempotency and progress. A record and its pg-boss send commit in one transaction (pg-boss `fromKysely`). `GET /jobs/:id` reads it.
- Queues are created only by the migrate job as `ob_owner` (ADR-032).
- The worker has `/metrics` (prom-client) on an unpublished port and a 25 s graceful stop.

**T-0105, files, scanning and mail.**

- **File store:** `packages/files` has a `FileStore` interface and an encrypted local-volume store.
  - Per-workspace file keys are wrapped by `secrets_kek` and kept on the volume.
  - Bodies are 64 KiB AES-GCM chunks bound to the file, the chunk index and a last-chunk flag, so truncation is detected.
  - Files have random ids, and the `delete_after` purge is a hard delete.
- **Signed links:** HMAC over file, session and expiry, 5 minutes, issued only after a permission callback. `GET /files/:id` streams a clean file through a new `FileDownloadSchema` contract marker.
- **Uploads:** size and magic-byte checks against the declared type and extension, then a `files.scan` job that streams the decrypted file into clamd INSTREAM. A file is readable only when clean; if clamd is down it stays `scanning` (ADR-021).
- **Mail:** `packages/mail` is a Nodemailer SMTP adapter with a branded base template and a lint that refuses PII markers and key material.
- **Headers:** `@fastify/helmet` sets a strict CSP (no inline script), HSTS and `frame-ancestors 'none'`.
- A new Docker secret, `file_link_hmac_key`, is mounted into web only. The worker mounts the files volume read-only.

**T-0106, tooling.**

- **F-04:** migration 0005 adds `credentials.delete_after` and drops the old constraint behind the annotated squawk waiver (ADR-045), with proof that squawk fails without it.
- **Pages:** a numbered-page helper (limit 20, 50 or 100, page up to 500, total exact to 10,000).
- **gitleaks:** the history scan works from worktrees and fails on 0 commits. The pre-commit scan fails on gitleaks errors.
- **`scripts/ui-refs.sh`:** refreshes the Linux reference images in the pinned Playwright image.
- **CI:** split into parallel jobs (`verify.sh --only`), with a docs fast path (`verify.sh --docs`), a Docker layer cache and one aggregate required check.
- **O-1:** fixed in the gate (see below).

## Halfway carry-over: outcome

1. **O-1, intermittent e2e failure: fixed.**
   - **Cause:** `compose up --wait` means alive, not ready. Web's and pii-vault's healthchecks accept 503 on purpose (liveness), so the gate started e2e while readiness could still lag under load. That gave the site no-response and `/healthz` 503 failures.
   - **Fix:** the stack step waits up to 120 s for `/healthz` ok through the edge and for the site to answer, and keeps the logs if not.
   - **Evidence:** 5 consecutive full local runs on `5d79079`, all rc=0 (720 s, 416 s, 391 s, 389 s, 405 s).
2. **F-04 `delete_after`: done** as migration 0005 (not 0003; this batch took 0003 and 0004).
3. **Gate defect, the Vite server reused on port 5173: fixed in PR #9** (`b1c55a3`). Please confirm.
4. **Follow-ups owned by T-0201: still open.**
   - `rls-coverage` must include `app.data_keys`, `app.credentials`, `app.job_records`, `app.job_leases` and `app.files`.
   - An all-workspace KEK re-wrap job and workspace fan-out for scheduled purges (credentials, job records, `delete_after` files).

## Risks

1. **Session-bound routes return 401 until M02.** `GET /jobs/:id` and `GET /files/:id` are `auth: session`, and production passes no session resolver, so they always answer 401. Tests inject one. No route is ever open.
2. **Purges are not scheduled yet.** File `delete_after` and credential `delete_after` purges exist as repository methods, but scheduling them per workspace needs T-0201's workspace list. **Correction (F-M01-end-05):** job-record and job-lease retention does **not** exist yet; it is proposed in PS-015.
3. **pg-boss `groupConcurrency` is best effort.** Correctness rests on the lease table, and the leases expire, so a dead worker frees its slot after 2 heartbeats.
4. **Version step-downs (PS-014, open):** nodemailer 10.1.0 and @fastify/helmet 13.1.2 instead of the ADR pins (7-day rule). prom-client 15.1.3 is marked deprecated upstream.
5. **Local resources:** the full stack with clamd fits the 3.8 GiB WSL VM, but tightly. The first run after a cold start takes about 12 minutes.

## Unsure of

- **Is `expires_at` still right for inactive credential rows?** It now keeps the provider expiry; S4 may want to confirm nothing else reads it.
- **Per-account cap scope.** It is per job type and account, not across all types for one account. Provider governors (M07) may want an account-wide budget instead.
- **Files have no HTTP upload route yet.** The pipeline is library-level plus the scan job. A route arrives with the first feature that uploads, and it may need a multipart dependency.

## Test evidence

| Where | Result |
|---|---|
| Full local gate, 5 consecutive runs on `5d79079` | rc=0 ×5; each: unit 51 files / 200 tests, integration 9 files / 40 tests, contract 2, e2e 21 |
| CI on PR #12 (parallel layout) | green, run 39407577612 on `1b188cf`: 6 min 1 s (before the split: 8 min 14 s). CI found two defects on the way, both fixed: bake targets sharing one cache directory, and signed-link signatures accepted in a non-canonical spelling |
| Clamd EICAR test | `[SEC-2] EICAR upload is marked infected and never served` against the pinned clamd 1.5.4 container |
| Mailpit | `[MAIL-2] invite email delivered to Mailpit with no PII marker` against the pinned Mailpit container |
| ui-refs | two runs give SHA-256 `57e5f6…`, equal to the committed `order-detail-linux.png` |
| Docs fast path | proven by the CI run of this report's own docs-only PR (see the PR); `verify.sh --docs` takes 26 s locally |

**Extra commands for S4:**

```bash
scripts/verify.sh --only=install,integration
```

```bash
scripts/verify.sh --docs
```

```bash
bash scripts/ui-refs.sh "order-detail matches"
```
