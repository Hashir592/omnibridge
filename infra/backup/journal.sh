#!/usr/bin/env bash
# Journal-only backup (T-0409, S5-20261118-01, ADR-068; invariant 10, DEL-2). From the repo root:
#   infra/backup/journal.sh              one run
#   infra/backup/journal.sh --every 900  a run every 15 minutes until stopped (the local scheduler)
# Ships the tombstone journal (IDs only) off-site soon after each deletion, not only with the
# nightly backup, so a host loss can undo at most the last 15 minutes of deletions (see the
# restore runbook). M22 schedules it every 15 minutes with a host timer.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

# Chained with &&: under `run_once || …` set -e is off, so a failed step must stop the run itself.
run_once() {
  restic_init main &&
    journal_backup &&
    echo "journal: backed up at $(date -u +%Y-%m-%dT%H:%M:%SZ)"
}

if [[ "${1:-}" == "--every" ]]; then
  interval="${2:?usage: journal.sh --every <seconds>}"
  while true; do
    # A failed run is reported and retried at the next tick; the loop keeps going.
    run_once || echo "journal: backup failed, retrying in ${interval}s" >&2
    sleep "$interval"
  done
else
  run_once
fi
