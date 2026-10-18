#!/usr/bin/env bash
# Secret scan with gitleaks in a digest-pinned container (SEC-5, ADR-031).
# Usage: scripts/gitleaks.sh staged   (pre-commit: staged changes only)
#        scripts/gitleaks.sh full     (verify: the whole git history plus the working tree)
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=lib/images.sh
source "$root/scripts/lib/images.sh"
src="$(docker_src "$root")"

run() {
  docker_run --rm -v "$src:/repo" -w /repo \
    -e GIT_CONFIG_COUNT=1 -e GIT_CONFIG_KEY_0=safe.directory -e GIT_CONFIG_VALUE_0=/repo \
    "$GITLEAKS_IMAGE" "$@" --config /repo/.gitleaks.toml --redact --no-banner
}

case "${1:-full}" in
  staged) run git --pre-commit --staged /repo ;;
  full)
    run git /repo
    run dir /repo
    ;;
  *)
    echo "usage: scripts/gitleaks.sh staged|full" >&2
    exit 2
    ;;
esac
