// Decides whether a pull request changes only documentation (ADR-043): every changed path is
// under docs/ (docs/backlog.json included) or is a Markdown file. Anything else runs the full gate.
// Usage: node scripts/lib/docs-only.mjs < changed-paths.txt   -> prints "true" or "false"
import { readFileSync } from 'node:fs';

/** True when the list is non-empty and every path is documentation. */
export function isDocsOnly(paths) {
  const files = paths.map((p) => p.trim()).filter(Boolean);
  return files.length > 0 && files.every((p) => p.startsWith('docs/') || p.endsWith('.md'));
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('docs-only.mjs')) {
  process.stdout.write(String(isDocsOnly(readFileSync(0, 'utf8').split('\n'))));
}
