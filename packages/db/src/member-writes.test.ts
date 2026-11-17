import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// F-M02e-01: MembershipRepository.add is a system write (it never acts as a user, so the
// database's admin-only rule lets it through). Only the dev seed may call it from app code;
// people join a workspace through an invite.

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const ALLOWED = new Set(['apps/web/src/auth/dev-seed.ts']);

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', 'dist'].includes(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sources(path));
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(path);
  }
  return out;
}

describe('system member writes', () => {
  it('[PERM-5] no app code but the dev seed adds a member directly', () => {
    const callers = ['apps']
      .flatMap((d) => sources(join(ROOT, d)))
      .filter((f) =>
        /MembershipRepository\([^)]*\)\.add\(|\bmembers\.add\(/.test(readFileSync(f, 'utf8')),
      )
      .map((f) => relative(ROOT, f).split('\\').join('/'));
    expect(callers.filter((f) => !ALLOWED.has(f))).toEqual([]);
    expect(callers).toContain('apps/web/src/auth/dev-seed.ts');
  });
});
