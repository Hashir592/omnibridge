import { readdirSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { DOCKER_SETUP_TIMEOUT_MS, loadComposeModel, readRepoFile, service } from './helpers.ts';

beforeAll(() => {
  loadComposeModel();
}, DOCKER_SETUP_TIMEOUT_MS);

/**
 * Label files are PII (invariant 11, T-1201): they live in pii-vault's own volume, only pii-vault
 * mounts it, no backup script reads it, and a restore drops the rows that pointed at its files.
 */
describe('label files are never backed up (invariant 11)', () => {
  it('[DP-8][DEL-1] only pii-vault mounts the label volume, at its LABELS_DIR, inside 256 MB (FA-15)', () => {
    const vault = service('pii-vault');
    const mount = vault.volumes?.find((v) => v.target === '/data/labels');
    expect(mount?.source).toBe('pii_labels');
    expect(vault.environment?.LABELS_DIR).toBe('/data/labels');
    expect(vault.mem_limit).toBe('256m');
    for (const name of ['web', 'worker', 'db-pii', 'db-main']) {
      expect(service(name).volumes?.some((v) => v.source === 'pii_labels') ?? false, name).toBe(
        false,
      );
    }
  });

  it('[DP-8][AT-8] no backup script names the label volume or its path; a restore drops label rows', () => {
    const dir = 'infra/backup/';
    const scripts = readdirSync(dir).filter((f) => /\.(sh|mjs)$/.test(f));
    expect(scripts.length).toBeGreaterThan(0);
    for (const file of scripts) {
      const text = readRepoFile(`${dir}${file}`);
      expect({ file, named: /pii_labels|\/data\/labels/.test(text) }).toEqual({
        file,
        named: false,
      });
    }
    expect(readRepoFile(`${dir}apply-tombstones.sql`)).toMatch(/DELETE FROM vault\.label_files;/);
  });
});
