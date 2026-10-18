// Writes each key of a decrypted SOPS JSON document (stdin) to <dir>/<key> as a Docker secret file
// (T-0103, SEC-5). Prints names only, never values. An existing file with different content stops
// the run unless --reset is given, because database volumes keep the passwords they started with.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [dir, mode] = process.argv.slice(2);
if (!dir) throw new Error('usage: materialise-secrets.mjs <dir> [--reset]');
const reset = mode === '--reset';

const doc = JSON.parse(readFileSync(0, 'utf8'));
mkdirSync(dir, { recursive: true });

const stale = [];
for (const [name, value] of Object.entries(doc)) {
  if (name === 'sops') continue;
  if (!/^[a-z][a-z0-9_]*$/.test(name) || typeof value !== 'string' || value === '') {
    throw new Error(
      `dev.sops.yaml entry ${name} must be a non-empty string with a snake_case name`,
    );
  }
  const file = join(dir, name);
  if (existsSync(file)) {
    if (readFileSync(file, 'utf8') === value) continue;
    if (!reset) {
      stale.push(name);
      continue;
    }
  }
  writeFileSync(file, value);
  // Readable by the non-root container users that mount it (dev only).
  chmodSync(file, 0o644);
  console.log(`wrote ${name}`);
}

if (stale.length > 0) {
  console.error(
    `dev-secrets: ${stale.join(', ')} differ from infra/secrets/dev.sops.yaml.\n` +
      'Database volumes keep their first passwords, so reset both together:\n' +
      '  docker compose -f infra/compose/compose.yaml -f infra/compose/compose.dev.yaml down -v\n' +
      '  bash scripts/dev-secrets.sh --reset',
  );
  process.exitCode = 1;
}
