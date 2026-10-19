import { describe, expect, it } from 'vitest';
import { readRepoFile } from './helpers.ts';

const workflow = readRepoFile('.github/workflows/ci.yml');
const verify = readRepoFile('scripts/verify.sh');

describe('CI workflow and gate', () => {
  it('[SEC-16] every action in the CI workflow is pinned to a 40-character commit SHA', () => {
    const uses = [...workflow.matchAll(/^\s*-?\s*uses:\s*(\S+)/gm)].map((m) => m[1] ?? '');
    expect(uses.length).toBeGreaterThan(0);
    for (const ref of uses) expect(ref).toMatch(/^[\w.-]+\/[\w.-]+(\/[\w./-]+)?@[0-9a-f]{40}$/);
  });

  it('[SEC-16] CI runs the full gate on pull requests to main', () => {
    expect(workflow).toMatch(/pull_request:\s*\n\s*branches: \[main\]/);
    expect(workflow).toContain('run: bash scripts/verify.sh');
    expect(workflow).not.toMatch(/verify\.sh --quick/);
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
    expect(pinned).toHaveLength(5); // gitleaks, osv-scanner, actionlint, caddy, sops (PS-007)
    for (const image of pinned) expect(image).toMatch(/@sha256:[0-9a-f]{64}$/);
  });

  it('[SEC-16] the gate e2e step starts its own UI server and never reuses another one', () => {
    const verify = readRepoFile('scripts/verify.sh');
    expect(verify).toMatch(/OB_UI_PORT=\d+ OB_E2E_OWN_SERVER=1 .*playwright test/);
    const config = readRepoFile('playwright.config.ts');
    expect(config).toContain(
      'reuseExistingServer: !process.env.CI && !process.env.OB_E2E_OWN_SERVER',
    );
    expect(config).toContain('--port ${uiPort} --strictPort');
  });
});
