# Tool images used by the gate, pinned by digest (ADR-019, ADR-031). Sourced by scripts/*.sh.
# shellcheck shell=bash
GITLEAKS_IMAGE='ghcr.io/gitleaks/gitleaks:v8.30.1@sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f'
OSV_SCANNER_IMAGE='ghcr.io/google/osv-scanner:v2.7.0@sha256:4f3b7e2c64b9d38a5febc5a7e4a3dfef1d1362f726dea7a2ef4762b46469fcd0'
ACTIONLINT_IMAGE='rhysd/actionlint:1.7.12@sha256:b1934ee5f1c509618f2508e6eb47ee0d3520686341fec936f3b79331f9315667'
CADDY_IMAGE='caddy:2.11.7-alpine@sha256:d8542f48d34a9cf4e4c11a478865229840e87e4c96ea3f439101f31a5d35f75f'

# The repo path as Docker on this host wants it for a bind mount (Git Bash on Windows needs the
# Windows form).
docker_src() {
  (cd "$1" && (pwd -W 2>/dev/null || pwd))
}

# docker run with MSYS path rewriting off, so container paths such as /repo reach Docker intact.
# Scoped to docker only: turning it off globally breaks the corepack shim on Windows.
docker_run() {
  MSYS_NO_PATHCONV=1 docker run "$@"
}
