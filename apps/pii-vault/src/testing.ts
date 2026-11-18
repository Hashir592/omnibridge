import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { generateKekLine, parseKeyring } from '@omnibridge/crypto';
import type { Logger } from '@omnibridge/logger';
import { migratePii, type PoolConfig } from '@omnibridge/pii-db';
import pg from 'pg';
import { buildVaultApp } from './app.ts';
import { ServiceTokens } from './auth.ts';
import { DeletionJournal, DeletionService } from './deletion.ts';
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
}): Promise<TestVault> {
  await migratePii(options.owner);
  const pool = new pg.Pool({ ...options.app, max: 4 });
  const tokens = {
    web: randomBytes(32).toString('base64url'),
    worker: randomBytes(32).toString('base64url'),
    deletion: randomBytes(32).toString('base64url'),
  };
  const now = options.now ?? (() => new Date());
  const vault = new Vault({ pool, keyring: parseKeyring('pii', generateKekLine(1)), now });
  const deletion = new DeletionService({
    pool,
    journal: new DeletionJournal(options.journalDir),
    now,
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
