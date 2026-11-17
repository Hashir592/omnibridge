import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// T-0212 (ADR-062): migration 0020 retires the functions 0018 and 0019 kept for the previous app
// version. This proves no app code still calls them: a removed call would otherwise fail only at
// run time, with "permission denied".

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));

/** Every non-test TypeScript source file of the apps, packages and mocks. */
function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', 'dist', 'migrations'].includes(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sources(path));
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(path);
  }
  return out;
}

/** The argument count of each `app.<name>(…)` call in `text`, by top-level commas. */
function callArities(text: string, name: string): number[] {
  const arities: number[] = [];
  const re = new RegExp(String.raw`app\.${name}\(`, 'g');
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    let depth = 1;
    let commas = 0;
    let empty = true;
    let quote = '';
    for (let i = m.index + m[0].length; i < text.length && depth > 0; i += 1) {
      const ch = text.charAt(i);
      // Commas inside a quoted SQL string are not argument separators.
      if (quote !== '') {
        if (ch === quote) quote = '';
        empty = false;
        continue;
      }
      if (ch === "'" || ch === '"') quote = ch;
      else if (ch === '(' || ch === '{' || ch === '[') depth += 1;
      else if (ch === ')' || ch === '}' || ch === ']') depth -= 1;
      else if (ch === ',' && depth === 1) commas += 1;
      if (depth > 0 && !/\s/.test(ch)) empty = false;
    }
    arities.push(empty ? 0 : commas + 1);
  }
  return arities;
}

describe('retired rollout functions (T-0212, ADR-062)', () => {
  const files = ['apps', 'packages', 'mocks'].flatMap((d) => sources(join(ROOT, d)));
  const text = files.map((f) => readFileSync(f, 'utf8')).join('\n');

  it('[USR-2] the scan counts arguments, not commas inside quoted strings', () => {
    expect(callArities("app.f(${'a'}, 'x,y', g(1, 2))", 'f')).toEqual([3]);
    expect(callArities('app.f()', 'f')).toEqual([0]);
  });

  it('[USR-2] the scan reads the auth store, so a miss means no call', () => {
    expect(files.some((f) => f.endsWith(join('db', 'src', 'auth.ts')))).toBe(true);
    expect(callArities(text, 'auth_record_failure')).not.toEqual([]);
  });

  it('[USR-5][USR-7] no app code calls the three-argument auth_record_failure or auth_reset_allow', () => {
    expect(callArities(text, 'auth_record_failure').every((n) => n === 5)).toBe(true);
    expect(callArities(text, 'auth_reset_allow').every((n) => n === 4)).toBe(true);
  });

  it('[USR-2] no app code names auth_user_workspaces (replaced by auth_user_workspaces_modules)', () => {
    expect(text).not.toMatch(/auth_user_workspaces(?!_modules)/);
  });
});
