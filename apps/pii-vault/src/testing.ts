import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { generateKekLine, parseKeyring, type Keyring } from '@omnibridge/crypto';
import type { Logger } from '@omnibridge/logger';
import { createPiiPool, migratePii, type PoolConfig } from '@omnibridge/pii-db';
import { buildVaultApp } from './app.ts';
import { ServiceTokens } from './auth.ts';
import { DeletionJournal, DeletionService } from './deletion.ts';
import { LabelStore } from './labels.ts';
import type { Caller } from './vault.ts';
import { Vault } from './vault.ts';

export interface TestVault {
  baseUrl: string;
  /** Synthetic per-run tokens, one per caller. */
  tokens: Readonly<Record<Caller, string>>;
  close(): Promise<void>;
}

/**
 * A real pii-vault on a random local port, over a test db-pii (migrated here), with a synthetic
 * master key and tokens. For cross-service tests (the AT-9 boundary scan) that may not import
 * db-pii themselves; never used by the running service.
 */
export async function startTestVault(options: {
  owner: PoolConfig;
  app: PoolConfig;
  logger: Logger;
  /** The off-site journal stand-in (a temporary directory in tests). */
  journalDir: string;
  now?: () => Date;
  /** Two vaults over copies of one database (a restore) share the master key. */
  keyring?: Keyring;
  /** The label files' volume stand-in (T-1201); without it the label routes answer 404. */
  labelsDir?: string;
}): Promise<TestVault> {
  await migratePii(options.owner);
  const pool = createPiiPool({ ...options.app, max: 4 }, (err) => {
    options.logger.warn({ event: 'db.connection_error', err }, 'db-pii connection error');
  });
  const tokens = {
    web: randomBytes(32).toString('base64url'),
    worker: randomBytes(32).toString('base64url'),
    deletion: randomBytes(32).toString('base64url'),
  };
  const now = options.now ?? (() => new Date());
  const journal = new DeletionJournal(options.journalDir);
  const vault = new Vault({
    pool,
    keyring: options.keyring ?? parseKeyring('pii', generateKekLine(1)),
    now,
    journal,
    onCanary: (event) => {
      options.logger.warn(
        { event: 'vault.canary_read', workspaceId: event.workspaceId },
        'canary record read',
      );
    },
    onVacuumFailed: (errorName) => {
      options.logger.warn(
        { event: 'vault.vacuum_failed', errorName },
        'VACUUM after a correction failed',
      );
    },
  });
  await vault.ensureVaultKey();
  const labels =
    options.labelsDir === undefined
      ? undefined
      : new LabelStore({ pool, dir: options.labelsDir, vault, now });
  const deletion = new DeletionService({
    pool,
    journal,
    now,
    ...(labels === undefined ? {} : { labels }),
    onWorkspaceClosed: (workspaceId) => {
      vault.forgetKeys(workspaceId);
    },
  });
  const app = buildVaultApp({
    logger: options.logger,
    version: 'test',
    dbPii: () => Promise.resolve(true),
    vault,
    tokens: new ServiceTokens(tokens),
    deletion,
    ...(labels === undefined ? {} : { labels }),
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const { port } = app.server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${String(port)}`,
    tokens,
    close: async () => {
      await app.close();
      await pool.end();
    },
  };
}
