#!/usr/bin/env node
// Requirement-ID coverage gate (SEC-16, invariant 24). Rules: docs/sessions/S3-builder.md §Coverage.
// Usage: node scripts/req-coverage.mjs   (exits 1 when any rule fails)
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkCoverage, testTitleIds } from './lib/req-coverage-lib.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (p) => readFileSync(join(root, p), 'utf8');

const SKIP = new Set(['node_modules', 'dist', '.git', '.astro', 'coverage', 'docs']);
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;

function* testFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* testFiles(path);
    else if (TEST_FILE.test(entry.name)) yield path;
  }
}

const testIds = new Set();
let files = 0;
for (const file of testFiles(root)) {
  // Fixture files that exist only to feed the coverage tests are not real tests.
  if (relative(root, file).replaceAll('\\', '/').startsWith('scripts/__fixtures__/')) continue;
  files += 1;
  for (const id of testTitleIds(readFileSync(file, 'utf8'))) testIds.add(id);
}

const result = checkCoverage({
  prd: read('docs/PRD.md'),
  index: read('docs/plan/requirements-index.md'),
  modules: read('docs/plan/MODULES.md'),
  backlog: JSON.parse(read('docs/backlog.json')),
  testIds,
});

console.log(
  `req-coverage: ${result.indexed} IDs indexed, ${result.owned} owned, ${result.unmapped} unmapped, ` +
    `${result.outsideModule} prd_ids outside their module; ${testIds.size} IDs cited in ${files} test files`,
);
for (const failure of result.failures) console.error(`  FAIL ${failure}`);
process.exitCode = result.failures.length === 0 ? 0 : 1;
