import { readdirSync, readFileSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { checkCommitMessage, loadIndexedIds } from '../../scripts/commit-msg.mjs';
import { readRepoFile, repoRoot, runScript } from './helpers.ts';

function packageJsons(): string[] {
  const found: string[] = [`${repoRoot}package.json`];
  const walk = (dir: string, depth: number) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === 'node_modules' || entry.name === 'dist') continue;
      const path = join(dir, entry.name);
      if (existsSync(join(path, 'package.json'))) found.push(join(path, 'package.json'));
      if (depth > 0) walk(path, depth - 1);
    }
  };
  for (const top of ['apps', 'packages', 'mocks']) walk(`${repoRoot}${top}`, 1);
  return found;
}

describe('repository rules', () => {
  it('[OPS-11] no managed-backend or hosted-telemetry SDK in any package.json', () => {
    const banned =
      /^(@vercel\/|@supabase\/|firebase|@firebase\/|@netlify\/|@aws-amplify\/|aws-amplify|@sentry\/|@clerk\/|@planetscale\/|@neondatabase\/)/;
    for (const file of packageJsons()) {
      const pkg = JSON.parse(readFileSync(file, 'utf8')) as Record<
        string,
        Record<string, string> | undefined
      >;
      const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
      expect({ file, banned: deps.filter((d) => banned.test(d)) }).toEqual({ file, banned: [] });
    }
  });

  it('[SEC-16] commit-msg rejects message without Refs footer', () => {
    const ids = loadIndexedIds(repoRoot);
    expect(checkCommitMessage('feat(web): add healthz\n', ids)).toEqual([
      'missing footer line "Refs: ID-1, ID-2" with the PRD IDs this change serves',
    ]);
    expect(checkCommitMessage('feat(web): add healthz\n\nRefs: NFR-1, OPS-10\n', ids)).toEqual([]);
  });

  it('[SEC-16] commit-msg rejects a non-conventional subject and unknown IDs', () => {
    const ids = loadIndexedIds(repoRoot);
    const problems = checkCommitMessage('Added stuff\n\nRefs: NOPE-1\n', ids);
    expect(problems).toHaveLength(2);
    expect(problems[1]).toBe('Refs: NOPE-1 is not in docs/plan/requirements-index.md');
  });

  it('[TEN-4] the name gate flags a hard-coded workspace name outside seed files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ob-names-'));
    execFileSync('git', ['init', '-q'], { cwd: dir });
    const name = ['Sid', 'son'].join('');
    writeFileSync(join(dir, 'ok.ts'), 'export const x = 1;\n');
    expect(runScript('scripts/check-names.sh', [dir]).code).toBe(0);
    writeFileSync(join(dir, 'bad.ts'), `export const company = '${name} Ltd';\n`);
    const res = runScript('scripts/check-names.sh', [dir]);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('bad.ts');
  });

  it('[TEN-4] the name gate fails when it cannot scan', () => {
    const notARepo = mkdtempSync(join(tmpdir(), 'ob-names-'));
    expect(runScript('scripts/check-names.sh', [notARepo]).code).toBe(2);
  });

  it('[TEN-4] the name gate allows names in seed files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ob-names-'));
    execFileSync('git', ['init', '-q'], { cwd: dir });
    execFileSync('mkdir', ['-p', join(dir, 'seed')]);
    writeFileSync(
      join(dir, 'seed', 'workspace.ts'),
      `export const n = '${['Kyy', 'z'].join('')}';\n`,
    );
    expect(runScript('scripts/check-names.sh', [dir]).code).toBe(0);
  });

  it('[TEN-4] hard-coded-name gate: the repository, launch seed included, has no names outside seed files', () => {
    // The launch seed holds the client's names (PRD §0.3); the gate must still pass on the repo.
    const seed = readRepoFile('packages/db/seed/launch.ts');
    expect(seed).toContain(['Jee', 'z Group'].join(''));
    const res = runScript('scripts/check-names.sh');
    expect({ code: res.code, stderr: res.stderr }).toEqual({ code: 0, stderr: '' });
  });

  it('[TEN-1] only the PLATFORM_JOBS module and the re-wrap job import the ob_platform pool', () => {
    // Mirrors the dependency-cruiser rule ob-platform-only-in-fanout (ADR-049).
    const config = readRepoFile('.dependency-cruiser.cjs');
    expect(config).toContain("name: 'ob-platform-only-in-fanout'");
    const importers: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(join(repoRoot, dir), { withFileTypes: true })) {
        const path = `${dir}/${entry.name}`;
        if (entry.isDirectory()) {
          if (!['node_modules', 'dist'].includes(entry.name)) walk(path);
        } else if (/\.tsx?$/.test(entry.name) && !/\.(test|int\.test)\.tsx?$/.test(entry.name)) {
          if (readRepoFile(path).includes("'@omnibridge/db/platform'")) importers.push(path);
        }
      }
    };
    for (const top of ['apps', 'mocks']) walk(top);
    for (const pkg of readdirSync(join(repoRoot, 'packages'), { withFileTypes: true })) {
      if (pkg.isDirectory() && pkg.name !== 'db') walk(`packages/${pkg.name}`);
    }
    expect(importers.sort()).toEqual([
      'apps/web/src/rewrap-keys.ts',
      'apps/worker/src/platform-jobs.ts',
    ]);
  });

  it('[OPS-9] the edge route file routes only OmniBridge hosts to OmniBridge aliases', () => {
    const caddy = readRepoFile('infra/edge/sites/omnibridge.caddy');
    const sites = [...caddy.matchAll(/^([a-z0-9., -]+)\s*\{/gm)].flatMap((m) =>
      (m[1] ?? '').split(',').map((s) => s.trim()),
    );
    expect(sites.sort()).toEqual([
      'app.omnibridge.co.uk',
      'omnibridge.co.uk',
      'www.omnibridge.co.uk',
    ]);
    const upstreams = [...caddy.matchAll(/reverse_proxy\s+(\S+)/g)].map((m) => m[1]);
    expect(upstreams.sort()).toEqual(['omnibridge-site:8080', 'omnibridge-web:8080']);
    expect(caddy.match(/import waf/g)).toHaveLength(2);
  });
});
