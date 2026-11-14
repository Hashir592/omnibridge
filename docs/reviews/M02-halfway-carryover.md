# M02 halfway carry-over (for the M02 end review)

From S3, 15 Nov 2026. Halfway flow (ADR-044): no round 2. Every Major and the Minors S1 assigned are fixed on branch `task/M02-halfway-fixes`; each fix, with its commit and test, is under `Resolution:` in `docs/reviews/M02-halfway-findings.md`.

## Fixes

| Finding | Commit | Proof |
|---|---|---|
| F-01 Major, reset token in logs | `a7a9047` | logger and web log-capture tests |
| F-02 Major, change-password with no lock | `a8fd4f3`, `4384c22` | `[USR-5][USR-3] a wrong current password counts toward the same lock as sign-in` |
| F-03 Major, auth definers open to every role | `eb51d7d` | ob_worker / ob_ops denial tests; session stage tests; seed and rewrap as ob_ops; fresh-volume stack with `[AT-3]` |
| F-04 forgot-password timing | `2e35ffa` | the 202 does not wait for any lookup |
| F-05 reset mail caps | `2e35ffa` | db and web cap tests |
| F-07 demo TOTP value | `c6c1198` | unit test pins the base32 value |
| F-08 `.claude/launch.json` | `c6c1198` | ignored by git and Prettier |
| F-10 dependencies, recipients | `c6c1198`, `4384c22` | Mailer recipient tests |

## Deferred (not in this PR)

- F-06 session and reset retention: T-0207.
- F-09 kit focus test: S2, fixed in PR #42.
- T-0204: invariant 4 ticks before any member user exists, with a walker test for a child with no ticks; USR-8 revoke on removal and the membership re-check; ADR-052 auth events placement.
- T-0206 (S5): the sign-in timing gap of Risk 4.
- T-0207 / M22: role connection caps against `max_connections` (now ob_app 30, ob_worker 20, ob_ops 4, ob_platform 4).

## Observations for S4

- **`session_advance` moves (ADR-051):** the ruling lists pre_mfa → signed_in → workspace and → platform. The function also allows the other moves the app makes:
  - pre_mfa → password_change (the password is older than 365 days)
  - pre_mfa → workspace (only one workspace)
  - workspace or platform → workspace or platform (the picker and the console)

  Every other move returns false.
- **ob_ops** can run `auth_user` instead of the sign-in lookup, so the seed checks for an existing demo user without ever reading a password hash.
- **The global reset ceiling** (100 a day) is what S4 asked for, but anyone who sends enough requests from many addresses can use it up for the day. Flagged for S5 (T-0206). Other options: a higher ceiling, or counting only real accounts.
- **Forgot-password backlog:** at most 64 requests are worked on after their 202. Beyond that the route still answers 202, but the request is logged and dropped.
- **Recipients:** a recipient the mailer refuses is skipped, not retried, and logged as `auth.mail_skipped` without the address.
- **Dev volume:** existing local volumes must be recreated once. Migration 0013 refuses to run with a clear message until the volume is recreated, because only `10-roles.sh` creates roles.
