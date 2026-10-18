#!/usr/bin/env node
// commit-msg hook (lefthook): Conventional Commits subject plus a `Refs:` footer of PRD IDs that
// exist in docs/plan/requirements-index.md (SEC-16, CLAUDE.md "Commits").
// Usage: node scripts/commit-msg.mjs <path-to-commit-message-file>
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const TYPES = [
  'feat',
  'fix',
  'docs',
  'style',
  'refactor',
  'perf',
  'test',
  'build',
  'ci',
  'chore',
  'revert',
];
const SUBJECT = new RegExp(`^(${TYPES.join('|')})(\\([a-z0-9][a-z0-9-]*\\))?!?: \\S.{0,99}$`);
const REFS = /^Refs: ([A-Z]+-\d+(?:, [A-Z]+-\d+)*)$/m;

/** Returns a list of problems with the message; empty when it is valid. */
export function checkCommitMessage(raw, indexedIds) {
  const text = raw
    .split(/\r?\n/)
    .filter((line) => !line.startsWith('#'))
    .join('\n')
    .trim();
  const subject = text.split('\n')[0] ?? '';

  // Git's own merge and revert messages are let through unchanged.
  if (/^Merge (branch|pull request|remote-tracking branch) /.test(subject)) return [];

  const problems = [];
  if (!SUBJECT.test(subject)) {
    problems.push(
      `subject must be "<type>(<scope>): <summary>" with type one of ${TYPES.join(', ')}`,
    );
  }
  const refs = REFS.exec(text);
  if (!refs) {
    problems.push('missing footer line "Refs: ID-1, ID-2" with the PRD IDs this change serves');
  } else {
    for (const id of refs[1].split(', ')) {
      if (!indexedIds.has(id))
        problems.push(`Refs: ${id} is not in docs/plan/requirements-index.md`);
    }
  }
  return problems;
}

export function loadIndexedIds(root = fileURLToPath(new URL('..', import.meta.url))) {
  const index = readFileSync(`${root}/docs/plan/requirements-index.md`, 'utf8');
  return new Set([...index.matchAll(/^- ([A-Z]+-\d+) — /gm)].map((m) => m[1]));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const file = process.argv[2];
  if (!file) {
    console.error('usage: commit-msg.mjs <message-file>');
    process.exit(2);
  }
  const problems = checkCommitMessage(readFileSync(file, 'utf8'), loadIndexedIds());
  for (const p of problems) console.error(`commit-msg: ${p}`);
  process.exitCode = problems.length === 0 ? 0 : 1;
}
