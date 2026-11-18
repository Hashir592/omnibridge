import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// F-M04h-01: a platform operator is not a member of the workspaces they manage, so a tenant
// transaction opened for a platform route must never name them as its user; the database's
// admin-only member rules would then refuse the write. They are named in audit rows instead.

const SRC = fileURLToPath(new URL('.', import.meta.url));

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return sources(path);
    return /\.ts$/.test(e.name) && !/\.test\.ts$/.test(e.name) ? [path] : [];
  });
}

describe('platform writes', () => {
  it('[TEN-7] no tenant transaction is opened as the platform operator', () => {
    const offenders = sources(SRC).filter((f) =>
      /\.(run|runWorkspace|runMember)\(\s*\{[^}]*userId:\s*platform\./s.test(
        readFileSync(f, 'utf8'),
      ),
    );
    expect(offenders).toEqual([]);
  });
});
