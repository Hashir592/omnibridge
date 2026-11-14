// The CI lane of a pull request (ADR-043, ADR-056), from its changed paths:
//   docs  every path is documentation (scripts/lib/docs-only.mjs)
//   ui    every path is under apps/ui/ (its package.json excepted) or is documentation, and at
//         least one is under apps/ui/. Nothing outside apps/ui imports it, so the UI tests and the
//         static checks cover the change; the UI reference images may change with it.
//   full  anything else. Unsure always means full: a new kind of path falls through to here.
// main always runs the full gate on push, so nothing a lane skips can hide there.
// Usage: git diff --no-renames --name-only … | node scripts/lib/change-lane.mjs   -> the lane
import { readFileSync } from 'node:fs';
import { isDocsOnly } from './docs-only.mjs';

const UI_REFERENCES = 'docs/design/reference/';

function isUi(path) {
  return path.startsWith('apps/ui/') && path !== 'apps/ui/package.json';
}

/** 'docs', 'ui' or 'full' for a list of changed paths. */
export function laneOf(paths) {
  const files = paths.map((p) => p.trim()).filter(Boolean);
  if (files.length === 0) return 'full';
  if (isDocsOnly(files)) return 'docs';
  const uiLane =
    files.some(isUi) &&
    files.every((f) => isUi(f) || f.startsWith(UI_REFERENCES) || isDocsOnly([f]));
  return uiLane ? 'ui' : 'full';
}

if (process.argv[1]?.endsWith('change-lane.mjs')) {
  process.stdout.write(laneOf(readFileSync(0, 'utf8').split('\n')));
}
