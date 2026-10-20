import { randomBytes } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DOCKER_SETUP_TIMEOUT_MS, repoRoot } from './helpers.ts';

const git = (cwd: string, ...args: string[]) =>
  execFileSync(
    'git',
    ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', ...args],
    {
      cwd,
      encoding: 'utf8',
    },
  );

const scan = (target: string) => {
  const res = spawnSync('bash', [`${repoRoot}scripts/gitleaks.sh`, 'full', target], {
    encoding: 'utf8',
  });
  return {
    code: res.status,
    output: `${res.stdout}${res.stderr}`.replace(/\u001b\[[0-9;]*m/g, ''),
  };
};

describe('gitleaks history scan from a worktree (SEC-4, T-0106)', () => {
  let base = '';
  let fromWorktree: ReturnType<typeof scan>;
  let notARepo: ReturnType<typeof scan>;

  // A fixture repo whose secret exists only in history: committed, then deleted. Scanned from a
  // worktree, where `.git` is just a pointer file. Keys are random and made at run time.
  beforeAll(() => {
    base = mkdtempSync(join(tmpdir(), 'ob-gl-wt-'));
    const repo = join(base, 'repo');
    mkdirSync(repo);
    git(repo, 'init', '-q', '-b', 'main');
    writeFileSync(join(repo, 'app.env'), `SECRETS_KEK=1:${randomBytes(32).toString('base64')}\n`);
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'add config');
    unlinkSync(join(repo, 'app.env'));
    writeFileSync(join(repo, 'README.md'), 'fixture\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'remove config');
    git(repo, 'worktree', 'add', '-q', '-b', 'feature', join(base, 'wt'));

    fromWorktree = scan(join(base, 'wt'));
    const plain = join(base, 'plain');
    mkdirSync(plain);
    notARepo = scan(plain);
  }, DOCKER_SETUP_TIMEOUT_MS);

  afterAll(() => {
    if (base !== '') rmSync(base, { recursive: true, force: true });
  });

  it('[SEC-4] gitleaks history scan finds a planted fake secret when run from a worktree (fixture repo)', () => {
    expect(fromWorktree.output).toMatch(/[1-9]\d* commits? scanned/);
    expect(fromWorktree.output).toMatch(/leaks found: 1/);
    expect(fromWorktree.code).not.toBe(0);
  });

  it('[SEC-4] a target with no git history fails loudly instead of scanning nothing', () => {
    expect(notARepo.code).toBe(2);
    expect(notARepo.output).toContain('is not a git repository');
  });
});
