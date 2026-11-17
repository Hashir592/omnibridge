import { beforeAll, describe, expect, it } from 'vitest';
import {
  composeModel,
  DOCKER_SETUP_TIMEOUT_MS,
  loadComposeModel,
  readRepoFile,
  service,
} from './helpers.ts';

// Docker runs once here, outside every test's timeout (F-M01-halfway-01).
beforeAll(() => {
  loadComposeModel();
}, DOCKER_SETUP_TIMEOUT_MS);

const SECRETISH = /PASSWORD|SECRET|TOKEN|KEY|KEK/;
/** A KEK line or any long base64 run: never allowed as a plain environment value. */
const KEY_MATERIAL = /[1-9][0-9]*:[A-Za-z0-9+/]{43}=|[A-Za-z0-9+/_-]{32,}/;

const composeSecrets = () => Object.keys(composeModel().secrets ?? {}).sort();

/** Top-level keys of a flat SOPS YAML file, with their raw values. */
function sopsEntries(text: string): Map<string, string> {
  const entries = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^([a-z][a-z0-9_]*):\s?(.*)$/.exec(line);
    if (match?.[1] !== undefined && match[1] !== 'sops') entries.set(match[1], match[2] ?? '');
  }
  return entries;
}

describe('secrets handling (SEC-5)', () => {
  it('[SEC-5] containers receive secrets only as /run/secrets files', () => {
    const model = composeModel();

    // Every secret comes from a git-ignored file materialised from SOPS, never from the environment.
    for (const [name, secret] of Object.entries(model.secrets ?? {})) {
      expect({ name, environment: secret.environment, external: secret.external }).toEqual({
        name,
        environment: undefined,
        external: undefined,
      });
      expect({ name, file: secret.file?.replace(/\\/g, '/') }).toEqual({
        name,
        file: expect.stringMatching(new RegExp(`/infra/compose/\\.secrets/${name}$`)) as unknown,
      });
    }

    for (const [name, svc] of Object.entries(model.services)) {
      const mounted = new Set((svc.secrets ?? []).map((s) => s.source));
      for (const [key, value] of Object.entries(svc.environment ?? {})) {
        // No plain value looks like key material, whatever the variable is called.
        const isSecretPath = /^\/run\/secrets\/[a-z0-9_]+$/.test(value ?? '');
        expect({ name, key, keyLike: !isSecretPath && KEY_MATERIAL.test(value ?? '') }).toEqual({
          name,
          key,
          keyLike: false,
        });
        if (!SECRETISH.test(key)) continue;
        // A secret-like variable only names a file that this same container mounts.
        const target = /^\/run\/secrets\/([a-z0-9_]+)$/.exec(value ?? '')?.[1];
        expect({
          name,
          key,
          ok: key.endsWith('_FILE') && target !== undefined && mounted.has(target),
        }).toEqual({
          name,
          key,
          ok: true,
        });
      }
    }

    // Each master key is mounted only where ADR-007 and ADR-014 put it.
    const holders = (secret: string) =>
      Object.entries(model.services)
        .filter(([, svc]) => (svc.secrets ?? []).some((s) => s.source === secret))
        .map(([name]) => name)
        .sort();
    // rewrap-keys is the one-off KEK rotation job (T-0201), run by hand in the ops profile.
    // seed is the DEV ONLY one-off of compose.dev.yaml (T-0203): it seals the demo TOTP secret.
    expect(holders('secrets_kek')).toEqual(['rewrap-keys', 'seed', 'web', 'worker']);
    expect(service('seed').environment?.OB_ENV).toBe('dev');
    expect(holders('pii_kek')).toEqual(['pii-vault']);
    // T-0402 (invariant 8): one vault token per caller. The vault holds all three; web holds its
    // own; the worker holds its own and the deletion token (DEL-1 jobs only).
    expect(holders('vault_token_web')).toEqual(['pii-vault', 'web']);
    expect(holders('vault_token_worker')).toEqual(['pii-vault', 'worker']);
    expect(holders('vault_token_deletion')).toEqual(['pii-vault', 'worker']);
    // DP-4: only the vault (and its migration job) holds a db-pii credential or joins ob_pii.
    for (const secret of [
      'vault_owner_password',
      'vault_app_password',
      'db_pii_superuser_password',
    ]) {
      expect(
        holders(secret).filter((h) => !['db-pii', 'migrate-pii', 'pii-vault'].includes(h)),
      ).toEqual([]);
    }
    const onPiiNetwork = Object.entries(model.services)
      .filter(([, svc]) => JSON.stringify(svc.networks ?? []).includes('ob_pii'))
      .map(([name]) => name)
      .sort();
    expect(onPiiNetwork).toEqual(['db-pii', 'migrate-pii', 'pii-vault']);
    // ob_platform reads workspace ids only: the scheduled fan-out (worker) and the re-wrap job.
    expect(holders('ob_platform_password')).toEqual(['db-main', 'rewrap-keys', 'worker']);
    // Only the worker may run the audit purge (ADR-049): its own role, held by nobody else.
    expect(holders('ob_worker_password')).toEqual(['db-main', 'worker']);
    // The sign-in HMAC key stays in web (T-0203): the worker sends mail but never checks codes.
    expect(holders('auth_hmac_key')).toEqual(['seed', 'web']);
    // Only web holds the role with every auth definer (ADR-051); the one-off jobs use ob_ops.
    expect(holders('ob_app_password')).toEqual(['db-main', 'web']);
    expect(holders('ob_ops_password')).toEqual(['db-main', 'rewrap-keys', 'seed']);
    expect(service('worker').environment?.DB_MAIN_USER).toBe('ob_worker');
    expect(service('worker').environment?.DB_PLATFORM_USER).toBe('ob_platform');
    expect(service('web').environment?.DB_PLATFORM_USER).toBeUndefined();
    expect(service('web').environment?.SECRETS_KEK_FILE).toBe('/run/secrets/secrets_kek');
    expect(service('worker').environment?.SECRETS_KEK_FILE).toBe('/run/secrets/secrets_kek');
    expect(service('rewrap-keys').environment?.SECRETS_KEK_FILE).toBe('/run/secrets/secrets_kek');
    expect(service('pii-vault').environment?.PII_KEK_FILE).toBe('/run/secrets/pii_kek');
  });

  it('[SEC-5] dev.sops.yaml is fully encrypted and holds exactly the compose secrets', () => {
    const text = readRepoFile('infra/secrets/dev.sops.yaml');
    const entries = sopsEntries(text);
    expect([...entries.keys()].sort()).toEqual(composeSecrets());
    for (const [name, value] of entries) {
      expect({ name, encrypted: /^ENC\[AES256_GCM,data:[^\]]+\]$/.test(value) }).toEqual({
        name,
        encrypted: true,
      });
    }
    expect(text).not.toMatch(/AGE-SECRET-KEY-/);
    expect(text).toMatch(/^sops:$/m);
  });

  it('[SEC-5] the committed age key is DEV ONLY and is the one .sops.yaml encrypts to', () => {
    const key = readRepoFile('infra/secrets/dev.age.key');
    expect(key.split('\n')[0]).toMatch(/^# DEV ONLY\./);
    const recipient = /^# public key: (age1[0-9a-z]+)$/m.exec(key)?.[1];
    expect(recipient).toBeDefined();
    expect(readRepoFile('infra/secrets/.sops.yaml')).toContain(`age: ${recipient ?? ''}`);
    expect(readRepoFile('infra/secrets/dev.sops.yaml')).toContain(recipient ?? '');
    // gitleaks allows exactly this file and nothing else under infra/secrets.
    const gitleaks = readRepoFile('.gitleaks.toml');
    expect(gitleaks).toContain("'''(^|/)infra/secrets/dev\\.age\\.key$'''");
    expect(gitleaks.match(/infra\/secrets/g)).toHaveLength(2); // the comment and the path
  });

  it('[SEC-5] the secrets register lists every secret with an owner and a rotation interval', () => {
    const register = readRepoFile('docs/ops/secrets-register.md');
    const rows = register.split('\n').filter((line) => line.startsWith('| `'));
    for (const name of composeSecrets()) {
      const row = rows.find((line) => line.startsWith(`| \`${name}\``));
      expect({ name, listed: row !== undefined }).toEqual({ name, listed: true });
      // Columns: name | what | owner | dev | production | containers | rotation | next rotation
      const cells = (row ?? '').split('|').map((c) => c.trim());
      expect({ name, owner: cells[3], rotation: cells[7] }).toEqual({
        name,
        owner: expect.stringMatching(/\S/) as unknown,
        rotation: expect.stringMatching(/\d+ (months|days)/) as unknown,
      });
    }
  });

  it('[SEC-5] secret files and the dev age key never enter a Docker build context', () => {
    const ignored = readRepoFile('.dockerignore')
      .split(/\r?\n/)
      .map((line) => line.trim());
    for (const path of ['infra/compose/.secrets', 'infra/secrets', 'infra/secrets/**']) {
      expect({ path, ignored: ignored.includes(path) }).toEqual({ path, ignored: true });
    }
  });
});
