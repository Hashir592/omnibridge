#!/usr/bin/env bash
# commit-msg check (see lefthook.yml). On Windows lefthook splits the message-file argument at
# spaces (a git worktree's path lives under the main checkout, e.g. "Work Projects"), so the pieces
# are joined again; git's own path for the file is the fallback.
msg="$*"
[[ -f "$msg" ]] || msg="$(git rev-parse --git-path COMMIT_EDITMSG)"
exec node scripts/commit-msg.mjs "$msg"
