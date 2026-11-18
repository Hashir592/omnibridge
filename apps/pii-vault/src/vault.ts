import {
  DataKey,
  generateDataKey,
  generateIndexKey,
  IndexKey,
  unwrapDataKey,
  unwrapIndexKey,
  type Keyring,
} from '@omnibridge/crypto';
import type { Pool, PoolClient } from '@omnibridge/pii-db';
import {
  PURPOSE_KINDS,
  type EbayUserMatchRequest,
  type EbayUserMatchResponse,
  type ExpiryRequest,
  type IngestRequest,
  type MaskResponse,
  type MatchResponse,
  type ReadFullResponse,
  type RecordKind,
  type ReadPurpose,
  type SearchResponse,
} from '@omnibridge/vault-client/schemas';
import { indexValues, maskFields, normaliseBuyer, queryValues } from './normalise.ts';

/** The caller a service token stands for (invariant 8). */
export type Caller = 'web' | 'worker' | 'deletion';

/** Who reads, for the access log (DP-7): the service, and the signed-in user when there is one. */
export interface Actor {
  caller: Caller;
  userId?: string | undefined;
}

/** A pii_ref that is not in this workspace, as far as the caller can tell (404). */
export class NotFound extends Error {}

/** The purpose does not cover this kind of record (DP-7): 403, and nothing is read or logged. */
export class PurposeRefused extends Error {}

/** delete_after outside now minus 1 day to now plus 90 days (ADR-065): 400. */
export class BadExpiry extends Error {}

/** Ingest for a workspace that was closed (ADR-065): 409, and no new keys. */
export class WorkspaceClosed extends Error {}

interface Keys {
  data: DataKey;
  index: IndexKey;
}

/** One transaction: keys it read or made are cached only once it commits. */
interface Tx {
  readonly c: PoolClient;
  keys?: Keys;
  /** True when this transaction stored the workspace's first keys. */
  created?: boolean;
}

/** A read of a canary record (SEC-12): IDs only, for M05's alerts. */
export interface CanaryEvent {
  workspaceId: string;
  piiRef: string;
  caller: Caller;
  capability: 'read_full' | 'mask';
}

/**
 * The canary's synthetic fields: obviously fake, and on the reserved `.invalid` domain, so they
 * can never be a real person. No blind index is written for them.
 */
const canaryFields = (workspaceId: string) => ({
  name: 'Canary Record',
  email: `canary.${workspaceId.slice(0, 8)}@canary.invalid`,
  postcode: 'ZZ99 9ZZ',
});

/**
 * The advisory lock key that orders ingest against workspace closure (ADR-065): a stable 64-bit
 * number from the workspace id. Shared by ingest, exclusive in closure's last batch.
 */
export function workspaceLock(workspaceId: string): string {
  return BigInt.asIntN(64, BigInt(`0x${workspaceId.replaceAll('-', '').slice(0, 16)}`)).toString();
}

const KEY_VERSION = 1;
/** PRD 7.3: PII of an order never dispatched goes at most 90 days after it arrived. */
export const HARD_LIMIT_MS = 90 * 24 * 60 * 60 * 1000;
/** ADR-065: an expiry may lie at most a day in the past (a late caller), never further. */
export const EXPIRY_PAST_MS = 24 * 60 * 60 * 1000;
/** Search answers at most this many matches; `truncated` says when there were more. */
const SEARCH_LIMIT = 5000;
const FIELD_TABLE = 'record_fields';

/**
 * The PII store (T-0402). Every statement runs in a short transaction with app.workspace_id set,
 * so row-level security keeps each workspace's records apart (invariant 1 on db-pii). Values are
 * encrypted per field with the workspace's data key; nothing here ever logs or returns a value
 * except read-full, and every read-full, search and match writes an access-log row without one.
 */
export class Vault {
  readonly #pool: Pool;
  readonly #keyring: Keyring;
  readonly #now: () => Date;
  /** Unwrapped keys per workspace, cached only after the transaction that read them commits. */
  readonly #keys = new Map<string, Keys>();

  readonly #onCanary: (event: CanaryEvent) => void;

  constructor(options: {
    pool: Pool;
    keyring: Keyring;
    now?: () => Date;
    /** Called after a canary read is recorded (SEC-12); the app logs it at warn. */
    onCanary?: (event: CanaryEvent) => void;
  }) {
    this.#pool = options.pool;
    this.#keyring = options.keyring;
    this.#now = options.now ?? (() => new Date());
    this.#onCanary = options.onCanary ?? (() => undefined);
  }

  /** A closed workspace's keys are deleted with it; the cached copies go too. */
  forgetKeys(workspaceId: string): void {
    this.#keys.delete(workspaceId);
  }

  async ingest(req: IngestRequest): Promise<{ pii_ref: string }> {
    this.#checkExpiry(req.delete_after);
    const index = indexValues(req.fields);
    return this.#tx(req.workspace_id, async (c, tx) => {
      // ADR-065 (F-M04h-04): a closed workspace takes no new PII and gets no new keys. The shared
      // lock orders this ingest against closure's last batch (which takes it exclusively), so a
      // record is either seen and deleted by closure, or refused here once the marker exists.
      await c.query('SELECT pg_advisory_xact_lock_shared($1::bigint)', [
        workspaceLock(req.workspace_id),
      ]);
      const closed = await c.query(
        'SELECT 1 FROM vault.closed_workspaces WHERE workspace_id = $1',
        [req.workspace_id],
      );
      if ((closed.rowCount ?? 0) > 0) throw new WorkspaceClosed();
      // Keys are made here and only here, never by a read (F-M04h-04).
      const keys = await this.#loadKeys(tx, req.workspace_id, true);
      if (keys === undefined) throw new Error('keys were not created');
      if (tx.created === true) await this.#insertCanary(c, req.workspace_id, keys);
      // pii_ref defaults to uuidv7() (PostgreSQL 18): time-ordered, so the key index stays compact.
      const inserted = await c.query<{ pii_ref: string }>(
        `INSERT INTO vault.records (workspace_id, kind, channel_account_id, subject_type,
                                    subject_id, data_key_version, delete_after, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING pii_ref`,
        [
          req.workspace_id,
          req.kind,
          req.channel_account_id ?? null,
          req.subject_type,
          req.subject_id,
          keys.data.version,
          // A backstop until the caller sets the real expiry at dispatch or delivery (DEL-1).
          req.delete_after ?? new Date(this.#now().getTime() + HARD_LIMIT_MS),
          this.#now(),
        ],
      );
      const piiRef = inserted.rows[0]?.pii_ref ?? '';
      const aad = (field: string) => ({
        workspaceId: req.workspace_id,
        table: FIELD_TABLE,
        column: field,
        rowId: piiRef,
      });
      for (const [field, value] of Object.entries(req.fields)) {
        await c.query(
          `INSERT INTO vault.record_fields (workspace_id, pii_ref, field, ciphertext) VALUES ($1, $2, $3, $4)`,
          [req.workspace_id, piiRef, field, keys.data.encrypt(value, aad(field))],
        );
      }
      for (const [field, value] of Object.entries(index)) {
        await c.query(
          `INSERT INTO vault.blind_index (workspace_id, pii_ref, field, mac, key_version) VALUES ($1, $2, $3, $4, $5)`,
          [req.workspace_id, piiRef, field, keys.index.mac(field, value), keys.index.version],
        );
      }
      return { pii_ref: piiRef };
    });
  }

  /** DEL-1: the caller sets delete_after once dispatch or delivery is known. */
  async setExpiry(req: ExpiryRequest): Promise<{ updated: number }> {
    this.#checkExpiry(req.delete_after);
    return this.#tx(req.workspace_id, async (c) => {
      const res = await c.query(
        `UPDATE vault.records SET delete_after = $3 WHERE workspace_id = $1 AND pii_ref = ANY($2::uuid[])`,
        [req.workspace_id, req.pii_refs, req.delete_after],
      );
      return { updated: res.rowCount ?? 0 };
    });
  }

  async readFull(
    workspaceId: string,
    piiRef: string,
    purpose: ReadPurpose,
    actor: Actor,
  ): Promise<ReadFullResponse> {
    return this.#tx(workspaceId, async (c, tx) => {
      const record = await this.#record(c, workspaceId, piiRef);
      if (!PURPOSE_KINDS[purpose].includes(record.kind)) throw new PurposeRefused();
      const keys = await this.#loadKeys(tx, workspaceId, false);
      if (keys === undefined) throw new NotFound();
      const fields = await this.#decryptFields(c, keys.data, workspaceId, piiRef);
      await this.#log(c, workspaceId, actor, 'read_full', purpose, piiRef, 1);
      if (record.canary) await this.#canary(c, workspaceId, [piiRef], actor, 'read_full');
      return {
        pii_ref: piiRef,
        kind: record.kind,
        subject_type: record.subject_type,
        subject_id: record.subject_id,
        fields,
      };
    });
  }

  /** ORD-5: masked strings, computed now and never stored. Unknown refs are left out. */
  async mask(workspaceId: string, piiRefs: readonly string[], actor: Actor): Promise<MaskResponse> {
    return this.#tx(workspaceId, async (c, tx) => {
      const keys = await this.#loadKeys(tx, workspaceId, false);
      if (keys === undefined) return { records: [] };
      const res = await c.query<{ pii_ref: string; field: string; ciphertext: Buffer }>(
        `SELECT pii_ref, field, ciphertext FROM vault.record_fields
          WHERE workspace_id = $1 AND pii_ref = ANY($2::uuid[]) ORDER BY pii_ref, field`,
        [workspaceId, piiRefs],
      );
      const byRef = new Map<string, Record<string, string>>();
      for (const row of res.rows) {
        const fields = byRef.get(row.pii_ref) ?? {};
        fields[row.field] = keys.data
          .decrypt(row.ciphertext, {
            workspaceId,
            table: FIELD_TABLE,
            column: row.field,
            rowId: row.pii_ref,
          })
          .toString('utf8');
        byRef.set(row.pii_ref, fields);
      }
      const records: MaskResponse['records'] = [...byRef].map(([piiRef, fields]) => ({
        pii_ref: piiRef,
        fields: maskFields(fields),
      }));
      const canaries = await c.query<{ pii_ref: string }>(
        `SELECT pii_ref FROM vault.records
          WHERE workspace_id = $1 AND pii_ref = ANY($2::uuid[]) AND canary`,
        [workspaceId, piiRefs],
      );
      if (canaries.rows.length > 0) {
        await this.#canary(
          c,
          workspaceId,
          canaries.rows.map((r) => r.pii_ref),
          actor,
          'mask',
        );
      }
      return { records };
    });
  }

  /** Blind-index search: every identifier given must match (AND). Logged with the count only. */
  async search(
    workspaceId: string,
    query: Parameters<typeof queryValues>[0],
    purpose: string,
    actor: Actor,
  ): Promise<SearchResponse> {
    const values = queryValues(query);
    return this.#tx(workspaceId, async (c, tx) => {
      const entries = Object.entries(values);
      let matches: SearchResponse['matches'] = [];
      let truncated = false;
      const keys = entries.length > 0 ? await this.#loadKeys(tx, workspaceId, false) : undefined;
      // A workspace with no keys holds no records: answer empty and write nothing (F-M04h-04).
      if (entries.length > 0 && keys === undefined) return { matches, truncated };
      if (keys !== undefined) {
        const fields = entries.map(([f]) => f);
        const macs = entries.map(([f, v]) => keys.index.mac(f, v));
        // Driven by the blind-index lookup (workspace, field, mac), never a scan of the records.
        const res = await c.query<SearchResponse['matches'][number]>(
          `SELECT r.pii_ref, r.kind, r.subject_type, r.subject_id, r.channel_account_id
             FROM (SELECT b.pii_ref
                     FROM vault.blind_index b
                     JOIN unnest($2::text[], $3::bytea[]) AS q(field, mac)
                       ON b.field = q.field AND b.mac = q.mac
                    WHERE b.workspace_id = $1
                    GROUP BY b.pii_ref
                   HAVING count(*) = $4) hit
             JOIN vault.records r ON r.workspace_id = $1 AND r.pii_ref = hit.pii_ref
            ORDER BY r.pii_ref
            LIMIT $5`,
          [workspaceId, fields, macs, entries.length, SEARCH_LIMIT + 1],
        );
        truncated = res.rows.length > SEARCH_LIMIT;
        matches = res.rows.slice(0, SEARCH_LIMIT);
      }
      await this.#log(c, workspaceId, actor, 'search', purpose, null, matches.length);
      return { matches, truncated };
    });
  }

  /**
   * ORD-9, ADR-055: the subject IDs of other records with the same buyer and delivery address on
   * the same channel account. Never a value, never another channel account's record.
   */
  async match(workspaceId: string, piiRef: string, actor: Actor): Promise<MatchResponse> {
    return this.#tx(workspaceId, async (c) => {
      await this.#record(c, workspaceId, piiRef);
      const res = await c.query<{ subject_id: string }>(
        `SELECT DISTINCT o.subject_id
           FROM vault.records r
           JOIN vault.blind_index rb ON rb.workspace_id = r.workspace_id AND rb.pii_ref = r.pii_ref
                                    AND rb.field = 'match'
           JOIN vault.blind_index ob ON ob.workspace_id = r.workspace_id AND ob.field = 'match'
                                    AND ob.mac = rb.mac AND ob.pii_ref <> r.pii_ref
           JOIN vault.records o ON o.workspace_id = ob.workspace_id AND o.pii_ref = ob.pii_ref
          WHERE r.workspace_id = $1 AND r.pii_ref = $2
            AND o.kind = r.kind AND o.subject_type = r.subject_type
            AND o.channel_account_id IS NOT DISTINCT FROM r.channel_account_id
            AND r.channel_account_id IS NOT NULL
          ORDER BY o.subject_id`,
        [workspaceId, piiRef],
      );
      await this.#log(c, workspaceId, actor, 'match', 'same_buyer', piiRef, res.rowCount ?? 0);
      return { subject_ids: res.rows.map((r) => r.subject_id) };
    });
  }

  /**
   * AT-10 (FA-14): the records of one eBay user, by user ID or username on the `buyer` blind
   * index, in every workspace that holds PII. One short transaction per workspace; a workspace
   * with a hit gets an access-log row with the count, one without is not logged.
   */
  async ebayUserMatch(req: EbayUserMatchRequest, actor: Actor): Promise<EbayUserMatchResponse> {
    const values = [req.user_id, req.username]
      .filter((v): v is string => v !== undefined)
      .map(normaliseBuyer)
      .filter((v) => v !== '');
    const directory = await this.#pool.query<{ workspace_id: string }>(
      'SELECT workspace_id FROM vault.workspace_directory ORDER BY workspace_id',
    );
    const workspaces: EbayUserMatchResponse['workspaces'] = [];
    for (const { workspace_id: workspaceId } of directory.rows) {
      const matches = await this.#tx(workspaceId, async (c, tx) => {
        const keys = await this.#loadKeys(tx, workspaceId, false);
        if (keys === undefined || values.length === 0) return [];
        const res = await c.query<SearchResponse['matches'][number]>(
          `SELECT r.pii_ref, r.kind, r.subject_type, r.subject_id, r.channel_account_id
             FROM vault.records r
            WHERE r.workspace_id = $1 AND NOT r.canary
              AND r.pii_ref IN (SELECT b.pii_ref FROM vault.blind_index b
                                 WHERE b.workspace_id = $1 AND b.field = 'buyer'
                                   AND b.mac = ANY($2::bytea[]))
            ORDER BY r.pii_ref
            LIMIT $3`,
          [workspaceId, values.map((v) => keys.index.mac('buyer', v)), SEARCH_LIMIT],
        );
        if (res.rows.length > 0) {
          await this.#log(
            c,
            workspaceId,
            actor,
            'search',
            'ebay_account_deletion',
            null,
            res.rows.length,
          );
        }
        return res.rows;
      });
      if (matches.length > 0) workspaces.push({ workspace_id: workspaceId, matches });
    }
    return { workspaces };
  }

  /** SEC-12: the workspace's canary, made with its first keys. No blind index, never expires. */
  async #insertCanary(c: PoolClient, workspaceId: string, keys: Keys): Promise<void> {
    const inserted = await c.query<{ pii_ref: string }>(
      `INSERT INTO vault.records (workspace_id, kind, subject_type, subject_id, data_key_version,
                                  delete_after, created_at, canary)
       VALUES ($1, 'buyer_contact', 'order', 'canary', $2, 'infinity', $3, true)
       RETURNING pii_ref`,
      [workspaceId, keys.data.version, this.#now()],
    );
    const piiRef = inserted.rows[0]?.pii_ref ?? '';
    for (const [field, value] of Object.entries(canaryFields(workspaceId))) {
      await c.query(
        `INSERT INTO vault.record_fields (workspace_id, pii_ref, field, ciphertext) VALUES ($1, $2, $3, $4)`,
        [
          workspaceId,
          piiRef,
          field,
          keys.data.encrypt(value, {
            workspaceId,
            table: FIELD_TABLE,
            column: field,
            rowId: piiRef,
          }),
        ],
      );
    }
  }

  /** Records a canary read in db-pii and tells the app (SEC-12). IDs only. */
  async #canary(
    c: PoolClient,
    workspaceId: string,
    piiRefs: readonly string[],
    actor: Actor,
    capability: CanaryEvent['capability'],
  ): Promise<void> {
    for (const piiRef of piiRefs) {
      await c.query(
        `INSERT INTO vault.canary_events (workspace_id, pii_ref, at, caller, capability, actor_user_id)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [workspaceId, piiRef, this.#now(), actor.caller, capability, actor.userId ?? null],
      );
      this.#onCanary({ workspaceId, piiRef, caller: actor.caller, capability });
    }
  }

  async #record(
    c: PoolClient,
    workspaceId: string,
    piiRef: string,
  ): Promise<{ kind: RecordKind; subject_type: string; subject_id: string; canary: boolean }> {
    const res = await c.query<{
      kind: RecordKind;
      subject_type: string;
      subject_id: string;
      canary: boolean;
    }>(
      `SELECT kind, subject_type, subject_id, canary FROM vault.records
        WHERE workspace_id = $1 AND pii_ref = $2`,
      [workspaceId, piiRef],
    );
    const row = res.rows[0];
    if (row === undefined) throw new NotFound();
    return row;
  }

  async #decryptFields(
    c: PoolClient,
    dataKey: DataKey,
    workspaceId: string,
    piiRef: string,
  ): Promise<Record<string, string>> {
    const res = await c.query<{ field: string; ciphertext: Buffer }>(
      `SELECT field, ciphertext FROM vault.record_fields WHERE workspace_id = $1 AND pii_ref = $2 ORDER BY field`,
      [workspaceId, piiRef],
    );
    const out: Record<string, string> = {};
    for (const row of res.rows) {
      out[row.field] = dataKey
        .decrypt(row.ciphertext, {
          workspaceId,
          table: FIELD_TABLE,
          column: row.field,
          rowId: piiRef,
        })
        .toString('utf8');
    }
    return out;
  }

  async #log(
    c: PoolClient,
    workspaceId: string,
    actor: Actor,
    capability: string,
    purpose: string,
    piiRef: string | null,
    count: number,
  ): Promise<void> {
    await c.query(
      `INSERT INTO vault.access_log (workspace_id, at, caller, capability, purpose, actor_user_id, pii_ref, result_count)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        workspaceId,
        this.#now(),
        actor.caller,
        capability,
        purpose,
        actor.userId ?? null,
        piiRef,
        count,
      ],
    );
  }

  /** ADR-065 (F-M04h-02): from now minus 1 day to now plus the 90-day hard limit; else 400. */
  #checkExpiry(deleteAfter: string | undefined): void {
    if (deleteAfter === undefined) return;
    const at = Date.parse(deleteAfter);
    const now = this.#now().getTime();
    if (!(at >= now - EXPIRY_PAST_MS && at <= now + HARD_LIMIT_MS)) throw new BadExpiry();
  }

  /**
   * The workspace's keys, in the caller's transaction. `create` (ingest only) stores a pair when
   * there is none; concurrent first ingests agree on one stored pair. Without `create`, a
   * workspace with no keys gives undefined and nothing is written (F-M04h-04).
   */
  async #loadKeys(tx: Tx, workspaceId: string, create: boolean): Promise<Keys | undefined> {
    const cached = this.#keys.get(workspaceId);
    if (cached !== undefined) return cached;
    if (create) {
      const data = generateDataKey(this.#keyring, workspaceId, KEY_VERSION).wrapped;
      const index = generateIndexKey(this.#keyring, workspaceId, KEY_VERSION).wrapped;
      for (const [kind, w] of [
        ['data', data],
        ['index', index],
      ] as const) {
        const made = await tx.c.query(
          `INSERT INTO vault.workspace_keys (workspace_id, kind, version, kek_version, wrapped, created_at)
           VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING`,
          [workspaceId, kind, w.version, w.kekVersion, w.wrapped, this.#now()],
        );
        if (kind === 'data' && (made.rowCount ?? 0) > 0) tx.created = true;
      }
      // AT-10: the workspace holds PII from now on, so an eBay notice must look in it.
      await tx.c.query(
        `INSERT INTO vault.workspace_directory (workspace_id, added_at) VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [workspaceId, this.#now()],
      );
    }
    const res = await tx.c.query<{
      kind: 'data' | 'index';
      /** bigint columns: read as strings. */
      version: string;
      kek_version: string;
      wrapped: Buffer;
    }>(
      `SELECT kind, version, kek_version, wrapped FROM vault.workspace_keys
        WHERE workspace_id = $1 AND version = $2`,
      [workspaceId, KEY_VERSION],
    );
    const stored = (kind: 'data' | 'index') => {
      const row = res.rows.find((r) => r.kind === kind);
      return row === undefined
        ? undefined
        : {
            workspaceId,
            version: Number(row.version),
            kekVersion: Number(row.kek_version),
            wrapped: row.wrapped,
          };
    };
    const data = stored('data');
    const index = stored('index');
    if (data === undefined || index === undefined) return undefined;
    tx.keys = {
      data: unwrapDataKey(this.#keyring, data),
      index: unwrapIndexKey(this.#keyring, index),
    };
    return tx.keys;
  }

  async #tx<T>(workspaceId: string, fn: (c: PoolClient, tx: Tx) => Promise<T>): Promise<T> {
    const c = await this.#pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.workspace_id', $1, true)`, [workspaceId]);
      const tx: Tx = { c };
      const out = await fn(c, tx);
      await c.query('COMMIT');
      // Keys this transaction read or made are committed now, so they may be cached.
      if (tx.keys !== undefined) this.#keys.set(workspaceId, tx.keys);
      return out;
    } catch (err) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      c.release();
    }
  }
}
