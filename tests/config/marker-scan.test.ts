import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// T-0405 (AT-9, DP-8): the restore drill's marker scan over dumps, logs, job tables, mail and
// exports. It names the source and line of a hit, never the line itself.

const SCAN = 'scripts/lib/marker-scan.mjs';
const run = (args: string[], input = '') =>
  spawnSync(process.execPath, [SCAN, ...args], { input, encoding: 'utf8' });

describe('marker scan', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ob-scan-'));
  const clean = join(dir, 'db-main.sql');
  writeFileSync(clean, 'COPY app.job_records (id, result) FROM stdin;\n1\t{"count":2}\n\\.\n');

  it('[AT-9] passes on clean sources, files and stdin', () => {
    const res = run([clean, '-'], '{"level":30,"msg":"order synced","count":3}\n');
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('marker scan: 2 sources, 0 hits');
  });

  it('[AT-9] fails on a planted marker and names where, not what', () => {
    const planted = join(dir, 'mail.json');
    writeFileSync(planted, 'line one\n{"to":"PIIMARK-planted@example.test"}\n');
    const res = run([clean, planted]);
    expect(res.status).toBe(1);
    expect(res.stdout).toContain(`${planted}:2`);
    expect(res.stdout).not.toContain('planted@example.test');
  });

  it('[AT-9] a source that cannot be read fails the scan', () => {
    const res = run([join(dir, 'missing.sql')]);
    expect(res.status).toBe(2);
  });
});
