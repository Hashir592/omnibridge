#!/usr/bin/env bash
# Fails when any Compose service lacks mem_limit, cpus, pids_limit or a healthcheck, or joins a
# non-OmniBridge network (OPS-8, OPS-10, invariant 14).
# Usage: scripts/check-limits.sh [compose-file ...]   (default: compose.yaml + compose.dev.yaml,
# every profile enabled so profile-only services such as clamd are checked too)
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
files=("$@")
if [[ ${#files[@]} -eq 0 ]]; then
  files=("$root/infra/compose/compose.yaml" "$root/infra/compose/compose.dev.yaml")
fi

args=()
for f in "${files[@]}"; do args+=(-f "$f"); done

# Secret files only need to exist for `config` to resolve the model.
[[ -d "$root/infra/compose/.secrets" ]] || bash "$root/scripts/dev-secrets.sh" >/dev/null

COMPOSE_PROFILES='*' docker compose "${args[@]}" config --format json --no-interpolate \
  | node "$root/scripts/lib/check-limits.mjs"
