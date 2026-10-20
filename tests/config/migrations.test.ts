import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readRepoFile, repoRoot } from './helpers.ts';

const MIGRATION_DIRS = ['packages/db/migrations', 'packages/pii-db/migrations'];
/** squawk-cli's own entry script, run with this Node: no shell, so paths with spaces work. */
const squawkScript = join(repoRoot, 'node_modules', 'squawk-cli', 'js', 'bin', 'squawk');

/** Runs squawk exactly as scripts/verify.sh does, on one file. */
function squawk(file: string) {
  const res = spawnSync(
    process.execPath,
    [squawkScript, '--pg-version', '18', '--assume-in-transaction', file],
    { encoding: 'utf8' },
  );
  return { code: res.status, output: `${res.stdout}${res.stderr}` };
}

describe('migration lint waivers (ADR-045, OPS-3)', () => {
  it('[SEC-4] migration 0005: squawk fails on the DROP CONSTRAINT without the waiver line and passes with it', () => {
    const migration = readRepoFile('packages/db/migrations/0005_credentials_delete_after.sql');
    const dir = mkdtempSync(join(tmpdir(), 'ob-squawk-'));
    const withWaiver = join(dir, 'with.sql');
    const without = join(dir, 'without.sql');
    writeFileSync(withWaiver, migration);
    writeFileSync(without, migration.replace(/^-- squawk-ignore ban-drop-constraint\r?\n/m, ''));
    expect(squawk(withWaiver).code).toBe(0);
    const bare = squawk(without);
    expect(bare.code).not.toBe(0);
    expect(bare.output).toContain('ban-drop-constraint');
  }, 60_000);

  it('[SEC-4] every squawk waiver is the annotated ban-drop-constraint form', () => {
    for (const dir of MIGRATION_DIRS) {
      for (const name of readdirSync(join(repoRoot, dir)).filter((f) => f.endsWith('.sql'))) {
        const lines = readRepoFile(`${dir}/${name}`).split(/\r?\n/);
        lines.forEach((line, index) => {
          if (!line.includes('squawk-ignore')) return;
          const where = `${dir}/${name}:${String(index + 1)}`;
          expect({ where, line }).toEqual({ where, line: '-- squawk-ignore ban-drop-constraint' });
          expect({ where, above: lines[index - 1] }).toEqual({
            where,
            above: expect.stringMatching(/^-- waiver: replaced by [a-z_]+; \S+$/) as unknown,
          });
        });
      }
    }
  });
});
