import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readSecretFile, requireEnv } from './env.ts';

describe('env helpers', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ob-secret-'));
  const file = join(dir, 'db_password');
  writeFileSync(file, 'synthetic-secret-value\n');

  it('[SEC-5] reads a secret from the file named by <NAME>_FILE', () => {
    expect(readSecretFile('DB_PASSWORD', { DB_PASSWORD_FILE: file })).toBe(
      'synthetic-secret-value',
    );
  });

  it('[SEC-5] refuses a secret passed directly as an environment variable', () => {
    expect(() =>
      readSecretFile('DB_PASSWORD', { DB_PASSWORD: 'x', DB_PASSWORD_FILE: file }),
    ).toThrow(/must not be set directly/);
  });

  it('[SEC-5] refuses a secret with extra surrounding whitespace', () => {
    const padded = join(dir, 'padded');
    writeFileSync(padded, 'synthetic-secret-value\n\n');
    expect(() => readSecretFile('DB_PASSWORD', { DB_PASSWORD_FILE: padded })).toThrow(
      /leading or trailing whitespace/,
    );
  });

  it('[SEC-5] names the missing variable without leaking values', () => {
    expect(() => requireEnv('DB_HOST', {})).toThrow('Environment variable DB_HOST is not set');
  });
});
