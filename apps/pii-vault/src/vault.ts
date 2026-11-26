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
  hasDeliveryAddress,
  PURPOSE_KINDS,
  type EbayUserMatchRequest,
  type EbayUserMatchResponse,
  type ExpiryRequest,
  type IngestRequest,
  type MaskResponse,
  type MatchRequest,
  type MatchResponse,
  type ReadFullResponse,
  type RecordKind,
  type ReadPurpose,
  type ReplaceRequest,
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

/** The off-site journal (invariant 10, ADR-068): IDs, dates and MACs, fsynced before commit. */
export interface Journal {
  append(lines: readonly Record<string, string | null>[]): Promise<void>;
}

interface Keys {
  data: DataKey;
  index: IndexKey;
}

/** A lock could not be had in time: 503, and the caller asks again. */
export class VaultBusy extends Error {}

/**
 * The address block of a buyer, replaced whole by a correction (ORD-4). Delivery instructions are
 * free text, not identity (ADR-086 2): like email and phone, a masked one is left out and the
 * stored one kept, so a star in them never refuses the address.
 */
const DELIVERY_FIELDS: ReadonlySet<string> = new Set([
  'name',
  'address_line1',
  'address_line2',
  'address_line3',
  'city',
  'county',
  'postcode',
  'country',
]);

/** A channel masks old buyers' details with stars or dots. */
const isMasked = (value: string): boolean => /[*\u2022]/.test(value);

/**
 * What a newer buyer block may write to an order's record (ORD-4): a named delivery address with
 * no masked part, or nothing at all. A masked email, phone or channel ID is left out, so the one
 * stored is kept.
 */
function usableBlock(fields: Readonly<Record<string, string>>): Record<string, string> | undefined {
  const given = Object.entries(fields);
  const named = fields.name !== undefined && fields.name.trim() !== '';
  const masked = given.some(([field, value]) => DELIVERY_FIELDS.has(field) && isMasked(value));
  if (!named || masked || !hasDeliveryAddress(fields)) return undefined;
  return Object.fromEntries(given.filter(([, value]) => !isMasked(value)));
}

/**
 * The vault-wide advisory lock of eBay notices (two-key space, so never a workspace's lock):
 * shared by every buyer write, taken alone by a notice.
 */
const NOTICE_LOCK = '8711, 1';

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
/** Stands for the vault itself where a key belongs to a workspace: never a UUID, so never one. */
export const VAULT_KEY_SCOPE = 'vault-wide';
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
  /** The vault-wide keys by version, unwrapped once. */
  readonly #vaultKeys = new Map<number, IndexKey>();

  readonly #onCanary: (event: CanaryEvent) => void;
  readonly #journal: Journal | undefined;
  readonly #onVacuumFailed: (errorName: string) => void;

  constructor(options: {
    pool: Pool;
    keyring: Keyring;
    now?: () => Date;
    /** Called after a canary read is recorded (SEC-12); the app logs it at warn. */
    onCanary?: (event: CanaryEvent) => void;
    /** Expiry changes are journalled here (ADR-068): the deletion journal's directory. */
    journal?: Journal;
    /** A VACUUM after a correction failed: the error's name, never its text. The app logs it. */
    onVacuumFailed?: (errorName: string) => void;
  }) {
    this.#pool = options.pool;
    this.#keyring = options.keyring;
    this.#now = options.now ?? (() => new Date());
    this.#onCanary = options.onCanary ?? (() => undefined);
    this.#journal = options.journal;
    this.#onVacuumFailed = options.onVacuumFailed ?? (() => undefined);
  }

  /** A closed workspace's keys are deleted with it; the cached copies go too. */
  forgetKeys(workspaceId: string): void {
    this.#keys.delete(workspaceId);
  }

  /**
   * PS-035 (ADR-081 8): makes the vault-wide index key, once, whoever starts first. Called before
   * the vault serves, never at the first notice: a key made after a backup would be lost by the
   * restore, and the entries replayed from the journal would then match nothing.
   */
  async ensureVaultKey(): Promise<void> {
    const { wrapped } = generateIndexKey(this.#keyring, VAULT_KEY_SCOPE, KEY_VERSION);
    await this.#pool.query(
      `INSERT INTO vault.vault_keys (kind, version, kek_version, wrapped, created_at)
       VALUES ('deleted_buyers', $1, $2, $3, $4) ON CONFLICT DO NOTHING`,
      [wrapped.version, wrapped.kekVersion, wrapped.wrapped, this.#now()],
    );
    await this.#vaultKeyList(this.#pool);
  }

  /** The vault-wide keys, oldest first. None is an error: without one nothing can be checked. */
  async #vaultKeyList(c: Pick<PoolClient, 'query'>): Promise<[IndexKey, ...IndexKey[]]> {
    const { rows } = await c.query<{ version: string; kek_version: string; wrapped: Buffer }>(
      `SELECT version, kek_version, wrapped FROM vault.vault_keys
        WHERE kind = 'deleted_buyers' ORDER BY version`,
    );
    const keys = rows.map((r) => {
      const version = Number(r.version);
      const cached = this.#vaultKeys.get(version);
      if (cached !== undefined) return cached;
      const key = unwrapIndexKey(this.#keyring, {
        workspaceId: VAULT_KEY_SCOPE,
        version,
        kekVersion: Number(r.kek_version),
        wrapped: r.wrapped,
      });
      this.#vaultKeys.set(version, key);
      return key;
    });
    const [first, ...rest] = keys;
    if (first === undefined) throw new Error('the vault-wide key is missing');
    return [first, ...rest];
  }

  /**
   * ORD-4 (ADR-081, T-1003): the channel corrected an order's buyer block before dispatch. The one
   * record takes it in place: same pii_ref, same delete_after, with its blind indexes and match
   * key, in one transaction. The delivery block is replaced whole; an email, phone or channel ID
   * the channel did not send again is kept. It never makes a record, and it changes nothing for a
   * record that is gone or past its date, an older update, or a block that is masked or no whole
   * address.
   */
  async replace(req: ReplaceRequest): Promise<{ changed: boolean }> {
    const changed = await this.#tx(req.workspace_id, async (c, tx) => {
      await this.#ingestLocks(c, req.workspace_id, true);
      const keys = await this.#loadKeys(tx, req.workspace_id, false);
      if (keys === undefined) return false;
      const found = await c.query<{ pii_ref: string; source_updated_at: Date | null }>(
        `SELECT pii_ref, source_updated_at FROM vault.records
          WHERE workspace_id = $1 AND pii_ref = $2 AND kind = 'buyer_contact'
            AND subject_type = 'order' AND subject_id = $3 AND NOT canary
            AND (delete_after IS NULL OR delete_after > $4)
          FOR UPDATE`,
        [req.workspace_id, req.pii_ref, req.subject_id, this.#now()],
      );
      const record = found.rows[0];
      if (record === undefined) return false;
      return this.#applyNewer(c, keys, req, record);
    });
    if (changed) await this.#vacuumReplaced();
    return { changed };
  }

  /**
   * The one way a newer buyer block reaches a record: for a correction, and for an ingest that
   * finds the record already there. The caller holds the record's row. Returns whether a value
   * was written.
   */
  async #applyNewer(
    c: PoolClient,
    keys: Keys,
    req: Pick<IngestRequest, 'workspace_id' | 'channel' | 'placed_at' | 'fields'> & {
      source_updated_at: string;
    },
    record: { pii_ref: string; source_updated_at: Date | null },
  ): Promise<boolean> {
    const fields = usableBlock(req.fields);
    if (fields === undefined) return false;
    const at = new Date(req.source_updated_at);
    if (record.source_updated_at !== null && record.source_updated_at >= at) return false;
    const ref = [req.workspace_id, record.pii_ref];
    await c.query(
      'UPDATE vault.records SET source_updated_at = $3 WHERE workspace_id = $1 AND pii_ref = $2',
      [...ref, at],
    );
    const old = await this.#decryptFields(c, keys.data, req.workspace_id, record.pii_ref);
    const next: Record<string, string> = {};
    for (const [field, value] of Object.entries(old)) {
      if (!DELIVERY_FIELDS.has(field)) next[field] = value;
    }
    Object.assign(next, fields);
    // The buyer as the record would hold it: an ID the channel did not send again still counts.
    await this.#refuseDeletedBuyer(c, { ...req, fields: next });
    const names = new Set([...Object.keys(old), ...Object.keys(next)]);
    const differing = [...names].filter((n) => old[n] !== next[n]);
    if (differing.length === 0) return false;
    await c.query(
      `DELETE FROM vault.record_fields
        WHERE workspace_id = $1 AND pii_ref = $2 AND field = ANY($3::text[])`,
      [...ref, differing],
    );
    await c.query('DELETE FROM vault.blind_index WHERE workspace_id = $1 AND pii_ref = $2', ref);
    const write = Object.fromEntries(Object.entries(next).filter(([n]) => differing.includes(n)));
    await this.#writeFields(c, keys, req.workspace_id, record.pii_ref, write);
    await this.#writeIndex(c, keys, req.workspace_id, record.pii_ref, indexValues(next));
    return true;
  }

  /**
   * Invariant 10: replaced values leave no dead tuple behind. A table another VACUUM holds is
   * skipped, so the caller never waits; a failure is reported by its name. Either way autovacuum
   * clears the tables later, and the values are ciphertext and MACs.
   */
  async #vacuumReplaced(): Promise<void> {
    try {
      await this.#pool.query('VACUUM (SKIP_LOCKED) vault.record_fields, vault.blind_index');
    } catch (err) {
      this.#onVacuumFailed(err instanceof Error ? err.name : 'unknown');
    }
  }

  /** Deleted-buyer entries past their 180 days go (0011). Run daily; returns how many went. */
  async purgeDeletedBuyers(): Promise<number> {
    const res = await this.#pool.query<{ n: string }>('SELECT vault.purge_deleted_buyers() AS n');
    return Number(res.rows[0]?.n ?? '0');
  }

  /**
   * The locks every write of a buyer takes, in this order, until it commits. The vault-wide one,
   * shared, orders it against an eBay notice (which takes it alone): an ingest past its check is
   * committed, with its workspace's directory row, before the notice looks. The workspace one,
   * shared, orders it against closure's last batch (ADR-065).
   */
  async #ingestLocks(c: PoolClient, workspaceId: string, buyer: boolean): Promise<void> {
    if (buyer) await c.query(`SELECT pg_advisory_xact_lock_shared(${NOTICE_LOCK})`);
    await c.query('SELECT pg_advisory_xact_lock_shared($1::bigint)', [workspaceLock(workspaceId)]);
    // ADR-065 (F-M04h-04): a closed workspace takes no new PII and gets no new keys, so a record is
    // either seen and deleted by closure, or refused here once the marker exists.
    const closed = await c.query('SELECT 1 FROM vault.closed_workspaces WHERE workspace_id = $1', [
      workspaceId,
    ]);
    if ((closed.rowCount ?? 0) > 0) throw new WorkspaceClosed();
  }

  async #writeFields(
    c: PoolClient,
    keys: Keys,
    workspaceId: string,
    piiRef: string,
    fields: Readonly<Record<string, string>>,
  ): Promise<void> {
    for (const [field, value] of Object.entries(fields)) {
      const aad = { workspaceId, table: FIELD_TABLE, column: field, rowId: piiRef };
      await c.query(
        `INSERT INTO vault.record_fields (workspace_id, pii_ref, field, ciphertext) VALUES ($1, $2, $3, $4)`,
        [workspaceId, piiRef, field, keys.data.encrypt(value, aad)],
      );
    }
  }

  async #writeIndex(
    c: PoolClient,
    keys: Keys,
    workspaceId: string,
    piiRef: string,
    values: Readonly<Record<string, string>>,
  ): Promise<void> {
    for (const [field, value] of Object.entries(values)) {
      await c.query(
        `INSERT INTO vault.blind_index (workspace_id, pii_ref, field, mac, key_version) VALUES ($1, $2, $3, $4, $5)`,
        [workspaceId, piiRef, field, keys.index.mac(field, value), keys.index.version],
      );
    }
  }

  async ingest(req: IngestRequest): Promise<{ pii_ref: string }> {
    this.#checkExpiry(req.delete_after);
    const index = indexValues(req.fields);
    const { pii_ref, changed } = await this.#tx(req.workspace_id, async (c, tx) => {
      const buyer = req.kind === 'buyer_contact';
      await this.#ingestLocks(c, req.workspace_id, buyer);
      if (buyer) await this.#refuseDeletedBuyer(c, req);
      // Keys are made here and only here, never by a read (F-M04h-04).
      const keys = await this.#loadKeys(tx, req.workspace_id, true);
      if (keys === undefined) throw new Error('keys were not created');
      if (tx.created === true) await this.#insertCanary(c, req.workspace_id, keys);
      // pii_ref defaults to uuidv7() (PostgreSQL 18): time-ordered, so the key index stays compact.
      // ORD-4 (ADR-079 3): one buyer record per order. A retried or repeated ingest of the same
      // order finds the record already there and gets its ref back; nothing is added. A newer
      // block than the record's is applied to it, as a correction is: if the first store failed
      // in db-main, the order is new again and nobody would ask for the correction.
      const deleteAfter =
        req.delete_after === undefined
          ? // A backstop until the caller sets the real expiry at dispatch or delivery (DEL-1).
            new Date(this.#now().getTime() + HARD_LIMIT_MS)
          : new Date(req.delete_after);
      const insert = async () => {
        const { rows } = await c.query<{ pii_ref: string }>(
          `INSERT INTO vault.records (workspace_id, kind, channel_account_id, subject_type,
                                      subject_id, data_key_version, delete_after, created_at,
                                      source_updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
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
            deleteAfter,
            this.#now(),
            req.source_updated_at ?? null,
          ],
        );
        return rows[0]?.pii_ref;
      };
      let piiRef = await insert();
      if (piiRef === undefined) {
        const existing = await c.query<{
          pii_ref: string;
          delete_after: Date | null;
          source_updated_at: Date | null;
        }>(
          `SELECT pii_ref, delete_after, source_updated_at FROM vault.records
            WHERE workspace_id = $1 AND kind = $2 AND subject_type = $3 AND subject_id = $4
              AND NOT canary
            FOR UPDATE`,
          [req.workspace_id, req.kind, req.subject_type, req.subject_id],
        );
        const record = existing.rows[0];
        if (record !== undefined) {
          // FA-10: the sweep expired it as an orphan, and its order is being stored after all. A
          // live order never gets a record the next hourly run deletes.
          if (record.delete_after !== null && record.delete_after <= this.#now()) {
            await this.#journalExpiry(
              req.workspace_id,
              [record.pii_ref],
              deleteAfter,
              'stored_again',
            );
            await c.query(
              'UPDATE vault.records SET delete_after = $3 WHERE workspace_id = $1 AND pii_ref = $2',
              [req.workspace_id, record.pii_ref, deleteAfter],
            );
          }
          const changed =
            buyer &&
            req.source_updated_at !== undefined &&
            (await this.#applyNewer(
              c,
              keys,
              { ...req, source_updated_at: req.source_updated_at },
              record,
            ));
          return { pii_ref: record.pii_ref, changed };
        }
        // A deletion run held it and has deleted it since: this is a new record.
        piiRef = await insert();
      }
      if (piiRef === undefined) throw new Error('order record conflict without a record');
      await this.#writeFields(c, keys, req.workspace_id, piiRef, req.fields);
      await this.#writeIndex(c, keys, req.workspace_id, piiRef, index);
      return { pii_ref: piiRef, changed: false };
    });
    if (changed) await this.#vacuumReplaced();
    return { pii_ref };
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
      await this.#journalExpiry(
        req.workspace_id,
        res.rows.map((r) => r.pii_ref),
        new Date(req.delete_after),
        req.reason,
      );
      return { updated: res.rowCount ?? 0 };
    });
  }

  async #journalExpiry(
    workspaceId: string,
    piiRefs: readonly string[],
    deleteAfter: Date,
    reason: string,
  ): Promise<void> {
    const at = this.#now().toISOString();
    await this.#journal?.append(
      piiRefs.map((ref) => ({
        type: 'expiry',
        workspace_id: workspaceId,
        pii_ref: ref,
        delete_after: deleteAfter.toISOString(),
        reason,
        at,
      })),
    );
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
   * ADR-068 tombstone check: a buyer whose eBay account was deleted is never stored again. An ID
   * is never reused, so a matching user ID always refuses, in either field (eBay may send the ID
   * as the username, and orders carry the username only). A username can be reused by someone
   * else, so it decides only for a record with no ID, and only for an order placed before the
   * notice (a re-poll or backfill of the deleted buyer's own orders).
   *
   * One table for the whole vault (PS-035), looked up under every key version. eBay buyers only:
   * a website or Amazon customer with the same ID is somebody else. No channel counts as eBay.
   */
  async #refuseDeletedBuyer(
    c: PoolClient,
    req: Pick<IngestRequest, 'channel' | 'placed_at' | 'fields'>,
  ): Promise<void> {
    if (req.channel !== undefined && req.channel !== 'ebay') return;
    const id = normaliseBuyerExact(req.fields.channel_buyer_id ?? '');
    const username = normaliseBuyerExact(req.fields.channel_username ?? '');
    const asked: [string, string][] = [];
    for (const value of new Set([id, username])) {
      if (value !== '') asked.push(['ebay_user_id', value]);
    }
    if (id === '' && username !== '') asked.push(['ebay_username', username]);
    if (asked.length === 0) return;
    const look = (await this.#vaultKeyList(c)).flatMap((key) =>
      asked.map(([field, value]) => ({ version: key.version, field, mac: key.mac(field, value) })),
    );
    const { rows } = await c.query<{ field: string; noticed_at: Date }>(
      `SELECT d.field, d.noticed_at FROM vault.ebay_deleted_buyers d
         JOIN unnest($1::bigint[], $2::text[], $3::bytea[]) AS q(version, field, mac)
           ON d.key_version = q.version AND d.field = q.field AND d.mac = q.mac`,
      [look.map((l) => l.version), look.map((l) => l.field), look.map((l) => l.mac)],
    );
    const placed = req.placed_at === undefined ? undefined : new Date(req.placed_at);
    for (const hit of rows) {
      if (hit.field === 'ebay_user_id') throw new BuyerDeleted();
      if (placed === undefined || placed < hit.noticed_at) throw new BuyerDeleted();
    }
  }

  /**
   * An eBay deletion notice, before anything is read: its entries are written once, for the whole
   * vault, under the notice lock taken alone, and committed. So every ingest already past its check
   * has committed (with its workspace's directory row) and is found by the match that follows, and
   * every later one is refused. Journalled off-site first (invariant 10): a MAC and dates, never
   * the ID or name. The wait is short: eBay sends again what was not answered 200.
   */
  async #recordNotice(req: EbayUserMatchRequest): Promise<void> {
    const entries: [string, string][] = [];
    const userId = normaliseBuyerExact(req.user_id ?? '');
    const username = normaliseBuyerExact(req.username ?? '');
    if (userId !== '') entries.push(['ebay_user_id', userId]);
    if (username !== '') entries.push(['ebay_username', username]);
    if (entries.length === 0) return;
    const c = await this.#pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SET LOCAL lock_timeout = '2s'`);
      await c.query(`SELECT pg_advisory_xact_lock(${NOTICE_LOCK})`);
      const keys = await this.#vaultKeyList(c);
      const key = keys.at(-1) ?? keys[0];
      const at = this.#now();
      const said = req.noticed_at === undefined ? at : new Date(req.noticed_at);
      const noticedAt = said < at ? said : at;
      const rows = entries.map(([field, value]) => ({ field, mac: key.mac(field, value) }));
      await this.#journal?.append(
        rows.map((r) => ({
          type: 'ebay_deleted',
          field: r.field,
          mac: r.mac.toString('hex'),
          key_version: String(key.version),
          noticed_at: noticedAt.toISOString(),
          at: at.toISOString(),
        })),
      );
      for (const r of rows) {
        // A second notice for a reused username covers its second owner's orders too; an older or
        // repeated one never moves the date back.
        await c.query(
          `INSERT INTO vault.ebay_deleted_buyers AS d (key_version, field, mac, noticed_at, received_at)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (key_version, field, mac) DO UPDATE
             SET noticed_at = greatest(d.noticed_at, excluded.noticed_at),
                 received_at = greatest(d.received_at, excluded.received_at)`,
          [key.version, r.field, r.mac, noticedAt, at],
        );
      }
      await c.query('COMMIT');
    } catch (err) {
      await c.query('ROLLBACK').catch(() => undefined);
      if ((err as { code?: string }).code === '55P03') throw new VaultBusy();
      throw err;
    } finally {
      c.release();
    }
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
   * ORD-9, ADR-055: which of these records share a buyer and delivery address, on one channel
   * account. Subject IDs only, never a value, and never another channel account's record.
   */
  async match(req: MatchRequest, actor: Actor): Promise<MatchResponse> {
    return this.#tx(req.workspace_id, async (c, tx) => {
      // A workspace with no keys holds no records: answer empty and write nothing (F-M04h-04).
      if ((await this.#loadKeys(tx, req.workspace_id, false)) === undefined) return { groups: [] };
      const res = await c.query<{ subjects: string[] }>(
        `SELECT array_agg(DISTINCT r.subject_id ORDER BY r.subject_id) AS subjects
           FROM vault.records r
           JOIN vault.blind_index b ON b.workspace_id = r.workspace_id AND b.pii_ref = r.pii_ref
                                   AND b.field = 'match'
          WHERE r.workspace_id = $1 AND r.channel_account_id = $2
            AND r.pii_ref = ANY($3::uuid[]) AND NOT r.canary
          GROUP BY b.mac, r.kind, r.subject_type
         HAVING count(DISTINCT r.subject_id) > 1
          ORDER BY 1`,
        [req.workspace_id, req.channel_account_id, req.pii_refs],
      );
      const groups = res.rows.map((r) => r.subjects);
      const count = groups.reduce((n, g) => n + g.length, 0);
      await this.#log(c, req.workspace_id, actor, 'match', 'same_buyer', null, count);
      return { groups };
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
    // Written once, on the first page, and committed before the directory is read.
    if (cursor === undefined) await this.#recordNotice(req);
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
   * F-M10-end-15: names and addresses are indexed without their punctuation now, and records from
   * before T-1002 have no such match key at all. Each record whose name or match key is not the one
   * its fields give today gets it. Idempotent; one short transaction per workspace. Returns how many
   * records changed (a count, never a value).
   */
  async reindexNames(): Promise<number> {
    const directory = await this.#pool.query<{ workspace_id: string }>(
      'SELECT workspace_id FROM vault.workspace_directory ORDER BY workspace_id',
    );
    let changed = 0;
    for (const { workspace_id: workspaceId } of directory.rows) {
      changed += await this.#tx(workspaceId, async (c, tx) => {
        const keys = await this.#loadKeys(tx, workspaceId, false);
        if (keys === undefined) return 0;
        const records = await c.query<{ pii_ref: string }>(
          `SELECT pii_ref FROM vault.records
            WHERE workspace_id = $1 AND kind = 'buyer_contact' AND NOT canary
            ORDER BY pii_ref FOR UPDATE`,
          [workspaceId],
        );
        let count = 0;
        for (const { pii_ref: ref } of records.rows) {
          const { name, match } = indexValues(
            await this.#decryptFields(c, keys.data, workspaceId, ref),
          );
          const want = Object.fromEntries(
            Object.entries({ name, match }).filter(
              (e): e is [string, string] => e[1] !== undefined,
            ),
          );
          const had = await c.query<{ field: string; mac: Buffer }>(
            `SELECT field, mac FROM vault.blind_index
              WHERE workspace_id = $1 AND pii_ref = $2 AND field IN ('name', 'match')`,
            [workspaceId, ref],
          );
          const same =
            had.rows.length === Object.keys(want).length &&
            had.rows.every((r) => {
              const value = want[r.field];
              return value !== undefined && keys.index.mac(r.field, value).equals(r.mac);
            });
          if (same) continue;
          await c.query(
            `DELETE FROM vault.blind_index
              WHERE workspace_id = $1 AND pii_ref = $2 AND field IN ('name', 'match')`,
            [workspaceId, ref],
          );
          await this.#writeIndex(c, keys, workspaceId, ref, want);
          count += 1;
        }
        return count;
      });
    }
    if (changed > 0) await this.#vacuumReplaced();
    return changed;
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
