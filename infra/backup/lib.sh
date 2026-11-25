# Shared settings for the backup, retention and restore scripts (T-0405, ADR-016). Sourced, not run.
#
# Two restic repositories with separate passwords (and, on B2, separate buckets and keys):
#   main: db-main dumps and the off-site tombstone journal (IDs and MACs, no values)
#   pii:  db-pii dumps only (ciphertext; 3 daily snapshots, P-010)
# The vault volume (label files, M12) and the files volume are never backed up here.
#
# Local (dev, CI, drills): both repositories are directories under $BACKUP_DIR, standing in for
# B2, with dev passwords made on first use. Production (M22): set RESTIC_MAIN_REPOSITORY and
# RESTIC_PII_REPOSITORY to b2:<bucket>:<path>, RESTIC_MAIN_PASSWORD_FILE and
# RESTIC_PII_PASSWORD_FILE to the secret files, and B2_ACCOUNT_ID / B2_ACCOUNT_KEY per bucket
# (hide-only application keys, see infra/backup/b2.md).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMPOSE_PROJECT="${COMPOSE_PROJECT:-omnibridge}"
COMPOSE=(docker compose -p "$COMPOSE_PROJECT" -f "$REPO_ROOT/infra/compose/compose.yaml")
# ADR-016: restic 0.19.1.
RESTIC_IMAGE="${RESTIC_IMAGE:-restic/restic:0.19.1}"
BACKUP_DIR="${BACKUP_DIR:-$REPO_ROOT/.backup}"
JOURNAL_VOLUME="${JOURNAL_VOLUME:-${COMPOSE_PROJECT}_pii_journal}"

# Git Bash on Windows rewrites /paths in docker arguments; keep them as written.
export MSYS_NO_PATHCONV=1

host_path() {
  if command -v cygpath >/dev/null 2>&1; then cygpath -w "$1"; else printf '%s' "$1"; fi
}

# The repository and password file of `main` or `pii`.
repo_of() {
  local which="$1" var="RESTIC_${1^^}_REPOSITORY"
  printf '%s' "${!var:-$BACKUP_DIR/restic-$which}"
}
password_of() {
  local which="$1" var="RESTIC_${1^^}_PASSWORD_FILE"
  if [[ -n "${!var:-}" ]]; then
    printf '%s' "${!var}"
    return
  fi
  # Dev only: a random password beside the local repository, never committed (.gitignore).
  mkdir -p "$BACKUP_DIR"
  local file="$BACKUP_DIR/$which.pass"
  [[ -s "$file" ]] || node -e "process.stdout.write(require('crypto').randomBytes(32).toString('base64url'))" >"$file"
  printf '%s' "$file"
}

# restic <main|pii> [docker run options --] <restic args...>
# Runs restic in its own short-lived container with OmniBridge limits (invariant 16). A local
# repository needs no network; a B2 one does.
restic_run() {
  local which="$1"
  shift
  local extra=()
  if [[ "${1:-}" == "--docker" ]]; then
    shift
    while [[ "$1" != "--" ]]; do
      extra+=("$1")
      shift
    done
    shift
  fi
  local repo pass
  repo="$(repo_of "$which")"
  pass="$(password_of "$which")"
  local mounts=(-v "$(host_path "$pass"):/run/secrets/restic_password:ro")
  local env=(-e RESTIC_PASSWORD_FILE=/run/secrets/restic_password -e RESTIC_CACHE_DIR=/tmp/restic-cache)
  if [[ "$repo" == b2:* ]]; then
    env+=(-e "RESTIC_REPOSITORY=$repo" -e B2_ACCOUNT_ID -e B2_ACCOUNT_KEY)
  else
    mkdir -p "$repo"
    mounts+=(-v "$(host_path "$repo"):/repo")
    env+=(-e RESTIC_REPOSITORY=/repo --network none)
  fi
  docker run --rm -i --memory 384m --cpus 1 --pids-limit 128 \
    "${env[@]}" "${mounts[@]}" "${extra[@]}" "$RESTIC_IMAGE" "$@"
}

# Creates the repository the first time.
restic_init() {
  local which="$1"
  if ! restic_run "$which" cat config >/dev/null 2>&1; then
    restic_run "$which" init >/dev/null
    echo "restic: $which repository initialised"
  fi
}

# The tombstone journal (invariant 10, S5-20261118-01): the pii_journal volume, or a directory
# given as an absolute path (tests), into the main repository under the tag journal.
journal_source() {
  if [[ "$JOURNAL_VOLUME" == */* || "$JOURNAL_VOLUME" == *\* ]]; then
    host_path "$JOURNAL_VOLUME"
  else
    printf '%s' "$JOURNAL_VOLUME"
  fi
}
journal_backup() {
  restic_run main --docker -v "$(journal_source):/journal:ro" -- \
    backup --quiet --host omnibridge --tag journal /journal
}

# The latest backed-up journal (what a restore after a host loss would have) into <dir>, owned
# by the calling user so it can be cleaned up without root.
journal_restore() {
  local out="$1"
  mkdir -p "$out"
  restic_run main --docker -v "$(host_path "$out"):/out" --entrypoint sh -- \
    -c "restic restore --quiet --tag journal latest --target /out && chown -R $(id -u):$(id -g) /out"
}
