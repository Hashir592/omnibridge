#!/usr/bin/env bash
# Nightly backup (T-0405; SEC-11, CAP-10 RPO 24 h, ADR-016). From the repo root:
#   infra/backup/backup.sh
# 1. db-main: pg_dump (custom format) streamed into the main repository, tag db-main.
# 2. db-pii:  pg_dump streamed into the PII repository, tag db-pii (fields are ciphertext; the
#    master key is never in a backup, invariant 9).
# 3. The off-site tombstone journal (pii_journal volume, IDs only) into the main repository,
#    tag journal, so a restore can always re-apply every deletion (invariant 10). journal.sh also
#    ships it every 15 minutes between nightly runs (S5-20261118-01).
# Never backed up: the vault's label files, the files volume, keys or secrets.
# The server's keys cannot delete: forget and prune run only from retention.sh (ADR-016).
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

restic_init main
restic_init pii

dump() {
  local service="$1" database="$2" which="$3" tag="$4"
  "${COMPOSE[@]}" exec -T "$service" pg_dump -U postgres -Fc "$database" |
    restic_run "$which" backup --quiet --host omnibridge --tag "$tag" \
      --stdin --stdin-filename "$tag.dump"
  echo "backup: $tag done"
}

dump db-main omnibridge main db-main
dump db-pii omnibridge_pii pii db-pii

# The journal volume exists once pii-vault has run; an empty one is created if not.
journal_backup
echo "backup: journal done"
