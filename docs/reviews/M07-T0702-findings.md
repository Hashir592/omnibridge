# M07 T-0702 findings (critical PR review), round 1

Reviewed: T-0702, PR #134 (merge d536c56, branch `task/T-0702-outbound-governors`), on main 43cf821. Also the T-0701 and T-0702 completeness checklist in `docs/reviews/M07-end-report.md`.
Gate: CI on #134 green on every check (verify full gate, unit/integration/contract, build/stack/e2e, static, semgrep).
Local: `verify.sh --quick` PASS (195 s). Integration re-run: db `outbound.int.test`, worker `outbound.int.test`, web `switches.int.test`, web `isolation.int.test`: 21/21 PASS.
Acceptance re-run: 4/4 PASS. Completeness lines: all built (see the last section).

Verdict: **FIX REQUIRED**. Blockers 0, Majors 1, Minors 1. Under ADR-077, S3 fixes the Major in the first commit of its next task; the M07 + M08 milestone review confirms it.

## The six checks

| # | Check | Result |
|---|---|---|
| 1 | Invariant 20 and 3 | PASS. `kit/src/outbound.ts:162-200`: get, `gate` (maintenance through `app.maintenance_state()`, the account's `paused_at`) and `claim` run inside one `runWorkspace`. The repositories join the bound transaction (`db/src/tenant.ts:83`). The governor calls get their own short context, and the provider call runs with no transaction open. Result, usage and health are stored in a new short transaction. An account the context cannot see counts as paused (`db/src/outbound.ts:128`). |
| 2 | Attempts, resume, recovery | PASS. `pause` leaves `attempts` unchanged. A governor `Wait` and eBay's daily limit `defer` with `attempted: false`. `unpause` is guarded by `paused_reason IS NOT NULL`, and the job key is `outbound:<write>:<seq>`, so a held write is sent once. `redispatch` is guarded by `state = 'pending' OR (sending AND claimed_at < staleBefore)`, so a `sent` or `failed` write is never sent again. A stale `sending` claim adds 1 attempt, and `MAX_SEND_ATTEMPTS` (6) stops it. A race between a pause and a resume (resume lists before the pause commits) is caught by the sweep's `kill_switch AND paused_at IS NULL` branch. |
| 3 | RL-3 | PASS. The two governor packages depend only on `@omnibridge/core`. `.dependency-cruiser.cjs` rules `governors-share-nothing`, `governors-no-core-retry-helper`, `providers-do-not-import-governors` and `kit-carrier-backoff-only-carriers`, plus the planted-import cruise in `tests/arch`. The worker routes `carrierBackoff` only for `CAPPED_PROVIDERS` (website, evri, dpd) and `withAmazonBackoff` only for amazon. eBay gets no retry wrapper. |
| 4 | RL-2, EBAY-8 | PASS. `app.ebay_budget_reserve` makes one guarded `UPDATE … WHERE (calls + n) * 100 <= cap * percent`. Under READ COMMITTED, concurrent callers re-check the guard on the locked row, and the 50-way test proves it. It reserves in `admit`, before every call (the token call too, under `identity.user_token`). Urgent work uses 95 and everything else 80, checked by `percent IN (80, 95)`. The 80% notice fires only on the call that crosses it (calls only grow), and `raisePlatform` dedupes it by API and Pacific day. |
| 5 | SAFE-1 | PASS. 32 random bytes, stored as SHA-256 only, with a 10-minute TTL. `take` uses `SELECT … FOR UPDATE` and sets `used_at` in the request transaction, so a second confirm gets 409. The token is bound to the user, the action, the sorted `account_ids` and the params, and the confirm runs the stored values, not the body. `visible()` re-checks every account under RLS (permitted companies), or nothing runs. The isolation walk reaches it (`isolation.int.test.ts:363`, `:550`). |
| 6 | 0039 definers | PASS. All 5 have `SET search_path = pg_catalog, pg_temp` and schema-qualified names, `REVOKE … FROM PUBLIC`, and grant `ob_tenant_rw` (`outbound_maintenance_workspaces`, `maintenance_state`, `ebay_budget_reserve`) or `ob_auth` (`console_*`, each re-checks the admin). Cross-workspace reads return IDs and counts only. The usage write stays under the caller's workspace (RLS WITH CHECK, plus the composite FK on the account). The F-M05e-02 concern (ob_app presetting a GUC) does not apply: no 0039 definer reads a table whose GUC-gated policy another definer opens. |

The known follow-ups (carrier-cap timeout, Amazon 429 re-metering, token refresh race) are noted and not re-raised. F-M07-T0702-01 below is a different problem in the same file.

## F-M07-T0702-01 — Major — Carrier backoff sleeps an unbounded Retry-After inside the slot lease and the claim
Area: Rate limits, Correctness  IDs: RL-4, invariant 3 (claim), SAFE-2

Evidence:
- `packages/providers/kit/src/carrier.ts:78-81`: on a 429, `carrierBackoff` sleeps `err.retryAfterMs` exactly as the provider sent it. Only the computed backoff is capped by `maxMs`.
- `kit/src/respond.ts:5-12` accepts any Retry-After, in seconds or as a date.
- The sleep runs inside `withCarrierSlot` (`apps/worker/src/governor.ts:79-82`). That slot's lease is 120 s (`carrier.ts:44`) and is never renewed.
- `website.stock_push` is live in M07 (`apps/worker/src/outbound.ts`), and the website adapter uses `readJson` (`providers/website/src/index.ts:83`).

Failure: a website (or carrier, from M11) answers 429 with `Retry-After: 300`.
1. The worker sleeps 300 s holding a slot whose lease expires at 120 s, so a fifth request can take a slot. The RL-4 cap of 4 is exceeded.
2. With 2 waits (3 attempts) the send can outlive `OUTBOUND_STALE_MS` (10 min). The sweep then redispatches a write that is still in flight, so it is sent twice, and a turned-on kill switch is bypassed for that resend window.
3. A worker slot is tied up for minutes.

Required fix:
- In `carrierBackoff`, sleep only when the wait fits inside the lease, for example `min(retryAfterMs, maxMs)` with `maxMs` well under the 120 s TTL. If the provider asks for longer, rethrow the `RateLimited`, so `runOutboundSend` defers the write with that `retryAfterMs` (it already does at `outbound.ts:306-318`) and no slot or claim is held while waiting.
- Also keep the worst-case run of a send (attempts × (15 s timeout + wait)) under both the lease TTL and `OUTBOUND_STALE_MS`, and state that bound in a comment.
- Test, citing `[RL-4]`: a 429 with `Retry-After: 300` returns without sleeping and leaves the write deferred until then, with the slot released.

Resolution: (S3 fills in)

## F-M07-T0702-02 — Minor — The app-wide eBay cap is set by whichever caller passes it
Area: Rate limits  IDs: RL-2, EBAY-8

Evidence: `0039_outbound_governors.sql`, `ebay_budget_reserve`: `ON CONFLICT (api, day) DO UPDATE SET cap = excluded.cap WHERE b.cap <> excluded.cap`, with `p_cap` taken from the caller's `EBAY_DAILY_CAPS`.

Failure: during a rolling deploy, or once M15 reads caps from getRateLimits, two workers with different caps flip the shared row back and forth. A higher stale cap lets non-urgent work run past the real 80%. Nothing exceeds eBay today, because the caps are constants.

Required fix (M15, when caps become dynamic): store the cap once per API and day from the hourly getRateLimits read, and have reservations use the stored cap only. Never let a reservation raise it, or take `least(stored, passed)`.

Resolution: (S3 fills in)

## Completeness checklist (T-0701 and T-0702)

Every DONE line in `M07-end-report.md` was checked against the code:
- All 43 test titles it cites exist in the named files, and the 4 T-0702 integration files pass locally.
- Spot-checked code behind the scope lines:
  - six provider packages;
  - `ChannelAdapter`, `AdsAdapter` and `ShippingProvider` in `kit/src/adapters.ts`;
  - `app.add_origin_columns` (0037);
  - credential current and next slots (`db/src/credentials.ts`);
  - kill switch `adminOnly` on the Connections tab, with an audit row and resume in one transaction;
  - maintenance on `auth: 'platform'`, audited, resuming per workspace in its own transaction;
  - the 50-way budget test;
  - the RL-5 live usage route.
- The DEFERRED line (mocks checked against official OpenAPI models) was deferred by S1 on 21 Nov 2026 to M12, M15 and M18. It is a ruling, not a gap.

No scope or acceptance line is unbuilt, so there is no Major from this check.
