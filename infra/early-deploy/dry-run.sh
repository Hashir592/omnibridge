#!/usr/bin/env bash
# Local dry run of the early deploy (T-0604): builds and starts the stack on local addresses with
# synthetic values only, runs the smoke checks against it, then stops it. Docker must be running.
# Usage: infra/early-deploy/dry-run.sh [--keep]
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../.." && pwd)"
cd "$root"

secrets="$here/.secrets"
mkdir -p "$secrets"
# Synthetic, local only (git-ignored). Production values come from the ops repo (runbook step 5).
[[ -s "$secrets/ebay_verification_token" ]] ||
  node -e "process.stdout.write('dryrun_'+require('crypto').randomBytes(24).toString('hex'))" \
    >"$secrets/ebay_verification_token"
printf 'synthetic-dry-run-client' >"$secrets/ebay_client_id"
printf 'synthetic-dry-run-secret' >"$secrets/ebay_client_secret"

export OB_SITE_OPERATOR_LEGAL_NAME='Synthetic Operator Ltd'
export OB_SITE_OPERATOR_COMPANY_NUMBER='00000000'
export OB_SITE_OPERATOR_REGISTERED_ADDRESS='1 Example Street, Testtown, TE1 1ST'
compose=(docker compose -f "$here/compose.yaml" -f "$here/compose.dryrun.yaml")

cleanup() { if [[ "${1:-}" != --keep ]]; then "${compose[@]}" down -v --remove-orphans >/dev/null 2>&1 || true; fi; }
trap 'cleanup "${KEEP:-}"' EXIT
[[ "${1:-}" == --keep ]] && KEEP=--keep

"${compose[@]}" up -d --build --wait --wait-timeout 300

# Caddy's local root certificate, so the smoke checks verify certificates instead of skipping it.
ca="$here/.secrets/caddy-root.crt"
"${compose[@]}" cp caddy:/data/caddy/pki/authorities/local/root.crt "$ca" >/dev/null
# Healthy means Caddy runs; its certificates for the sites are issued on a fresh volume a moment
# later, so wait until HTTPS answers before checking.
revoke=()
app_ready="https://localhost:9443/webhooks/ebay/account-deletion?challenge_code=ready"
if curl --help all 2>/dev/null | grep -q -- --ssl-no-revoke; then revoke=(--ssl-no-revoke); fi
for _ in $(seq 1 30); do
  if curl -fsS --cacert "$ca" "${revoke[@]}" -o /dev/null https://localhost:9444/ &&
    curl -fsS --cacert "$ca" "${revoke[@]}" -o /dev/null "$app_ready"; then
    break
  fi
  sleep 1
done

SITE_URL=https://localhost:9444 WWW_URL=https://www.localhost:9444 APP_URL=https://localhost:9443 \
  EBAY_VERIFICATION_TOKEN_FILE="$secrets/ebay_verification_token" \
  bash "$here/smoke.sh" --cacert "$ca"

# The whole verify chain: eBay's own signed sample (its key is served by provider-mocks) is
# accepted with 200 (EBAY-2). Only possible in the dry run; production notices come from eBay itself.
sample="$(node -e "import('./packages/providers/ebay/src/sample.ts').then(({ EBAY_SDK_SAMPLE: s }) => process.stdout.write(JSON.stringify({ body: JSON.stringify(s.message), sig: s.signature })))")"
body="$(node -e "process.stdout.write(JSON.parse(process.argv[1]).body)" "$sample")"
sig="$(node -e "process.stdout.write(JSON.parse(process.argv[1]).sig)" "$sample")"
extra=()
if curl --help all 2>/dev/null | grep -q -- --ssl-no-revoke; then extra=(--ssl-no-revoke); fi
status="$(curl -sS --cacert "$ca" "${extra[@]}" -o /dev/null -w '%{http_code}' -X POST \
  -H 'content-type: application/json' -H "x-ebay-signature: $sig" --data "$body" \
  https://localhost:9443/webhooks/ebay/account-deletion)"
if [[ "$status" != 200 ]]; then
  echo "FAIL eBay's signed sample was not accepted ($status)" >&2
  exit 1
fi
echo "ok   eBay's signed sample is verified and accepted (200)"
