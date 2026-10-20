#!/usr/bin/env bash
# Secret scan with gitleaks in a digest-pinned container (SEC-5, ADR-031).
# Usage: scripts/gitleaks.sh staged [path]   (pre-commit: staged changes only)
#        scripts/gitleaks.sh full [path]     (verify: the whole git history plus the working tree)
# `path` defaults to this repository; the rules always come from this repository's .gitleaks.toml.
#
# Works from a git worktree too (T-0106): a worktree's .git is only a pointer file, so the shared
# git directory is mounted as well and the container is told where the worktree's git dir is.
# A history scan that covers no commit fails instead of passing silently.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=lib/images.sh
source "$root/scripts/lib/images.sh"

mode="${1:-full}"
target="$(cd "${2:-$root}" && pwd)"
if ! git -C "$target" rev-parse --git-dir >/dev/null 2>&1; then
  echo "gitleaks: $target is not a git repository, so its history cannot be scanned" >&2
  exit 2
fi

git_dir="$(cd "$(git -C "$target" rev-parse --absolute-git-dir)" && pwd)"
common_dir="$(cd "$(git -C "$target" rev-parse --git-common-dir)" && pwd)"
mounts=(-v "$(docker_src "$target"):/repo" -v "$(docker_src "$root")/.gitleaks.toml:/config/gitleaks.toml:ro")
git_env=(-e GIT_CONFIG_COUNT=1 -e GIT_CONFIG_KEY_0=safe.directory -e GIT_CONFIG_VALUE_0='*')
if [[ "$git_dir" != "$common_dir" ]]; then
  # A worktree: its own git dir lives under <common>/worktrees/<name>, and its `commondir` file
  # points two levels up, so mounting <common> at /common resolves both.
  mounts+=(-v "$(docker_src "$common_dir"):/common")
  git_env+=(-e "GIT_DIR=/common/worktrees/$(basename "$git_dir")" -e GIT_WORK_TREE=/repo)
fi

run() {
  docker_run --rm "${mounts[@]}" "${git_env[@]}" -w /repo "$GITLEAKS_IMAGE" "$@" \
    --config /config/gitleaks.toml --redact --no-banner
}

case "$mode" in
  staged) run git --pre-commit --staged /repo ;;
  full)
    # Every ref, so commits on other branches and worktrees are scanned too.
    log="$(mktemp)"
    code=0
    run git --log-opts=--all /repo 2>&1 | tee "$log" || code=${PIPESTATUS[0]}
    if ! grep -Eq '[1-9][0-9]* commits? scanned' "$log"; then
      echo "gitleaks: the history scan covered no commits; failing rather than passing silently" >&2
      rm -f "$log"
      exit 1
    fi
    rm -f "$log"
    [[ $code -eq 0 ]] || exit "$code"
    run dir /repo
    ;;
  *)
    echo "usage: scripts/gitleaks.sh staged|full [path]" >&2
    exit 2
    ;;
esac
