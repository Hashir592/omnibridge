#!/usr/bin/env bash
# Generates random dev-only Docker secret files under infra/compose/.secrets/ (git-ignored).
# Existing files are kept, so database volumes keep matching passwords. Synthetic values only:
# real secrets never exist on a dev machine (SEC-5). T-0103 replaces this with SOPS + age.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
dir="$root/infra/compose/.secrets"
mkdir -p "$dir"

names=(
  db_main_superuser_password
  ob_owner_password
  ob_app_password
  ob_platform_password
  db_pii_superuser_password
  vault_owner_password
  vault_app_password
)

for name in "${names[@]}"; do
  file="$dir/$name"
  if [[ ! -s "$file" ]]; then
    node -e "process.stdout.write(require('node:crypto').randomBytes(24).toString('base64url'))" >"$file"
    # Readable by the non-root container users that mount it (dev only).
    chmod 0644 "$file"
    echo "created $name"
  fi
done
