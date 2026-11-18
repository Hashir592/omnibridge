# M04 halfway carry-over

From S3, 18 Nov 2026. Halfway flow (ADR-044): no round 2. S4 checks this at the M04 end review.
Findings: `docs/reviews/M04-halfway-findings.md` (each has its `Resolution:`). Rulings: ADR-065.
Fix PR: branch `task/M04h-fixes` (one PR, high tier).

## Fixes

| Finding | Fix | Tests |
|---|---|---|
| F-M04h-01 (Major) | `inviteFirstAdmin` runs as a system write (no user in the transaction); audit row names the operator | `auth.int.test.ts` [TEN-7] invite through the route and accept; `people.int.test.ts` [PERM-5] child 403 and RLS refusal; `platform-writes.test.ts` guard |
| F-M04h-02 | `delete_after` only within now − 1 day … now + 90 days, else 400 `invalid_expiry` | `vault.int.test.ts` [DEL-1][DP-6] both edges, ingest and expiry |
| F-M04h-03 | VACUUM runs whenever the run has tombstones, so on a retry too | `deletion.int.test.ts` [DEL-2] VACUUM retry |
| F-M04h-04 | Keys made on ingest only; closed marker (`vault.closed_workspaces`, db-pii 0004); ingest for a closed workspace 409 | `vault.int.test.ts` [DP-5] reads make no keys; `deletion.int.test.ts` closure marker and 409 |
| F-M04h-05 | Phased job handlers: the vault loop runs before the job's db-main transaction opens | `runtime.test.ts` [TEN-1] phased order and failing prepare; `apps/worker/src/deletion.test.ts` [DEL-2] |

## Changed on purpose

- The closure test in `apps/pii-vault/src/deletion.int.test.ts` used to prove that an ingest after closure made fresh keys. ADR-065 reverses that behaviour, so the test now proves the 409 and that no keys are made.

## Left for the M04 end (observations)

- Found in S3's own `/code-review` (high) and fixed in the same PR:
  - The platform invite now answers 409 once the workspace has an admin (`MemberAccessRepository.hasAdmin`). Otherwise an operator could invite themselves as admin of a live workspace (PLAT-3). The TEN-7 test covers it.
  - Closure versus a concurrent ingest:
    - Ingest takes a shared advisory lock per workspace; closure's last batch takes it exclusively.
    - Before deleting the keys, closure re-checks for records left behind. If it finds any, it answers `more` and the caller loops.
    - Test: `deletion.int.test.ts` "[DEL-1] an ingest that lands during closure is caught".
  - A search for a workspace with no keys now writes no access-log row.
- **Phased handlers:**
  - `prepare` holds no db-main connection, but it still holds the job's lease slot and the global gate while it runs. That is intended: a deletion still counts against `WORKER_CONCURRENCY`.
  - Later network-calling jobs (SMTP mail jobs, M07 provider jobs) can move to the same shape; the STATE follow-up is updated.

## Follow-ups placed by S1 (ADR-065)

- Ingest idempotent per subject (`pii_ref` reused for the same order and kind): M10 ingestion task.
- The vault reads `data_key_version` with PII key rotation: M22.
