import { sql, type Kysely } from 'kysely';
import type { MainDb } from './schema.ts';

/**
 * The workspace id list, read as ob_platform (invariant 2): the fan-out of all-workspace jobs
 * such as the KEK re-wrap. It reads ids only; each workspace's own work then runs as ob_app in
 * that workspace's tenant transaction.
 */
export class WorkspaceDirectory {
  readonly #db: Kysely<MainDb>;

  constructor(db: Kysely<MainDb>) {
    this.#db = db;
  }

  async listIds(): Promise<string[]> {
    // Any other role sees no workspace through RLS, so an all-workspace job would silently do
    // nothing and report success. Refuse instead.
    const { rows } = await sql<{ role: string }>`SELECT current_user AS role`.execute(this.#db);
    const role = rows[0]?.role;
    if (role !== 'ob_platform') {
      throw new Error(`The workspace list is read as ob_platform only, not as ${String(role)}`);
    }
    const ids = await this.#db.selectFrom('app.workspaces').select('id').orderBy('id').execute();
    return ids.map((row) => row.id);
  }
}
