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
                  uses it when a PR touches only docs/** and *.md, except docs a test reads
                  (READ_BY_TESTS in scripts/lib/docs-only.mjs).
  --ui            UI-only changes (ADR-056): static checks, unit tests, the Playwright ui project
                  and gitleaks; no Postgres and no Docker stack. CI uses it when a PR touches only
                  apps/ui/** (scripts/lib/change-lane.mjs); main always runs the full gate.
  --help          Show this help.

Output (ADR-056): one line per step. A failing step prints its last 60 lines; every step's full
log is in .verify-logs/<step>.log (git-ignored).

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
  17 e2e           Playwright (chromium project) against https://localhost:8443 and :8444
  18 ui-e2e        Playwright ui project against its own Vite server (no stack needed)
  19 gitleaks      secrets in git history and the working tree
  20 audit         osv-scanner and pnpm audit; high or critical fails
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
    --ui) mode=ui ;;
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

logs="$root/.verify-logs"
mkdir -p "$logs"

# Quiet output (ADR-056): one line per step; the full log goes to .verify-logs/<step>.log and a
# failing step prints its last 60 lines.
step() {
  local name=$1
  shift
  local t0 log="$logs/$name.log"
  t0=$(date +%s)
  if "$@" >"$log" 2>&1; then
    printf -- '--- %s ok (%ss)\n' "$name" "$(($(date +%s) - t0))"
  else
    printf -- '--- %s FAILED (%ss), last 60 lines of .verify-logs/%s.log:\n' \
      "$name" "$(($(date +%s) - t0))" "$name" >&2
    tail -n 60 "$log" >&2
    exit 1
  fi
}

lint() {
  "${pnpm[@]}" exec eslint --max-warnings 0 . && "${pnpm[@]}" exec prettier --check .
}

# The core stack, and the early public deploy (T-0604) with its dry-run override.
limits() {
  bash scripts/check-limits.sh &&
    bash scripts/check-limits.sh infra/early-deploy/compose.yaml infra/early-deploy/compose.dryrun.yaml
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

# The migration runner wraps each file in one transaction (sql-migrations.ts), so squawk is told so,
# except for a file marked `-- migrate: no-transaction` (ADR-047), which runs outside one.
squawk() {
  local tx=() notx=() f
  for f in packages/db/migrations/*.sql packages/pii-db/migrations/*.sql; do
    if [[ "$(head -n 1 "$f" | tr -d '\r')" == "-- migrate: no-transaction" ]]; then
      notx+=("$f")
    else
      tx+=("$f")
    fi
  done
  "${pnpm[@]}" exec squawk --pg-version 18 --assume-in-transaction "${tx[@]}" &&
    { [[ ${#notx[@]} -eq 0 ]] || "${pnpm[@]}" exec squawk --pg-version 18 "${notx[@]}"; }
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
# Bake resolves compose's `context: ../..` from the current directory, so it runs from
# infra/compose, and it is granted exactly the repo (the build context) and the cache directory.
# The targets build in parallel, so each exports its cache to its own directory: one shared
# directory makes their writes of the same layer blobs collide.
BAKE_TARGETS=(web worker pii-vault site provider-mocks)

# OB_IMAGE_CACHE_DIR (set by CI, T-0208): built images are saved there as <target>-<key>.tar,
# keyed by a hash of everything they are built from (scripts/lib/image-key.mjs). An image whose
# key is unchanged is loaded instead of rebuilt; tars of other keys are pruned.
build_images() {
  local cache="${OB_BUILD_CACHE_DIR:-}" images="${OB_IMAGE_CACHE_DIR:-}"
  if [[ -z "$cache" ]]; then
    "${compose[@]}" build
    return
  fi
  local -A key=()
  local targets=() target k
  if [[ -n "$images" ]]; then
    mkdir -p "$images" || return 1
    while read -r target k; do key[$target]=$k; done < <(node scripts/lib/image-key.mjs "${BAKE_TARGETS[@]}")
    for target in "${BAKE_TARGETS[@]}"; do
      if [[ -f "$images/$target-${key[$target]}.tar" ]]; then
        docker load -q -i "$images/$target-${key[$target]}.tar" || return 1
        echo "image $target: unchanged, loaded from the image cache"
      else
        targets+=("$target")
      fi
    done
  else
    targets=("${BAKE_TARGETS[@]}")
  fi
  if ((${#targets[@]} > 0)); then
    bake_images "${targets[@]}" || return 1
  fi
  if [[ -n "$images" ]]; then
    for target in "${targets[@]}"; do
      docker save -o "$images/$target-${key[$target]}.tar" "omnibridge/$target:dev" || return 1
    done
    local tar keep
    for tar in "$images"/*.tar; do
      [[ -e "$tar" ]] || continue
      keep=false
      for target in "${BAKE_TARGETS[@]}"; do
        if [[ "$(basename "$tar")" == "$target-${key[$target]}.tar" ]]; then keep=true; fi
      done
      if [[ "$keep" == false ]]; then rm -f "$tar"; fi
    done
  fi
}

# Builds the given targets with buildx bake and the local layer cache in OB_BUILD_CACHE_DIR.
# Each target exports its cache to its own directory (parallel writes of one shared directory
# collide), and a target's directory is replaced only when that target was built.
bake_images() {
  local cache="$OB_BUILD_CACHE_DIR" sets=() target
  for target in "$@"; do
    mkdir -p "$cache/$target" || return 1
    sets+=(--set "$target.cache-from=type=local,src=$cache/$target")
    sets+=(--set "$target.cache-to=type=local,dest=$cache-new/$target,mode=max")
  done
  (cd infra/compose && docker buildx bake -f compose.yaml -f compose.dev.yaml \
    --allow "fs.read=$root" --allow "fs=$(dirname "$cache")" \
    "${sets[@]}" --load "$@") || return 1
  for target in "$@"; do
    rm -rf "${cache:?}/$target" && mv "$cache-new/$target" "$cache/$target" || return 1
  done
  rm -rf "$cache-new"
}

stack_down() {
  if [[ "$keep_stack" == false && "$stack_started" == true ]]; then
    "${compose[@]}" down --remove-orphans >/dev/null 2>&1 || true
  fi
}

playwright_install() {
  local install=(install chromium)
  if [[ -n "${CI:-}" && "$(uname -s)" == Linux ]]; then install=(install --with-deps chromium); fi
  "${pnpm[@]}" exec playwright "${install[@]}"
}

# The line reporter keeps logs short (ADR-056); CI also keeps the HTML report as evidence.
playwright_reporter() {
  if [[ -n "${CI:-}" ]]; then echo line,html; else echo line; fi
}

# The ui project needs no stack: Playwright starts its own Vite server on a port nobody else uses,
# so a developer's or another session's dev server on 5173 is never reused.
ui_e2e() {
  playwright_install &&
    OB_UI_PORT=5199 OB_E2E_OWN_SERVER=1 "${pnpm[@]}" exec playwright test --project=ui \
      --reporter="$(playwright_reporter)"
}

e2e() {
  playwright_install &&
    "${pnpm[@]}" exec playwright test --project=chromium --reporter="$(playwright_reporter)" || {
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
  # pnpm audit exits 1 when it finds anything; the gate script decides (PS-026 exceptions).
  report="$(mktemp)"
  "${pnpm[@]}" audit --json >"$report" || true
  node scripts/lib/pnpm-audit-gate.mjs <"$report" || {
    rm -f "$report"
    return 1
  }
  rm -f "$report"
}

# Every full-gate step, in gate order. --only picks from this list.
FULL_STEPS=(install lint typecheck openapi depcruise names coverage limits squawk actionlint caddy
  unit integration contract build stack e2e ui-e2e gitleaks audit)

run_step() {
  case "$1" in
    install) step install "${pnpm[@]}" install --frozen-lockfile ;;
    lint) step lint lint ;;
    typecheck) step typecheck "${pnpm[@]}" exec tsc -p tsconfig.json ;;
    openapi) step openapi "${pnpm[@]}" run --silent contract:check ;;
    depcruise) step depcruise "${pnpm[@]}" exec depcruise apps packages mocks --config .dependency-cruiser.cjs ;;
    names) step names bash scripts/check-names.sh ;;
    coverage) step coverage node scripts/req-coverage.mjs ;;
    limits) step limits limits ;;
    squawk) step squawk squawk ;;
    actionlint) step actionlint actionlint ;;
    caddy) step caddy caddy_validate ;;
    unit) step unit "${pnpm[@]}" exec vitest run --project unit --reporter=dot ;;
    integration) step integration "${pnpm[@]}" exec vitest run --project integration --reporter=dot ;;
    contract) step contract "${pnpm[@]}" exec vitest run --project contract --reporter=dot ;;
    build) step build "${pnpm[@]}" -r run build ;;
    stack) step stack stack_up ;;
    e2e) step e2e e2e ;;
    ui-e2e) step ui-e2e ui_e2e ;;
    gitleaks) step gitleaks bash scripts/gitleaks.sh full ;;
    audit) step audit audit ;;
    *)
      echo "verify: unknown step '$1'" >&2
      exit 2
      ;;
  esac
}

if [[ "$mode" == quick ]]; then
  for name in lint typecheck openapi unit; do run_step "$name"; done
  printf 'verify --quick passed in %ss (not a merge gate; CI runs the full gate)\n' \
    "$(($(date +%s) - started))"
  exit 0
fi

if [[ "$mode" == ui ]]; then
  for name in install lint typecheck openapi depcruise names coverage unit ui-e2e gitleaks; do
    run_step "$name"
  done
  printf 'verify --ui passed in %ss (UI-only changes)\n' "$(($(date +%s) - started))"
  exit 0
fi

if [[ "$mode" == docs ]]; then
  run_step install
  step format "${pnpm[@]}" exec prettier --check .
  run_step coverage
  run_step gitleaks
  printf 'verify --docs passed in %ss (docs-only changes)\n' "$(($(date +%s) - started))"
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
  printf 'verify --only=%s passed in %ss\n' "$only" "$(($(date +%s) - started))"
else
  printf 'verify: full gate passed in %ss\n' "$(($(date +%s) - started))"
fi
