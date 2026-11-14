#!/usr/bin/env bash
# Smoke checks for the early public deploy (T-0604): every public page answers 200 over HTTPS
# with a valid certificate, www redirects to the bare domain, the security headers are set, the
# eBay challenge answers the right hash, and an unsigned notice is refused.
#
# Usage: infra/early-deploy/smoke.sh [--cacert FILE]
#   SITE_URL      default https://omnibridge.co.uk
#   WWW_URL       default https://www.omnibridge.co.uk
#   APP_URL       default https://app.omnibridge.co.uk
#   EBAY_ENDPOINT_URL         default $APP_URL/webhooks/ebay/account-deletion
#   EBAY_VERIFICATION_TOKEN_FILE  the token file (to check the challenge hash)
# Without --cacert the system trust store is used, so a real certificate is required.
set -euo pipefail

cacert=()
if [[ "${1:-}" == --cacert ]]; then cacert=(--cacert "$2"); fi

SITE_URL="${SITE_URL:-https://omnibridge.co.uk}"
WWW_URL="${WWW_URL:-https://www.omnibridge.co.uk}"
APP_URL="${APP_URL:-https://app.omnibridge.co.uk}"
EBAY_ENDPOINT_URL="${EBAY_ENDPOINT_URL:-$APP_URL/webhooks/ebay/account-deletion}"
: "${EBAY_VERIFICATION_TOKEN_FILE:?set EBAY_VERIFICATION_TOKEN_FILE}"

# Windows curl cannot check revocation for a local CA; harmless elsewhere.
extra=()
if curl --help all 2>/dev/null | grep -q -- --ssl-no-revoke; then extra=(--ssl-no-revoke); fi
http() { curl -sS --max-time 10 --proto '=https' "${cacert[@]}" "${extra[@]}" "$@"; }

failures=0
check() {
  local name=$1 ok=$2
  if [[ "$ok" == true ]]; then
    echo "ok   $name"
  else
    echo "FAIL $name" >&2
    failures=$((failures + 1))
  fi
}

for page in / /features /security /privacy /terms /cookies /contact; do
  # -L: static-web-server answers /features with a redirect to /features/, as browsers expect.
  body="$(http -L -w '\n%{http_code}' "$SITE_URL$page" || echo 000)"
  code="${body##*$'\n'}"
  ok=false
  if [[ "$code" == 200 && "$body" != *'[OPERATOR_'* ]]; then ok=true; fi
  check "page $page answers 200 over HTTPS with the Operator details" "$ok"
done

headers="$(http -o /dev/null -D - "$SITE_URL/" || true)"
grep -qi '^content-security-policy:' <<<"$headers" && csp=true || csp=false
check "site sends a Content-Security-Policy" "$csp"
grep -qi '^strict-transport-security:' <<<"$headers" && hsts=true || hsts=false
check "site sends Strict-Transport-Security" "$hsts"

loc="$(http -o /dev/null -w '%{http_code} %{redirect_url}' "$WWW_URL/privacy" || true)"
[[ "$loc" == 30[18]" $SITE_URL/privacy" ]] && www=true || www=false
check "www redirects to the bare domain ($loc)" "$www"

code="challenge-$(date +%s)"
token="$(tr -d '\r\n' <"$EBAY_VERIFICATION_TOKEN_FILE")"
want="$(printf '%s%s%s' "$code" "$token" "$EBAY_ENDPOINT_URL" | sha256sum | cut -d' ' -f1)"
got="$(http "$EBAY_ENDPOINT_URL?challenge_code=$code" || true)"
[[ "$got" == "{\"challengeResponse\":\"$want\"}" ]] && challenge=true || challenge=false
check "eBay challenge answers the right hash" "$challenge"

status="$(http -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' \
  --data '{"metadata":{"topic":"MARKETPLACE_ACCOUNT_DELETION"},"notification":{}}' \
  "$EBAY_ENDPOINT_URL" || true)"
[[ "$status" == 412 ]] && unsigned=true || unsigned=false
check "an unsigned eBay notice is refused ($status)" "$unsigned"

other="$(http -o /dev/null -w '%{http_code}' "$APP_URL/anything-else" || true)"
[[ "$other" == 404 ]] && closed=true || closed=false
check "the app domain serves nothing else ($other)" "$closed"

if ((failures > 0)); then
  echo "smoke: $failures check(s) failed" >&2
  exit 1
fi
echo "smoke: all checks passed"
