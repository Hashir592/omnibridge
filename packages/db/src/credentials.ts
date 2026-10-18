import { randomUUID } from 'node:crypto';
import type { TenantContext } from '@omnibridge/core';
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
import type { ExpressionBuilder, Kysely } from 'kysely';
import type { CredentialsTable, MainDb } from './schema.ts';

export type CredentialSlot = CredentialsTable['slot'];

/** Which credential: its kind (for example `amazon.refresh_token`) and, if it has one, its account. */
export interface CredentialRef {
  readonly kind: string;
  readonly channelAccountId?: string | null;
}

export interface CredentialRepositoryOptions {
  /** The secrets master key (never the PII one). */
  readonly keyring: Keyring;
  readonly logger: Logger;
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

  constructor(options: CredentialRepositoryOptions) {
    if (options.keyring.purpose !== 'secrets') {
      throw new Error('The credential store uses the secrets master key only');
    }
    this.#keyring = options.keyring;
    this.#log = options.logger.child({ component: 'credentials' });
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
    if ((await this.#activeRow(db, ctx, ref, slot)) !== undefined) {
      throw new Error(`An active ${slot} credential of kind ${ref.kind} already exists`);
    }
    return this.#insert(db, ctx, ref, slot, value, options.expiresAt ?? null);
  }

  /** The active value in a slot, or undefined. */
  async get(
    db: Kysely<MainDb>,
    ctx: TenantContext,
    ref: CredentialRef,
    slot: CredentialSlot = 'current',
  ): Promise<Secret | undefined> {
    const row = await this.#activeRow(db, ctx, ref, slot);
    if (row === undefined) return undefined;
    const dataKey = await this.#dataKey(db, ctx, Number(row.key_version));
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
    await this.#retireCurrent(db, ctx, ref, options.retainOldForMs);
    return this.#insert(db, ctx, ref, 'current', value, options.expiresAt ?? null);
  }

  /** Hard-deletes inactive credentials whose retention has ended. Returns how many. */
  async purgeExpired(db: Kysely<MainDb>, ctx: TenantContext, now = new Date()): Promise<number> {
    const result = await db
      .deleteFrom(TABLE)
      .where('workspace_id', '=', ctx.workspaceId)
      .where('is_active', '=', false)
      .where('expires_at', '<=', now)
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
   */
  async rewrapDataKeys(db: Kysely<MainDb>, ctx: TenantContext): Promise<number> {
    const stale = await db
      .selectFrom('app.data_keys')
      .select(['version', 'kek_version', 'wrapped_key'])
      .where('workspace_id', '=', ctx.workspaceId)
      .where('kek_version', '<>', String(this.#keyring.activeVersion))
      .forUpdate()
      .execute();
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
      .set({ is_active: false, rotated_at: now, expires_at: new Date(now.getTime() + retainForMs) })
      .execute();
  }

  #activeRow(db: Kysely<MainDb>, ctx: TenantContext, ref: CredentialRef, slot: CredentialSlot) {
    return db
      .selectFrom(TABLE)
      .where(this.#slot(ctx, ref, slot))
      .select(['id', 'key_version', 'encrypted_value'])
      .executeTakeFirst();
  }

  /** Filter for the active row of one slot of one credential, shared by select and update. */
  #slot(ctx: TenantContext, ref: CredentialRef, slot: CredentialSlot) {
    return (eb: ExpressionBuilder<MainDb, typeof TABLE>) =>
      eb.and([
        eb('workspace_id', '=', ctx.workspaceId),
        eb('kind', '=', ref.kind),
        eb('channel_account_id', 'is not distinct from', ref.channelAccountId ?? null),
        eb('slot', '=', slot),
        eb('is_active', '=', true),
      ]);
  }

  /** The newest data key of the workspace, created on first use. */
  async #activeDataKey(db: Kysely<MainDb>, ctx: TenantContext): Promise<DataKey> {
    const newest = await db
      .selectFrom('app.data_keys')
      .select('version')
      .where('workspace_id', '=', ctx.workspaceId)
      .orderBy('version', 'desc')
      .limit(1)
      .executeTakeFirst();
    if (newest !== undefined) return this.#dataKey(db, ctx, Number(newest.version));

    const { wrapped } = generateDataKey(this.#keyring, ctx.workspaceId, 1);
    await db
      .insertInto('app.data_keys')
      .values({
        workspace_id: ctx.workspaceId,
        version: wrapped.version,
        kek_version: wrapped.kekVersion,
        wrapped_key: wrapped.wrapped,
      })
      .onConflict((oc) => oc.columns(['workspace_id', 'version']).doNothing())
      .execute();
    // Re-read, so a key created by a concurrent transaction wins over ours.
    return this.#dataKey(db, ctx, 1);
  }

  async #dataKey(db: Kysely<MainDb>, ctx: TenantContext, version: number): Promise<DataKey> {
    const row = await db
      .selectFrom('app.data_keys')
      .select(['version', 'kek_version', 'wrapped_key'])
      .where('workspace_id', '=', ctx.workspaceId)
      .where('version', '=', String(version))
      .executeTakeFirstOrThrow(
        () => new Error(`Data key version ${String(version)} is missing for this workspace`),
      );
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
