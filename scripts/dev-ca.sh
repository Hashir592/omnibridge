#!/usr/bin/env bash
# Exports the dev Caddy local root certificate to infra/compose/.local/caddy-root.crt (git-ignored)
# so curl can verify https://localhost:8443. Trusting it system-wide is optional and up to you.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
out="$root/infra/compose/.local/caddy-root.crt"
mkdir -p "$(dirname "$out")"

docker compose -f "$root/infra/compose/compose.yaml" -f "$root/infra/compose/compose.dev.yaml" \
  cp caddy:/data/caddy/pki/authorities/local/root.crt "$out"
echo "dev-ca: wrote $out"
