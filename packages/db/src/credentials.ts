import { randomUUID } from 'node:crypto';
import type { ProviderMode, TenantContext } from '@omnibridge/core';
import {
  generateDataKey,
  rewrapDataKey,
  Secret,
  unwrapDataKey,
  type DataKey,
  type FieldAad,
  type Keyring,
} from '@omnibridge/crypto';
import type { Logger } from '@omnibridge/logger';
import { sql, type ExpressionBuilder, type Kysely } from 'kysely';
import type { CredentialsTable, MainDb } from './schema.ts';
import { withTenantTransaction } from './tenant.ts';

export type CredentialSlot = CredentialsTable['slot'];

/**
 * Every credential kind the store accepts, one per row of docs/ops/secrets-register.md
 * (F-M01-halfway-05). Provider modules add their kinds here; a typo is a type error, not an
 * empty slot.
 */
export const CREDENTIAL_KINDS = [
  'amazon.refresh_token',
  'ads.refresh_token',
  'ebay.refresh_token',
  'evri.api_key',
  'dpd.api_key',
  'website.api_key',
  // T-1101 (WEB-2): the HMAC secret a website and OmniBridge sign their calls with.
  'website.signing_secret',
] as const;
export type CredentialKind = (typeof CREDENTIAL_KINDS)[number];

const KNOWN_KINDS: ReadonlySet<string> = new Set(CREDENTIAL_KINDS);

/** Which credential: its kind and, if it has one, its account. */
export interface CredentialRef {
  readonly kind: CredentialKind;
  readonly channelAccountId?: string | null;
}

export interface CredentialRepositoryOptions {
  /** The secrets master key (never the PII one). */
  readonly keyring: Keyring;
  readonly logger: Logger;
  /**
   * The provider environment this process talks to (PROVIDER_MODE, INT-3). Tokens are stored with
   * it and only tokens of it are read, so a copied or restored database cannot use another
   * environment's token. Defaults to `mock` (dev and CI).
   */
  readonly environment?: ProviderMode;
}

const TABLE = 'app.credentials';
const COLUMN = 'encrypted_value';

/**
 * Envelope-encrypted provider credentials in db-main (SEC-6, INT-3), with current/next slots
 * (AMZ-8, AMZ-10).
 *
 * Every method takes a transaction that has already run `SET LOCAL app.workspace_id` for `ctx`;
 * row-level security does the rest. Values go in and come out only as `Secret`, and logs carry
 * ids, kinds, slots and counts, never values.
 */
export class CredentialRepository {
  readonly #keyring: Keyring;
  readonly #log: Logger;
  readonly #environment: ProviderMode;

  constructor(options: CredentialRepositoryOptions) {
    if (options.keyring.purpose !== 'secrets') {
      throw new Error('The credential store uses the secrets master key only');
    }
    this.#keyring = options.keyring;
    this.#log = options.logger.child({ component: 'credentials' });
    this.#environment = options.environment ?? 'mock';
  }

  /** Stores a value in an empty slot. Use `replaceCurrent` or `promoteNext` to rotate. */
  async store(
    db: Kysely<MainDb>,
    ctx: TenantContext,
    ref: CredentialRef,
    slot: CredentialSlot,
    value: Secret,
    options: { expiresAt?: Date } = {},
  ): Promise<string> {
    await this.#lock(db, ctx, ref);
    if ((await this.#activeRow(db, ctx, ref, slot)) !== undefined) {
      throw new Error(`An active ${slot} credential of kind ${ref.kind} already exists`);
    }
    try {
      return await this.#insert(db, ctx, ref, slot, value, options.expiresAt ?? null);
    } catch (err) {
      // Defence in depth: the advisory lock already serialises writers of one credential.
      if (isUniqueViolation(err)) {
        throw new Error(`An active ${slot} credential of kind ${ref.kind} already exists`);
      }
      throw err;
    }
  }

  /** The active value in a slot, or undefined. */
  async get(
    db: Kysely<MainDb>,
    ctx: TenantContext,
    ref: CredentialRef,
    slot: CredentialSlot = 'current',
  ): Promise<Secret | undefined> {
    // A mistyped kind is an error, never an empty slot that looks like a disconnected account.
    assertKnownKind(ref.kind);
    // One round trip: the credential and the data key it was written under.
    const row = await db
      .selectFrom(TABLE)
      .innerJoin('app.data_keys as k', (join) =>
        join
          .onRef('k.workspace_id', '=', `${TABLE}.workspace_id`)
          .onRef('k.version', '=', `${TABLE}.key_version`),
      )
      .where(this.#slot(ctx, ref, slot))
      .select([
        `${TABLE}.id`,
        `${TABLE}.encrypted_value`,
        'k.version',
        'k.kek_version',
        'k.wrapped_key',
      ])
      .executeTakeFirst();
    if (row === undefined) return undefined;
    const dataKey = this.#unwrap(ctx, row);
    const plaintext = dataKey.decrypt(row.encrypted_value, this.#aad(ctx, row.id));
    return new Secret(plaintext.toString('utf8'));
  }

  /**
   * Makes `next` the new `current` (AMZ-10). The old current stays inactive for `retainOldForMs`
   * and is then removed by `purgeExpired`.
   */
  async promoteNext(
    db: Kysely<MainDb>,
    ctx: TenantContext,
    ref: CredentialRef,
    options: { retainOldForMs: number },
  ): Promise<void> {
    await this.#lock(db, ctx, ref);
    const next = await this.#activeRow(db, ctx, ref, 'next');
    if (next === undefined) throw new Error(`There is no next credential of kind ${ref.kind}`);
    await this.#retireCurrent(db, ctx, ref, options.retainOldForMs);
    await db
      .updateTable(TABLE)
      .set({ slot: 'current', rotated_at: new Date() })
      .where('workspace_id', '=', ctx.workspaceId)
      .where('id', '=', next.id)
      .execute();
    this.#log.info(
      { event: 'credential.promoted', workspaceId: ctx.workspaceId, credentialId: next.id },
      'credential promoted from next to current',
    );
  }

  /**
   * Stores a new current value and keeps the old one inactive for `retainOldForMs`, then the purge
   * deletes it (AMZ-8: re-authorisation keeps the old refresh token for 7 days).
   */
  async replaceCurrent(
    db: Kysely<MainDb>,
    ctx: TenantContext,
    ref: CredentialRef,
    value: Secret,
    options: { retainOldForMs: number; expiresAt?: Date },
  ): Promise<string> {
    // Two re-authorisations racing for one account run one after the other: the later one retires
    // the earlier one's token instead of failing on the unique index (F-M01-halfway-07).
    await this.#lock(db, ctx, ref);
    await this.#retireCurrent(db, ctx, ref, options.retainOldForMs);
    return this.#insert(db, ctx, ref, 'current', value, options.expiresAt ?? null);
  }

  /** Hard-deletes inactive credentials whose `delete_after` has passed. Returns how many. */
  async purgeExpired(db: Kysely<MainDb>, ctx: TenantContext, now = new Date()): Promise<number> {
    const result = await db
      .deleteFrom(TABLE)
      .where('workspace_id', '=', ctx.workspaceId)
      .where('is_active', '=', false)
      .where('delete_after', '<=', now)
      .executeTakeFirst();
    const count = Number(result.numDeletedRows);
    this.#log.info(
      { event: 'credential.purged', workspaceId: ctx.workspaceId, count },
      'expired credentials deleted',
    );
    return count;
  }

  /**
   * KEK rotation for one workspace: every data key still wrapped by an older KEK version is
   * re-wrapped under the active one. Credential rows are not touched (SEC-6).
   *
   * Data keys under a newer KEK than this process holds (another container already on the next
   * keyring, mid-rollout) are left alone and only counted (F-M01-halfway-06).
   */
  async rewrapDataKeys(db: Kysely<MainDb>, ctx: TenantContext): Promise<number> {
    const active = String(this.#keyring.activeVersion);
    const stale = await db
      .selectFrom('app.data_keys')
      .select(['version', 'kek_version', 'wrapped_key'])
      .where('workspace_id', '=', ctx.workspaceId)
      .where('kek_version', '<', active)
      .forUpdate()
      .execute();
    const newer = await db
      .selectFrom('app.data_keys')
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .where('workspace_id', '=', ctx.workspaceId)
      .where('kek_version', '>', active)
      .executeTakeFirstOrThrow();
    if (Number(newer.count) > 0) {
      this.#log.warn(
        {
          event: 'data_keys.newer_kek',
          workspaceId: ctx.workspaceId,
          kekVersion: this.#keyring.activeVersion,
          count: Number(newer.count),
        },
        'data keys under a newer KEK than this process holds were left alone',
      );
    }
    for (const row of stale) {
      const next = rewrapDataKey(this.#keyring, {
        workspaceId: ctx.workspaceId,
        version: Number(row.version),
        kekVersion: Number(row.kek_version),
        wrapped: row.wrapped_key,
      });
      await db
        .updateTable('app.data_keys')
        .set({ kek_version: next.kekVersion, wrapped_key: next.wrapped, rewrapped_at: new Date() })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('version', '=', String(next.version))
        .execute();
    }
    this.#log.info(
      {
        event: 'data_keys.rewrapped',
        workspaceId: ctx.workspaceId,
        kekVersion: this.#keyring.activeVersion,
        count: stale.length,
      },
      'data keys re-wrapped under the active KEK',
    );
    return stale.length;
  }

  /** Data keys of the workspace under an older and under a newer KEK than the active one. */
  async countDataKeys(
    db: Kysely<MainDb>,
    ctx: TenantContext,
  ): Promise<{ stale: number; newer: number }> {
    const active = String(this.#keyring.activeVersion);
    const row = await db
      .selectFrom('app.data_keys')
      .select((eb) => [
        eb.fn.countAll<string>().filterWhere('kek_version', '<', active).as('stale'),
        eb.fn.countAll<string>().filterWhere('kek_version', '>', active).as('newer'),
      ])
      .where('workspace_id', '=', ctx.workspaceId)
      .executeTakeFirstOrThrow();
    return { stale: Number(row.stale), newer: Number(row.newer) };
  }

  async #insert(
    db: Kysely<MainDb>,
    ctx: TenantContext,
    ref: CredentialRef,
    slot: CredentialSlot,
    value: Secret,
    expiresAt: Date | null,
  ): Promise<string> {
    const dataKey = await this.#activeDataKey(db, ctx);
    const id = randomUUID();
    await db
      .insertInto(TABLE)
      .values({
        id,
        workspace_id: ctx.workspaceId,
        kind: ref.kind,
        channel_account_id: ref.channelAccountId ?? null,
        slot,
        environment: this.#environment,
        encrypted_value: dataKey.encrypt(value.reveal(), this.#aad(ctx, id)),
        key_version: dataKey.version,
        expires_at: expiresAt,
      })
      .execute();
    this.#log.info(
      {
        event: 'credential.stored',
        workspaceId: ctx.workspaceId,
        credentialId: id,
        credentialKind: ref.kind,
        slot,
        keyVersion: dataKey.version,
      },
      'credential stored',
    );
    return id;
  }

  async #retireCurrent(
    db: Kysely<MainDb>,
    ctx: TenantContext,
    ref: CredentialRef,
    retainForMs: number,
  ): Promise<void> {
    if (!Number.isFinite(retainForMs) || retainForMs < 0) {
      throw new Error('retainOldForMs must be zero or more');
    }
    const now = new Date();
    await db
      .updateTable(TABLE)
      .where(this.#slot(ctx, ref, 'current'))
      // expires_at keeps the provider's expiry; delete_after is when the purge removes the row.
      .set({
        is_active: false,
        rotated_at: now,
        delete_after: new Date(now.getTime() + retainForMs),
      })
      .execute();
  }

  /**
   * Serialises every writer of one credential (workspace, kind, account) until the transaction
   * ends, and refuses kinds outside CREDENTIAL_KINDS for callers that bypass the type.
   */
  async #lock(db: Kysely<MainDb>, ctx: TenantContext, ref: CredentialRef): Promise<void> {
    assertKnownKind(ref.kind);
    const key = ['app.credentials', ctx.workspaceId, ref.kind, ref.channelAccountId ?? ''].join(
      '|',
    );
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`.execute(db);
  }

  #activeRow(db: Kysely<MainDb>, ctx: TenantContext, ref: CredentialRef, slot: CredentialSlot) {
    return db
      .selectFrom(TABLE)
      .where(this.#slot(ctx, ref, slot))
      .select('id')
      .executeTakeFirst();
  }

  /**
   * Filter for the active row of one slot of one credential, shared by select and update. Columns
   * are table-qualified because get() joins app.data_keys, which also has workspace_id.
   */
  #slot(ctx: TenantContext, ref: CredentialRef, slot: CredentialSlot) {
    return (eb: ExpressionBuilder<MainDb, typeof TABLE>) =>
      eb.and([
        eb(`${TABLE}.workspace_id`, '=', ctx.workspaceId),
        eb(`${TABLE}.kind`, '=', ref.kind),
        eb(`${TABLE}.channel_account_id`, 'is not distinct from', ref.channelAccountId ?? null),
        eb(`${TABLE}.slot`, '=', slot),
        eb(`${TABLE}.is_active`, '=', true),
        eb(`${TABLE}.environment`, '=', this.#environment),
      ]);
  }

  /** The newest data key of the workspace, created on first use. */
  async #activeDataKey(db: Kysely<MainDb>, ctx: TenantContext): Promise<DataKey> {
    const newest = () =>
      db
        .selectFrom('app.data_keys')
        .select(['version', 'kek_version', 'wrapped_key'])
        .where('workspace_id', '=', ctx.workspaceId)
        .orderBy('version', 'desc')
        .limit(1)
        .executeTakeFirst();
    const existing = await newest();
    if (existing !== undefined) return this.#unwrap(ctx, existing);

    const { dataKey, wrapped } = generateDataKey(this.#keyring, ctx.workspaceId, 1);
    const inserted = await db
      .insertInto('app.data_keys')
      .values({
        workspace_id: ctx.workspaceId,
        version: wrapped.version,
        kek_version: wrapped.kekVersion,
        wrapped_key: wrapped.wrapped,
      })
      .onConflict((oc) => oc.columns(['workspace_id', 'version']).doNothing())
      .executeTakeFirst();
    if (Number(inserted.numInsertedOrUpdatedRows ?? 0n) === 1) return dataKey;
    // A concurrent transaction created the key first: use theirs.
    const theirs = await newest();
    if (theirs === undefined) throw new Error('Data key vanished while it was being created');
    return this.#unwrap(ctx, theirs);
  }

  #unwrap(
    ctx: TenantContext,
    row: { version: string; kek_version: string; wrapped_key: Buffer },
  ): DataKey {
    return unwrapDataKey(this.#keyring, {
      workspaceId: ctx.workspaceId,
      version: Number(row.version),
      kekVersion: Number(row.kek_version),
      wrapped: row.wrapped_key,
    });
  }

  #aad(ctx: TenantContext, rowId: string): FieldAad {
    return { workspaceId: ctx.workspaceId, table: TABLE, column: COLUMN, rowId };
  }
}

/** Refuses kinds outside CREDENTIAL_KINDS, for callers that bypass the type (F-M01-halfway-05). */
function assertKnownKind(kind: string): void {
  if (!KNOWN_KINDS.has(kind)) throw new Error(`Unknown credential kind ${kind}`);
}

/** PostgreSQL unique_violation (23505), as raised through pg. */
function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && err.code === '23505';
}

/** The stored credential of each provider: a refresh token (OAuth) or an API key. */
export const CREDENTIAL_KIND_BY_PROVIDER = {
  amazon: 'amazon.refresh_token',
  amazon_ads: 'ads.refresh_token',
  ebay: 'ebay.refresh_token',
  website: 'website.api_key',
  evri: 'evri.api_key',
  dpd: 'dpd.api_key',
} as const satisfies Readonly<Record<string, CredentialKind>>;

/** AMZ-8: a re-authorisation keeps the old refresh token, inactive, for 7 days. */
const REAUTH_RETAIN_MS = 7 * 86_400_000;

/**
 * Per-account provider tokens (INT-3) as provider code uses them: one call per read or write,
 * each in the caller's tenant context. Values stay `Secret` and are never logged or returned.
 */
export class AccountCredentials {
  readonly #db: Kysely<MainDb>;
  readonly #repo: CredentialRepository;

  constructor(db: Kysely<MainDb>, repo: CredentialRepository) {
    this.#db = db;
    this.#repo = repo;
  }

  read(
    ctx: TenantContext,
    channelAccountId: string,
    provider: keyof typeof CREDENTIAL_KIND_BY_PROVIDER,
  ): Promise<Secret | undefined> {
    return withTenantTransaction(this.#db, ctx, (trx) =>
      this.#repo.get(trx, ctx, { kind: CREDENTIAL_KIND_BY_PROVIDER[provider], channelAccountId }),
    );
  }

  /** Another credential of the account than its provider token (the website signing secret). */
  readKind(
    ctx: TenantContext,
    channelAccountId: string,
    kind: CredentialKind,
  ): Promise<Secret | undefined> {
    return withTenantTransaction(this.#db, ctx, (trx) =>
      this.#repo.get(trx, ctx, { kind, channelAccountId }),
    );
  }

  /**
   * Stores a new value of that credential as current; the old one stops at once (kept inactive
   * until the purge, never read again).
   */
  replaceKind(
    ctx: TenantContext,
    channelAccountId: string,
    kind: CredentialKind,
    value: Secret,
  ): Promise<string> {
    return withTenantTransaction(this.#db, ctx, (trx) =>
      this.#repo.replaceCurrent(trx, ctx, { kind, channelAccountId }, value, { retainOldForMs: 0 }),
    );
  }

  /**
   * Disconnect (T-1101): every credential of the account, of every kind and environment, current
   * or retired, is deleted. Returns how many rows went.
   */
  async removeAll(ctx: TenantContext, channelAccountId: string): Promise<number> {
    const result = await withTenantTransaction(this.#db, ctx, (trx) =>
      trx
        .deleteFrom('app.credentials')
        .where('workspace_id', '=', ctx.workspaceId)
        .where('channel_account_id', '=', channelAccountId)
        .executeTakeFirst(),
    );
    return Number(result.numDeletedRows);
  }

  /** Stores a new token as current (a connect or re-authorisation); the old one is retired. */
  replace(
    ctx: TenantContext,
    channelAccountId: string,
    provider: keyof typeof CREDENTIAL_KIND_BY_PROVIDER,
    value: Secret,
    expiresAt?: Date,
  ): Promise<string> {
    return withTenantTransaction(this.#db, ctx, (trx) =>
      this.#repo.replaceCurrent(
        trx,
        ctx,
        { kind: CREDENTIAL_KIND_BY_PROVIDER[provider], channelAccountId },
        value,
        { retainOldForMs: REAUTH_RETAIN_MS, ...(expiresAt === undefined ? {} : { expiresAt }) },
      ),
    );
  }
}
