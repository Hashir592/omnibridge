import { requireEnv } from '@omnibridge/core';
import { loadKeyring } from '@omnibridge/crypto';
import {
  createMainDb,
  CredentialRepository,
  mainDbConfig,
  platformDbConfig,
  rewrapAllDataKeys,
  WorkspaceDirectory,
} from '@omnibridge/db';
import { FileKeyStore } from '@omnibridge/files';
import { createLogger } from '@omnibridge/logger';
import { rotateKeys } from './key-rotation.ts';

/**
 * KEK rotation for every workspace (SEC-6, runbook "Rotate a master key"): re-wraps each
 * workspace's data keys in db-main and every file key on the volume under the active secrets KEK,
 * then counts what is left. It runs as the one-off `rewrap-keys` ops container (web image), which
 * alone holds ob_app, ob_platform, the secrets KEK and a writable files volume:
 *   docker compose -f infra/compose/compose.yaml --profile ops run --rm rewrap-keys
 * Exits 1 while any key is under another KEK than the active one, so the old line must stay.
 */
const logger = createLogger({ service: 'web', version: process.env.APP_VERSION ?? '0.0.0-dev' });
const keyring = loadKeyring('secrets');
const onDbError = (err: Error) => {
  logger.warn({ event: 'db.connection_error', err }, 'db-main connection error');
};
const app = createMainDb(mainDbConfig('omnibridge-rewrap-keys', 1), onDbError);
const platform = createMainDb(platformDbConfig('omnibridge-rewrap-keys-list'), onDbError);
try {
  const credentials = new CredentialRepository({ keyring, logger });
  const report = await rotateKeys({
    kekVersion: keyring.activeVersion,
    dataKeys: () =>
      rewrapAllDataKeys({
        db: app.db,
        directory: new WorkspaceDirectory(platform.db),
        credentials,
      }),
    fileKeys: new FileKeyStore(requireEnv('FILES_DIR'), keyring),
    logger,
  });
  if (!report.done) process.exitCode = 1;
} finally {
  await platform.destroy();
  await app.destroy();
}
