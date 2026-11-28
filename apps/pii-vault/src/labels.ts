import { mkdir, open, readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { DataKey } from '@omnibridge/crypto';
import type { Pool, PoolClient } from '@omnibridge/pii-db';
import type { LabelFiles } from './deletion.ts';
import { mergeLabelPdfs } from './label-merge.ts';
import { NotFound, type Actor } from './vault.ts';

/** A label file is at most this big (a thermal label is tens of kilobytes). */
export const LABEL_MAX_BYTES = 2 * 1024 * 1024;
/** SHP-2: at most this many labels in one print file. */
export const MERGE_MAX = 200;
/** Invariant 11: a label goes 30 days after it was stored at the latest. */
export const LABEL_DAYS = 30;
const DAY_MS = 86_400_000;
/** A file with no row is left this long, so a store still writing is never swept. */
const ORPHAN_GRACE_MS = 3_600_000;
const AAD_TABLE = 'label_files';

export class NotPdf extends Error {}

/** The vault's transaction with a workspace's data key (Vault.withDataKey). */
export interface DataKeyRunner {
  withDataKey<T>(workspaceId: string, fn: (key: DataKey, c: PoolClient) => Promise<T>): Promise<T>;
}

const isUuid = (s: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(s);

/**
 * Label files (invariant 11, FA-15, T-1201). The worker stores the carrier's PDF here; nothing else
 * ever holds it. Each file is encrypted with AES-256-GCM under the workspace's data key and kept
 * in the vault's own volume, which no backup reads. db-pii keeps IDs, a size and a date.
 *
 * - `merge` decrypts the labels asked for and returns one PDF, built in memory and never written
 *   (SHP-2); each label read is logged as a full read for printing (DP-7).
 * - A file goes at the earlier of 30 days or its buyer record's expiry: `deleteFor` runs when the
 *   records are deleted (any trigger, DEL-1), `expire` in each hourly expiry run.
 */
export class LabelStore implements LabelFiles {
  readonly #pool: Pool;
  readonly #dir: string;
  readonly #vault: DataKeyRunner;
  readonly #now: () => Date;

  constructor(options: { pool: Pool; dir: string; vault: DataKeyRunner; now?: () => Date }) {
    this.#pool = options.pool;
    this.#dir = options.dir;
    this.#vault = options.vault;
    this.#now = options.now ?? (() => new Date());
  }

  #path(workspaceId: string, labelId: string): string {
    if (!isUuid(workspaceId) || !isUuid(labelId)) throw new NotFound();
    return join(this.#dir, workspaceId, `${labelId}.bin`);
  }

  /**
   * Stores a label for buyer records that exist. Stored once: a repeat (a reprint that fetched the
   * label again) keeps the first. Its date is the earlier of 30 days or the records' expiry.
   */
  async store(req: {
    workspaceId: string;
    labelId: string;
    piiRefs: readonly string[];
    pdf: Buffer;
  }): Promise<{ stored: boolean }> {
    if (req.pdf.length === 0 || req.pdf.length > LABEL_MAX_BYTES) throw new NotPdf();
    if (req.pdf.subarray(0, 5).toString('latin1') !== '%PDF-') throw new NotPdf();
    const path = this.#path(req.workspaceId, req.labelId);
    return this.#vault.withDataKey(req.workspaceId, async (key, c) => {
      const { rows } = await c.query<{ n: string; first: Date | null }>(
        `SELECT count(*)::text AS n, min(delete_after) AS first FROM vault.records
          WHERE workspace_id = $1 AND pii_ref = ANY($2::uuid[]) AND kind = 'buyer_contact'`,
        [req.workspaceId, req.piiRefs],
      );
      if (Number(rows[0]?.n ?? 0) !== new Set(req.piiRefs).size) throw new NotFound();
      const now = this.#now();
      const cap = new Date(now.getTime() + LABEL_DAYS * DAY_MS);
      const first = rows[0]?.first ?? null;
      const deleteAfter = first !== null && first < cap ? first : cap;
      const inserted = await c.query(
        `INSERT INTO vault.label_files (workspace_id, label_id, pii_refs, bytes, delete_after, created_at)
         VALUES ($1, $2, $3::uuid[], $4, $5, $6) ON CONFLICT DO NOTHING`,
        [req.workspaceId, req.labelId, req.piiRefs, req.pdf.length, deleteAfter, now],
      );
      if ((inserted.rowCount ?? 0) === 0) return { stored: false };
      const sealed = key.encrypt(req.pdf, {
        workspaceId: req.workspaceId,
        table: AAD_TABLE,
        column: 'file',
        rowId: req.labelId,
      });
      // Written beside its final name and renamed, so a reader never meets half a file; the row
      // commits after the file is on disk.
      await mkdir(join(this.#dir, req.workspaceId), { recursive: true, mode: 0o700 });
      const tmp = `${path}.tmp`;
      const file = await open(tmp, 'w', 0o600);
      try {
        await file.write(sealed);
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(tmp, path);
      return { stored: true };
    });
  }

  /**
   * SHP-2, FA-15: one PDF of the labels, in the order asked for, built in memory and never
   * written. NotFound when any label is not stored. Each label is logged as a full read, in a
   * short transaction before the merge; the merge itself holds no db-pii connection, so prints
   * never starve the vault's pool.
   */
  async merge(workspaceId: string, labelIds: readonly string[], actor: Actor): Promise<Uint8Array> {
    if (labelIds.length === 0 || labelIds.length > MERGE_MAX) throw new NotFound();
    const paths = labelIds.map((id) => this.#path(workspaceId, id));
    const key = await this.#vault.withDataKey(workspaceId, async (dataKey, c) => {
      const { rows } = await c.query<{ label_id: string; pii_refs: string[] }>(
        `SELECT label_id, pii_refs FROM vault.label_files
          WHERE workspace_id = $1 AND label_id = ANY($2::uuid[])`,
        [workspaceId, labelIds],
      );
      const byId = new Map(rows.map((r) => [r.label_id, r.pii_refs]));
      if (labelIds.some((id) => !byId.has(id))) throw new NotFound();
      const at = this.#now();
      for (const id of labelIds) {
        for (const ref of byId.get(id) ?? []) {
          await c.query(
            `INSERT INTO vault.access_log (workspace_id, at, caller, capability, purpose, actor_user_id, pii_ref, result_count)
             VALUES ($1, $2, $3, 'read_full', 'label', $4, $5, 1)`,
            [workspaceId, at, actor.caller, actor.userId ?? null, ref],
          );
        }
      }
      return dataKey;
    });
    return mergeLabelPdfs(labelIds.length, async (i) => {
      const id = labelIds[i] ?? '';
      const sealed = await readFile(paths[i] ?? '').catch(() => {
        throw new NotFound();
      });
      return key.decrypt(sealed, { workspaceId, table: AAD_TABLE, column: 'file', rowId: id });
    });
  }

  /**
   * Invariant 11's safety net, at start and daily: a file nobody points at (a restore dropped its
   * row, or a write failed after the file landed) is deleted once it is an hour old, and every
   * file goes at 30 days whatever its row says. A file being written is never that old.
   */
  async sweepOrphans(): Promise<number> {
    const now = this.#now().getTime();
    let removed = 0;
    const workspaces = await readdir(this.#dir).catch(() => [] as string[]);
    for (const ws of workspaces) {
      if (!isUuid(ws)) continue;
      const names = await readdir(join(this.#dir, ws)).catch(() => [] as string[]);
      const ids = names
        .map((n) => /^([0-9a-f-]{36})\.bin$/.exec(n)?.[1])
        .filter((id): id is string => id !== undefined && isUuid(id));
      const known = new Set(ids.length === 0 ? [] : await this.stored(ws, ids));
      for (const name of names) {
        const file = join(this.#dir, ws, name);
        const age = now - (await stat(file).catch(() => ({ mtimeMs: now }))).mtimeMs;
        const id = /^([0-9a-f-]{36})\.bin$/.exec(name)?.[1];
        const orphan = id === undefined || !known.has(id);
        if (age >= LABEL_DAYS * DAY_MS || (orphan && age >= ORPHAN_GRACE_MS)) {
          await rm(file, { force: true });
          removed += 1;
        }
      }
    }
    return removed;
  }

  /** Whether each label is stored, for a reprint (IDs only). */
  async stored(workspaceId: string, labelIds: readonly string[]): Promise<string[]> {
    return this.#tx(workspaceId, async (c) => {
      const { rows } = await c.query<{ label_id: string }>(
        `SELECT label_id FROM vault.label_files WHERE workspace_id = $1 AND label_id = ANY($2::uuid[])`,
        [workspaceId, labelIds],
      );
      return rows.map((r) => r.label_id);
    });
  }

  /** DEL-1: the labels of deleted buyer records go with them (LabelFiles hook). */
  async deleteFor(workspaceId: string, piiRefs: readonly string[]): Promise<number> {
    return this.#remove(workspaceId, 'pii_refs && $2::uuid[]', [piiRefs]);
  }

  /** Invariant 11: labels whose own date has passed (30 days), in the hourly expiry run. */
  async expire(workspaceId: string, at: Date): Promise<number> {
    return this.#remove(workspaceId, 'delete_after <= $2', [at]);
  }

  /** SHP-5: a voided label is useless and still personal: it goes at once. */
  async discard(workspaceId: string, labelId: string): Promise<number> {
    return this.#remove(workspaceId, 'label_id = $2', [labelId]);
  }

  /**
   * The rows are deleted, then their files, then the transaction commits: a failed unlink rolls
   * the rows back (the next run tries again), so no file is ever left without its row.
   */
  async #remove(workspaceId: string, where: string, params: unknown[]): Promise<number> {
    const n = await this.#tx(workspaceId, async (c) => {
      const { rows } = await c.query<{ label_id: string }>(
        `DELETE FROM vault.label_files WHERE workspace_id = $1 AND ${where} RETURNING label_id`,
        [workspaceId, ...params],
      );
      for (const r of rows) await rm(this.#path(workspaceId, r.label_id), { force: true });
      return rows.length;
    });
    if (n > 0) await this.#pool.query('VACUUM vault.label_files');
    return n;
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
