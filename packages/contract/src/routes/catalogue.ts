import { z } from 'zod';
import { FileDownloadSchema } from '../download.ts';
import { pagedOf, pageQuery } from '../pages.ts';
import { defineRoute } from '../route.ts';
import { ProviderSchema } from './connections.ts';

/*
 * M08: the catalogue (CAT-1 to CAT-6, FIN-1). Master SKUs, bundles, VAT types and COGS with
 * history, and channel listings mapped to exactly one SKU. Workspace-shared (ARCHITECTURE 6.1):
 * every member with the Stock & Catalogue tab sees the whole catalogue, whatever companies they
 * hold. Money is integer pence, rates are basis points (2000 = 20%).
 */

const catalogueTab = {
  auth: 'session',
  tab: 'stock-catalogue',
  adminOnly: false,
  companyScoped: false,
} as const;

const At = z.iso.datetime();
/** A calendar day, YYYY-MM-DD (shown as DD/MM/YYYY). */
const Day = z.iso.date();
const Pence = z.number().int().min(0).max(100_000_000);
const BasisPoints = z.number().int().min(0).max(10_000);
const SkuParams = z.object({ skuId: z.uuid() });
const ListingParams = z.object({ listingId: z.uuid() });

/**
 * CAT-2: the four VAT types, always kept apart (zero-rated is not "no VAT"). Their rates live in a
 * workspace table with effective dates.
 */
export const VatTypeSchema = z.enum(['standard', 'reduced', 'zero', 'no_vat']).meta({
  id: 'VatType',
});

/** A SKU code: unique per workspace, matched exactly against channel SKUs (CAT-5). */
const SkuCode = z
  .string()
  .min(1)
  .max(64)
  .regex(/^\S(.*\S)?$/, 'no leading or trailing spaces');

export const DimensionsSchema = z
  .object({
    length_mm: z.number().int().min(1).max(10_000),
    width_mm: z.number().int().min(1).max(10_000),
    height_mm: z.number().int().min(1).max(10_000),
  })
  .meta({ id: 'Dimensions' });

/** CAT-1 reorder settings, used by forecasting. */
export const ReorderSettingsSchema = z
  .object({
    lead_time_days: z.number().int().min(0).max(365),
    safety_days: z.number().int().min(0).max(365),
    target_cover_days: z.number().int().min(0).max(730),
  })
  .meta({ id: 'ReorderSettings' });

/** CAT-3: a bundle holds `pack_size` units of one component SKU and has no stock of its own. */
export const BundleSchema = z
  .object({
    component_id: z.uuid(),
    component_sku: z.string(),
    pack_size: z.number().int().min(2).max(1_000),
  })
  .meta({ id: 'Bundle' });

/** One row of a SKU's VAT-type history: the type from this day on (ADR-078 4). */
export const VatHistoryEntrySchema = z
  .object({ vat_type: VatTypeSchema, effective_from: Day })
  .meta({ id: 'VatHistoryEntry' });

/** One row of a SKU's COGS history: ex-VAT cost per unit from this day on (CAT-4). */
export const CogsEntrySchema = z
  .object({ cogs_pence: Pence, effective_from: Day, created_at: At })
  .meta({ id: 'CogsEntry' });

export const MasterSkuSummarySchema = z
  .object({
    id: z.uuid(),
    sku: z.string(),
    title: z.string(),
    vat_type: VatTypeSchema,
    /** Today's COGS; a bundle's is the component's times the pack size. Null when none is set. */
    cogs_pence: Pence.nullable(),
    active: z.boolean(),
    bundle: BundleSchema.nullable(),
    listing_count: z.number().int().min(0),
    updated_at: At,
  })
  .meta({ id: 'MasterSkuSummary' });

/** A listing as a SKU's detail shows it. */
export const SkuListingSchema = z
  .object({
    id: z.uuid(),
    channel_account_id: z.uuid(),
    provider: ProviderSchema,
    external_sku: z.string(),
    external_id: z.string(),
    title: z.string().nullable(),
  })
  .meta({ id: 'SkuListing' });

export const MasterSkuSchema = MasterSkuSummarySchema.extend({
  short_description: z.string(),
  barcode: z.string().nullable(),
  manufacturer: z.string().nullable(),
  weight_g: z.number().int().min(0),
  dimensions: DimensionsSchema.nullable(),
  image_url: z.url().nullable(),
  /** CAT-4: set only when the purchase VAT rate differs from the SKU's VAT type (PRF-6). */
  purchase_vat_rate_bp: BasisPoints.nullable(),
  reorder: ReorderSettingsSchema,
  vat_history: z.array(VatHistoryEntrySchema),
  cogs_history: z.array(CogsEntrySchema),
  listings: z.array(SkuListingSchema),
  created_at: At,
}).meta({ id: 'MasterSku' });

const editable = {
  title: z.string().trim().min(1).max(200),
  /** The carrier item description (CAT-1). */
  short_description: z.string().trim().min(1).max(100),
  barcode: z.string().trim().min(1).max(64).nullable(),
  manufacturer: z.string().trim().min(1).max(100).nullable(),
  weight_g: z.number().int().min(0).max(1_000_000),
  dimensions: DimensionsSchema.nullable(),
  image_url: z.url().max(2_000).nullable(),
  active: z.boolean(),
  reorder: ReorderSettingsSchema,
  purchase_vat_rate_bp: BasisPoints.nullable(),
};

export const MasterSkuCreateSchema = z
  .object({
    sku: SkuCode,
    ...editable,
    barcode: editable.barcode.optional(),
    manufacturer: editable.manufacturer.optional(),
    dimensions: editable.dimensions.optional(),
    image_url: editable.image_url.optional(),
    active: editable.active.optional(),
    reorder: editable.reorder.optional(),
    purchase_vat_rate_bp: editable.purchase_vat_rate_bp.optional(),
    /** Required for a plain SKU; a bundle takes its component's, locked (CAT-3). */
    vat_type: VatTypeSchema.optional(),
    /** The first COGS, from `cogs_effective_from` (default today). Not for bundles. */
    cogs_pence: Pence.optional(),
    cogs_effective_from: Day.optional(),
    bundle: z
      .object({ component_id: z.uuid(), pack_size: z.number().int().min(2).max(1_000) })
      .optional(),
  })
  .strict()
  .meta({ id: 'MasterSkuCreate' });

/**
 * Any of the editable fields. The SKU code and a bundle's make-up never change (a new SKU instead).
 * `vat` adds a VAT-type history row from `effective_from`; refused (409) on a bundle.
 */
export const MasterSkuUpdateSchema = z
  .object({
    title: editable.title.optional(),
    short_description: editable.short_description.optional(),
    barcode: editable.barcode.optional(),
    manufacturer: editable.manufacturer.optional(),
    weight_g: editable.weight_g.optional(),
    dimensions: editable.dimensions.optional(),
    image_url: editable.image_url.optional(),
    active: editable.active.optional(),
    reorder: editable.reorder.optional(),
    purchase_vat_rate_bp: editable.purchase_vat_rate_bp.optional(),
    vat: z.object({ vat_type: VatTypeSchema, effective_from: Day }).strict().optional(),
  })
  .strict()
  .meta({ id: 'MasterSkuUpdate' });

/** A CSV import's report (dry run or applied). Errors carry the line and a stable code only. */
export const CsvImportReportSchema = z
  .object({
    rows: z.number().int().min(0),
    valid: z.number().int().min(0),
    /** False on a dry run, or when any row failed: an import applies all rows or none. */
    applied: z.boolean(),
    errors: z.array(
      z.object({
        line: z.number().int().min(1),
        code: z.string(),
        column: z.string().nullable(),
      }),
    ),
  })
  .meta({ id: 'CsvImportReport' });

const CsvImportBody = z
  .object({ csv: z.string().min(1).max(1_000_000), dry_run: z.boolean() })
  .strict();

export const VatRateSchema = z
  .object({ vat_type: VatTypeSchema, rate_bp: BasisPoints, effective_from: Day })
  .meta({ id: 'VatRate' });

/** CAT-5: Amazon fulfilment (MFN or FBA); null for other channels. */
export const FulfilmentSchema = z.enum(['mfn', 'fba']).meta({ id: 'Fulfilment' });

export const ListingSchema = z
  .object({
    id: z.uuid(),
    channel_account_id: z.uuid(),
    provider: ProviderSchema,
    external_sku: z.string(),
    /** Listing ID, ASIN or item ID. */
    external_id: z.string(),
    title: z.string().nullable(),
    fulfilment: FulfilmentSchema.nullable(),
    /** eBay only: the listing's stock is managed through the Inventory API. */
    inventory_api: z.boolean().nullable(),
    master_sku: z.object({ id: z.uuid(), sku: z.string() }).nullable(),
    mapped_at: At.nullable(),
    discovered_at: At,
  })
  .meta({ id: 'Listing' });

// ---- Master SKUs and bundles (CAT-1, CAT-3) ----------------------------------------------------

/** Master SKUs, by SKU code. `q` matches the code, title or barcode. */
export const listMasterSkus = defineRoute({
  id: 'listMasterSkus',
  method: 'GET',
  path: '/catalogue/skus',
  summary: 'List Master SKUs',
  query: pageQuery.extend({
    q: z.string().trim().min(1).max(100).optional(),
    active: z.enum(['true', 'false']).optional(),
    bundles: z.enum(['true', 'false']).optional(),
  }),
  responses: { 200: pagedOf(MasterSkuSummarySchema) },
  ...catalogueTab,
});

export const getMasterSku = defineRoute({
  id: 'getMasterSku',
  method: 'GET',
  path: '/catalogue/skus/:skuId',
  summary: 'One Master SKU with its histories and listings',
  params: SkuParams,
  responses: { 200: MasterSkuSchema },
  ...catalogueTab,
});

/**
 * 409 when the code is taken, or for a bundle whose component is itself a bundle. A bundle names
 * one component SKU only (CAT-3, AT-5): there is no field for a second.
 */
export const createMasterSku = defineRoute({
  id: 'createMasterSku',
  method: 'POST',
  path: '/catalogue/skus',
  summary: 'Create a Master SKU or a bundle',
  body: MasterSkuCreateSchema,
  responses: { 201: MasterSkuSchema },
  ...catalogueTab,
});

export const updateMasterSku = defineRoute({
  id: 'updateMasterSku',
  method: 'PATCH',
  path: '/catalogue/skus/:skuId',
  summary: 'Edit a Master SKU',
  params: SkuParams,
  body: MasterSkuUpdateSchema,
  responses: { 200: MasterSkuSchema },
  ...catalogueTab,
});

/** CAT-1: manufacturers already used in this workspace, for the dropdown. */
export const listManufacturers = defineRoute({
  id: 'listManufacturers',
  method: 'GET',
  path: '/catalogue/manufacturers',
  summary: 'Manufacturers used so far',
  responses: {
    200: z.object({ items: z.array(z.string()) }).meta({ id: 'ManufacturerList' }),
  },
  ...catalogueTab,
});

// ---- VAT rates (CAT-2) -------------------------------------------------------------------------

export const listVatRates = defineRoute({
  id: 'listVatRates',
  method: 'GET',
  path: '/catalogue/vat-rates',
  summary: "The workspace's VAT rates with their effective dates",
  responses: { 200: z.object({ items: z.array(VatRateSchema) }).meta({ id: 'VatRateList' }) },
  ...catalogueTab,
});

/** A new rate for one VAT type from a date (a future rate change needs no code). Admins only. */
export const createVatRate = defineRoute({
  id: 'createVatRate',
  method: 'POST',
  path: '/catalogue/vat-rates',
  summary: 'Add a VAT rate from a date',
  body: VatRateSchema.strict(),
  responses: { 201: VatRateSchema },
  auth: 'session',
  tab: 'settings',
  adminOnly: true,
  companyScoped: false,
});

// ---- COGS (CAT-4) ------------------------------------------------------------------------------

export const listCogs = defineRoute({
  id: 'listCogs',
  method: 'GET',
  path: '/catalogue/skus/:skuId/cogs',
  summary: "A SKU's COGS history, newest first",
  params: SkuParams,
  responses: { 200: z.object({ items: z.array(CogsEntrySchema) }).meta({ id: 'CogsHistory' }) },
  ...catalogueTab,
});

/** One COGS from a date; the same date again replaces it. 409 on a bundle (its COGS is derived). */
export const setCogs = defineRoute({
  id: 'setCogs',
  method: 'POST',
  path: '/catalogue/skus/:skuId/cogs',
  summary: 'Set the COGS from a date',
  params: SkuParams,
  body: z.object({ cogs_pence: Pence, effective_from: Day }).strict(),
  responses: { 201: CogsEntrySchema },
  ...catalogueTab,
});

/**
 * COGS by CSV (CAT-4): columns `sku`, `cogs` (pounds, for example 12.34) and `effective_from`
 * (DD/MM/YYYY or YYYY-MM-DD). `dry_run` reports without writing; otherwise all rows or none.
 */
export const importCogs = defineRoute({
  id: 'importCogs',
  method: 'POST',
  path: '/catalogue/cogs/import',
  summary: 'Import COGS from CSV',
  body: CsvImportBody,
  responses: { 200: CsvImportReportSchema },
  ...catalogueTab,
});

// ---- Listings and mapping (CAT-5, CAT-6) -------------------------------------------------------

/** Listings; `mapped=false` is the Unmapped listings queue. */
export const listListings = defineRoute({
  id: 'listListings',
  method: 'GET',
  path: '/catalogue/listings',
  summary: 'List channel listings',
  query: pageQuery.extend({
    mapped: z.enum(['true', 'false']).optional(),
    channel_account_id: z.uuid().optional(),
    q: z.string().trim().min(1).max(100).optional(),
  }),
  responses: { 200: pagedOf(ListingSchema) },
  ...catalogueTab,
});

/** Maps a listing to one SKU. 409 when it is already mapped to another one (unmap it first). */
export const mapListing = defineRoute({
  id: 'mapListing',
  method: 'PUT',
  path: '/catalogue/listings/:listingId/mapping',
  summary: 'Map a listing to a Master SKU',
  params: ListingParams,
  body: z.object({ master_sku_id: z.uuid() }).strict(),
  responses: { 200: ListingSchema },
  ...catalogueTab,
});

/** Unmaps a listing: it goes back to the queue and gets no stock writes (CAT-5). */
export const unmapListing = defineRoute({
  id: 'unmapListing',
  method: 'DELETE',
  path: '/catalogue/listings/:listingId/mapping',
  summary: 'Unmap a listing',
  params: ListingParams,
  responses: { 200: ListingSchema },
  ...catalogueTab,
});

/**
 * Mappings by CSV: columns `listing_id` (from the export) and `sku` (empty to unmap). `dry_run`
 * reports without writing; otherwise all rows or none.
 */
export const importMappings = defineRoute({
  id: 'importMappings',
  method: 'POST',
  path: '/catalogue/mappings/import',
  summary: 'Import listing mappings from CSV',
  body: CsvImportBody,
  responses: { 200: CsvImportReportSchema },
  ...catalogueTab,
});

/** Every listing as CSV: listing_id, account, provider, external_sku, external_id, title, sku. */
export const exportMappings = defineRoute({
  id: 'exportMappings',
  method: 'GET',
  path: '/catalogue/mappings/export',
  summary: 'Export listing mappings as CSV',
  responses: { 200: FileDownloadSchema },
  ...catalogueTab,
});

export const catalogueRoutes = [
  listMasterSkus,
  getMasterSku,
  createMasterSku,
  updateMasterSku,
  listManufacturers,
  listVatRates,
  createVatRate,
  listCogs,
  setCogs,
  importCogs,
  listListings,
  mapListing,
  unmapListing,
  importMappings,
  exportMappings,
] as const;
