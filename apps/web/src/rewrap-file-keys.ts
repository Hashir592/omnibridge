import { requireEnv } from '@omnibridge/core';
import { loadKeyring } from '@omnibridge/crypto';
import { FileKeyStore } from '@omnibridge/files';
import { createLogger } from '@omnibridge/logger';

/**
 * KEK rotation for the files volume (SEC-6, runbook "Rotate a master key"): re-wraps every
 * workspace's file keys under the active secrets KEK, then checks that none is left under an older
 * one. File bodies are untouched. Runs in the web container, which is the only one that can write
 * the volume:
 *   docker compose -f infra/compose/compose.yaml exec web node dist/rewrap-file-keys.js
 * Exits 1 if any key is still under an old KEK, so the old keyring line must stay.
 */
const logger = createLogger({ service: 'web', version: process.env.APP_VERSION ?? '0.0.0-dev' });
const keyring = loadKeyring('secrets');
const keys = new FileKeyStore(requireEnv('FILES_DIR'), keyring);
const rewrapped = await keys.rewrapAll();
const stale = await keys.countStale();
logger.info(
  { event: 'file_keys.rewrapped', kekVersion: keyring.activeVersion, count: rewrapped },
  'file keys re-wrapped',
);
if (stale > 0) {
  logger.error(
    { event: 'file_keys.stale', kekVersion: keyring.activeVersion, count: stale },
    'file keys still under an old KEK: keep the old keyring line',
  );
  process.exitCode = 1;
}
