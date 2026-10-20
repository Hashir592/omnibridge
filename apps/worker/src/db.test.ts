import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLAMD_TIMEOUT_MS } from '@omnibridge/files';
import { describe, expect, it } from 'vitest';
import { WORKER_TX_TIMEOUTS, workerHandlerDbConfig } from './db.ts';

describe('worker transactions (S1 ruling, 20 Oct 2026)', () => {
  it('[NFR-3] worker handler connections carry a statement and an idle-in-transaction timeout', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ob-worker-db-'));
    writeFileSync(join(dir, 'pw'), 'synthetic-test-password\n');
    const config = workerHandlerDbConfig(8, {
      DB_MAIN_HOST: 'db-main',
      DB_MAIN_NAME: 'omnibridge',
      DB_MAIN_USER: 'ob_app',
      DB_MAIN_PASSWORD_FILE: join(dir, 'pw'),
    });
    expect(config).toMatchObject({
      max: 8,
      statement_timeout: WORKER_TX_TIMEOUTS.statementMs,
      idle_in_transaction_session_timeout: WORKER_TX_TIMEOUTS.idleInTransactionMs,
    });
    // A virus scan holds its job transaction open while clamd reads the file, so the idle limit
    // must outlast the clamd timeout, or every large scan would be cut off.
    expect(WORKER_TX_TIMEOUTS.idleInTransactionMs).toBeGreaterThan(CLAMD_TIMEOUT_MS);
    expect(WORKER_TX_TIMEOUTS.statementMs).toBeGreaterThan(0);
  });
});
