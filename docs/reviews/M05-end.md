# M05 end review (S4, 21 Nov 2026)

Reviewed: all of M05 on `main` at `419dc20` (PR #127 merge). S3: T-0411 (#107), T-0501 (#108), T-0502 (#109), T-0503 (#110), T-0504 and T-0505 (#117), T-0507 (#124), T-0412 (#125). S2: T-0311 (#113), T-0312 (#114), T-0313 (#120), T-0315 (#127). S5: `security/20261121-findings.md` (-01, -02 fixed, re-checked in #126).
**Verdict: APPROVED** (0 Blockers, 0 Majors, 2 Minors). The Minors become follow-ups and do not block. This is the last review under the old rules (ADR-077 from M07).

## Evidence

- **Gate (ADR-054):** CI run 44814278353 on `419dc20` is green, and so are the merge runs before it (44812102682 `ecdc148`, 44811346471 `f2a2c97`, 44811250928 `eca0d06`). Every PR in scope has a green `verify (full gate)` check. The S3 PRs ran every lane; the S2 PRs ran the UI lane.
- **My local run:** `scripts/verify.sh --quick` on `419dc20` in a clean worktree: PASS in 330 s (lint, typecheck, openapi, unit).
- **Probes (break it on purpose, throwaway worktree, never committed):**

| What I broke | Result |
|---|---|
| The PLAT-3 platform walk accepts any status (`route-walker.ts:212`) | `route-walker.test` "[PLAT-3] a platform route refused by mistake (403) fails the walk" fails |
| A platform route answers an `email` field (`routes/platform.ts`) | `platform.test` "[PLAT-3] every platform route answers only allowlisted fields" fails |
| Notification params accept any string, not only UUIDs (`core/notifications.ts`) | `notifications.test` "[NTF-1] a notification holds IDs, counts and flags only" fails |
| Platform event window cut from 24 h to 15 min (`worker/security.ts:207`) | No unit test fails. It is covered by `security.int.test.ts` "[SEC-12] a console entry 2 hours old, missed by earlier sweeps, still raises (24-hour window)" and the lockout case in the next test. Those are integration tests, which CI runs; I did not run them locally on this 7.9 GB host. |

- **Catalog probe (live dev db-main, superuser read-only):** I listed every `SECURITY DEFINER` function that `ob_app` may execute and that reads `workspaces`, `memberships`, `channel_accounts`, `job_records`, `credentials` or `deletion_runs` (the six tables with 0033's console policies). Each one outside the console set filters by workspace or user explicitly. None relies on RLS alone (see F-M05e-02).

## The five checks S1 asked for

1. **M04 end Minors, all closed:**
   - **F-M04e-01 and -02 (T-0411, T-0311):** `stuckCondition` (`packages/db/src/erasure.ts:29`) covers a confirmed request with no job after the 2-minute grace, or whose `pii.delete` job is not live (failed, cancelled, gone). `retry` accepts failed or stuck, otherwise 409 (`privacy.ts:215-230`), with a new key `<id>:retry<n>` (ADR-071 1). Tests: `privacy.int.test.ts:639`, `:672`, `:703`; UI `buyer-data.spec.ts:125`, mock `privacy.test.ts:160`. The UI shows Retry for `failed || stuck` (`buyer-data.tsx:689`).
   - **F-M04e-03:** the `truncated` branch is gone from `buyer-data.tsx`.
   - **F-M04e-04 (T-0412):** `packages/testkit/fixtures/buyer-identifier-cases.json` is read by `packages/contract/src/identifier-cases.test.ts` (the schema) and by `apps/ui/src/mocks/privacy.test.ts:177`. That test checks both `pinsOneBuyer` (now `apps/ui/src/lib/pinsOneBuyer.ts`) and the MSW mock's 400.
2. **PRD IDs:** each is proven by test titles that cite it:

   | ID | Titles | Examples |
   |---|---|---|
   | NTF-1 / NTF-2 / NTF-3 / NTF-4 / NTF-5 | 15 / 9 / 4 / 9 / 4 | `notifications.int.test.ts:169`, `:265`; `notify-mail.int.test.ts:223` |
   | MAIL-3 | 2 | `notify-mail.int.test.ts:263` (no record contents, marker never reaches mail) |
   | SEC-12 | 17 | `security.int.test.ts` (workspace and platform rules) |
   | PLAT-1 / PLAT-2 / PLAT-3 / PLAT-4 | 19 / 26 / 4 / 13 | `isolation.int.test.ts:593`; `platform.test.ts:96`; `app-secrets.int.test.ts:60-135`; `auth.int.test.ts:1699` |
   | OPS-6 | 1 | `platform-console.int.test.ts:245` (once per admin and day, counts only, marker scan) |

   SEC-12's 12-month retention and two-weekly review are M22 (ADR-071 4f, out of scope).
3. **Rulings in the code:**
   - **ADR-070:** the stuck rule as above. The dead-letter sweep idea is dropped.
   - **ADR-071:**
     - retry key per retry.
     - Severities as ruled in `NOTIFICATION_TYPES`.
     - Thresholds fire at or above. Defaults are 5 / 10 / 50, and the env values are checked (`worker/security.ts:34-55`).
     - The 90-day purge of resolved notices only (`0033:350-385`, workspace and platform).
   - **ADR-073:**
     - One usage table `app.api_usage_daily` keyed by `day`, with `providerDay` (`core/time.ts:81-113`; eBay on US Pacific, the others on UTC).
     - The console allowlist reads `request.ip` through Fastify `trustProxy` from `TRUSTED_PROXIES` (`app.ts:169`, `auth/service.ts:251`). An empty list denies.
     - Archive is final (`0033:14`; the walk's `setWorkspaceModules` after archive is 409).
   - **ADR-075:** `workspaces()` reads `platformAdmin && mfaConfirmed` fresh on each call (`auth/service.ts:933-943`). The console gate re-reads both on every request (`:227-248`).
   - **ADR-076:**
     - `enterPlatform` records `platform.console_entered` with the IP (`auth/service.ts:956-969`).
     - A sign-in that ends at the picker records `auth.login`.
     - The platform rule: critical new network (IPv4 /32, IPv6 /64, 90-day lookback, never the first entry; `0035:76-104`); warnings for failures at the threshold in 15 min and for each lockout.
     - Entries and lockouts are read over 24 h (`worker/security.ts:207`).
     - The workspace rules skip platform admins.
     - `session_advance` takes the workspace `FOR SHARE` (`0035:177`).
     - The 30-minute console idle limit is tested (`auth.int.test.ts:1507`).
4. **Invariants:**
   - **No PII in notifications, emails, digest or job payloads:** params are UUIDs, finite numbers or booleans only. Record IDs are a UUID, a time slot or a number, and titles come from the registry (`core/notifications.ts`, probed above). Emails carry the title and a link only (MAIL-3 test, marker scan). The digest carries counts only (OPS-6 test, `scanTextForMarkers`). Security alerts carry IDs and counts (`security.int.test.ts` "[SEC-12] alert rows hold IDs and counts only").
   - **Platform tables only through definers:** `platform_notifications`, `platform_notification_reads`, `platform_notification_emails`, `platform_settings`, `platform_audit_events`, `platform_digests` and `app_secrets` are `FORCE RLS` with an `ob_owner`-only policy, and `REVOKE ALL … FROM PUBLIC, ob_tenant_rw`. `api_usage_daily` is a tenant table (RLS by workspace) with an owner-only console read.
   - **App secrets:** ciphertext only, sealed to the name (AAD). There are write-only routes, the value is wrapped in `Secret` (`platform.ts:483-488`), and the audit holds the name and slot only. Proven by `app-secrets.int.test.ts:60`, `:124`, `:135` and `auth.int.test.ts:1699` (no route, log or audit row holds a value).
5. **PLAT-3 walk and field allowlist:** the contract has 26 `/platform` paths. Every one uses `auth: 'platform'`, and the walk's call map names all 26. The walk asserts set equality with every `auth === 'platform'` route and requires a 2xx or the declared status (409, 404, 409), with B's business markers absent. The static allowlist (`packages/contract/src/platform.test.ts`) covers every response schema of every platform route.

**`squawk-ignore` waivers (ADR-045):** one in M05. `0035:23-25` drops the old `auth_events_action_check`, which `auth_events_action` replaces. That constraint is added just above as a strict superset (`NOT VALID`, enforced for new rows, validated in 0036). The `-- waiver:` line is present and cites ADR-076. 0030 to 0034 and 0036 carry none.

## Minor findings (follow-ups; none blocks)

## F-M05e-01 — Minor — Event security notices never resolve, so the 90-day purge never removes them
Area: 1 Correctness, 6 Performance  IDs: NTF-1, SEC-12 (ADR-071 4a)
Evidence:
- The event rules raise one notice per event: workspace `security.unusual_login`, `security.account_locked` and `security.canary_read`, and platform `security.platform_unusual_login` and `security.platform_account_locked` (`apps/worker/src/security.ts:14-16`, `:253-269`). Nothing ever resolves them. Only the counter rules call `resolve` (`:122`, `:246`).
- The purge deletes only rows with `resolved_at < cutoff` (`packages/db/migrations/0033_platform_console.sql:350-385`). These notices and their read and email rows stay forever, and they stay in the centre's unread/read lists for good.
- Volume is low today (one per event). It grows with every new network and lockout, and the M08/M09 event types will follow the same pattern.

Required fix (S1 to rule, then S3, light): an event notice resolves itself when its event leaves the rule's window (for example, 7 days after the event, in the security sweep), so the 90-day purge reaches it. Add a test that an event notice is resolved after the window and purged 90 days later.
Resolution:

## F-M05e-02 — Minor — The console's `app.platform_console` setting can be preset by the caller; only explicit filters in the other definers keep it harmless
Area: 2 Tenancy, 9 Invariants  IDs: PLAT-3, TEN-1 (invariant 1)
Evidence:
- 0033 adds `FOR SELECT TO ob_owner USING (current_setting('app.platform_console', true) = 'on')` on six tenant tables (`0033_platform_console.sql:20-34`). A transaction-local setting can be set by `ob_app` itself (`SET LOCAL app.platform_console = 'on'`) before it calls any definer owned by `ob_owner`.
- Today this opens nothing. My catalog probe found that every `ob_app`-callable definer reading those tables filters by workspace or user in its own WHERE clause. Examples: `member_scope`, `is_co_member`, `notification_email_recipients`, `auth_user_workspaces_modules` (by user, then one workspace), `invite_accept`, `session_advance`.
- A future definer that relies on RLS alone for its workspace scope would read every workspace's rows when called after that `SET LOCAL`. The same holds for 0031's `app.platform_notice_mail` on `app.users`. Nothing tests for it.

Required fix (S3, light): a catalog test in `packages/db`. For every `SECURITY DEFINER` function that `ob_app` can execute, and whose body reads one of the tables carrying a `*_platform_console` policy, it asserts the function is either a console definer (calls `app.console_require`) or sets `app.platform_console` to `''` on entry. Alternatively, add one line to ARCHITECTURE 6.8 ("definers never rely on RLS alone for workspace scope") plus the test. No change to the console design.
Resolution:

## Accepted, not raised (S1 rulings or earlier decisions)

- Notification email is at-least-once (ADR-071 4d). Platform admins have no email preferences (4e). A failed alert insert rolls back the failed state (4c).
- `enterPlatform` advances the session and then records the entry in a separate step. If the record fails, the request fails and the new token never reaches the browser (S5-20261121-01 resolution, re-checked by S5).
- `public_signup` is stored only (T-0205). The platform-audit read route is M21, the eBay keyset moves into the store in M15, and LWA reminders are M18 (ADR-073 4).
- Production allowlist, `TRUSTED_PROXIES`, Caddy settings and SEC-12 log retention are M22 (out of scope).

## Notes for later

- My M04 note listed `ebay.account_deletion.too_large` as an alert candidate. It is still a log event only, and ADR-071 did not list it. S1 may place it with M15 (eBay).
- The picomatch audit exception expires on 1 Dec 2026 (PS-026).
- Under ADR-077, from M07 the next S4 review is the first critical PR or the first milestone.
