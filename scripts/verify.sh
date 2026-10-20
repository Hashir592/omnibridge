#!/usr/bin/env bash
# The single quality gate (CLAUDE.md "Quality gate"). The full run must pass before any merge,
# and it is what CI runs. Run from Git Bash on Windows or any POSIX shell; Docker must be running.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/verify.sh [mode] [--keep-stack]

Modes:
  (none), --full  The full gate. Required before any merge; CI runs all of it on every code PR.
  --quick         Lint, typecheck, contract drift and unit tests only, for use while working.
  --only=a,b,...  Only the named full-gate steps, in gate order. CI splits the gate into parallel
                  jobs this way (ADR-043); together they are the full gate.
  --docs          Docs-only changes: install, format check, coverage and gitleaks (ADR-043). CI
                  uses it when a PR touches only docs/**, *.md or docs/backlog.json.
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
only=''
for arg in "$@"; do
  case "$arg" in
    --full) mode=full ;;
    --quick) mode=quick ;;
    --docs) mode=docs ;;
    --only=*)
      mode=only
      only="${arg#--only=}"
      ;;
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

# The migration runner wraps each file in one transaction (sql-migrations.ts), so squawk is told so.
squawk() {
  "${pnpm[@]}" exec squawk --pg-version 18 --assume-in-transaction packages/db/migrations/*.sql packages/pii-db/migrations/*.sql
}

# Steps run inside `if` (see step), where set -e is off, so every multi-command step chains with &&.
stack_started=false

stack_up() {
  # A stack that was already running belongs to the developer: leave it running afterwards.
  if [[ -z "$("${compose[@]}" ps -q 2>/dev/null)" ]]; then stack_started=true; fi
  bash scripts/dev-secrets.sh &&
    build_images &&
    "${compose[@]}" up -d --wait --wait-timeout 600 &&
    wait_ready
}

# `up --wait` only means every container is alive: web's and pii-vault's healthchecks accept a
# 503 (degraded) on purpose, because they are liveness checks. The e2e step needs the stack ready,
# so wait until /healthz through the edge reports ok and the public site answers (O-1). A stack
# that is not ready in time fails here, with its logs kept under .verify/.
wait_ready() {
  local deadline=$(($(date +%s) + 120))
  until curl -fsk --max-time 10 https://localhost:8443/healthz | grep -q '"status":"ok"' &&
    curl -fsk --max-time 10 -o /dev/null https://localhost:8444/; do
    if (($(date +%s) > deadline)); then
      echo "stack: not ready within 120 s (healthz ok through the edge, site answering)" >&2
      mkdir -p .verify &&
        "${compose[@]}" logs --no-color --timestamps >.verify/stack-not-ready-logs.txt 2>&1
      return 1
    fi
    sleep 2
  done
}

# OB_BUILD_CACHE_DIR (set by CI): build the compose images with buildx bake and a local layer
# cache that the workflow saves between runs. The new cache replaces the old, so it never grows.
# The migrate jobs reuse the web and pii-vault images, so only the five distinct images are built.
build_images() {
  local cache="${OB_BUILD_CACHE_DIR:-}"
  if [[ -z "$cache" ]]; then
    "${compose[@]}" build
    return
  fi
  mkdir -p "$cache" &&
    docker buildx bake -f infra/compose/compose.yaml -f infra/compose/compose.dev.yaml \
      --set "*.cache-from=type=local,src=$cache" \
      --set "*.cache-to=type=local,dest=$cache-new,mode=max" --load \n      web worker pii-vault site provider-mocks &&
    rm -rf "$cache" && mv "$cache-new" "$cache"
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
    # Its own Vite server on a port nobody else uses: a developer's or another session's dev server
    # on 5173 is never reused, so the gate always tests this checkout.
    OB_UI_PORT=5199 OB_E2E_OWN_SERVER=1 "${pnpm[@]}" exec playwright test || {
    local code=$?
    # Keep the evidence before stack_down removes the containers (git-ignored).
    mkdir -p .verify &&
      "${compose[@]}" logs --no-color --timestamps >.verify/e2e-stack-logs.txt 2>&1
    docker stats --no-stream >.verify/e2e-docker-stats.txt 2>&1
    echo "e2e failed: stack logs and docker stats saved under .verify/" >&2
    return "$code"
  }
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

# Every full-gate step, in gate order. --only picks from this list.
FULL_STEPS=(install lint typecheck openapi depcruise names coverage limits squawk actionlint caddy
  unit integration contract build stack e2e gitleaks audit)

run_step() {
  case "$1" in
    install) step install "${pnpm[@]}" install --frozen-lockfile ;;
    lint) step lint lint ;;
    typecheck) step typecheck "${pnpm[@]}" exec tsc -p tsconfig.json ;;
    openapi) step openapi "${pnpm[@]}" run --silent contract:check ;;
    depcruise) step depcruise "${pnpm[@]}" exec depcruise apps packages mocks --config .dependency-cruiser.cjs ;;
    names) step names bash scripts/check-names.sh ;;
    coverage) step coverage node scripts/req-coverage.mjs ;;
    limits) step limits bash scripts/check-limits.sh ;;
    squawk) step squawk squawk ;;
    actionlint) step actionlint actionlint ;;
    caddy) step caddy caddy_validate ;;
    unit) step unit "${pnpm[@]}" exec vitest run --project unit ;;
    integration) step integration "${pnpm[@]}" exec vitest run --project integration ;;
    contract) step contract "${pnpm[@]}" exec vitest run --project contract ;;
    build) step build "${pnpm[@]}" -r run build ;;
    stack) step stack stack_up ;;
    e2e) step e2e e2e ;;
    gitleaks) step gitleaks bash scripts/gitleaks.sh full ;;
    audit) step audit audit ;;
    *)
      echo "verify: unknown step '$1'" >&2
      exit 2
      ;;
  esac
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

if [[ "$mode" == docs ]]; then
  run_step install
  step format "${pnpm[@]}" exec prettier --check .
  run_step coverage
  run_step gitleaks
  printf '\n\033[32mverify --docs passed in %ss (docs-only changes)\033[0m\n' "$(($(date +%s) - started))"
  exit 0
fi

if [[ "$mode" == only ]]; then
  IFS=',' read -r -a wanted <<<"$only"
  if [[ ${#wanted[@]} -eq 0 ]]; then
    echo "verify: --only needs at least one step (see --help)" >&2
    exit 2
  fi
  for name in "${wanted[@]}"; do
    if [[ " ${FULL_STEPS[*]} " != *" $name "* ]]; then
      echo "verify: --only names an unknown step '$name' (see --help)" >&2
      exit 2
    fi
  done
fi

trap stack_down EXIT

for name in "${FULL_STEPS[@]}"; do
  if [[ "$mode" == full || ",$only," == *",$name,"* ]]; then run_step "$name"; fi
done

if [[ "$mode" == only ]]; then
  printf '\n\033[32mverify --only=%s passed in %ss\033[0m\n' "$only" "$(($(date +%s) - started))"
else
  printf '\n\033[32mverify: full gate passed in %ss\033[0m\n' "$(($(date +%s) - started))"
fi
