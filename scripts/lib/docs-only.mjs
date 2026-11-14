// Decides whether a pull request changes only documentation (ADR-043): every changed path is
// under docs/ (docs/backlog.json included) or is a Markdown file, and none is a file that a test
// reads (READ_BY_TESTS). Anything else runs the full gate.
// Usage: git diff --no-renames --name-only … | node scripts/lib/docs-only.mjs   -> "true" or "false"
import { readFileSync } from 'node:fs';

/**
 * Docs that tests read, so a change to them must run the full gate (F-M01-end-04). An entry ending
 * in `/` covers its whole directory. tests/config/ci.test.ts fails if a test or script reads a
 * docs path that is neither listed here nor checked by the `coverage` step of `verify.sh --docs`.
 */
export const READ_BY_TESTS = [
  'docs/ops/secrets-register.md',
  'docs/ops/mailboxes.md',
  'docs/design/reference/',
];

/** Docs the `coverage` step reads; it runs on the fast path too, so they may stay docs-only. */
export const READ_BY_DOCS_GATE = [
  'docs/PRD.md',
  'docs/plan/requirements-index.md',
  'docs/plan/MODULES.md',
  'docs/backlog.json',
];

const covers = (entry, path) => (entry.endsWith('/') ? path.startsWith(entry) : path === entry);

function isDoc(path) {
  if (READ_BY_TESTS.some((entry) => covers(entry, path))) return false;
  return path.startsWith('docs/') || path.endsWith('.md');
}

/** True when the list is non-empty and every path is documentation. */
export function isDocsOnly(paths) {
  const files = paths.map((p) => p.trim()).filter(Boolean);
  return files.length > 0 && files.every(isDoc);
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('docs-only.mjs')) {
  process.stdout.write(String(isDocsOnly(readFileSync(0, 'utf8').split('\n'))));
}
