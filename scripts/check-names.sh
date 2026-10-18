#!/usr/bin/env bash
# Hard-coded-name gate (TEN-4, ARCHITECTURE.md invariant 6): no workspace, company or account name
# appears outside seed files. Planning documents (docs/, CLAUDE.md) describe the client and are
# exempt; so are seed paths (**/seed/**, **/seeds/**, *.seed.*).
# Usage: scripts/check-names.sh [dir]   (default: repo root; scans tracked and untracked files)
set -euo pipefail

dir="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
cd "$dir"

# Built from fragments so this file does not match itself.
names=("Jee""z" "Sids""on" "Kyy""z")
pattern="$(IFS='|'; echo "${names[*]}")"

# git grep exits 0 on a match, 1 on no match, and >1 on an error; an error must fail the gate.
code=0
hits="$(git grep --untracked -n -I -i -E "($pattern)" -- . \
  ':(exclude,glob)docs/**' ':(exclude,glob)CLAUDE.md' \
  ':(exclude,glob)**/seed/**' ':(exclude,glob)**/seeds/**' ':(exclude,glob)**/*.seed.*')" ||
  code=$?

if [[ $code -gt 1 ]]; then
  echo "check-names: git grep failed (exit $code); the gate cannot pass without a scan" >&2
  exit 2
fi
if [[ $code -eq 0 ]]; then
  echo "check-names: hard-coded workspace/company/account names found outside seed files:" >&2
  echo "$hits" >&2
  exit 1
fi
echo "check-names: no hard-coded names"
