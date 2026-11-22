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
  type SignalsRequest,
  type SignalsResponse,
  type SubjectsRequest,
  type SubjectsResponse,
} from '@omnibridge/vault-client/schemas';
import {
  BUYER_SOURCE_FIELDS,
  indexValues,
  maskFields,
  normaliseBuyerExact,
  queryValues,
} from './normalise.ts';

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

/**
 * Ingest of a buyer an eBay account-deletion notice removed (ADR-068 tombstone check): 409, and
 * nothing is stored. The caller keeps the order with no customer details.
 */
export class BuyerDeleted extends Error {}

/** The off-site journal (invariant 10, ADR-068): IDs and dates only, fsynced before commit. */
export interface Journal {
  append(lines: readonly Record<string, string | null>[]): Promise<void>;
}

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
  readonly #journal: Journal | undefined;

  constructor(options: {
    pool: Pool;
    keyring: Keyring;
    now?: () => Date;
    /** Called after a canary read is recorded (SEC-12); the app logs it at warn. */
    onCanary?: (event: CanaryEvent) => void;
    /** Expiry changes are journalled here (ADR-068): the deletion journal's directory. */
    journal?: Journal;
  }) {
    this.#pool = options.pool;
    this.#keyring = options.keyring;
    this.#now = options.now ?? (() => new Date());
    this.#onCanary = options.onCanary ?? (() => undefined);
    this.#journal = options.journal;
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
      if (req.kind === 'buyer_contact') await this.#refuseDeletedBuyer(c, req, keys);
      // pii_ref defaults to uuidv7() (PostgreSQL 18): time-ordered, so the key index stays compact.
      // ORD-4 (ADR-079 3): one buyer record per order. A retried or repeated ingest of the same
      // order finds the record already there and gets its ref back; nothing is added or changed.
      const inserted = await c.query<{ pii_ref: string }>(
        `INSERT INTO vault.records (workspace_id, kind, channel_account_id, subject_type,
                                    subject_id, data_key_version, delete_after, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (workspace_id, kind, subject_type, subject_id)
           WHERE subject_type = 'order' AND NOT canary DO NOTHING
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
      if (inserted.rows.length === 0) {
        const existing = await c.query<{ pii_ref: string }>(
          `SELECT pii_ref FROM vault.records
            WHERE workspace_id = $1 AND kind = $2 AND subject_type = $3 AND subject_id = $4
              AND NOT canary`,
          [req.workspace_id, req.kind, req.subject_type, req.subject_id],
        );
        const ref = existing.rows[0]?.pii_ref;
        if (ref === undefined) throw new Error('order record conflict without a record');
        return { pii_ref: ref };
      }
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

  /**
   * DEL-1: the caller sets delete_after once dispatch or delivery is known. The canary never
   * expires (S5-20261118 hardening 3): a caller holding its ref cannot move it.
   */
  async setExpiry(req: ExpiryRequest): Promise<{ updated: number }> {
    this.#checkExpiry(req.delete_after);
    return this.#tx(req.workspace_id, async (c) => {
      const res = await c.query<{ pii_ref: string }>(
        `UPDATE vault.records SET delete_after = $3
          WHERE workspace_id = $1 AND pii_ref = ANY($2::uuid[]) AND NOT canary
            AND delete_after IS DISTINCT FROM $3::timestamptz
          RETURNING pii_ref`,
        [req.workspace_id, req.pii_refs, req.delete_after],
      );
      // ADR-068: every change is journalled off-site before it commits, so a restore of an older
      // backup re-applies it and no copy outlives its date. IDs and the date only.
      const at = this.#now().toISOString();
      const deleteAfter = new Date(req.delete_after).toISOString();
      await this.#journal?.append(
        res.rows.map((r) => ({
          type: 'expiry',
          workspace_id: req.workspace_id,
          pii_ref: r.pii_ref,
          delete_after: deleteAfter,
          reason: req.reason,
          at,
        })),
      );
      return { updated: res.rowCount ?? 0 };
    });
  }

  /**
   * FA-10: the nightly orphan sweep's list. Order records created before a time, IDs only, in
   * pii_ref order; `next` is the last ref when the page is full.
   */
  async subjects(req: SubjectsRequest): Promise<SubjectsResponse> {
    const limit = req.limit ?? 1000;
    return this.#tx(req.workspace_id, async (c) => {
      const res = await c.query<{ pii_ref: string; subject_id: string }>(
        `SELECT pii_ref, subject_id FROM vault.records
          WHERE workspace_id = $1 AND subject_type = $2 AND NOT canary AND created_at < $3
            AND ($4::uuid IS NULL OR pii_ref > $4::uuid)
          ORDER BY pii_ref
          LIMIT $5`,
        [req.workspace_id, req.subject_type, req.created_before, req.after ?? null, limit],
      );
      return {
        records: res.rows,
        next: res.rows.length === limit ? (res.rows.at(-1)?.pii_ref ?? null) : null,
      };
    });
  }

  /**
   * ADR-068 tombstone check: a buyer whose eBay account was deleted is never stored again. The
   * user ID decides when the record has one; the username only when it has no ID (a username
   * can be reused by someone else, an ID cannot).
   */
  async #refuseDeletedBuyer(c: PoolClient, req: IngestRequest, keys: Keys): Promise<void> {
    const id = normaliseBuyerExact(req.fields.channel_buyer_id ?? '');
    const username = normaliseBuyerExact(req.fields.channel_username ?? '');
    let probe: [string, Buffer] | undefined;
    if (id !== '') probe = ['ebay_user_id', keys.index.mac('ebay_user_id', id)];
    else if (username !== '') probe = ['ebay_username', keys.index.mac('ebay_username', username)];
    if (probe === undefined) return;
    const hit = await c.query(
      'SELECT 1 FROM vault.deleted_buyers WHERE workspace_id = $1 AND field = $2 AND mac = $3',
      [req.workspace_id, probe[0], probe[1]],
    );
    if ((hit.rowCount ?? 0) > 0) throw new BuyerDeleted();
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
   * AT-10 (FA-14): the records of one eBay user, by user ID or username on the exact
   * `buyer_exact` blind index (ADR-066: trim only, never case-folded), in every workspace that
   * holds PII. One short transaction per workspace; a workspace
   * with a hit gets an access-log row with the count, one without is not logged.
   *
   * A-001 (ADR-069): paged, never cut short. One answer holds at most `pageSize` refs, in
   * (workspace, pii_ref) order from `cursor`; `next` is where the following page starts, or null
   * once every match has been returned.
   */
  async ebayUserMatch(
    req: EbayUserMatchRequest,
    actor: Actor,
    pageSize = SEARCH_LIMIT,
  ): Promise<EbayUserMatchResponse> {
    const values = [req.user_id, req.username]
      .filter((v): v is string => v !== undefined)
      .map(normaliseBuyerExact)
      .filter((v) => v !== '');
    const cursor = req.cursor;
    const directory = await this.#pool.query<{ workspace_id: string }>(
      `SELECT workspace_id FROM vault.workspace_directory
        WHERE $1::uuid IS NULL OR workspace_id >= $1::uuid
        ORDER BY workspace_id`,
      [cursor?.workspace_id ?? null],
    );
    const workspaces: EbayUserMatchResponse['workspaces'] = [];
    let remaining = pageSize;
    let last: EbayUserMatchResponse['next'] = null;
    let next: EbayUserMatchResponse['next'] = null;
    for (const { workspace_id: workspaceId } of directory.rows) {
      if (remaining === 0) {
        // The page is full and more workspaces are left: the next page starts after the last ref.
        next = last;
        break;
      }
      const after = cursor?.workspace_id === workspaceId ? cursor.pii_ref : null;
      const take = remaining;
      const page = await this.#tx(workspaceId, async (c, tx) => {
        const keys = await this.#loadKeys(tx, workspaceId, false);
        if (keys === undefined || values.length === 0) return { rows: [], more: false };
        // ADR-068: the buyer is never stored again in this workspace (the ingest check). The
        // user ID when the notice has one, else the username. Repeated pages add nothing.
        const userId = normaliseBuyerExact(req.user_id ?? '');
        const username = normaliseBuyerExact(req.username ?? '');
        const tomb: [string, string] | undefined =
          userId !== ''
            ? ['ebay_user_id', userId]
            : username !== ''
              ? ['ebay_username', username]
              : undefined;
        if (tomb !== undefined && after === null) {
          await c.query(
            `INSERT INTO vault.deleted_buyers (workspace_id, field, mac, key_version, created_at)
             VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
            [
              workspaceId,
              tomb[0],
              keys.index.mac(tomb[0], tomb[1]),
              keys.index.version,
              this.#now(),
            ],
          );
        }
        // One more than fits, so a full page knows whether this workspace has more.
        const res = await c.query<SearchResponse['matches'][number]>(
          `SELECT r.pii_ref, r.kind, r.subject_type, r.subject_id, r.channel_account_id
             FROM vault.records r
            WHERE r.workspace_id = $1 AND NOT r.canary
              AND ($4::uuid IS NULL OR r.pii_ref > $4::uuid)
              AND r.pii_ref IN (SELECT b.pii_ref FROM vault.blind_index b
                                 WHERE b.workspace_id = $1 AND b.field = 'buyer_exact'
                                   AND b.mac = ANY($2::bytea[]))
            ORDER BY r.pii_ref
            LIMIT $3`,
          [workspaceId, values.map((v) => keys.index.mac('buyer_exact', v)), take + 1, after],
        );
        const more = res.rows.length > take;
        const rows = more ? res.rows.slice(0, take) : res.rows;
        if (rows.length > 0) {
          await this.#log(
            c,
            workspaceId,
            actor,
            'search',
            'ebay_account_deletion',
            null,
            rows.length,
          );
        }
        return { rows, more };
      });
      const lastRow = page.rows.at(-1);
      if (lastRow !== undefined) {
        workspaces.push({ workspace_id: workspaceId, matches: page.rows });
        last = { workspace_id: workspaceId, pii_ref: lastRow.pii_ref };
        remaining -= page.rows.length;
      }
      if (page.more) {
        next = last;
        break;
      }
    }
    return { workspaces, next };
  }

  /**
   * SEC-12 (T-0503): what the security alerts watch in one workspace, as counts and IDs only: how
   * many records each user read in full since `read_full_since` (system reads have no user and
   * are left out), and every canary read since `canary_since`. Reads the logs; logs nothing.
   */
  async signals(req: SignalsRequest): Promise<SignalsResponse> {
    return this.#tx(req.workspace_id, async (c) => {
      const reads = await c.query<{ actor_user_id: string; n: string }>(
        `SELECT actor_user_id, count(*) AS n FROM vault.access_log
          WHERE workspace_id = $1 AND capability = 'read_full' AND at >= $2
            AND actor_user_id IS NOT NULL
          GROUP BY actor_user_id ORDER BY actor_user_id`,
        [req.workspace_id, req.read_full_since],
      );
      const canary = await c.query<{
        id: string;
        at: Date;
        caller: Caller;
        capability: 'read_full' | 'mask';
        actor_user_id: string | null;
      }>(
        `SELECT id::text AS id, at, caller, capability, actor_user_id FROM vault.canary_events
          WHERE workspace_id = $1 AND at >= $2 ORDER BY at, id LIMIT 500`,
        [req.workspace_id, req.canary_since],
      );
      return {
        read_full: reads.rows.map((r) => ({ actor_user_id: r.actor_user_id, count: Number(r.n) })),
        canary: canary.rows.map((r) => ({ ...r, at: r.at.toISOString() })),
      };
    });
  }

  /**
   * Security log retention (ADR-068, PRD 7.3): deletes access-log rows and canary events older
   * than 6 years, in every workspace, closed ones too. The cut-off is fixed in db-pii 0007. Run
   * daily; returns how many rows went (a count only).
   */
  async purgeSecurityLogs(): Promise<number> {
    const res = await this.#pool.query<{ n: string }>('SELECT vault.purge_security_logs() AS n');
    return Number(res.rows[0]?.n ?? '0');
  }

  /**
   * ADR-066 backfill (T-0407): records ingested before `buyer_exact` existed get that entry,
   * from their stored buyer fields. Idempotent: a record that has one is skipped. One short
   * transaction per workspace. Returns how many entries were added (a count, never a value).
   */
  async backfillBuyerExact(): Promise<number> {
    const directory = await this.#pool.query<{ workspace_id: string }>(
      'SELECT workspace_id FROM vault.workspace_directory ORDER BY workspace_id',
    );
    let added = 0;
    for (const { workspace_id: workspaceId } of directory.rows) {
      added += await this.#tx(workspaceId, async (c, tx) => {
        const keys = await this.#loadKeys(tx, workspaceId, false);
        if (keys === undefined) return 0;
        const res = await c.query<{ pii_ref: string; field: string; ciphertext: Buffer }>(
          `SELECT f.pii_ref, f.field, f.ciphertext
             FROM vault.record_fields f
             JOIN vault.records r ON r.workspace_id = f.workspace_id AND r.pii_ref = f.pii_ref
            WHERE f.workspace_id = $1 AND NOT r.canary AND f.field = ANY($2::text[])
              AND NOT EXISTS (SELECT 1 FROM vault.blind_index b
                               WHERE b.workspace_id = f.workspace_id AND b.pii_ref = f.pii_ref
                                 AND b.field = 'buyer_exact')
            ORDER BY f.pii_ref`,
          [workspaceId, BUYER_SOURCE_FIELDS],
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
        let count = 0;
        for (const [piiRef, fields] of byRef) {
          const exact = indexValues(fields).buyer_exact;
          if (exact === undefined) continue;
          const ins = await c.query(
            `INSERT INTO vault.blind_index (workspace_id, pii_ref, field, mac, key_version)
             VALUES ($1, $2, 'buyer_exact', $3, $4) ON CONFLICT DO NOTHING`,
            [workspaceId, piiRef, keys.index.mac('buyer_exact', exact), keys.index.version],
          );
          count += ins.rowCount ?? 0;
        }
        return count;
      });
    }
    return added;
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
