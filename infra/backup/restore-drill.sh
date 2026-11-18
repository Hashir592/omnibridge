#!/usr/bin/env bash
# Restore drill (T-0405; AT-8, AT-9, AT-24, DEL-2, CAP-10 RTO 8 h). From the repo root, with
# db-main and db-pii running and at least one backup taken (backup.sh):
#   infra/backup/restore-drill.sh
# Restores the latest backups into scratch databases on the running clusters (omnibridge_drill,
# omnibridge_pii_drill), never over the live ones, then:
#   1. re-applies every deletion to the restored PII store BEFORE anything reads it: db-pii's own
#      tombstones, db-main's copy (app.pii_tombstones) and the off-site journal, plus the
#      expiry re-run and closed workspaces (infra/backup/apply-tombstones.sql);
#   2. runs the AT-9 marker scan over the restored db-main and db-pii dumps, the stack's logs
#      (a marker the logger scrubbed still counts) and every message Mailpit captured, in full;
#   3. drops the scratch databases and fails if any step failed or it took over 10 minutes.
# The real restore (over the live databases) is docs/ops/runbooks/restore.md.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

START=$(date +%s)
MAIN_DB=omnibridge_drill
PII_DB=omnibridge_pii_drill
WORK="$(mktemp -d)"
psql_main() { "${COMPOSE[@]}" exec -T db-main psql -U postgres -v ON_ERROR_STOP=1 -q "$@"; }
psql_pii() { "${COMPOSE[@]}" exec -T db-pii psql -U postgres -v ON_ERROR_STOP=1 -q "$@"; }
cleanup() {
  psql_main -d postgres -c "DROP DATABASE IF EXISTS $MAIN_DB WITH (FORCE)" >/dev/null 2>&1 || true
  psql_pii -d postgres -c "DROP DATABASE IF EXISTS $PII_DB WITH (FORCE)" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

restore() {
  local service="$1" database="$2" which="$3" tag="$4" run=psql_main
  [[ "$service" == db-pii ]] && run=psql_pii
  "$run" -d postgres -c "DROP DATABASE IF EXISTS $database WITH (FORCE)" -c "CREATE DATABASE $database"
  restic_run "$which" dump --quiet --tag "$tag" latest "/$tag.dump" |
    "${COMPOSE[@]}" exec -T "$service" pg_restore -U postgres -d "$database" --exit-on-error
  echo "drill: $tag restored into $database"
}

restore db-main "$MAIN_DB" main db-main
restore db-pii "$PII_DB" pii db-pii

# The off-site journal as backed up (not the live volume): what a real restore would have.
# That is the latest journal-only run (journal.sh, every 15 minutes), so a deletion made after
# the nightly dumps is re-applied too (S5-20261118-01).
journal_restore "$WORK/journal"
JOURNAL_LINES="$(find "$WORK/journal" -name 'tombstones-*.jsonl' -exec cat {} + 2>/dev/null | wc -l)"

# db-main's tombstone copy (superuser: the drill reads every workspace).
psql_main -d "$MAIN_DB" -Atc \
  "COPY (SELECT workspace_id, pii_ref, run_id, channel_account_id, deleted_at FROM app.pii_tombstones) TO STDOUT WITH (FORMAT csv)" \
  >"$WORK/main-tombstones.csv"

{
  echo 'CREATE TEMP TABLE replay_journal (line text);'
  echo 'CREATE TEMP TABLE replay_main (workspace_id uuid, pii_ref uuid, run_id uuid, channel_account_id uuid, deleted_at timestamptz);'
  echo 'COPY replay_journal FROM STDIN;'
  find "$WORK/journal" -name 'tombstones-*.jsonl' -exec cat {} + 2>/dev/null || true
  printf '\\.\n'
  echo 'COPY replay_main FROM STDIN WITH (FORMAT csv);'
  cat "$WORK/main-tombstones.csv"
  printf '\\.\n'
  cat "$REPO_ROOT/infra/backup/apply-tombstones.sql"
} | psql_pii -d "$PII_DB" -At >"$WORK/replay.out"
echo "drill: tombstones re-applied (journal lines: $JOURNAL_LINES, db-main tombstones: $(wc -l <"$WORK/main-tombstones.csv"), records deleted: $(head -1 "$WORK/replay.out"))"

# AT-9: no PII marker anywhere outside the PII store's ciphertext.
"${COMPOSE[@]}" exec -T db-main pg_dump -U postgres "$MAIN_DB" >"$WORK/db-main.sql"
"${COMPOSE[@]}" exec -T db-pii pg_dump -U postgres "$PII_DB" >"$WORK/db-pii.sql"
"${COMPOSE[@]}" logs --no-color >"$WORK/logs.txt" 2>&1 || true
sources=("$WORK/db-main.sql" "$WORK/db-pii.sql" "$WORK/logs.txt")
# Every captured message in full (headers and raw body), not the list's short snippets
# (S5-20261118-03).
# Mailpit reachable but not fully read fails the drill; no Mailpit (not dev) skips mail.
if curl -fsS --max-time 5 'http://127.0.0.1:8025/readyz' >/dev/null 2>&1; then
  node "$(host_path "$REPO_ROOT/infra/backup/mailpit-raw.mjs")" http://127.0.0.1:8025 >"$WORK/mail.eml"
  sources+=("$WORK/mail.eml")
else
  echo "drill: Mailpit not reachable on 127.0.0.1:8025; mail not scanned"
fi
scan_args=()
for source in "${sources[@]}"; do scan_args+=("$(host_path "$source")"); done
node "$(host_path "$REPO_ROOT/scripts/lib/marker-scan.mjs")" "${scan_args[@]}"

ELAPSED=$(($(date +%s) - START))
echo "drill: done in ${ELAPSED}s"
if ((ELAPSED > 600)); then
  echo "drill: FAIL, over the 10-minute target" >&2
  exit 1
fi
