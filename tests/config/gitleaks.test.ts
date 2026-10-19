import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { DOCKER_SETUP_TIMEOUT_MS, readRepoFile, repoRoot } from './helpers.ts';

/** A fresh random KEK line, made at run time and never committed. */
const kekLine = () =>
  `${String(1 + Math.floor(Math.random() * 9))}:${randomBytes(32).toString('base64')}`;

/** The shapes a pasted master key most often takes (F-M01-halfway-02). */
const variants: Record<string, (line: string) => string> = {
  'bare.txt': (line) => `${line}\n`,
  'indented.yaml': (line) => `secrets_kek: |-\n  ${line}\n`,
  'quoted.yaml': (line) => `secrets_kek: "${line}"\n`,
  'app.env': (line) => `SECRETS_KEK=${line}\n`,
  'config.json': (line) => `{"kek":"${line}"}\n`,
  'keys.ts': (line) => `export const KEK = '${line}';\n`,
  'two-versions.txt': (line) => `${line}\n${kekLine()}\n`,
};

interface Finding {
  RuleID: string;
  File: string;
}

const gitleaksImage = () => {
  const image = /^GITLEAKS_IMAGE='([^']+)'$/m.exec(readRepoFile('scripts/lib/images.sh'))?.[1];
  if (image === undefined) throw new Error('GITLEAKS_IMAGE not found in scripts/lib/images.sh');
  return image;
};

describe('gitleaks master-key rule (SEC-5, SEC-6)', () => {
  let findings: Finding[] = [];
  let exitCode: number | null = null;

  // One pinned-image `dir` scan, run outside every test's timeout.
  beforeAll(() => {
    const base = mkdtempSync(join(tmpdir(), 'ob-gitleaks-'));
    const scan = join(base, 'scan');
    const out = join(base, 'out');
    mkdirSync(scan);
    mkdirSync(out);
    for (const [file, make] of Object.entries(variants))
      writeFileSync(join(scan, file), make(kekLine()));
    writeFileSync(join(scan, 'clean.ts'), "export const version = '1:not-a-key';\n");

    const res = spawnSync(
      'docker',
      [
        'run',
        '--rm',
        '-v',
        `${scan}:/scan:ro`,
        '-v',
        `${out}:/out`,
        '-v',
        `${join(repoRoot, '.gitleaks.toml')}:/config/gitleaks.toml:ro`,
        gitleaksImage(),
        'dir',
        '/scan',
        '--config',
        '/config/gitleaks.toml',
        '--redact',
        '--no-banner',
        '--report-format',
        'json',
        '--report-path',
        '/out/report.json',
      ],
      { encoding: 'utf8', env: { ...process.env, MSYS_NO_PATHCONV: '1' } },
    );
    exitCode = res.status;
    findings = JSON.parse(readFileSync(join(out, 'report.json'), 'utf8')) as Finding[];
  }, DOCKER_SETUP_TIMEOUT_MS);

  it('[SEC-6] flags a KEK line in bare, env, YAML, JSON and code files', () => {
    expect(exitCode).toBe(1);
    const flagged = new Set(
      findings
        .filter((f) => f.RuleID === 'omnibridge-kek-line')
        .map((f) => f.File.split('/').pop()),
    );
    for (const file of Object.keys(variants)) {
      expect({ file, flagged: flagged.has(file) }).toEqual({ file, flagged: true });
    }
    expect(flagged.has('clean.ts')).toBe(false);
  });
});
