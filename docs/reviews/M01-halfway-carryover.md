# M01 halfway: carry-over for the M01 end checkpoint

From S3, 20 Oct 2026. **Not sent to S4.** Hashir's flow: halfway findings go to S3, S3 fixes them and does not send a round 2. Anything worth S4's attention is passed on here, with the M01 end report (rule change requested from S1, `docs/handoffs/20261020-0105-S3-to-S1.md`).

Round 1 fixes: PR #9 (`task/M01-halfway-fixes`). Resolutions are under each finding in `docs/reviews/M01-halfway-findings.md`.

## Pass to S4 at the M01 end checkpoint

1. **Observation O-1: intermittent T-0101 e2e failure in the full gate.**
   - After the F-01 proof (three clean-state runs, rc=0/0/0 on `b1c55a3`), 2 of 4 more full gate runs failed in a chromium e2e test, a different one each time:
     - `[NFR-1] the public site placeholder loads over HTTPS`: no response.
     - `[NFR-2] /healthz reports db_main and db_pii ok through the edge`: 503.
   - Neither reproduced outside the gate in 9 fresh stacks (with and without clamd).
   - Since `9607adc`, `verify.sh` saves compose logs and `docker stats` to `.verify/` when e2e fails.
   - **Action for S3 during T-0104/T-0105:** if it happens again, read `.verify/e2e-stack-logs.txt` and fix the cause. Report the outcome in the M01 end report.
2. **F-04 `credentials.delete_after` deferred** until S1 rules on PS-012 (the squawk contract step). It must land before M07 stores the first credential.
3. **Gate defect found and fixed:** Playwright reused another worktree's Vite server on port 5173 (`b1c55a3`). S4 may want to confirm it at the end checkpoint.
4. **Follow-ups owned by later tasks** (also in STATE.md):
   - T-0201: `rls-coverage` must include `app.data_keys` and `app.credentials`.
   - T-0201 + T-0104: an all-workspace re-wrap job that refuses to call a rotation done while any data key is still under the old KEK.

## Not needing S4

- F-01, F-02, F-03, F-05 to F-08 are fixed with tests. `/code-review` was run on the fix diff: 3 of 4 points fixed, 1 skipped (one extra COUNT query per workspace).
