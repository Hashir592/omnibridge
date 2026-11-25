import { open, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Pool, PoolClient } from '@omnibridge/pii-db';
import type { DeleteRequest, DeleteResponse } from '@omnibridge/vault-client/schemas';
import { workspaceLock } from './vault.ts';

/** At most this many records per call; the response says `more` and the caller calls again. */
export const DELETE_BATCH = 5000;

/** One deleted record, IDs only. */
interface Target {
  pii_ref: string;
  channel_account_id: string | null;
}

/**
 * Label files are PII and live in the vault's volume (invariant 11). They arrive in M12; until
 * then this hook is called with every deleted ref and deletes nothing.
 */
export interface LabelFiles {
  deleteFor(workspaceId: string, piiRefs: readonly string[]): Promise<number>;
}
export const NO_LABEL_FILES: LabelFiles = { deleteFor: () => Promise.resolve(0) };

/**
 * The off-site tombstone journal (invariant 10): one JSON line per deleted ref, IDs only, appended
 * and fsynced before the delete commits, so a restore can always re-apply it. In dev and CI the
 * directory is a local volume standing in for the B2 bucket (T-0405 ships it off-site).
 */
export class DeletionJournal {
  readonly #dir: string;

  constructor(dir: string) {
    this.#dir = dir;
  }

  async append(lines: readonly Record<string, string | null>[]): Promise<void> {
    if (lines.length === 0) return;
    await mkdir(this.#dir, { recursive: true });
    const day = (lines[0]?.at ?? new Date().toISOString()).slice(0, 10);
    const file = await open(join(this.#dir, `tombstones-${day}.jsonl`), 'a', 0o600);
    try {
      await file.write(lines.map((l) => `${JSON.stringify(l)}\n`).join(''));
      await file.sync();
    } finally {
      await file.close();
    }
  }
}

/**
 * The one deletion service (DEL-1, DEL-2, invariant 10). Every trigger comes here with a scope of
 * IDs. A run: picks the records, journals their refs off-site, then in one transaction hard-deletes
 * fields, blind indexes and records and writes the db-pii tombstones and the run log; after the
 * commit it VACUUMs the tables, so no deleted value stays in a dead tuple. Idempotent: a repeat
 * finds nothing left, deletes nothing and logs zero, still reports what its run id deleted, and
 * VACUUMs again (in case the first VACUUM failed).
 */
export class DeletionService {
  readonly #pool: Pool;
  readonly #journal: DeletionJournal;
  readonly #labels: LabelFiles;
  readonly #now: () => Date;
  readonly #onWorkspaceClosed: (workspaceId: string) => void;

  constructor(options: {
    pool: Pool;
    journal: DeletionJournal;
    labels?: LabelFiles;
    now?: () => Date;
    /** Drops cached keys of a closed workspace (its stored keys are deleted with it). */
    onWorkspaceClosed?: (workspaceId: string) => void;
  }) {
    this.#pool = options.pool;
    this.#journal = options.journal;
    this.#labels = options.labels ?? NO_LABEL_FILES;
    this.#now = options.now ?? (() => new Date());
    this.#onWorkspaceClosed = options.onWorkspaceClosed ?? (() => undefined);
  }

  async delete(req: DeleteRequest): Promise<DeleteResponse> {
    const ws = req.workspace_id;
    const at = this.#now();
    const targets = await this.#tx(ws, (c) => this.#targets(c, req, at));
    // Journal first: if the delete then fails, re-applying these tombstones is harmless.
    await this.#journal.append(
      targets.map((t) => ({
        at: at.toISOString(),
        workspace_id: ws,
        run_id: req.run_id,
        trigger: req.trigger,
        pii_ref: t.pii_ref,
        channel_account_id: t.channel_account_id,
      })),
    );
    if (req.scope.type === 'workspace' && targets.length < DELETE_BATCH) {
      // The closure itself is journalled too, so a restore closes the workspace again (T-0405).
      await this.#journal.append([
        {
          at: at.toISOString(),
          workspace_id: ws,
          run_id: req.run_id,
          trigger: req.trigger,
          type: 'workspace_closed',
        },
      ]);
    }
    const refs = targets.map((t) => t.pii_ref);
    const result = await this.#tx(ws, async (c) => {
      // Closure's last batch: hold off any ingest for this workspace until it commits (ADR-065).
      if (req.scope.type === 'workspace' && targets.length < DELETE_BATCH) {
        await c.query('SELECT pg_advisory_xact_lock($1::bigint)', [workspaceLock(ws)]);
      }
      // Records before their fields, as an ingest or a correction takes them (no deadlock).
      await c.query(
        `SELECT 1 FROM vault.records WHERE workspace_id = $1 AND pii_ref = ANY($2::uuid[])
          ORDER BY pii_ref FOR UPDATE`,
        [ws, refs],
      );
      const fields = await c.query(
        'DELETE FROM vault.record_fields WHERE workspace_id = $1 AND pii_ref = ANY($2::uuid[])',
        [ws, refs],
      );
      const index = await c.query(
        'DELETE FROM vault.blind_index WHERE workspace_id = $1 AND pii_ref = ANY($2::uuid[])',
        [ws, refs],
      );
      const records = await c.query<Target>(
        `DELETE FROM vault.records WHERE workspace_id = $1 AND pii_ref = ANY($2::uuid[])
         RETURNING pii_ref, channel_account_id`,
        [ws, refs],
      );
      if (records.rows.length > 0) {
        await c.query(
          `INSERT INTO vault.tombstones (workspace_id, pii_ref, run_id, deleted_at, channel_account_id)
           SELECT $1, t.pii_ref, $2, $3, t.channel_account_id
             FROM unnest($4::uuid[], $5::uuid[]) AS t(pii_ref, channel_account_id)
           ON CONFLICT DO NOTHING`,
          [
            ws,
            req.run_id,
            at,
            records.rows.map((r) => r.pii_ref),
            records.rows.map((r) => r.channel_account_id),
          ],
        );
      }
      let more = targets.length === DELETE_BATCH;
      if (req.scope.type === 'workspace' && !more) {
        // An ingest that committed after the targets were read: not done yet, call again.
        const left = await c.query('SELECT 1 FROM vault.records WHERE workspace_id = $1 LIMIT 1', [
          ws,
        ]);
        more = (left.rowCount ?? 0) > 0;
      }
      if (req.scope.type === 'workspace' && !more) {
        // Closure: the keys go last, once no record is left that they could open. The marker
        // makes the vault refuse any later ingest for this workspace (ADR-065, F-M04h-04).
        await c.query('DELETE FROM vault.workspace_keys WHERE workspace_id = $1', [ws]);
        await c.query('DELETE FROM vault.workspace_directory WHERE workspace_id = $1', [ws]);
        await c.query(
          `INSERT INTO vault.closed_workspaces (workspace_id, closed_at) VALUES ($1, $2)
           ON CONFLICT DO NOTHING`,
          [ws, at],
        );
      }
      const counts = {
        records: records.rowCount ?? 0,
        fields: fields.rowCount ?? 0,
        index: index.rowCount ?? 0,
      };
      await c.query(
        `INSERT INTO vault.deletion_runs (workspace_id, run_id, at, trigger, scope_type, records, fields, index_entries)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          ws,
          req.run_id,
          at,
          req.trigger,
          req.scope.type,
          counts.records,
          counts.fields,
          counts.index,
        ],
      );
      const deleted = await c.query<Target>(
        `SELECT pii_ref, channel_account_id FROM vault.tombstones
          WHERE workspace_id = $1 AND run_id = $2 ORDER BY pii_ref`,
        [ws, req.run_id],
      );
      return { counts, deleted: deleted.rows, more, removed: records.rows.map((r) => r.pii_ref) };
    });
    const { removed, ...answer } = result;
    if (removed.length > 0) await this.#labels.deleteFor(ws, removed);
    // Invariant 10: VACUUM cannot run in a transaction; it clears the dead tuples just made. It
    // runs whenever the run has tombstones, so a retry after a failed VACUUM runs it again even
    // though it finds nothing left to delete (ADR-065, F-M04h-03).
    if (removed.length > 0 || answer.deleted.length > 0) {
      await this.#pool.query('VACUUM vault.record_fields, vault.blind_index, vault.records');
    }
    if (req.scope.type === 'workspace' && !result.more) this.#onWorkspaceClosed(ws);
    return { run_id: req.run_id, ...answer };
  }

  /** The records this scope covers that still exist, at most one batch. */
  async #targets(c: PoolClient, req: DeleteRequest, at: Date): Promise<Target[]> {
    const ws = req.workspace_id;
    const scope = req.scope;
    const base = 'SELECT pii_ref, channel_account_id FROM vault.records WHERE workspace_id = $1';
    const limit = `ORDER BY pii_ref LIMIT ${String(DELETE_BATCH)}`;
    switch (scope.type) {
      case 'expiry':
        return (await c.query<Target>(`${base} AND delete_after <= $2 ${limit}`, [ws, at])).rows;
      case 'subjects':
        return (
          await c.query<Target>(
            `${base} AND subject_type = $2 AND subject_id = ANY($3::text[]) ${limit}`,
            [ws, scope.subject_type, scope.subject_ids],
          )
        ).rows;
      case 'refs':
        return (
          await c.query<Target>(`${base} AND pii_ref = ANY($2::uuid[]) ${limit}`, [
            ws,
            scope.pii_refs,
          ])
        ).rows;
      case 'channel_account':
        return (
          await c.query<Target>(`${base} AND channel_account_id = $2 ${limit}`, [
            ws,
            scope.channel_account_id,
          ])
        ).rows;
      case 'workspace':
        return (await c.query<Target>(`${base} ${limit}`, [ws])).rows;
    }
  }

  async #tx<T>(workspaceId: string, fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const c = await this.#pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.workspace_id', $1, true)`, [workspaceId]);
      const out = await fn(c);
      await c.query('COMMIT');
      return out;
    } catch (err) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      c.release();
    }
  }
}
