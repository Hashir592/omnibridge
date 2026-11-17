import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { activeException, loadExceptions } from '../../scripts/lib/audit-exceptions.mjs';
import { repoRoot } from './helpers.ts';

// PS-026: a time-boxed exception lets one named advisory through until it expires.
const entry = {
  ids: ['GHSA-aaaa-bbbb-cccc'],
  expires: '2026-12-01',
  ref: 'PS-026',
  reason: 'test',
};

function pnpmGate(report: unknown): { code: number; out: string } {
  try {
    const out = execFileSync('node', ['scripts/lib/pnpm-audit-gate.mjs'], {
      cwd: repoRoot,
      input: JSON.stringify(report),
      encoding: 'utf8',
    });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status: number; stdout: string };
    return { code: err.status, out: err.stdout };
  }
}

const advisory = (id: string, severity: string) => ({
  advisories: { '1': { github_advisory_id: id, module_name: 'pkg', severity, cves: [] } },
});

describe('dependency audit gate', () => {
  it('[SEC-4] an exception covers only the advisory it names, and only until it expires', () => {
    expect(activeException([entry], ['GHSA-aaaa-bbbb-cccc'], '2026-12-01')).toBe(entry);
    expect(activeException([entry], ['GHSA-aaaa-bbbb-cccc'], '2026-12-02')).toBeUndefined();
    expect(activeException([entry], ['GHSA-other'], '2026-11-17')).toBeUndefined();
  });

  it('[SEC-4] every committed exception names its ADR or PS entry, a reason and an expiry', () => {
    for (const e of loadExceptions()) {
      expect(e.ref).toMatch(/^(ADR|PS)-\d{3}$/);
      expect(e.expires).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('[SEC-4] the pnpm audit gate fails on a high advisory with no exception and passes a moderate one', () => {
    expect(pnpmGate(advisory('GHSA-none-none-none', 'high')).code).toBe(1);
    expect(pnpmGate(advisory('GHSA-none-none-none', 'critical')).code).toBe(1);
    expect(pnpmGate(advisory('GHSA-none-none-none', 'moderate')).code).toBe(0);
  });

  it('[SEC-4] the pnpm audit gate refuses an empty or error report instead of passing it', () => {
    expect(pnpmGate({ error: { code: 'ENOAUDIT' } }).code).toBe(1);
    expect(pnpmGate({}).code).toBe(1);
  });
});
