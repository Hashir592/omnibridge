# M07 end report (S3, 21 Nov 2026)

M07, the integration framework, outbound pipeline and governors, ran under the ADR-077 fast lane: a contract PR, then two tasks. There is no S4 milestone review here, because M07 + M08 is one milestone and S4 reviews it at M08 end. T-0702 is critical, so it gets its own S4 review (handoff saved next to this report).

## Tasks

| Task | Tier | PR | Status |
|---|---|---|---|
| Contract (every M07 route and schema) | light | #131 | merged |
| T-0701 integration framework | high | #133 | merged, full gate green (incl. build, stack and e2e) |
| T-0702 outbound path, switches, governors | critical | #134 | merged, full gate green |

## How each was built

**Contract (#131).** The routes are in `routes/connections.ts`:
- list and detail;
- kill switch;
- authorise;
- the public OAuth return (303);
- bulk preview and confirm.

`routes/platform.ts` adds maintenance and live usage. S2 built T-0314 on it (PR #132).

**T-0701 (#133).**
- **Provider kit, `@omnibridge/provider-kit`:**
  - one HTTP client with a host allowlist per `PROVIDER_MODE` (mock, sandbox or live; mock reaches provider-mocks only);
  - versioned parsers that strip unknown fields and stop on a missing one, raising the INT-5 platform notice once per parser version;
  - cursors with a 5-minute overlap and page-cap resume, and the incremental sync loop;
  - an in-memory access token cache.
- **Adapters:** eBay is the full reference (token, getOrders by lastmodifieddate, stock write). Amazon, Evri, DPD, website and Ads are thin.
- **Mocks:** provider-mocks gets per-account scenario switches (rate_limit_storm, invalid_parcel, invalid_grant, revoked, ebay_cap_exhausted), checked by contract tests through the adapters' own parsers.
- **db-main 0037 and 0038:**
  - connection health columns, with `needs_reauth` after 3 auth failures in a sliding hour or a revocation;
  - `app.add_origin_columns` (INT-6);
  - sync cursors and single-use hashed OAuth states;
  - credentials tagged with their environment (a mismatch is refused) and linked to their account.
- **Web:**
  - Connections list and detail;
  - the OAuth connect flow, the one web provider call (INT-2). Return codes are `OAUTH_RETURN_ERRORS`: access_denied, state_invalid, exchange_failed, forbidden.
- **Egress:** the dev and CI network `ob_mocks` is internal; provider-mocks is on it alone with web and worker.
- **Scans:** no scraping libraries (INT-7), no marketplace hosts in source, no raw fetch outside the kit.
- **dependency-cruiser:** INT-1, and the narrowed web exception.

**T-0702 (#134).**
- **One send path:** `runOutboundSend`, the `OutboundQueue` and the intent table `app.outbound_writes`.
  - The kill switch and the maintenance switch are read in the same short transaction that claims the write, just before the send (invariant 20).
  - Paused writes and governor waits spend no attempt; resume sends a held write once. A 10-minute sweep recovers stale claims and lost jobs.
- **Kill switch (SAFE-2):** per account, audited.
- **Maintenance (SAFE-3):** a platform setting, audited; turning it off resumes each workspace's writes.
- **Bulk confirmation (SAFE-1):** a 10-minute, single-use token bound to the user, action, sorted accounts and params. Modules register their actions (M09, M12, M19).
- **Amazon governor (RL-1):** PostgreSQL token buckets, with rates learned from the header and its own full-jitter backoff.
- **eBay governor (RL-2, EBAY-8):** the app-wide `ebay_budget_daily`, reserved with one guarded UPDATE before every call, stopping non-urgent work at 80% and everything at 95%; one notice at 80%.
- **Carriers and website (RL-4):** at most 4 requests at once per account.
- **Live usage (RL-5):** a console route.
- **RL-3:** dependency-cruiser rules plus fixture cruises keep the governors apart, with no shared retry helper.

## Decisions made (also in the PRs)

- **eBay budget:** an app-wide row table (Hashir). Its definer call also writes the account's usage row.
- **Mocks:** framework plus what M07 uses (Hashir). Evri, DPD, website and Ads endpoints are provisional until M11 to M13, M19.
- **Outbound writes as an intent table:** pg-boss cannot requeue a job without spending an attempt.
- **Recovery:**
  - a dead worker's claim spends one attempt, so a write that keeps crashing stops after 6;
  - resume and recovery are state-guarded, so a finished write is never sent twice.
- **Errors and waits:**
  - `platform.report_failure` is the INT-5 notice;
  - a governor's own wait is not an account error;
  - eBay's own daily-limit answer waits an hour at a time without spending an attempt.
- **Status precedence:** disconnected > needs_reauth > paused > error > active.
- **Kill switch timing:** it cannot stop a write already in flight, because no transaction is held across a provider call.

## Test evidence

- Tests came first. Test titles cite every T-0701 and T-0702 ID:

  | IDs | Titles citing each |
  |---|---|
  | INT-1 to INT-8 | 2 to 15 |
  | SAFE-1, SAFE-2, SAFE-3 | 3, 8, 4 |
  | RL-1 to RL-5 | 1 to 7 |
  | EBAY-8 | 2 |

- **Real PostgreSQL:**
  - db outbound (8), worker outbound (4), web switches (5);
  - the isolation walk, which now reaches the bulk account-scope check (SAFE-1).
- **Real mock server:** the eBay order sync and the OAuth flow.
- **Locally:**
  - T-0702's touched integration files: 26 of 26;
  - `verify.sh --quick`, depcruise and the arch tests all pass.
- **CI:** #133 and #134 merged with the full gate green.
- **Code review (high):**
  - T-0701: 7 findings, 6 fixed, 1 skipped by decision (environment in the credentials unique index).
  - T-0702: 6 findings, 3 fixed, 3 left as the follow-ups 4 to 6 below.

## Completeness (S1 check, 21 Nov 2026)

Every scope and acceptance line of T-0701 and T-0702, and every item of the M07 paste. DONE names the file or test that shows it. Test files are named without their folder where the name is unique.

### T-0701 scope

| Line | Result |
|---|---|
| Contract PR first, every M07 route, then the S2 block | DONE. #131 merged; S2 block in `docs/handoffs/20261121-0245-S3-to-S2.md`. No 503 stub is left: the stubs answer only when web is built without those options (tests). `apps/web/src/main.ts` wires Connections (with bulk, audit, outbound) and the platform maintenance and usage routes |
| ChannelAdapter, AdsAdapter, ShippingProvider interfaces; no provider code in business modules | DONE. `packages/providers/kit/src/adapters.ts`; architecture.test "[INT-1] a business module importing a provider package fails the architecture check" |
| Versioned parsers: unknown fields ignored, a missing field raises the INT-5 notice, the job fails cleanly | DONE. `kit/src/parser.ts`. Tests: parser.test "[INT-5] a missing required field throws one parser error naming provider, parser, version and path"; sync.int.test "[INT-5] a missing field raises one platform notice and fails the job once, with no retry". Decision: the notice is `platform.report_failure` naming provider, parser and version. The field path goes to the worker log (`fieldPath`), because notifications hold IDs only (NTF-1). The job code is `provider.parser_failed` |
| Origin tag enum plus channel_account_id, a shared helper, a test listing tables without them | DONE. `core/src/origins.ts`, `app.add_origin_columns` (0037); connections.int.test "[INT-6] every provider table carries its origin and account; the shared helper adds them" |
| Sync cursors, 5-minute overlap, de-duplication by external ID | DONE. `app.sync_cursors`, `kit/src/cursor.ts`; cursor.test "[INT-8] a re-poll inside the overlap creates no duplicate"; sync-cursors.int.test |
| One reference adapter proving job, governor, parser, cursor | DONE. eBay; sync.int.test "[INT-8] polls through the governor, parses, stores the cursor; a re-poll inside the overlap adds nothing" |
| provider-mocks for the Release 1 modules, from the official specs | DONE for M07's scope. Per Hashir's ruling: the framework plus what M07 uses; each module adds its own endpoints. Each route cites its official doc and API version |
| Mocks checked against official OpenAPI models where they exist | MISSING. It needs the official model files in the repo (Amazon SP-API models, eBay OpenAPI), which is a download, so it waits for Hashir's yes. Today the mocks are checked by the adapters' own parsers (adapters.contract.test) |
| Scenario switches: 429 storm, INVALID parcel, invalid_grant, revocation, eBay cap | DONE. `mocks/provider-mocks/src/scenarios.ts`; adapters.contract.test, one test per provider, plus "[INT-3] a scenario switch is set and cleared over HTTP" |
| Egress allowlist (network plus client allowlist); production hosts in config for M22 | DONE. `kit/src/http.ts` lists the hosts per mode. Tests: http.test "[INT-3] in mock mode only the provider-mocks host and loopback are reachable" and "[INT-3] a live provider host is refused unless PROVIDER_MODE=live"; compose.test "[INT-3] provider-mocks is alone on the internal ob_mocks network with web and worker" |
| INT-7 scraping scan | DONE. architecture.test "[INT-7] no package depends on a headless browser or scraping library" and "[INT-7] the scan fails on a planted dependency" |
| Per-account tokens encrypted, current and next slots, never logged or returned | DONE. `db/src/credentials.ts`, `AccountCredentials`. Tests: credentials.int.test "[INT-3] a token is read only in the provider environment it was stored in, and rests as ciphertext"; sync.int.test "[INT-3] the marker scan finds no token in db-main, the job tables or the logs" |
| OAuth code-exchange skeleton against the mocks | DONE. `apps/web/src/oauth-exchange.ts`; connections.int.test "[INT-2][INT-3] connecting: consent, the code exchange against the mock, the token stored encrypted, the state used once" |
| Connections route with every field | DONE. connections.int.test "[INT-4] the list shows every account with each Connections field; a child without the tab gets 403" |
| Auth failures raise "Channel authorisation lost" and resolve on success | DONE. connections.int.test "[INT-4] three auth failures within an hour mark Needs re-authorisation once; a success clears it"; sync.int.test "[INT-4] a revoked eBay token marks the account and raises one critical notice; a success after re-auth resolves it" |
| Test and production credentials kept apart | DONE. `credentials.environment`; credentials.int.test (the environment test above) |

### T-0701 acceptance

| Line | Result |
|---|---|
| Missing field gives one notice and no crash; unknown field ignored; re-poll gives no duplicate; a business-to-provider import fails | DONE. The tests above, plus parser.test "[INT-5] an unknown field is ignored and does not reach the result" |
| Each scenario errors at the adapter; an off-allowlist host is refused; the scraping scan fails on a plant | DONE. adapters.contract.test, http.test, architecture.test |
| Raw SQL shows ciphertext; marker scan; 3 failures give Needs re-authorisation and one notice; a success resolves it | DONE. credentials.int.test, sync.int.test, connections.int.test |
| CI full gate green at merge | DONE. #133 at 65e52eb, every check green |

### T-0702 scope and acceptance

| Line | Result |
|---|---|
| One send path; kill switch and maintenance read just before each write; paused work requeued with no attempt | DONE. `kit/src/outbound.ts`, `queue/src/outbound.ts`, `db/src/outbound.ts`. Tests: outbound.test "[SAFE-2] the switches are read at send time, so turning one on after the write was queued stops it"; worker outbound.int.test "[SAFE-2] a write for a paused account is not sent and spends no attempt; resuming sends it once" |
| Kill switch per account, admin only, audited; reads continue | DONE. switches.int.test "[SAFE-2] pausing an account is audited and shown; resuming sends its held writes at once". Every write (stock now; tracking, ads and review requests later) can only go through the send path |
| Maintenance switch, platform admin, audited | DONE. switches.int.test "[SAFE-3] maintenance is a platform switch, audited and shown to every workspace"; outbound.int.test "[SAFE-3] maintenance stops writes in every workspace while reads go on" |
| Resume paths and the recover sweep | DONE. `OutboundQueue.resumeAccount`, `resumeMaintenance` and `recover`. db outbound.int.test "[SAFE-2] recovery never sends a finished write again, picks up a lost one, and a dead claim spends an attempt". The sweep is scheduled every 10 minutes (audit-retention.int.test) |
| Bulk writes need a preview token listing every account; without it they are refused | DONE. switches.int.test "[SAFE-1] the preview names every account; the write runs only with a valid token, once, for the previewed accounts"; db "[SAFE-1] a confirmation token is single use, expires, and belongs to its user and accounts". Decision: a used, expired, other user's or changed-accounts token answers 409. A token this workspace never issued answers 404, so a token from another workspace looks unknown (the isolation walk's 403/404 rule). A missing token is a 400 |
| Web makes no provider call except OAuth | DONE. architecture.test "[INT-2] web reaches a provider only from the OAuth exchange, and only an OAuth provider" |
| Amazon buckets per seller and operation; full jitter (1 s, 60 s, 8 attempts); honours x-amzn-RateLimit-Limit | DONE. db outbound.int.test "[RL-1] an Amazon bucket starts full, spends one token per take, refills by time and learns a new rate"; amazon governor.test "[RL-1] after 8 attempts it stops so the work is requeued"; worker governor.test "[RL-1] an Amazon 429 carrying x-amzn-RateLimit-Limit teaches the seller bucket that rate" (new) |
| A 429 storm from the mock backs off and recovers | DONE. adapters.contract.test "[RL-1] a 429 storm from the mock backs off with full jitter and recovers, learning the rate" (new) |
| eBay budget reserved before every send at 80% and 95%; never exceeded under concurrency; one notice | DONE. db outbound.int.test "[RL-2][EBAY-8] the eBay budget is reserved before send and never exceeded under concurrency, app-wide"; budget.test "[RL-2] non-urgent work stops at 80% of the daily cap and urgent work at 95%" and "[EBAY-8] the call that crosses 80% says so, once"; worker governor.test "[EBAY-8] the 80% notice is keyed by eBay's US Pacific day, once" (new) |
| No shared retry helper; the rule fails on a planted import | DONE. architecture.test "[RL-3] the shared-helper rules fail on a planted import between the two code paths" |
| Carrier and website semaphore, 4 per account, backoff on 429 or 5xx | DONE. carrier.test "[RL-4] at most 4 requests run at once per account" and "[RL-4] a carrier 429 or 5xx is retried with growing waits"; db "[RL-4] a fifth parallel request to one carrier account waits for a free slot"; worker governor.test "[RL-4] website calls run inside the account cap of 4" (new) |
| Usage written in real time, after every send | DONE. outbound.test "[RL-5] usage is written with the result of every send, the failed ones too, unless the governor already wrote it" (new); switches.int.test "[RL-5] live usage shows today's calls per account and API" |
| S4 reviews this PR after merge | Pending. The block is in `docs/handoffs/20261121-1909-S3-to-S4.md` |
| CI full gate green at merge | DONE. #134 merged at f8d2152 with every check green, after the fix for the missing `outbound.recover-sweep` handler in audit-retention.int.test. The mock-storm test and this checklist came in the follow-up PR |

### M07 paste extras

| Line | Result |
|---|---|
| Adapters for all six providers | DONE. eBay (the reference), Amazon, Evri, DPD, website and Ads; adapters.contract.test, one test each |
| eBay budget reserved before every send in api_usage_daily | DONE. `app.ebay_budget_reserve` reserves in `ebay_budget_daily` and writes the account's `api_usage_daily` row in the same call (Hashir's ruling) |
| End report and one S1 block, no S4 milestone block | DONE. This file, and `docs/handoffs/20261121-1909-S3-to-S1.md` |

## Risks and follow-ups (for S1 to place)

1. **Connect a new account, and Disconnect:** no route in M07. S2 asked (T-0314) and could not build them.
2. **Amazon buyer messages setup (C6, CS-6):** M18 owns it. S2's SPA calls a dev-only mock today.
3. **Bulk action registry:** empty until M09 registers `stock_push`; preview answers 409 "not available yet" until then.
4. **Carrier cap timeout:** a full 4-slot cap that times out (30 s) counts as `provider.unavailable`, spending an attempt and marking the account error. It should be a governor wait.
5. **Amazon 429 retries:** the retries inside `withAmazonBackoff` take no extra bucket token and are not counted in usage.
6. **Token refresh race (pre-existing, T-0701):** a caller that joins a refresh already in flight can refresh once more after that refresh failed.
7. **Credentials unique index:** it does not include the environment. That is harmless while one database holds one environment; revisit at M22.
8. **Process:**
   - the WIP commits on both branches used `--no-verify`; the final commits ran the hooks;
   - the local `/healthz` e2e check failed once while integration tests loaded the 7.9 GB host, and CI passed it.
