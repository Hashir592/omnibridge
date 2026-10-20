import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

// T-0304: msw must never reach a production build (ADR-046). App code may use the mock data
// layer (mocks/api.ts, plain fetch) until S3 builds the routes, but never msw itself or the
// modules that define MSW handlers. The only exception is main.tsx, which starts the mocks
// behind import.meta.env.DEV. This guards the source until the M22 build check exists.
const SRC = join(import.meta.dirname, '..');
const MSW_MODULES =
  /from\s+['"](msw(\/[^'"]*)?|[./]+(\/mocks)?\/(handlers|browser|auth)\.ts)['"]|import\(\s*['"]msw/;

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return e.name === 'mocks' ? [] : files(path);
    return /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [path] : [];
  });
}

describe('production code and the mocks', () => {
  it('[NFR-8] no app module imports msw or an MSW handler module', () => {
    const offenders = files(SRC)
      .filter((f) => relative(SRC, f) !== 'main.tsx')
      .filter((f) => MSW_MODULES.test(readFileSync(f, 'utf8')))
      .map((f) => relative(SRC, f));
    expect(offenders).toEqual([]);
  });

  it('[NFR-8] the guard catches an import of the auth mock', () => {
    expect(MSW_MODULES.test("import { DEMO_TOTP } from '../../mocks/auth.ts';")).toBe(true);
    expect(MSW_MODULES.test("import { http } from 'msw/http';")).toBe(true);
    expect(MSW_MODULES.test("import type { MfaResult } from '../../auth/shapes.ts';")).toBe(false);
    expect(MSW_MODULES.test("import { mockApi } from '../mocks/api.ts';")).toBe(false);
  });
});
