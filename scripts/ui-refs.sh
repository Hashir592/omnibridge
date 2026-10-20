#!/usr/bin/env bash
# Refreshes the Linux UI reference screenshots (docs/design/reference/*-linux.png) inside the
# digest-pinned Playwright image (ADR-039, ADR-046), so they match what CI renders. For S2.
#
# The working tree's tracked and new files (never node_modules) are copied into the container,
# installed there for Linux, and the `ui` project runs with --update-snapshots. Only the
# -linux.png images come back; the Windows ones are made by a normal local run.
#
# Usage: scripts/ui-refs.sh [title-grep]
#   default grep: every screenshot test ("matches the ... reference")
#   example:      scripts/ui-refs.sh "order-detail matches"
# Changing a reference image needs Hashir's approval (docs/design/README.md).
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=lib/images.sh
source "$root/scripts/lib/images.sh"

grep_arg="${1:-matches the (locked )?reference}"
out="$root/.verify/ui-refs"
rm -rf "$out"
mkdir -p "$out"

# New files that are not committed yet are included, so S2 can refresh before committing; they
# are listed, because CI will only have them once they are committed.
untracked="$(cd "$root" && git ls-files --others --exclude-standard)"
if [[ -n "$untracked" ]]; then
  echo "ui-refs: including files not yet committed:"
  echo "$untracked" | sed 's/^/  /'
fi

(cd "$root" && git ls-files -z --cached --others --exclude-standard | tar --null -T - -cf -) |
  docker_run -i --rm -v "$(docker_src "$out"):/out" -e CI=1 -e GREP="$grep_arg" \
    -e COREPACK_ENABLE_DOWNLOAD_PROMPT=0 "$PLAYWRIGHT_IMAGE" bash -euo pipefail -c '
      mkdir /w && cd /w && tar -xf -
      corepack enable >/dev/null
      corepack pnpm install --frozen-lockfile --ignore-scripts >/dev/null
      corepack pnpm exec playwright test --project ui --update-snapshots=all --grep "$GREP" \
        --reporter=line
      cp docs/design/reference/*-linux.png /out/
    '

changed=0
for image in "$out"/*-linux.png; do
  name="$(basename "$image")"
  if ! cmp -s "$image" "$root/docs/design/reference/$name"; then
    cp "$image" "$root/docs/design/reference/$name"
    echo "ui-refs: updated docs/design/reference/$name"
    changed=$((changed + 1))
  fi
done
echo "ui-refs: $changed Linux reference image(s) changed"
