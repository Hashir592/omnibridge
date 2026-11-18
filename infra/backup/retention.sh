#!/usr/bin/env bash
# Retention (T-0405, ADR-016, P-010). Production runs this only from the protected GitHub
# Actions `backup-admin` environment (M22): the server's own keys cannot delete. Locally it
# keeps the drill repositories the same shape.
#   main db-main: 7 daily + 4 weekly + 6 monthly
#   main journal: 6 monthly (IDs only; it must outlive every main snapshot it may be applied to)
#   pii  db-pii:  3 daily, so with the live copy gone at day 25 no copy survives day 30 (DEL-2)
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

restic_run main forget --quiet --tag db-main --group-by tags \
  --keep-daily 7 --keep-weekly 4 --keep-monthly 6 --prune
restic_run main forget --quiet --tag journal --group-by tags \
  --keep-daily 31 --keep-monthly 6 --prune
restic_run pii forget --quiet --tag db-pii --group-by tags --keep-daily 3 --prune
restic_run main check --quiet
restic_run pii check --quiet
echo "retention: done"
