#!/usr/bin/env bash
# Materialises the dev-only Docker secret files under infra/compose/.secrets/ (git-ignored) from
# infra/secrets/dev.sops.yaml (T-0103, SEC-5, ADR-014, PS-007). SOPS runs in a digest-pinned image
# with the committed DEV ONLY age key, so a clean clone needs nothing but Docker. Every value is
# synthetic; real secrets never exist on a dev machine.
#
# Usage: scripts/dev-secrets.sh           write missing files; stop if an existing one differs
#        scripts/dev-secrets.sh --reset   overwrite files that differ (after `docker compose down -v`,
#                                         because database volumes keep their first passwords)
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=lib/images.sh
source "$root/scripts/lib/images.sh"

case "${1:-}" in
  '' | --reset) ;;
  *)
    echo "usage: scripts/dev-secrets.sh [--reset]" >&2
    exit 2
    ;;
esac

# Decrypted values travel only through this pipe, never through a file outside .secrets/.
docker_run --rm -v "$(docker_src "$root/infra/secrets"):/secrets:ro" \
  -e SOPS_AGE_KEY_FILE=/secrets/dev.age.key \
  "$SOPS_IMAGE" --decrypt --output-type json /secrets/dev.sops.yaml \
  | node "$root/scripts/lib/materialise-secrets.mjs" "$root/infra/compose/.secrets" "${1:-}"
