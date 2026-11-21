import { randomUUID } from 'node:crypto';
import type { Pence, TenantContext } from '@omnibridge/core';
import { pence } from '@omnibridge/core';
import { type Kysely, sql, type Transaction, type Updateable } from 'kysely';
import { pgCode } from './errors.ts';
import type { ListingProvider, MainDb, MasterSkusTable, VatType } from './schema.ts';
import { withTenantTransaction } from './tenant.ts';

/** A calendar day, 'YYYY-MM-DD' (Europe/London dates are worked out by the caller). */
export type Day = string;

export type CatalogueRefusal =
  | 'sku_taken'
  | 'component_not_found'
  | 'component_is_bundle'
  | 'bundle_locked'
  | 'vat_type_required'
  | 'already_mapped'
  | 'not_found';

/** A catalogue rule refused the change (CAT-1, CAT-3, CAT-5). Web answers 409 (404 for not_found). */
export class CatalogueRefused extends Error {
  readonly code: CatalogueRefusal;

  constructor(code: CatalogueRefusal) {
    super(`Catalogue change refused: ${code}`);
    this.name = 'CatalogueRefused';
    this.code = code;
  }
}

export interface Dimensions {
  lengthMm: number;
  widthMm: number;
  heightMm: number;
}

export interface ReorderSettings {
  leadTimeDays: number;
  safetyDays: number;
  targetCoverDays: number;
}

export interface BundleRef {
  componentId: string;
  componentSku: string;
  packSize: number;
}

export interface SkuSummary {
  id: string;
  sku: string;
  title: string;
  /** In force today; a bundle's is its component's (CAT-3). */
  vatType: VatType;
  /** In force today; a bundle's is its component's times the pack size. Null when none is set. */
  cogsPence: Pence | null;
  active: boolean;
  bundle: BundleRef | null;
  listingCount: number;
  updatedAt: Date;
}

export interface SkuListingRef {
  id: string;
  channelAccountId: string;
  provider: ListingProvider;
  externalSku: string;
  externalId: string;
  title: string | null;
}

export interface CogsEntry {
  cogsPence: Pence;
  effectiveFrom: Day;
  createdAt: Date;
}

export interface VatTypeEntry {
  vatType: VatType;
  effectiveFrom: Day;
}

export interface SkuDetail extends SkuSummary {
  shortDescription: string;
  barcode: string | null;
  manufacturer: string | null;
  weightG: number;
  dimensions: Dimensions | null;
  imageUrl: string | null;
  purchaseVatRateBp: number | null;
  reorder: ReorderSettings;
  /** Newest first. A bundle shows its component's. */
  vatHistory: VatTypeEntry[];
  /** Newest first. Empty for a bundle (its COGS is derived). */
  cogsHistory: CogsEntry[];
  listings: SkuListingRef[];
  createdAt: Date;
}

export interface SkuFields {
  title: string;
  shortDescription: string;
  barcode?: string | null;
  manufacturer?: string | null;
  weightG: number;
  dimensions?: Dimensions | null;
  imageUrl?: string | null;
  active?: boolean;
  reorder?: ReorderSettings;
  purchaseVatRateBp?: number | null;
}

export interface NewSku extends SkuFields {
  /** Chosen by the caller only for seed data with fixed ids. */
  id?: string;
  sku: string;
  /** Required for a plain SKU; refused for a bundle, which follows its component. */
  vatType?: VatType;
  firstCogs?: { cogsPence: Pence; effectiveFrom: Day };
  bundle?: { componentId: string; packSize: number };
}

export type SkuPatch = Partial<SkuFields> & {
  vat?: { vatType: VatType; effectiveFrom: Day };
};

export interface SkuFilter {
  q?: string;
  active?: boolean;
  bundles?: boolean;
  offset: number;
  limit: number;
}

export interface VatRateRow {
  vatType: VatType;
  rateBp: number;
  effectiveFrom: Day;
}

export interface Listing {
  id: string;
  channelAccountId: string;
  provider: ListingProvider;
  externalSku: string;
  externalId: string;
  title: string | null;
  fulfilment: 'mfn' | 'fba' | null;
  inventoryApi: boolean | null;
  masterSku: { id: string; sku: string } | null;
  mappingSource: 'auto' | 'manual' | null;
  mappedAt: Date | null;
  discoveredAt: Date;
  endedAt: Date | null;
}

export interface ListingFilter {
  mapped?: boolean;
  channelAccountId?: string;
  q?: string;
  offset: number;
  limit: number;
}

/** One listing as a channel reports it at discovery (CAT-5). */
export interface DiscoveredListing {
  externalSku: string;
  externalId: string;
  title: string | null;
  fulfilment: 'mfn' | 'fba' | null;
  inventoryApi: boolean | null;
  quantity: number | null;
}

/** A map, remap or unmap: what M09 (stock back-fill) and M10 (snapshots) react to (CAT-6). */
export interface MappingChange {
  listingId: string;
  masterSkuId: string | null;
  previousMasterSkuId: string | null;
}

/** A listing export row, for the mapping CSV (CAT-5). */
export interface ListingExportRow {
  id: string;
  accountName: string | null;
  provider: ListingProvider;
  externalSku: string;
  externalId: string;
  title: string | null;
  sku: string | null;
}

const num = (value: string | number): number => Number(value);
const numOrNull = (value: string | number | null): number | null =>
  value === null ? null : Number(value);

const isUniqueViolation = (err: unknown): boolean => pgCode(err) === '23505';
const constraintOf = (err: unknown): string | undefined =>
  typeof err === 'object' &&
  err !== null &&
  'constraint' in err &&
  typeof err.constraint === 'string'
    ? err.constraint
    : undefined;

/** The catalogue triggers' own SQLSTATE (migration 0042). */
const isCatalogueRule = (err: unknown): boolean => pgCode(err) === 'OBK01';

interface SkuRow {
  id: string;
  sku: string;
  title: string;
  active: boolean;
  bundle_component_id: string | null;
  component_sku: string | null;
  pack_size: string | null;
  vat_type: VatType | null;
  cogs_pence: string | null;
  listing_count: string;
  updated_at: Date;
}

function toSummary(row: SkuRow): SkuSummary {
  const bundle =
    row.bundle_component_id === null
      ? null
      : {
          componentId: row.bundle_component_id,
          componentSku: row.component_sku ?? '',
          packSize: num(row.pack_size ?? 0),
        };
  return {
    id: row.id,
    sku: row.sku,
    title: row.title,
    // A SKU created before any VAT history is impossible (create writes one); 'standard' only
    // guards a row whose history starts in the future.
    vatType: row.vat_type ?? 'standard',
    cogsPence: row.cogs_pence === null ? null : pence(BigInt(row.cogs_pence)),
    active: row.active,
    bundle,
    listingCount: num(row.listing_count),
    updatedAt: row.updated_at,
  };
}

/**
 * The catalogue (CAT-1 to CAT-6): Master SKUs, bundles, VAT types and rates, COGS with history,
 * and channel listings with their mapping. Workspace-shared (ARCHITECTURE 6.1). Every call takes
 * a TenantContext and joins the request's or job's transaction when there is one.
 */
export class CatalogueRepository {
  readonly #db: Kysely<MainDb>;

  constructor(db: Kysely<MainDb>) {
    this.#db = db;
  }

  // ---- Lookups for M10's write-once snapshots (ADR-078 4) --------------------------------------

  /** CAT-4: the COGS in effect on `day`; a bundle's is its component's times the pack size. */
  async cogsOn(ctx: TenantContext, skuId: string, day: Day): Promise<Pence | undefined> {
    return withTenantTransaction(this.#db, ctx, async (trx) => {
      const { rows } = await sql<{ cogs: string | null }>`
        SELECT (SELECT c.cogs_pence FROM app.cogs_history c
                 WHERE c.workspace_id = s.workspace_id
                   AND c.master_sku_id = coalesce(s.bundle_component_id, s.id)
                   AND c.effective_from <= ${day}::date
                 ORDER BY c.effective_from DESC LIMIT 1) * coalesce(s.pack_size, 1) AS cogs
          FROM app.master_skus s
         WHERE s.workspace_id = ${ctx.workspaceId}::uuid AND s.id = ${skuId}::uuid`.execute(trx);
      const cogs = rows[0]?.cogs;
      return cogs === null || cogs === undefined ? undefined : pence(BigInt(cogs));
    });
  }

  /** CAT-2: the VAT type in effect on `day`; a bundle follows its component (CAT-3). */
  async vatTypeOn(ctx: TenantContext, skuId: string, day: Day): Promise<VatType | undefined> {
    return withTenantTransaction(this.#db, ctx, async (trx) => {
      const { rows } = await sql<{ vat_type: VatType | null }>`
        SELECT (SELECT v.vat_type FROM app.sku_vat_types v
                 WHERE v.workspace_id = s.workspace_id
                   AND v.master_sku_id = coalesce(s.bundle_component_id, s.id)
                   AND v.effective_from <= ${day}::date
                 ORDER BY v.effective_from DESC LIMIT 1) AS vat_type
          FROM app.master_skus s
         WHERE s.workspace_id = ${ctx.workspaceId}::uuid AND s.id = ${skuId}::uuid`.execute(trx);
      return rows[0]?.vat_type ?? undefined;
    });
  }

  /** CAT-2: the workspace's rate for a VAT type on `day`, in basis points. */
  async vatRateOn(ctx: TenantContext, vatType: VatType, day: Day): Promise<number | undefined> {
    const row = await withTenantTransaction(this.#db, ctx, (trx) =>
      trx
        .selectFrom('app.vat_rates')
        .select('rate_bp')
        .where('workspace_id', '=', ctx.workspaceId)
        .where('vat_type', '=', vatType)
        .where('effective_from', '<=', sql<Date>`${day}::date`)
        .orderBy('effective_from', 'desc')
        .limit(1)
        .executeTakeFirst(),
    );
    return row === undefined ? undefined : num(row.rate_bp);
  }

  // ---- Master SKUs (CAT-1, CAT-3) ---------------------------------------------------------------

  async listSkus(
    ctx: TenantContext,
    filter: SkuFilter,
    today: Day,
    countUpTo: number,
  ): Promise<{ items: SkuSummary[]; total: number }> {
    return withTenantTransaction(this.#db, ctx, async (trx) => {
      const where = sql.join(
        [
          sql`s.workspace_id = ${ctx.workspaceId}::uuid`,
          ...(filter.q === undefined
            ? []
            : [
                sql`(s.sku ILIKE ${likeOf(filter.q)} OR s.title ILIKE ${likeOf(filter.q)}
                     OR s.barcode = ${filter.q})`,
              ]),
          ...(filter.active === undefined ? [] : [sql`s.active = ${filter.active}`]),
          ...(filter.bundles === undefined
            ? []
            : [
                filter.bundles
                  ? sql`s.bundle_component_id IS NOT NULL`
                  : sql`s.bundle_component_id IS NULL`,
              ]),
        ],
        sql` AND `,
      );
      const { rows } = await sql<SkuRow>`
        ${summarySelect(today)}
         WHERE ${where}
         ORDER BY s.sku
         LIMIT ${filter.limit} OFFSET ${filter.offset}`.execute(trx);
      const count = await sql<{ n: string }>`
        SELECT count(*) AS n FROM (SELECT 1 FROM app.master_skus s WHERE ${where}
                                   LIMIT ${countUpTo}) t`.execute(trx);
      return { items: rows.map(toSummary), total: num(count.rows[0]?.n ?? 0) };
    });
  }

  async getSku(ctx: TenantContext, id: string, today: Day): Promise<SkuDetail | undefined> {
    return withTenantTransaction(this.#db, ctx, (trx) => this.#detail(trx, ctx, id, today));
  }

  /** Several SKUs by code (exact), for the CSV imports. */
  async skusByCode(
    ctx: TenantContext,
    codes: readonly string[],
  ): Promise<Map<string, { id: string; bundle: boolean }>> {
    if (codes.length === 0) return new Map();
    const rows = await withTenantTransaction(this.#db, ctx, (trx) =>
      trx
        .selectFrom('app.master_skus')
        .select(['id', 'sku', 'bundle_component_id'])
        .where('workspace_id', '=', ctx.workspaceId)
        .where('sku', 'in', [...new Set(codes)])
        .execute(),
    );
    return new Map(
      rows.map((r) => [r.sku, { id: r.id, bundle: r.bundle_component_id !== null }] as const),
    );
  }

  /**
   * Creates a plain SKU (with its first VAT type and optional first COGS) or a bundle (CAT-3).
   * Refuses a taken code, a missing or bundle component, and a VAT type or COGS on a bundle.
   */
  async createSku(
    ctx: TenantContext,
    input: NewSku,
    userId: string | null,
    now: Date,
  ): Promise<string> {
    if (input.bundle === undefined && input.vatType === undefined) {
      throw new CatalogueRefused('vat_type_required');
    }
    if (input.bundle !== undefined && (input.vatType !== undefined || input.firstCogs)) {
      throw new CatalogueRefused('bundle_locked');
    }
    const id = input.id ?? randomUUID();
    const today = input.firstCogs?.effectiveFrom;
    return this.#write(ctx, async (trx) => {
      if (input.bundle !== undefined) {
        const component = await trx
          .selectFrom('app.master_skus')
          .select(['bundle_component_id'])
          .where('workspace_id', '=', ctx.workspaceId)
          .where('id', '=', input.bundle.componentId)
          .executeTakeFirst();
        if (component === undefined) throw new CatalogueRefused('component_not_found');
        if (component.bundle_component_id !== null) {
          throw new CatalogueRefused('component_is_bundle');
        }
      }
      await trx
        .insertInto('app.master_skus')
        .values({
          ...fieldValues(input),
          workspace_id: ctx.workspaceId,
          id,
          sku: input.sku,
          title: input.title,
          short_description: input.shortDescription,
          bundle_component_id: input.bundle?.componentId ?? null,
          pack_size: input.bundle?.packSize ?? null,
          created_by: userId,
          created_at: now,
          updated_at: now,
        })
        .execute();
      if (input.vatType !== undefined) {
        await trx
          .insertInto('app.sku_vat_types')
          .values({
            workspace_id: ctx.workspaceId,
            master_sku_id: id,
            vat_type: input.vatType,
            // The first type holds from the beginning, so any order date finds it.
            effective_from: '1973-04-01',
            created_by: userId,
            created_at: now,
          })
          .execute();
      }
      if (input.firstCogs !== undefined && today !== undefined) {
        await insertCogs(trx, ctx, id, input.firstCogs.cogsPence, today, userId, now);
      }
      return id;
    });
  }

  /**
   * Edits a SKU's fields. `vat` adds a VAT-type history row from its date (ADR-078 4), refused on
   * a bundle. Returns the summary before and after, for the audit log.
   */
  async updateSku(
    ctx: TenantContext,
    id: string,
    patch: SkuPatch,
    userId: string | null,
    now: Date,
  ): Promise<{ bundle: boolean; vatChanged: boolean } | undefined> {
    return this.#write(ctx, async (trx) => {
      const current = await trx
        .selectFrom('app.master_skus')
        .select(['bundle_component_id'])
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst();
      if (current === undefined) return undefined;
      const bundle = current.bundle_component_id !== null;
      if (patch.vat !== undefined && bundle) throw new CatalogueRefused('bundle_locked');
      await trx
        .updateTable('app.master_skus')
        .set({ ...fieldValues(patch), updated_at: now })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', id)
        .execute();
      if (patch.vat !== undefined) {
        await trx
          .insertInto('app.sku_vat_types')
          .values({
            workspace_id: ctx.workspaceId,
            master_sku_id: id,
            vat_type: patch.vat.vatType,
            effective_from: patch.vat.effectiveFrom,
            created_by: userId,
            created_at: now,
          })
          .onConflict((oc) =>
            oc
              .columns(['workspace_id', 'master_sku_id', 'effective_from'])
              .doUpdateSet({ vat_type: patch.vat?.vatType ?? 'standard', created_by: userId }),
          )
          .execute();
      }
      return { bundle, vatChanged: patch.vat !== undefined };
    });
  }

  /** CAT-1: manufacturers already used, for the dropdown. */
  async manufacturers(ctx: TenantContext): Promise<string[]> {
    const rows = await withTenantTransaction(this.#db, ctx, (trx) =>
      trx
        .selectFrom('app.master_skus')
        .select('manufacturer')
        .distinct()
        .where('workspace_id', '=', ctx.workspaceId)
        .where('manufacturer', 'is not', null)
        .orderBy('manufacturer')
        .limit(1000)
        .execute(),
    );
    return rows.flatMap((r) => (r.manufacturer === null ? [] : [r.manufacturer]));
  }

  // ---- VAT rates (CAT-2) -----------------------------------------------------------------------

  async vatRates(ctx: TenantContext): Promise<VatRateRow[]> {
    const rows = await withTenantTransaction(this.#db, ctx, (trx) =>
      trx
        .selectFrom('app.vat_rates')
        .select(['vat_type', 'rate_bp', dayOf('effective_from')])
        .where('workspace_id', '=', ctx.workspaceId)
        .orderBy('vat_type')
        .orderBy('effective_from', 'desc')
        .execute(),
    );
    return rows.map((r) => ({
      vatType: r.vat_type,
      rateBp: num(r.rate_bp),
      effectiveFrom: r.effective_from,
    }));
  }

  /** A new rate from a date. Refuses a second rate for the same type and day. */
  async addVatRate(ctx: TenantContext, rate: VatRateRow, now: Date): Promise<boolean> {
    try {
      await withTenantTransaction(this.#db, ctx, (trx) =>
        trx
          .insertInto('app.vat_rates')
          .values({
            workspace_id: ctx.workspaceId,
            vat_type: rate.vatType,
            rate_bp: rate.rateBp,
            effective_from: rate.effectiveFrom,
            created_at: now,
          })
          .execute(),
      );
      return true;
    } catch (err) {
      if (isUniqueViolation(err)) return false;
      throw err;
    }
  }

  // ---- COGS (CAT-4) ----------------------------------------------------------------------------

  /** Newest first. Undefined when the SKU does not exist; empty for a bundle. */
  async cogsHistory(ctx: TenantContext, skuId: string): Promise<CogsEntry[] | undefined> {
    return withTenantTransaction(this.#db, ctx, async (trx) => {
      const sku = await trx
        .selectFrom('app.master_skus')
        .select('id')
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', skuId)
        .executeTakeFirst();
      if (sku === undefined) return undefined;
      return cogsRows(trx, ctx, skuId);
    });
  }

  /**
   * Sets the COGS from a day; the same day again replaces it (CAT-4). Refused on a bundle, whose
   * COGS is its component's times the pack size. Undefined when the SKU does not exist.
   */
  async setCogs(
    ctx: TenantContext,
    skuId: string,
    cogsPence: Pence,
    effectiveFrom: Day,
    userId: string | null,
    now: Date,
  ): Promise<CogsEntry | undefined> {
    return this.#write(ctx, async (trx) => {
      const sku = await trx
        .selectFrom('app.master_skus')
        .select('bundle_component_id')
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', skuId)
        .executeTakeFirst();
      if (sku === undefined) return undefined;
      if (sku.bundle_component_id !== null) throw new CatalogueRefused('bundle_locked');
      await insertCogs(trx, ctx, skuId, cogsPence, effectiveFrom, userId, now);
      return { cogsPence, effectiveFrom, createdAt: now };
    });
  }

  // ---- Listings and mapping (CAT-5, CAT-6) -----------------------------------------------------

  async listListings(
    ctx: TenantContext,
    filter: ListingFilter,
    countUpTo: number,
  ): Promise<{ items: Listing[]; total: number }> {
    return withTenantTransaction(this.#db, ctx, async (trx) => {
      const where = sql.join(
        [
          sql`l.workspace_id = ${ctx.workspaceId}::uuid`,
          ...(filter.mapped === undefined
            ? []
            : [
                filter.mapped
                  ? sql`l.master_sku_id IS NOT NULL AND l.ended_at IS NULL`
                  : sql`l.master_sku_id IS NULL AND l.ended_at IS NULL`,
              ]),
          ...(filter.channelAccountId === undefined
            ? []
            : [sql`l.channel_account_id = ${filter.channelAccountId}::uuid`]),
          ...(filter.q === undefined
            ? []
            : [
                sql`(l.external_sku ILIKE ${likeOf(filter.q)} OR l.title ILIKE ${likeOf(filter.q)}
                     OR l.external_id = ${filter.q})`,
              ]),
        ],
        sql` AND `,
      );
      const { rows } = await sql<ListingRow>`
        ${listingSelect()}
         WHERE ${where}
         ORDER BY l.discovered_at DESC, l.id
         LIMIT ${filter.limit} OFFSET ${filter.offset}`.execute(trx);
      const count = await sql<{ n: string }>`
        SELECT count(*) AS n FROM (SELECT 1 FROM app.listings l WHERE ${where}
                                   LIMIT ${countUpTo}) t`.execute(trx);
      return { items: rows.map(toListing), total: num(count.rows[0]?.n ?? 0) };
    });
  }

  async getListing(ctx: TenantContext, id: string): Promise<Listing | undefined> {
    return withTenantTransaction(this.#db, ctx, async (trx) => {
      const { rows } = await sql<ListingRow>`
        ${listingSelect()}
         WHERE l.workspace_id = ${ctx.workspaceId}::uuid AND l.id = ${id}::uuid`.execute(trx);
      const row = rows[0];
      return row === undefined ? undefined : toListing(row);
    });
  }

  /**
   * Maps a listing to one SKU (CAT-5). Mapping it to the SKU it already has is a no-op (null);
   * mapping a listing that has another SKU is refused: unmap it first. Returns the change for
   * the CAT-6 mapped event.
   */
  async mapListing(
    ctx: TenantContext,
    listingId: string,
    skuId: string,
    source: 'auto' | 'manual',
    userId: string | null,
    now: Date,
  ): Promise<MappingChange | null> {
    return this.#write(ctx, async (trx) => {
      const listing = await lockListing(trx, ctx, listingId);
      if (listing === undefined) throw new CatalogueRefused('not_found');
      const sku = await trx
        .selectFrom('app.master_skus')
        .select('id')
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', skuId)
        .executeTakeFirst();
      if (sku === undefined) throw new CatalogueRefused('not_found');
      if (listing.master_sku_id === skuId) return null;
      if (listing.master_sku_id !== null) throw new CatalogueRefused('already_mapped');
      await trx
        .updateTable('app.listings')
        .set({
          master_sku_id: skuId,
          mapping_source: source,
          mapped_at: now,
          mapped_by: userId,
          updated_at: now,
        })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', listingId)
        .execute();
      return { listingId, masterSkuId: skuId, previousMasterSkuId: null };
    });
  }

  /** Unmaps a listing: back to the queue, no stock writes (CAT-5). Null when it was not mapped. */
  async unmapListing(
    ctx: TenantContext,
    listingId: string,
    now: Date,
  ): Promise<MappingChange | null> {
    return this.#write(ctx, async (trx) => {
      const listing = await lockListing(trx, ctx, listingId);
      if (listing === undefined) throw new CatalogueRefused('not_found');
      if (listing.master_sku_id === null) return null;
      await trx
        .updateTable('app.listings')
        .set({
          master_sku_id: null,
          mapping_source: null,
          mapped_at: null,
          mapped_by: null,
          updated_at: now,
        })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', listingId)
        .execute();
      return { listingId, masterSkuId: null, previousMasterSkuId: listing.master_sku_id };
    });
  }

  /** Which of these listing IDs exist, with their current SKU (for the mapping import). */
  async listingsById(
    ctx: TenantContext,
    ids: readonly string[],
  ): Promise<Map<string, { masterSkuId: string | null }>> {
    if (ids.length === 0) return new Map();
    const rows = await withTenantTransaction(this.#db, ctx, (trx) =>
      trx
        .selectFrom('app.listings')
        .select(['id', 'master_sku_id'])
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', 'in', [...new Set(ids)])
        .execute(),
    );
    return new Map(rows.map((r) => [r.id, { masterSkuId: r.master_sku_id }] as const));
  }

  /**
   * Every listing for the mapping CSV export, oldest first; undefined when there are more than
   * `cap`, so the caller refuses rather than export part of the catalogue.
   */
  async exportListings(ctx: TenantContext, cap: number): Promise<ListingExportRow[] | undefined> {
    return withTenantTransaction(this.#db, ctx, async (trx) => {
      // LEFT JOIN: channel accounts are company-scoped, listings are not (ARCHITECTURE 6.1).
      const { rows } = await sql<{
        id: string;
        account_name: string | null;
        provider: ListingProvider;
        external_sku: string;
        external_id: string;
        title: string | null;
        sku: string | null;
      }>`
        SELECT l.id, a.display_name AS account_name, l.provider, l.external_sku, l.external_id,
               l.title, s.sku
          FROM app.listings l
          LEFT JOIN app.channel_accounts a
            ON a.workspace_id = l.workspace_id AND a.id = l.channel_account_id
          LEFT JOIN app.master_skus s
            ON s.workspace_id = l.workspace_id AND s.id = l.master_sku_id
         WHERE l.workspace_id = ${ctx.workspaceId}::uuid
         ORDER BY l.discovered_at, l.id
         LIMIT ${cap + 1}`.execute(trx);
      if (rows.length > cap) return undefined;
      return rows.map((r) => ({
        id: r.id,
        accountName: r.account_name,
        provider: r.provider,
        externalSku: r.external_sku,
        externalId: r.external_id,
        title: r.title,
        sku: r.sku,
      }));
    });
  }

  /**
   * Upserts one page of discovered listings by (account, external SKU) (CAT-5, INT-8). A listing
   * seen for the first time is matched to the Master SKU whose code equals its external SKU
   * exactly; a known listing keeps its mapping, so a person's unmap is never undone. Returns the
   * new auto-mappings (for the CAT-6 event).
   */
  async upsertDiscovered(
    ctx: TenantContext,
    channelAccountId: string,
    provider: ListingProvider,
    items: readonly DiscoveredListing[],
    seenAt: Date,
  ): Promise<{ created: number; skipped: number; autoMapped: MappingChange[] }> {
    if (items.length === 0) return { created: 0, skipped: 0, autoMapped: [] };
    return this.#write(ctx, async (trx) => {
      const codes = await trx
        .selectFrom('app.master_skus')
        .select(['id', 'sku'])
        .where('workspace_id', '=', ctx.workspaceId)
        .where(
          'sku',
          'in',
          items.map((i) => i.externalSku),
        )
        .execute();
      const skuByCode = new Map(codes.map((c) => [c.sku, c.id] as const));
      let created = 0;
      let skipped = 0;
      const autoMapped: MappingChange[] = [];
      for (const raw of items) {
        // A code longer than the column cannot be matched or written to a channel: skip it.
        if (raw.externalSku.length > 200 || raw.externalId.length > 200) {
          skipped += 1;
          continue;
        }
        // A long title is only a label: keep its start (the column holds 500).
        const item = { ...raw, title: raw.title === null ? null : raw.title.slice(0, 500) };
        const match = skuByCode.get(item.externalSku) ?? null;
        const row = await trx
          .insertInto('app.listings')
          .values({
            workspace_id: ctx.workspaceId,
            id: randomUUID(),
            origin: provider,
            channel_account_id: channelAccountId,
            provider,
            external_sku: item.externalSku,
            external_id: item.externalId,
            title: item.title,
            fulfilment: item.fulfilment,
            inventory_api: item.inventoryApi,
            channel_qty: item.quantity,
            master_sku_id: match,
            mapping_source: match === null ? null : 'auto',
            mapped_at: match === null ? null : seenAt,
            discovered_at: seenAt,
            last_seen_at: seenAt,
            updated_at: seenAt,
          })
          .onConflict((oc) =>
            oc.columns(['workspace_id', 'channel_account_id', 'external_sku']).doUpdateSet({
              external_id: item.externalId,
              title: item.title,
              fulfilment: item.fulfilment,
              inventory_api: item.inventoryApi,
              channel_qty: item.quantity,
              last_seen_at: seenAt,
              ended_at: null,
              updated_at: seenAt,
            }),
          )
          .returning(['id', 'master_sku_id', sql<boolean>`xmax = 0`.as('inserted')])
          .executeTakeFirstOrThrow();
        if (row.inserted) {
          created += 1;
          if (row.master_sku_id !== null) {
            autoMapped.push({
              listingId: row.id,
              masterSkuId: row.master_sku_id,
              previousMasterSkuId: null,
            });
          }
        }
      }
      return { created, skipped, autoMapped };
    });
  }

  /**
   * After a complete scan: listings of the account not seen since the scan began have ended
   * (CAT-5). Returns their IDs, so M09 clears their manual settings (C7.3).
   */
  async endUnseen(
    ctx: TenantContext,
    channelAccountId: string,
    scanStartedAt: Date,
    now: Date,
  ): Promise<string[]> {
    const rows = await this.#write(ctx, (trx) =>
      trx
        .updateTable('app.listings')
        .set({ ended_at: now, updated_at: now })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('channel_account_id', '=', channelAccountId)
        .where('last_seen_at', '<', scanStartedAt)
        .where('ended_at', 'is', null)
        .returning('id')
        .execute(),
    );
    return rows.map((r) => r.id);
  }

  async #detail(
    trx: Transaction<MainDb>,
    ctx: TenantContext,
    id: string,
    today: Day,
  ): Promise<SkuDetail | undefined> {
    const { rows } = await sql<
      SkuRow & {
        short_description: string;
        barcode: string | null;
        manufacturer: string | null;
        weight_g: string;
        length_mm: string | null;
        width_mm: string | null;
        height_mm: string | null;
        image_url: string | null;
        purchase_vat_rate_bp: string | null;
        lead_time_days: string;
        safety_days: string;
        target_cover_days: string;
        created_at: Date;
      }
    >`
      ${summarySelect(
        today,
        sql`, s.short_description, s.barcode, s.manufacturer, s.weight_g, s.length_mm,
             s.width_mm, s.height_mm, s.image_url, s.purchase_vat_rate_bp, s.lead_time_days,
             s.safety_days, s.target_cover_days, s.created_at`,
      )}
       WHERE s.workspace_id = ${ctx.workspaceId}::uuid AND s.id = ${id}::uuid`.execute(trx);
    const row = rows[0];
    if (row === undefined) return undefined;
    const vatSku = row.bundle_component_id ?? id;
    const vat = await trx
      .selectFrom('app.sku_vat_types')
      .select(['vat_type', dayOf('effective_from')])
      .where('workspace_id', '=', ctx.workspaceId)
      .where('master_sku_id', '=', vatSku)
      .orderBy('effective_from', 'desc')
      .execute();
    const listings = await trx
      .selectFrom('app.listings')
      .select(['id', 'channel_account_id', 'provider', 'external_sku', 'external_id', 'title'])
      .where('workspace_id', '=', ctx.workspaceId)
      .where('master_sku_id', '=', id)
      .where('ended_at', 'is', null)
      .orderBy('discovered_at')
      .execute();
    const dimensions =
      row.length_mm === null || row.width_mm === null || row.height_mm === null
        ? null
        : {
            lengthMm: num(row.length_mm),
            widthMm: num(row.width_mm),
            heightMm: num(row.height_mm),
          };
    return {
      ...toSummary(row),
      shortDescription: row.short_description,
      barcode: row.barcode,
      manufacturer: row.manufacturer,
      weightG: num(row.weight_g),
      dimensions,
      imageUrl: row.image_url,
      purchaseVatRateBp: numOrNull(row.purchase_vat_rate_bp),
      reorder: {
        leadTimeDays: num(row.lead_time_days),
        safetyDays: num(row.safety_days),
        targetCoverDays: num(row.target_cover_days),
      },
      vatHistory: vat.map((v) => ({ vatType: v.vat_type, effectiveFrom: v.effective_from })),
      cogsHistory: row.bundle_component_id === null ? await cogsRows(trx, ctx, id) : [],
      listings: listings.map((l) => ({
        id: l.id,
        channelAccountId: l.channel_account_id,
        provider: l.provider,
        externalSku: l.external_sku,
        externalId: l.external_id,
        title: l.title,
      })),
      createdAt: row.created_at,
    };
  }

  async #write<T>(ctx: TenantContext, fn: (trx: Transaction<MainDb>) => Promise<T>): Promise<T> {
    try {
      return await withTenantTransaction(this.#db, ctx, fn);
    } catch (err) {
      if (isUniqueViolation(err) && constraintOf(err) === 'master_skus_code') {
        throw new CatalogueRefused('sku_taken');
      }
      if (isCatalogueRule(err)) {
        const message = err instanceof Error ? err.message : '';
        throw new CatalogueRefused(
          message.includes('plain SKU') ? 'component_is_bundle' : 'bundle_locked',
        );
      }
      throw err;
    }
  }
}

// ---- SQL pieces ----------------------------------------------------------------------------------

/** '%text%' with LIKE's own characters escaped. */
function likeOf(text: string): string {
  return `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/** Selects a date column as 'YYYY-MM-DD' text: no time-zone shift on the way out. */
function dayOf<C extends 'effective_from'>(column: C) {
  return sql<string>`to_char(${sql.ref(column)}, 'YYYY-MM-DD')`.as(column);
}

/** The summary columns, with today's VAT type and COGS (a bundle's from its component). */
function summarySelect(today: Day, extra = sql``) {
  return sql`
    SELECT s.id, s.sku, s.title, s.active, s.bundle_component_id, c.sku AS component_sku,
           s.pack_size, s.updated_at,
           (SELECT v.vat_type FROM app.sku_vat_types v
             WHERE v.workspace_id = s.workspace_id
               AND v.master_sku_id = coalesce(s.bundle_component_id, s.id)
               AND v.effective_from <= ${today}::date
             ORDER BY v.effective_from DESC LIMIT 1) AS vat_type,
           (SELECT h.cogs_pence FROM app.cogs_history h
             WHERE h.workspace_id = s.workspace_id
               AND h.master_sku_id = coalesce(s.bundle_component_id, s.id)
               AND h.effective_from <= ${today}::date
             ORDER BY h.effective_from DESC LIMIT 1) * coalesce(s.pack_size, 1) AS cogs_pence,
           (SELECT count(*) FROM app.listings l
             WHERE l.workspace_id = s.workspace_id AND l.master_sku_id = s.id
               AND l.ended_at IS NULL) AS listing_count
           ${extra}
      FROM app.master_skus s
      LEFT JOIN app.master_skus c
        ON c.workspace_id = s.workspace_id AND c.id = s.bundle_component_id`;
}

interface ListingRow {
  id: string;
  channel_account_id: string;
  provider: ListingProvider;
  external_sku: string;
  external_id: string;
  title: string | null;
  fulfilment: 'mfn' | 'fba' | null;
  inventory_api: boolean | null;
  master_sku_id: string | null;
  sku: string | null;
  mapping_source: 'auto' | 'manual' | null;
  mapped_at: Date | null;
  discovered_at: Date;
  ended_at: Date | null;
}

function listingSelect() {
  return sql`
    SELECT l.id, l.channel_account_id, l.provider, l.external_sku, l.external_id, l.title,
           l.fulfilment, l.inventory_api, l.master_sku_id, s.sku, l.mapping_source, l.mapped_at,
           l.discovered_at, l.ended_at
      FROM app.listings l
      LEFT JOIN app.master_skus s ON s.workspace_id = l.workspace_id AND s.id = l.master_sku_id`;
}

function toListing(row: ListingRow): Listing {
  return {
    id: row.id,
    channelAccountId: row.channel_account_id,
    provider: row.provider,
    externalSku: row.external_sku,
    externalId: row.external_id,
    title: row.title,
    fulfilment: row.fulfilment,
    inventoryApi: row.inventory_api,
    masterSku: row.master_sku_id === null ? null : { id: row.master_sku_id, sku: row.sku ?? '' },
    mappingSource: row.mapping_source,
    mappedAt: row.mapped_at,
    discoveredAt: row.discovered_at,
    endedAt: row.ended_at,
  };
}

async function lockListing(trx: Transaction<MainDb>, ctx: TenantContext, id: string) {
  return trx
    .selectFrom('app.listings')
    .select(['id', 'master_sku_id'])
    .where('workspace_id', '=', ctx.workspaceId)
    .where('id', '=', id)
    .forUpdate()
    .executeTakeFirst();
}

async function cogsRows(
  trx: Transaction<MainDb>,
  ctx: TenantContext,
  skuId: string,
): Promise<CogsEntry[]> {
  const rows = await trx
    .selectFrom('app.cogs_history')
    .select(['cogs_pence', dayOf('effective_from'), 'created_at'])
    .where('workspace_id', '=', ctx.workspaceId)
    .where('master_sku_id', '=', skuId)
    .orderBy('effective_from', 'desc')
    .execute();
  return rows.map((r) => ({
    cogsPence: pence(BigInt(r.cogs_pence)),
    effectiveFrom: r.effective_from,
    createdAt: r.created_at,
  }));
}

async function insertCogs(
  trx: Transaction<MainDb>,
  ctx: TenantContext,
  skuId: string,
  cogsPence: Pence,
  effectiveFrom: Day,
  userId: string | null,
  now: Date,
): Promise<void> {
  // Pence fit a JS number (contract cap 100,000,000); the column is bigint (FIN-1).
  const value = Number(cogsPence);
  await trx
    .insertInto('app.cogs_history')
    .values({
      workspace_id: ctx.workspaceId,
      master_sku_id: skuId,
      effective_from: effectiveFrom,
      cogs_pence: value,
      created_by: userId,
      created_at: now,
    })
    .onConflict((oc) =>
      oc
        .columns(['workspace_id', 'master_sku_id', 'effective_from'])
        .doUpdateSet({ cogs_pence: value, created_by: userId, created_at: now }),
    )
    .execute();
}

function fieldValues(fields: Partial<SkuFields>): Updateable<MasterSkusTable> {
  const out: Updateable<MasterSkusTable> = {};
  if (fields.title !== undefined) out.title = fields.title;
  if (fields.shortDescription !== undefined) out.short_description = fields.shortDescription;
  if (fields.barcode !== undefined) out.barcode = fields.barcode;
  if (fields.manufacturer !== undefined) out.manufacturer = fields.manufacturer;
  if (fields.weightG !== undefined) out.weight_g = fields.weightG;
  if (fields.dimensions !== undefined) {
    out.length_mm = fields.dimensions?.lengthMm ?? null;
    out.width_mm = fields.dimensions?.widthMm ?? null;
    out.height_mm = fields.dimensions?.heightMm ?? null;
  }
  if (fields.imageUrl !== undefined) out.image_url = fields.imageUrl;
  if (fields.active !== undefined) out.active = fields.active;
  if (fields.purchaseVatRateBp !== undefined) out.purchase_vat_rate_bp = fields.purchaseVatRateBp;
  if (fields.reorder !== undefined) {
    out.lead_time_days = fields.reorder.leadTimeDays;
    out.safety_days = fields.reorder.safetyDays;
    out.target_cover_days = fields.reorder.targetCoverDays;
  }
  return out;
}
