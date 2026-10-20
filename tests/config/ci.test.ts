import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isDocsOnly, READ_BY_DOCS_GATE } from '../../scripts/lib/docs-only.mjs';
import { readRepoFile, repoRoot } from './helpers.ts';

const workflow = readRepoFile('.github/workflows/ci.yml');
const verify = readRepoFile('scripts/verify.sh');
const localActions = readdirSync(`${repoRoot}.github/actions`).map((dir) =>
  readRepoFile(`.github/actions/${dir}/action.yml`),
);

const PINNED = /^[\w.-]+\/[\w.-]+(\/[\w./-]+)?@[0-9a-f]{40}$/;
const LOCAL = /^\.\/\.github\/actions\/[\w-]+$/;

describe('CI workflow and gate', () => {
  it('[SEC-16] every action in the CI workflow is pinned to a 40-character commit SHA', () => {
    // Local composite actions live in this repo; every action they use is pinned as well.
    for (const file of [workflow, ...localActions]) {
      const uses = [...file.matchAll(/^\s*-?\s*uses:\s*(\S+)/gm)].map((m) => m[1] ?? '');
      expect(uses.length).toBeGreaterThan(0);
      for (const ref of uses)
        expect({ ref, ok: PINNED.test(ref) || LOCAL.test(ref) }).toEqual({ ref, ok: true });
    }
  });

  it('[SEC-16] CI runs the full gate on pull requests to main', () => {
    expect(workflow).toMatch(/pull_request:\s*\n\s*branches: \[main\]/);
    expect(workflow).toContain('run: bash scripts/verify.sh');
    expect(workflow).not.toMatch(/verify\.sh --quick/);
  });

  it('[SEC-4] the parallel CI jobs together run exactly the full gate (ADR-043)', () => {
    const fullSteps = (/FULL_STEPS=\(([^)]*)\)/.exec(verify)?.[1] ?? '')
      .split(/\s+/)
      .filter(Boolean);
    expect(fullSteps).toHaveLength(19);
    const jobs = [...workflow.matchAll(/verify\.sh --only=([\w,-]+)/g)].map((m) =>
      (m[1] ?? '').split(','),
    );
    expect(jobs).toHaveLength(3);
    // Each job installs first; every other step runs in exactly one job, and nothing unknown.
    for (const job of jobs) expect(job[0]).toBe('install');
    const covered = jobs.flat().filter((step) => step !== 'install');
    expect([...covered].sort()).toEqual(fullSteps.filter((step) => step !== 'install').sort());
  });

  it('[SEC-4] the required check keeps its name and needs every gate job', () => {
    expect(workflow).toContain('name: verify (full gate)');
    expect(workflow).toMatch(/needs: \[changes, docs, static, tests, stack\]\n\s+if: always\(\)/);
    expect(workflow).toContain('run: bash scripts/verify.sh --docs');
    expect(workflow).toContain("if: needs.changes.outputs.code == 'false'");
  });

  it('[SEC-4] only docs/**, *.md and docs/backlog.json take the docs fast path', () => {
    expect(isDocsOnly(['docs/STATE.md', 'README.md', 'docs/backlog.json'])).toBe(true);
    expect(isDocsOnly(['docs/STATE.md', 'packages/db/src/x.ts'])).toBe(false);
    expect(isDocsOnly(['.github/workflows/ci.yml'])).toBe(false);
    expect(isDocsOnly(['scripts/verify.sh'])).toBe(false);
    expect(isDocsOnly([])).toBe(false);
  });

  it('[SEC-4] docs that tests read run the full gate', () => {
    expect(isDocsOnly(['docs/ops/secrets-register.md'])).toBe(false);
    expect(isDocsOnly(['docs/design/reference/order-detail-linux.png'])).toBe(false);
    expect(isDocsOnly(['docs/ops/runbook.md', 'docs/design/README.md'])).toBe(true);
  });

  it('[SEC-4] every docs path a test or script names is either full-gate or checked on the fast path', () => {
    const files = execFileSync(
      'git',
      ['ls-files', 'tests', 'scripts', 'packages', 'apps', 'mocks', '*.config.ts'],
      {
        cwd: repoRoot,
        encoding: 'utf8',
      },
    )
      .split('\n')
      .filter((f) => /\.(ts|tsx|mjs|js|sh)$/.test(f))
      .filter((f) => !['tests/config/ci.test.ts', 'scripts/lib/docs-only.mjs'].includes(f));
    const unguarded: string[] = [];
    for (const file of files) {
      for (const line of readRepoFile(file).split('\n')) {
        if (/^\s*(\/\/|\*|\/\*|#)/.test(line)) continue; // prose in comments names docs freely
        for (const [match] of line.matchAll(/docs\/[\w./{}*-]+/g)) {
          const path = match.replace(/[{*].*$/, '').replace(/\.$/, '');
          // The bare tree (an exclude pathspec, help text) names no file a test could read.
          if (path === 'docs/' || READ_BY_DOCS_GATE.includes(path)) continue;
          if (isDocsOnly([path])) unguarded.push(`${file}: ${path}`);
        }
      }
    }
    expect(unguarded).toEqual([]);
  });

  it('[SEC-4] a file moved from code into docs/ is not docs-only in the CI diff', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ob-rename-'));
    try {
      // Trees, not commits, so no local commit hook or signing setting affects the test.
      const git = (...args: string[]) =>
        execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
      git('init', '-q');
      mkdirSync(join(dir, 'packages'));
      writeFileSync(join(dir, 'packages', 'a.ts'), 'export const a = 1;\n'.repeat(20));
      git('add', '.');
      const before = git('write-tree');
      mkdirSync(join(dir, 'docs'));
      git('mv', 'packages/a.ts', 'docs/a.md');
      const after = git('write-tree');

      const flags = workflow.match(/git diff ([^"]*)"\$BASE\.\.\.\$HEAD"/)?.[1]?.trim() ?? '';
      expect(flags).toBe('--no-renames --name-only');
      const changed = git('diff', ...flags.split(' '), before, after).split('\n');
      expect(changed).toContain('packages/a.ts');
      expect(isDocsOnly(changed)).toBe(false);
      // Without --no-renames, git reports only the new path, which would look docs-only.
      expect(isDocsOnly(git('diff', '--name-only', before, after).split('\n'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('[SEC-4] CI runs Semgrep CE on pull requests from a digest-pinned image', () => {
    expect(workflow).toMatch(/image: semgrep\/semgrep:[\d.]+@sha256:[0-9a-f]{64}/);
    expect(workflow).toContain("if: github.event_name == 'pull_request'");
    expect(workflow).toContain('--metrics=off');
  });

  it('[SEC-4] the full gate runs dependency and secret scanning', () => {
    for (const step of ['step gitleaks', 'step audit', 'osv-scanner', 'audit --audit-level high']) {
      expect(verify).toContain(step);
    }
  });

  it('[SEC-4] gate tool images are pinned by digest', () => {
    const images = readRepoFile('scripts/lib/images.sh');
    const pinned = [...images.matchAll(/_IMAGE='([^']+)'/g)].map((m) => m[1]);
    // gitleaks, osv-scanner, actionlint, caddy, sops (PS-007), playwright (ADR-039, ui-refs.sh)
    expect(pinned).toHaveLength(6);
    for (const image of pinned) expect(image).toMatch(/@sha256:[0-9a-f]{64}$/);
  });

  it('[SEC-16] the gate e2e step starts its own UI server and never reuses another one', () => {
    expect(verify).toMatch(/OB_UI_PORT=\d+ OB_E2E_OWN_SERVER=1 .*playwright test/);
  });

  it('[SEC-16] with the gate settings, Playwright starts its own UI server on that port', async () => {
    const saved = { ...process.env };
    try {
      delete process.env.OB_UI_URL;
      process.env.OB_UI_PORT = '5199';
      process.env.OB_E2E_OWN_SERVER = '1';
      const { default: config } = await import('../../playwright.config.ts');
      const server = Array.isArray(config.webServer) ? config.webServer[0] : config.webServer;
      expect(server?.reuseExistingServer).toBe(false);
      expect(server?.url).toBe('http://localhost:5199');
      expect(server?.command).toContain('--port 5199 --strictPort');
    } finally {
      process.env = saved;
    }
  });

  it('[NFR-1] the gate waits for the stack to be ready, not just alive, before e2e (O-1)', () => {
    // Liveness healthchecks accept 503 on purpose; readiness is checked through the edge.
    expect(readRepoFile('apps/web/src/healthcheck.ts')).toContain('status === 503');
    expect(verify).toMatch(/up -d --wait --wait-timeout \d+ &&\s*\n\s*wait_ready/);
    expect(verify).toContain(
      'curl -fsk --max-time 10 https://localhost:8443/healthz | grep -q \'"status":"ok"\'',
    );
    expect(verify).toContain('curl -fsk --max-time 10 -o /dev/null https://localhost:8444/');
  });
});
