#!/usr/bin/env bash
# The single quality gate (CLAUDE.md "Quality gate"). The full run must pass before any merge,
# and it is what CI runs. Run from Git Bash on Windows or any POSIX shell; Docker must be running.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/verify.sh [mode] [--keep-stack]

Modes:
  (none), --full  The full gate. Required before any merge; CI always runs this.
  --quick         Lint, typecheck, contract drift and unit tests only, for use while working.
  --help          Show this help.

Options:
  --keep-stack    Full mode only: leave the Docker stack running afterwards (a stack that was
                  already running before verify started is always left running).

Full gate, in order:
   1 install       pnpm install --frozen-lockfile
   2 lint          ESLint (strict type-checked) and Prettier check
   3 typecheck     tsc over the whole workspace
   4 openapi       openapi.json and the client types match the route registry (pnpm contract:check)
   5 depcruise     architecture rules (.dependency-cruiser.cjs)
   6 names         hard-coded workspace/company/account names (scripts/check-names.sh)
   7 coverage      requirement-ID coverage (scripts/req-coverage.mjs)
   8 limits        container limits and isolation (scripts/check-limits.sh)
   9 squawk        migration lint
  10 actionlint    CI workflow lint, every action pinned to a commit SHA
  11 caddy         validate the dev Caddyfile and infra/edge/sites/omnibridge.caddy
  12 unit          Vitest unit project
  13 integration   Vitest + Testcontainers PostgreSQL 18
  14 contract      adapter stubs against provider-mocks
  15 build         pnpm -r build
  16 stack         build images, then compose up --wait with the scan profile
  17 e2e           Playwright against https://localhost:8443 and :8444
  18 gitleaks      secrets in git history and the working tree
  19 audit         osv-scanner and pnpm audit; high or critical fails
EOF
}

mode=full
keep_stack=false
for arg in "$@"; do
  case "$arg" in
    --full) mode=full ;;
    --quick) mode=quick ;;
    --keep-stack) keep_stack=true ;;
    --help | -h)
      usage
      exit 0
      ;;
    *)
      echo "verify: unknown argument '$arg'" >&2
      usage >&2
      exit 2
      ;;
  esac
done

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"
# shellcheck source=lib/images.sh
source "$root/scripts/lib/images.sh"

export COREPACK_ENABLE_DOWNLOAD_PROMPT=0 ASTRO_TELEMETRY_DISABLED=1
required_pnpm="$(node -p "require('./package.json').packageManager.split('@')[1]")"
if [[ "$(pnpm --version 2>/dev/null || true)" == "$required_pnpm" ]]; then
  pnpm=(pnpm)
else
  pnpm=(corepack pnpm)
fi

compose=(docker compose -f infra/compose/compose.yaml -f infra/compose/compose.dev.yaml --profile scan)
started=$(date +%s)

step() {
  local name=$1
  shift
  local t0
  t0=$(date +%s)
  printf '\n\033[1m==> %s\033[0m\n' "$name"
  if "$@"; then
    printf '\033[32m--- %s ok (%ss)\033[0m\n' "$name" "$(($(date +%s) - t0))"
  else
    printf '\033[31m--- %s FAILED\033[0m\n' "$name" >&2
    exit 1
  fi
}

lint() {
  "${pnpm[@]}" exec eslint --max-warnings 0 . && "${pnpm[@]}" exec prettier --check .
}

actionlint() {
  docker_run --rm -v "$(docker_src "$root"):/repo" -w /repo "$ACTIONLINT_IMAGE" -color
}

caddy_validate() {
  local src
  src="$(docker_src "$root")"
  docker_run --rm -v "$src/infra/compose/dev/Caddyfile:/etc/caddy/Caddyfile:ro" "$CADDY_IMAGE" \
    caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile &&
    docker_run --rm \
      -v "$src/infra/edge/test/Caddyfile:/etc/caddy/Caddyfile:ro" \
      -v "$src/infra/edge/sites:/etc/caddy/sites:ro" \
      "$CADDY_IMAGE" caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
}

squawk() {
  "${pnpm[@]}" exec squawk --pg-version 18 packages/db/migrations/*.sql packages/pii-db/migrations/*.sql
}

# Steps run inside `if` (see step), where set -e is off, so every multi-command step chains with &&.
stack_started=false

stack_up() {
  # A stack that was already running belongs to the developer: leave it running afterwards.
  if [[ -z "$("${compose[@]}" ps -q 2>/dev/null)" ]]; then stack_started=true; fi
  bash scripts/dev-secrets.sh &&
    "${compose[@]}" build &&
    "${compose[@]}" up -d --wait --wait-timeout 600
}

stack_down() {
  if [[ "$keep_stack" == false && "$stack_started" == true ]]; then
    "${compose[@]}" down --remove-orphans >/dev/null 2>&1 || true
  fi
}

e2e() {
  local install=(install chromium)
  if [[ -n "${CI:-}" && "$(uname -s)" == Linux ]]; then install=(install --with-deps chromium); fi
  "${pnpm[@]}" exec playwright "${install[@]}" &&
    "${pnpm[@]}" exec playwright test
}

audit() {
  local report code=0
  report="$(mktemp)"
  # osv-scanner exits 0 (clean) or 1 (findings); anything else is a scanner error, never a pass.
  docker_run --rm -v "$(docker_src "$root"):/src" "$OSV_SCANNER_IMAGE" \
    scan source --lockfile /src/pnpm-lock.yaml --format json >"$report" || code=$?
  if [[ $code -gt 1 ]]; then
    echo "audit: osv-scanner failed with exit code $code" >&2
    rm -f "$report"
    return 1
  fi
  node scripts/lib/osv-gate.mjs <"$report" || {
    rm -f "$report"
    return 1
  }
  rm -f "$report"
  "${pnpm[@]}" audit --audit-level high
}

if [[ "$mode" == quick ]]; then
  step lint lint
  step typecheck "${pnpm[@]}" exec tsc -p tsconfig.json
  step openapi "${pnpm[@]}" run --silent contract:check
  step unit "${pnpm[@]}" exec vitest run --project unit
  printf '\n\033[32mverify --quick passed in %ss (not a merge gate; run the full gate before merging)\033[0m\n' \
    "$(($(date +%s) - started))"
  exit 0
fi

trap stack_down EXIT

step install "${pnpm[@]}" install --frozen-lockfile
step lint lint
step typecheck "${pnpm[@]}" exec tsc -p tsconfig.json
step openapi "${pnpm[@]}" run --silent contract:check
step depcruise "${pnpm[@]}" exec depcruise apps packages mocks --config .dependency-cruiser.cjs
step names bash scripts/check-names.sh
step coverage node scripts/req-coverage.mjs
step limits bash scripts/check-limits.sh
step squawk squawk
step actionlint actionlint
step caddy caddy_validate
step unit "${pnpm[@]}" exec vitest run --project unit
step integration "${pnpm[@]}" exec vitest run --project integration
step contract "${pnpm[@]}" exec vitest run --project contract
step build "${pnpm[@]}" -r run build
step stack stack_up
step e2e e2e
step gitleaks bash scripts/gitleaks.sh full
step audit audit

printf '\n\033[32mverify: full gate passed in %ss\033[0m\n' "$(($(date +%s) - started))"
