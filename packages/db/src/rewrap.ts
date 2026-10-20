import type { Kysely } from 'kysely';
import type { CredentialRepository } from './credentials.ts';
import type { WorkspaceDirectory } from './platform.ts';
import type { MainDb } from './schema.ts';
import { withTenantTransaction } from './tenant.ts';

export interface DataKeyTotals {
  workspaces: number;
  rewrapped: number;
  /** Still under an older KEK than the active one, counted after the re-wrap. */
  stale: number;
  /** Under a newer KEK than this process holds; left alone (mid-rollout). */
  newer: number;
}

/**
 * KEK rotation for the database (SEC-6, F-03): for every workspace, re-wraps its data keys under
 * the active KEK in that workspace's tenant transaction, then counts again in a new one.
 */
export async function rewrapAllDataKeys(input: {
  db: Kysely<MainDb>;
  directory: Pick<WorkspaceDirectory, 'listIds'>;
  credentials: Pick<CredentialRepository, 'rewrapDataKeys' | 'countDataKeys'>;
}): Promise<DataKeyTotals> {
  const ids = await input.directory.listIds();
  const totals: DataKeyTotals = { workspaces: ids.length, rewrapped: 0, stale: 0, newer: 0 };
  for (const workspaceId of ids) {
    const ctx = { workspaceId, companyIds: [] };
    totals.rewrapped += await withTenantTransaction(input.db, ctx, (trx) =>
      input.credentials.rewrapDataKeys(trx, ctx),
    );
    const left = await withTenantTransaction(input.db, ctx, (trx) =>
      input.credentials.countDataKeys(trx, ctx),
    );
    totals.stale += left.stale;
    totals.newer += left.newer;
  }
  return totals;
}
