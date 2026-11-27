import type { TenantContext } from '@omnibridge/core';
import { sql, type Kysely } from 'kysely';
import type { MainDb } from './schema.ts';
import { withTenantTransaction } from './tenant.ts';

/*
 * M11 website connector in db-main (T-1101: WEB-1, WEB-2, AT-14). A Website account's settings and
 * the SHA-256 of its inbound key (db-main 0061); the key itself is never stored. The inbound lookup
 * runs before any tenant context, through one definer function that answers the one connection a
 * call names. Remembered answers hold a request hash and IDs only (invariant 7a).
 */

export interface WebsiteSettingsRow {
  channelAccountId: string;
  companyId: string;
  baseUrl: string;
  inboundKeyHint: string;
  keysIssuedAt: Date;
}

/** What a website call's connection ID resolves to, before its key and signature are checked. */
export interface WebsiteInbound {
  workspaceId: string;
  companyId: string;
  /** SHA-256 of the inbound key; compared in constant time by the caller. */
  keyHash: Buffer;
  /** The workspace's `website_connector` module (ADR-059). */
  moduleOn: boolean;
}

/** WEB-2: the answer given for one idempotency key, kept as given. */
export interface RememberedAnswer {
  route: string;
  requestHash: Buffer;
  status: number;
  /** IDs and counts only. */
  response: Readonly<Record<string, unknown>>;
}

export class WebsiteConnectionRepository {
  readonly #db: Kysely<MainDb>;
  readonly #now: () => Date;

  constructor(db: Kysely<MainDb>, options: { now?: () => Date } = {}) {
    this.#db = db;
    this.#now = options.now ?? (() => new Date());
  }

  /** WEB-1: the settings of a Website account just created (in the caller's transaction). */
  async create(
    ctx: TenantContext,
    input: {
      channelAccountId: string;
      companyId: string;
      baseUrl: string;
      keyHash: Buffer;
      keyHint: string;
    },
  ): Promise<void> {
    const now = this.#now();
    await withTenantTransaction(this.#db, ctx, (trx) =>
      sql`
        INSERT INTO app.website_connections (workspace_id, channel_account_id, company_id, base_url,
                                             inbound_key_hash, inbound_key_hint, keys_issued_at,
                                             created_at)
        VALUES (${ctx.workspaceId}::uuid, ${input.channelAccountId}::uuid,
                ${input.companyId}::uuid, ${input.baseUrl}, ${input.keyHash}, ${input.keyHint},
                ${now}, ${now})`.execute(trx),
    );
  }

  /** The account's settings, under the caller's company scope; undefined when not a website. */
  async settings(
    ctx: TenantContext,
    channelAccountId: string,
  ): Promise<WebsiteSettingsRow | undefined> {
    const { rows } = await withTenantTransaction(this.#db, ctx, (trx) =>
      sql<{
        channel_account_id: string;
        company_id: string;
        base_url: string;
        inbound_key_hint: string;
        keys_issued_at: Date;
      }>`
        SELECT channel_account_id, company_id, base_url, inbound_key_hint, keys_issued_at
          FROM app.website_connections
         WHERE workspace_id = ${ctx.workspaceId}::uuid
           AND channel_account_id = ${channelAccountId}::uuid`.execute(trx),
    );
    const r = rows[0];
    return r === undefined
      ? undefined
      : {
          channelAccountId: r.channel_account_id,
          companyId: r.company_id,
          baseUrl: r.base_url,
          inboundKeyHint: r.inbound_key_hint,
          keysIssuedAt: r.keys_issued_at,
        };
  }

  async setBaseUrl(
    ctx: TenantContext,
    channelAccountId: string,
    baseUrl: string,
  ): Promise<boolean> {
    const result = await withTenantTransaction(this.#db, ctx, (trx) =>
      sql`UPDATE app.website_connections SET base_url = ${baseUrl}
           WHERE workspace_id = ${ctx.workspaceId}::uuid
             AND channel_account_id = ${channelAccountId}::uuid`.execute(trx),
    );
    return (result.numAffectedRows ?? 0n) > 0n;
  }

  /** New inbound key (its hash and hint): the old one stops working with this commit. */
  async setKeys(
    ctx: TenantContext,
    channelAccountId: string,
    keys: { keyHash: Buffer; keyHint: string },
  ): Promise<boolean> {
    const result = await withTenantTransaction(this.#db, ctx, (trx) =>
      sql`UPDATE app.website_connections
             SET inbound_key_hash = ${keys.keyHash}, inbound_key_hint = ${keys.keyHint},
                 keys_issued_at = ${this.#now()}
           WHERE workspace_id = ${ctx.workspaceId}::uuid
             AND channel_account_id = ${channelAccountId}::uuid`.execute(trx),
    );
    return (result.numAffectedRows ?? 0n) > 0n;
  }

  /**
   * WEB-2, ADR-059: the connection a website call names, before any tenant context. Undefined for
   * an unknown connection, an account that is not a website, or one that is archived.
   */
  async inbound(connectionId: string): Promise<WebsiteInbound | undefined> {
    const { rows } = await sql<{
      workspace_id: string;
      company_id: string;
      inbound_key_hash: Buffer;
      module_on: boolean;
    }>`SELECT * FROM app.website_inbound(${connectionId}::uuid)`.execute(this.#db);
    const r = rows[0];
    return r === undefined
      ? undefined
      : {
          workspaceId: r.workspace_id,
          companyId: r.company_id,
          keyHash: r.inbound_key_hash,
          moduleOn: r.module_on,
        };
  }

  /**
   * WEB-2: the answer already given for this key, if any. Takes a transaction-scoped lock on the
   * account and key first, so a second call with the same key waits for the first to commit.
   */
  async answered(
    ctx: TenantContext,
    channelAccountId: string,
    key: string,
  ): Promise<RememberedAnswer | undefined> {
    return withTenantTransaction(this.#db, ctx, async (trx) => {
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`website:${channelAccountId}:${key}`}, 0))`.execute(
        trx,
      );
      const { rows } = await sql<{
        route: string;
        request_hash: Buffer;
        status: string;
        response: Record<string, unknown>;
      }>`
        SELECT route, request_hash, status, response FROM app.website_idempotency
         WHERE workspace_id = ${ctx.workspaceId}::uuid
           AND channel_account_id = ${channelAccountId}::uuid
           AND idempotency_key = ${key}`.execute(trx);
      const r = rows[0];
      return r === undefined
        ? undefined
        : {
            route: r.route,
            requestHash: r.request_hash,
            status: Number(r.status),
            response: r.response,
          };
    });
  }

  /** Keeps the answer given for this key (in the caller's transaction, with its work). */
  async remember(
    ctx: TenantContext,
    input: { channelAccountId: string; companyId: string; key: string } & RememberedAnswer,
  ): Promise<void> {
    await withTenantTransaction(this.#db, ctx, (trx) =>
      sql`
        INSERT INTO app.website_idempotency (workspace_id, channel_account_id, company_id,
                                             idempotency_key, route, request_hash, status,
                                             response, created_at)
        VALUES (${ctx.workspaceId}::uuid, ${input.channelAccountId}::uuid,
                ${input.companyId}::uuid, ${input.key}, ${input.route}, ${input.requestHash},
                ${input.status}, ${JSON.stringify(input.response)}::jsonb, ${this.#now()})`.execute(
        trx,
      ),
    );
  }
}
