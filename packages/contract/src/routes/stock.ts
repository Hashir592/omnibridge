import { z } from 'zod';
import { FileDownloadSchema } from '../download.ts';
import { pagedOf, pageQuery } from '../pages.ts';
import { defineRoute } from '../route.ts';
import { CsvImportReportSchema, FulfilmentSchema } from './catalogue.ts';
import { ProviderSchema } from './connections.ts';

/*
 * M09: the stock engine (INV-1 to INV-10, AT-4, AT-27). One stock number per plain Master SKU
 * drives every channel; a bundle's comes from its component (CAT-3). Workspace-shared
 * (ARCHITECTURE 6.1): a movement that names an order shows its reference only when the user can
 * see that order's company. Quantities are whole units.
 */

const stockTab = {
  auth: 'session',
  tab: 'stock-catalogue',
  adminOnly: false,
  companyScoped: false,
} as const;

const At = z.iso.datetime();
const Day = z.iso.date();
const Units = z.number().int().min(0).max(10_000_000);
const SkuParams = z.object({ skuId: z.uuid() });
/** An optimistic-lock version: the save is refused (409) when it no longer matches (C7.2). */
const Version = z.number().int().min(0);

/** INV-10: how a listing's quantity is chosen. A SKU is `mixed` when its listings differ. */
export const StockModeSchema = z.enum(['auto', 'manual']).meta({ id: 'StockMode' });

/** The last write sent for a listing (INV-4, INV-8): queued, sent, held by a switch, or failed. */
export const PushResultSchema = z
  .enum(['pending', 'sent', 'held', 'failed'])
  .meta({ id: 'PushResult' });

export const StockRowSchema = z
  .object({
    sku_id: z.uuid(),
    sku: z.string(),
    title: z.string(),
    active: z.boolean(),
    bundle: z
      .object({ component_id: z.uuid(), component_sku: z.string(), pack_size: z.number().int() })
      .nullable(),
    /** Null for a bundle: it has no stock of its own (CAT-3). */
    on_hand: z.number().int().nullable(),
    reserved: z.number().int().min(0),
    /** On hand minus reserved (INV-1); below 0 when oversold (INV-6). A bundle's is floored. */
    available: z.number().int(),
    oversold: z.boolean(),
    /** At least one listing's last push failed for good (INV-8). */
    sync_failed: z.boolean(),
    sync_mode: z.enum(['auto', 'manual', 'mixed']),
    listing_count: z.number().int().min(0),
    fba_count: z.number().int().min(0),
    last_movement_at: At.nullable(),
  })
  .meta({ id: 'StockRow' });

/** One listing of a SKU as the stock page shows it (INV-2, INV-9, INV-10). */
export const StockListingSchema = z
  .object({
    id: z.uuid(),
    channel_account_id: z.uuid(),
    provider: ProviderSchema,
    external_sku: z.string(),
    external_id: z.string(),
    title: z.string().nullable(),
    fulfilment: FulfilmentSchema.nullable(),
    /** The buffer in force: the listing's own, else its account's (INV-2). */
    buffer: Units,
    buffer_override: z.boolean(),
    /** The quantity OmniBridge sends; null for FBA (INV-9), which it never writes. */
    target: Units.nullable(),
    /** INV-10: the target is held down by real stock, not by the manual number. */
    capped_by_stock: z.boolean(),
    last_sent_qty: Units.nullable(),
    /** What the channel showed at the last discovery or reconciliation (INV-7). */
    channel_qty: Units.nullable(),
    mode: StockModeSchema,
    manual: z
      .object({ qty: Units, sold: Units, set_at: At, set_by: z.uuid().nullable() })
      .nullable(),
    sync_failed: z.boolean(),
    last_push: z.object({ at: At, result: PushResultSchema }).nullable(),
  })
  .meta({ id: 'StockListing' });

export const StockDetailSchema = StockRowSchema.extend({
  /** Send it back with an allocation save (C7.2). */
  version: Version,
  listings: z.array(StockListingSchema),
  /** C7.2: "Allocated 240 · Available 186" over the manual merchant-fulfilled listings. */
  allocation: z.object({ allocated: Units, available: z.number().int() }),
  /** Bundles of this SKU, with their floored availability (CAT-3). */
  bundles: z.array(
    z.object({
      id: z.uuid(),
      sku: z.string(),
      pack_size: z.number().int(),
      available: z.number().int(),
    }),
  ),
}).meta({ id: 'StockDetail' });

/** INV-3 movement kinds; `allocation` records a manual-allocation change (C7.2), stock unchanged. */
export const MovementKindSchema = z
  .enum([
    'reserve',
    'release',
    'dispatch',
    'return',
    'stock_in',
    'adjust',
    'stock_take',
    'allocation',
  ])
  .meta({ id: 'MovementKind' });

/** INV-3: a manual adjustment needs one of these reasons; `other` needs text too. */
export const AdjustReasonSchema = z
  .enum(['damaged', 'count_correction', 'lost', 'other'])
  .meta({ id: 'AdjustReason' });

/** One change log row (INV-5). */
export const MovementSchema = z
  .object({
    id: z.uuid(),
    at: At,
    sku_id: z.uuid(),
    sku: z.string(),
    kind: MovementKindSchema,
    on_hand_change: z.number().int(),
    reserved_change: z.number().int(),
    on_hand_after: z.number().int(),
    reason: AdjustReasonSchema.nullable(),
    /** The adjustment text, stock-in notes or the allocation change, as typed. */
    note: z.string().nullable(),
    supplier: z.string().nullable(),
    /**
     * Who or what moved it. An order's reference is null when the user cannot see the order's
     * company (ARCHITECTURE 6.1: shown as "another company").
     */
    source: z.discriminatedUnion('type', [
      z.object({ type: z.literal('order'), ref: z.string().nullable() }),
      z.object({ type: z.literal('user'), user_id: z.uuid().nullable() }),
      z.object({ type: z.literal('system') }),
    ]),
    /** The writes queued for listings after this movement, by their result now (INV-5). */
    pushes: z.object({
      pending: z.number().int().min(0),
      sent: z.number().int().min(0),
      held: z.number().int().min(0),
      failed: z.number().int().min(0),
    }),
  })
  .meta({ id: 'Movement' });

const movementFilter = {
  sku_id: z.uuid().optional(),
  kind: MovementKindSchema.optional(),
  source: z.enum(['order', 'user', 'system']).optional(),
  /** London calendar days, inclusive. */
  from: Day.optional(),
  to: Day.optional(),
};

// ---- Stock (INV-1, INV-6, INV-8) ---------------------------------------------------------------

/** Stock by SKU. `filter` picks the oversold, sync-failed, manual or bundle rows. */
export const listStock = defineRoute({
  id: 'listStock',
  method: 'GET',
  path: '/stock',
  summary: 'List stock by Master SKU',
  query: pageQuery.extend({
    q: z.string().trim().min(1).max(100).optional(),
    filter: z.enum(['oversold', 'sync_failed', 'manual', 'bundles']).optional(),
  }),
  responses: { 200: pagedOf(StockRowSchema) },
  ...stockTab,
});

export const getStock = defineRoute({
  id: 'getStock',
  method: 'GET',
  path: '/stock/:skuId',
  summary: "One SKU's stock, listings, targets and sync state",
  params: SkuParams,
  responses: { 200: StockDetailSchema },
  ...stockTab,
});

// ---- Change log (INV-5) ------------------------------------------------------------------------

export const listMovements = defineRoute({
  id: 'listMovements',
  method: 'GET',
  path: '/stock/movements',
  summary: 'The stock change log, newest first',
  query: pageQuery.extend(movementFilter),
  responses: { 200: pagedOf(MovementSchema) },
  ...stockTab,
});

/** The change log as CSV with the same filters (INV-5). */
export const exportMovements = defineRoute({
  id: 'exportMovements',
  method: 'GET',
  path: '/stock/movements/export',
  summary: 'Export the stock change log as CSV',
  query: z.object(movementFilter),
  responses: { 200: FileDownloadSchema },
  ...stockTab,
});

// ---- Movements by hand (INV-3) -----------------------------------------------------------------

/**
 * Stock-in: on hand goes up. `client_ref` makes a resend harmless (the same movement comes back).
 * 409 on a bundle, which has no stock of its own.
 */
export const stockIn = defineRoute({
  id: 'stockIn',
  method: 'POST',
  path: '/stock/:skuId/stock-in',
  summary: 'Book stock in',
  params: SkuParams,
  body: z
    .object({
      quantity: z.number().int().min(1).max(1_000_000),
      supplier: z.string().trim().min(1).max(200).optional(),
      notes: z.string().trim().min(1).max(500).optional(),
      client_ref: z.uuid(),
    })
    .strict(),
  responses: { 201: MovementSchema },
  ...stockTab,
});

/** An adjustment with a required reason; `other` also needs `text`. 409 on a bundle. */
export const adjustStock = defineRoute({
  id: 'adjustStock',
  method: 'POST',
  path: '/stock/:skuId/adjustments',
  summary: 'Adjust stock with a reason',
  params: SkuParams,
  body: z
    .object({
      delta: z
        .number()
        .int()
        .min(-1_000_000)
        .max(1_000_000)
        .refine((n) => n !== 0, 'not zero'),
      reason: AdjustReasonSchema,
      text: z.string().trim().min(1).max(500).optional(),
      client_ref: z.uuid(),
    })
    .strict(),
  responses: { 201: MovementSchema },
  ...stockTab,
});

/**
 * Stock-take by CSV: columns `sku` and `on_hand` (the counted number). Each changed SKU gets one
 * stock_take movement. `dry_run` reports without writing; otherwise all rows or none.
 */
export const importStockTake = defineRoute({
  id: 'importStockTake',
  method: 'POST',
  path: '/stock/stock-take/import',
  summary: 'Import a stock-take from CSV',
  body: z.object({ csv: z.string().min(1).max(1_000_000), dry_run: z.boolean() }).strict(),
  responses: { 200: CsvImportReportSchema },
  ...stockTab,
});

// ---- Buffers (INV-2) ---------------------------------------------------------------------------

export const BufferSchema = z
  .object({
    channel_account_id: z.uuid(),
    provider: ProviderSchema,
    display_name: z.string(),
    buffer: Units,
  })
  .meta({ id: 'StockBuffer' });

/** The safety buffer of each sales account the user can see (default 0). */
export const listBuffers = defineRoute({
  id: 'listBuffers',
  method: 'GET',
  path: '/stock/buffers',
  summary: 'Safety buffers per sales account',
  responses: { 200: z.object({ items: z.array(BufferSchema) }).meta({ id: 'StockBufferList' }) },
  ...stockTab,
});

export const setAccountBuffer = defineRoute({
  id: 'setAccountBuffer',
  method: 'PUT',
  path: '/stock/buffers/:accountId',
  summary: "Set a sales account's safety buffer",
  params: z.object({ accountId: z.uuid() }),
  body: z.object({ buffer: Units }).strict(),
  responses: { 200: BufferSchema },
  ...stockTab,
});

/** A listing's own buffer; null goes back to its account's. */
export const setListingBuffer = defineRoute({
  id: 'setListingBuffer',
  method: 'PUT',
  path: '/stock/listings/:listingId/buffer',
  summary: "Set or clear a listing's own buffer",
  params: z.object({ listingId: z.uuid() }),
  body: z.object({ buffer: Units.nullable() }).strict(),
  responses: { 200: StockListingSchema },
  ...stockTab,
});

// ---- Manual allocation (INV-10, C7) ------------------------------------------------------------

/** What each listing's write is right after a save or Back to Auto (C7.2). */
export const AllocationPushSchema = z
  .object({
    listing_id: z.uuid(),
    /** queued: a new quantity is on its way; unchanged: the target did not move. */
    result: z.enum(['queued', 'unchanged', 'held']),
  })
  .meta({ id: 'AllocationPush' });

export const AllocationResultSchema = z
  .object({ stock: StockDetailSchema, pushes: z.array(AllocationPushSchema) })
  .meta({ id: 'AllocationResult' });

/**
 * One save of a SKU's allocation (C7.2): each named listing's mode and manual quantity (bundle
 * listings of this SKU included: the client names the ones the product switch covers), checked
 * against `version` in one transaction. 409 `version_conflict` when stock or settings changed
 * since the form was read; FBA (INV-9) and unmapped listings are refused.
 */
export const saveAllocation = defineRoute({
  id: 'saveAllocation',
  method: 'PUT',
  path: '/stock/:skuId/allocation',
  summary: "Save a SKU's manual allocation",
  params: SkuParams,
  body: z
    .object({
      version: Version,
      listings: z
        .array(
          z
            .object({
              listing_id: z.uuid(),
              mode: StockModeSchema,
              /** Required in manual mode; 0 stops selling on that listing. */
              manual_qty: Units.optional(),
            })
            .strict(),
        )
        .min(1)
        .max(200),
    })
    .strict(),
  responses: { 200: AllocationResultSchema },
  ...stockTab,
});

/**
 * Back to Auto (C7.2): the named listings, or every listing of the SKU (and, with
 * `include_bundles`, of its bundles), drop their manual settings; one write each is queued now.
 */
export const backToAuto = defineRoute({
  id: 'backToAuto',
  method: 'POST',
  path: '/stock/:skuId/allocation/auto',
  summary: 'Switch listings back to automatic stock',
  params: SkuParams,
  body: z
    .object({
      listing_ids: z.array(z.uuid()).min(1).max(200).optional(),
      include_bundles: z.boolean().optional(),
    })
    .strict(),
  responses: { 200: AllocationResultSchema },
  ...stockTab,
});

export const stockRoutes = [
  listStock,
  getStock,
  listMovements,
  exportMovements,
  stockIn,
  adjustStock,
  importStockTake,
  listBuffers,
  setAccountBuffer,
  setListingBuffer,
  saveAllocation,
  backToAuto,
] as const;
