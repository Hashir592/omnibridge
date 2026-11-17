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

// ADR-045
describe('migration lint waivers [OPS-3]', () => {
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

  it('[SEC-4] migration 0023: squawk fails on the DROP FUNCTION without the waiver lines and passes with them', () => {
    const migration = readRepoFile('packages/db/migrations/0023_drop_retired_functions.sql');
    const dir = mkdtempSync(join(tmpdir(), 'ob-squawk-'));
    const withWaiver = join(dir, 'with.sql');
    const without = join(dir, 'without.sql');
    writeFileSync(withWaiver, migration);
    writeFileSync(without, migration.replace(/^-- squawk-ignore ban-drop-function\r?\n/gm, ''));
    expect(squawk(withWaiver).code).toBe(0);
    const bare = squawk(without);
    expect(bare.code).not.toBe(0);
    expect(bare.output).toContain('ban-drop-function');
  }, 60_000);

  it('[SEC-4] every squawk waiver is an annotated ban-drop-constraint or ban-drop-function form', () => {
    // ADR-045 allows ban-drop-constraint; ADR-063 adds ban-drop-function, only to drop a function
    // an earlier migration already revoked from every role (two steps, never one).
    for (const dir of MIGRATION_DIRS) {
      const names = readdirSync(join(repoRoot, dir))
        .filter((f) => f.endsWith('.sql'))
        .sort();
      names.forEach((name, fileIndex) => {
        const lines = readRepoFile(`${dir}/${name}`).split(/\r?\n/);
        lines.forEach((line, index) => {
          if (!line.includes('squawk-ignore')) return;
          const where = `${dir}/${name}:${String(index + 1)}`;
          expect({ where, line }).toEqual({
            where,
            line: expect.stringMatching(
              /^-- squawk-ignore ban-drop-(constraint|function)$/,
            ) as unknown,
          });
          expect({ where, above: lines[index - 1] }).toEqual({
            where,
            above: expect.stringMatching(/^-- waiver: replaced by [a-z_]+; \S+$/) as unknown,
          });
          if (!line.endsWith('ban-drop-function')) return;
          const signature = /^DROP FUNCTION (app\.\w+\([^)]*\));$/.exec(
            lines[index + 1] ?? '',
          )?.[1];
          const revokedEarlier = names
            .slice(0, fileIndex)
            .map((earlier) => readRepoFile(`${dir}/${earlier}`))
            .some(
              (text) =>
                text.includes('REVOKE ALL ON FUNCTION') && text.includes(`'${signature ?? '?'}'`),
            );
          expect({ where, signature, revokedEarlier }).toEqual({
            where,
            signature: expect.any(String) as unknown,
            revokedEarlier: true,
          });
        });
      });
    }
  });
});
