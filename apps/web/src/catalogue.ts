import { Readable } from 'node:stream';
import type { catalogueRoutes } from '@omnibridge/contract';
import { pageOffset, pageResult, TOTAL_COUNT_CAP } from '@omnibridge/contract';
import {
  ApiError,
  londonDate,
  parseCsv,
  parsePounds,
  pence,
  toCsv,
  type TenantContext,
} from '@omnibridge/core';
import {
  CatalogueRefused,
  type AuditLog,
  type CatalogueRepository,
  type Listing,
  type MappingChange,
  type SkuDetail,
  type SkuSummary,
} from '@omnibridge/db';
import type { Handlers } from './contract.ts';
import { UTF8_BOM } from './audit-csv.ts';

/**
 * The catalogue (T-0801: CAT-1 to CAT-6, FIN-1). Workspace-shared (ARCHITECTURE 6.1): every
 * member with the Stock & Catalogue tab sees the whole catalogue. Each request is one
 * transaction, so a CSV import applies all its rows or none.
 */
export interface CatalogueOptions {
  catalogue: CatalogueRepository;
  audit: Pick<AuditLog, 'record'>;
  /** CAT-6: tells M09 and M10 a listing's mapping changed, in the request's transaction. */
  mappingChanged: (ctx: TenantContext, change: MappingChange, at: Date) => Promise<void>;
  now?: () => Date;
}

const notFound = () => Promise.reject(new ApiError({ status: 404, code: 'not_found' }));
const iso = (d: Date | null) => (d === null ? null : d.toISOString());
const MAX_IMPORT_ROWS = 20_000;

function refused(err: unknown): never {
  if (err instanceof CatalogueRefused) {
    // Another workspace's SKU or listing is simply not there (the route walk asks for 404).
    if (err.code === 'not_found' || err.code === 'component_not_found') {
      throw new ApiError({ status: 404, code: 'not_found' });
    }
    throw new ApiError({ status: 409, code: 'conflict', detail: REFUSAL_TEXT[err.code] });
  }
  throw err;
}

const REFUSAL_TEXT: Record<CatalogueRefused['code'], string> = {
  sku_taken: 'This SKU code is already used in this workspace.',
  component_not_found: 'The component SKU does not exist.',
  component_is_bundle: 'A bundle contains units of one plain SKU, not another bundle.',
  bundle_locked: "A bundle's VAT type and COGS come from its component and cannot be set.",
  vat_type_required: 'Choose a VAT type.',
  already_mapped: 'This listing is mapped to another SKU. Unmap it first.',
  not_found: 'Not found.',
};

function summary(s: SkuSummary) {
  return {
    id: s.id,
    sku: s.sku,
    title: s.title,
    vat_type: s.vatType,
    cogs_pence: s.cogsPence === null ? null : Number(s.cogsPence),
    active: s.active,
    bundle:
      s.bundle === null
        ? null
        : {
            component_id: s.bundle.componentId,
            component_sku: s.bundle.componentSku,
            pack_size: s.bundle.packSize,
          },
    listing_count: s.listingCount,
    updated_at: s.updatedAt.toISOString(),
  };
}

function detail(s: SkuDetail) {
  return {
    ...summary(s),
    short_description: s.shortDescription,
    barcode: s.barcode,
    manufacturer: s.manufacturer,
    weight_g: s.weightG,
    dimensions:
      s.dimensions === null
        ? null
        : {
            length_mm: s.dimensions.lengthMm,
            width_mm: s.dimensions.widthMm,
            height_mm: s.dimensions.heightMm,
          },
    image_url: s.imageUrl,
    purchase_vat_rate_bp: s.purchaseVatRateBp,
    reorder: {
      lead_time_days: s.reorder.leadTimeDays,
      safety_days: s.reorder.safetyDays,
      target_cover_days: s.reorder.targetCoverDays,
    },
    vat_history: s.vatHistory.map((v) => ({
      vat_type: v.vatType,
      effective_from: v.effectiveFrom,
    })),
    cogs_history: s.cogsHistory.map((c) => ({
      cogs_pence: Number(c.cogsPence),
      effective_from: c.effectiveFrom,
      created_at: c.createdAt.toISOString(),
    })),
    listings: s.listings.map((l) => ({
      id: l.id,
      channel_account_id: l.channelAccountId,
      provider: l.provider,
      external_sku: l.externalSku,
      external_id: l.externalId,
      title: l.title,
    })),
    created_at: s.createdAt.toISOString(),
  };
}

function listing(l: Listing) {
  return {
    id: l.id,
    channel_account_id: l.channelAccountId,
    provider: l.provider,
    external_sku: l.externalSku,
    external_id: l.externalId,
    title: l.title,
    fulfilment: l.fulfilment,
    inventory_api: l.inventoryApi,
    master_sku: l.masterSku,
    mapped_at: iso(l.mappedAt),
    discovered_at: l.discoveredAt.toISOString(),
  };
}

const bool = (v: 'true' | 'false' | undefined) => (v === undefined ? undefined : v === 'true');

interface ImportError {
  line: number;
  code: string;
  column: string | null;
}

/** DD/MM/YYYY or YYYY-MM-DD to YYYY-MM-DD; undefined for anything that is not a real day. */
export function parseDay(text: string): string | undefined {
  const t = text.trim();
  const uk = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(t);
  const isoDay = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
  const [y, m, d] = uk !== null ? [uk[3], uk[2], uk[1]] : isoDay !== null ? isoDay.slice(1) : [];
  if (y === undefined || m === undefined || d === undefined) return undefined;
  const day = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  const out = `${y}-${m}-${d}`;
  return day.toISOString().slice(0, 10) === out ? out : undefined;
}

/**
 * Reads a CSV with the given required columns (header names, any case). Returns the rows as
 * records, or a report-ready error for a broken file or a missing column.
 */
function readCsv<C extends string>(
  text: string,
  columns: readonly C[],
): { rows: { line: number; cells: Record<C, string> }[] } | { error: ImportError } {
  let parsed;
  try {
    parsed = parseCsv(text);
  } catch {
    return { error: { line: 1, code: 'csv_invalid', column: null } };
  }
  const header = parsed.header.map((h) => h.trim().toLowerCase());
  const index = new Map<C, number>();
  for (const column of columns) {
    const at = header.indexOf(column);
    if (at < 0) return { error: { line: 1, code: 'column_missing', column } };
    index.set(column, at);
  }
  if (parsed.rows.length > MAX_IMPORT_ROWS) {
    return { error: { line: 1, code: 'too_many_rows', column: null } };
  }
  return {
    rows: parsed.rows.map((row) => {
      const cells = {} as Record<C, string>;
      for (const column of columns)
        cells[column] = (row.cells[index.get(column) ?? 0] ?? '').trim();
      return { line: row.line, cells };
    }),
  };
}

const report = (rows: number, errors: ImportError[], applied: boolean) => ({
  status: 200 as const,
  body: {
    rows,
    // A file-level error (line 1, the header) has no data row to subtract.
    valid: Math.max(0, rows - new Set(errors.filter((e) => e.line > 1).map((e) => e.line)).size),
    applied,
    errors,
  },
});

export function catalogueHandlers(options?: CatalogueOptions): Handlers<typeof catalogueRoutes> {
  if (options === undefined) {
    return {
      listMasterSkus: notFound,
      getMasterSku: notFound,
      createMasterSku: notFound,
      updateMasterSku: notFound,
      listManufacturers: notFound,
      listVatRates: notFound,
      createVatRate: notFound,
      listCogs: notFound,
      setCogs: notFound,
      importCogs: notFound,
      listListings: notFound,
      mapListing: notFound,
      unmapListing: notFound,
      importMappings: notFound,
      exportMappings: notFound,
    };
  }
  const o = options;
  const repo = o.catalogue;
  const now = o.now ?? (() => new Date());
  const today = () => londonDate(now());

  const getDetail = async (tenant: TenantContext, id: string) => {
    const found = await repo.getSku(tenant, id, today());
    if (found === undefined) throw new ApiError({ status: 404, code: 'not_found' });
    return found;
  };

  return {
    listMasterSkus: async ({ tenant, query }) => {
      const filter = {
        offset: pageOffset(query),
        limit: query.limit,
        ...(query.q === undefined ? {} : { q: query.q }),
        ...(bool(query.active) === undefined ? {} : { active: query.active === 'true' }),
        ...(bool(query.bundles) === undefined ? {} : { bundles: query.bundles === 'true' }),
      };
      const { items, total } = await repo.listSkus(tenant, filter, today(), TOTAL_COUNT_CAP + 1);
      return {
        status: 200,
        body: await pageResult({
          items: items.map(summary),
          page: query.page,
          limit: query.limit,
          countUpTo: () => Promise.resolve(total),
        }),
      };
    },

    getMasterSku: async ({ tenant, params }) => ({
      status: 200,
      body: detail(await getDetail(tenant, params.skuId)),
    }),

    createMasterSku: async ({ tenant, session, body: input, request }) => {
      const at = now();
      let id: string;
      try {
        id = await repo.createSku(
          tenant,
          {
            sku: input.sku,
            title: input.title,
            shortDescription: input.short_description,
            weightG: input.weight_g,
            ...(input.barcode === undefined ? {} : { barcode: input.barcode }),
            ...(input.manufacturer === undefined ? {} : { manufacturer: input.manufacturer }),
            ...(input.dimensions === undefined ? {} : { dimensions: dims(input.dimensions) }),
            ...(input.image_url === undefined ? {} : { imageUrl: input.image_url }),
            ...(input.active === undefined ? {} : { active: input.active }),
            ...(input.reorder === undefined ? {} : { reorder: reorder(input.reorder) }),
            ...(input.purchase_vat_rate_bp === undefined
              ? {}
              : { purchaseVatRateBp: input.purchase_vat_rate_bp }),
            ...(input.vat_type === undefined ? {} : { vatType: input.vat_type }),
            ...(input.cogs_pence === undefined
              ? {}
              : {
                  firstCogs: {
                    cogsPence: pence(BigInt(input.cogs_pence)),
                    effectiveFrom: input.cogs_effective_from ?? londonDate(at),
                  },
                }),
            ...(input.bundle === undefined
              ? {}
              : {
                  bundle: {
                    componentId: input.bundle.component_id,
                    packSize: input.bundle.pack_size,
                  },
                }),
          },
          session.userId,
          at,
        );
      } catch (err) {
        refused(err);
      }
      await o.audit.record(tenant, {
        action: 'catalogue.changed',
        actor: { kind: 'user', userId: session.userId },
        entityId: id,
        after: {
          sku: input.sku,
          title: input.title,
          active: input.active ?? true,
          bundle_component_id: input.bundle?.component_id ?? null,
          pack_size: input.bundle?.pack_size ?? null,
          vat_type: input.vat_type ?? null,
        },
        ip: request.ip,
      });
      return { status: 201, body: detail(await getDetail(tenant, id)) };
    },

    updateMasterSku: async ({ tenant, session, params, body: input, request }) => {
      const before = await getDetail(tenant, params.skuId);
      try {
        await repo.updateSku(
          tenant,
          params.skuId,
          {
            ...(input.title === undefined ? {} : { title: input.title }),
            ...(input.short_description === undefined
              ? {}
              : { shortDescription: input.short_description }),
            ...(input.barcode === undefined ? {} : { barcode: input.barcode }),
            ...(input.manufacturer === undefined ? {} : { manufacturer: input.manufacturer }),
            ...(input.weight_g === undefined ? {} : { weightG: input.weight_g }),
            ...(input.dimensions === undefined ? {} : { dimensions: dims(input.dimensions) }),
            ...(input.image_url === undefined ? {} : { imageUrl: input.image_url }),
            ...(input.active === undefined ? {} : { active: input.active }),
            ...(input.reorder === undefined ? {} : { reorder: reorder(input.reorder) }),
            ...(input.purchase_vat_rate_bp === undefined
              ? {}
              : { purchaseVatRateBp: input.purchase_vat_rate_bp }),
            ...(input.vat === undefined
              ? {}
              : { vat: { vatType: input.vat.vat_type, effectiveFrom: input.vat.effective_from } }),
          },
          session.userId,
          now(),
        );
      } catch (err) {
        refused(err);
      }
      const after = await getDetail(tenant, params.skuId);
      await o.audit.record(tenant, {
        action: 'catalogue.changed',
        actor: { kind: 'user', userId: session.userId },
        entityId: params.skuId,
        before: { title: before.title, active: before.active },
        after: {
          title: after.title,
          active: after.active,
          ...(input.vat === undefined
            ? {}
            : { vat_type: input.vat.vat_type, vat_effective_from: input.vat.effective_from }),
        },
        ip: request.ip,
      });
      return { status: 200, body: detail(after) };
    },

    listManufacturers: async ({ tenant }) => ({
      status: 200,
      body: { items: await repo.manufacturers(tenant) },
    }),

    listVatRates: async ({ tenant }) => ({
      status: 200,
      body: {
        items: (await repo.vatRates(tenant)).map((r) => ({
          vat_type: r.vatType,
          rate_bp: r.rateBp,
          effective_from: r.effectiveFrom,
        })),
      },
    }),

    createVatRate: async ({ tenant, session, body: input, request }) => {
      if ((input.vat_type === 'zero' || input.vat_type === 'no_vat') && input.rate_bp !== 0) {
        throw new ApiError({
          status: 409,
          code: 'conflict',
          detail: 'Zero-rated and No VAT are always 0%.',
        });
      }
      const added = await repo.addVatRate(
        tenant,
        { vatType: input.vat_type, rateBp: input.rate_bp, effectiveFrom: input.effective_from },
        now(),
      );
      if (!added) {
        throw new ApiError({
          status: 409,
          code: 'conflict',
          detail: 'This VAT type already has a rate from that date.',
        });
      }
      await o.audit.record(tenant, {
        action: 'vat_rate.created',
        actor: { kind: 'user', userId: session.userId },
        after: { ...input },
        ip: request.ip,
      });
      return { status: 201, body: input };
    },

    listCogs: async ({ tenant, params }) => {
      const items = await repo.cogsHistory(tenant, params.skuId);
      if (items === undefined) throw new ApiError({ status: 404, code: 'not_found' });
      return {
        status: 200,
        body: {
          items: items.map((c) => ({
            cogs_pence: Number(c.cogsPence),
            effective_from: c.effectiveFrom,
            created_at: c.createdAt.toISOString(),
          })),
        },
      };
    },

    setCogs: async ({ tenant, session, params, body: input, request }) => {
      let entry;
      try {
        entry = await repo.setCogs(
          tenant,
          params.skuId,
          pence(BigInt(input.cogs_pence)),
          input.effective_from,
          session.userId,
          now(),
        );
      } catch (err) {
        refused(err);
      }
      if (entry === undefined) throw new ApiError({ status: 404, code: 'not_found' });
      await o.audit.record(tenant, {
        action: 'cogs.changed',
        actor: { kind: 'user', userId: session.userId },
        entityId: params.skuId,
        after: { cogs_pence: input.cogs_pence, effective_from: input.effective_from },
        ip: request.ip,
      });
      return {
        status: 201,
        body: {
          cogs_pence: Number(entry.cogsPence),
          effective_from: entry.effectiveFrom,
          created_at: entry.createdAt.toISOString(),
        },
      };
    },

    importCogs: async ({ tenant, session, body: input, request }) => {
      const read = readCsv(input.csv, ['sku', 'cogs', 'effective_from'] as const);
      if ('error' in read) return report(0, [read.error], false);
      const skus = await repo.skusByCode(
        tenant,
        read.rows.map((r) => r.cells.sku),
      );
      const errors: ImportError[] = [];
      const seen = new Set<string>();
      const valid: { id: string; cogs: ReturnType<typeof pence>; day: string }[] = [];
      for (const { line, cells } of read.rows) {
        const sku = skus.get(cells.sku);
        const cogs = parsePounds(cells.cogs);
        const day = parseDay(cells.effective_from);
        const before = errors.length;
        if (sku === undefined) errors.push({ line, code: 'sku_unknown', column: 'sku' });
        else if (sku.bundle) errors.push({ line, code: 'bundle_cogs', column: 'sku' });
        if (cogs === undefined || cogs > 100_000_000n) {
          errors.push({ line, code: 'cogs_invalid', column: 'cogs' });
        }
        if (day === undefined)
          errors.push({ line, code: 'date_invalid', column: 'effective_from' });
        const key = `${cells.sku}\u0000${day ?? ''}`;
        if (seen.has(key)) errors.push({ line, code: 'duplicate', column: null });
        seen.add(key);
        if (errors.length === before && sku !== undefined && cogs !== undefined && day) {
          valid.push({ id: sku.id, cogs, day });
        }
      }
      const apply = !input.dry_run && errors.length === 0 && valid.length > 0;
      if (apply) {
        const at = now();
        for (const row of valid) {
          await repo.setCogs(tenant, row.id, row.cogs, row.day, session.userId, at);
        }
        await o.audit.record(tenant, {
          action: 'catalogue.imported',
          actor: { kind: 'user', userId: session.userId },
          after: { kind: 'cogs', row_count: valid.length },
          ip: request.ip,
        });
      }
      return report(read.rows.length, errors, apply);
    },

    listListings: async ({ tenant, query }) => {
      const filter = {
        offset: pageOffset(query),
        limit: query.limit,
        ...(query.mapped === undefined ? {} : { mapped: query.mapped === 'true' }),
        ...(query.channel_account_id === undefined
          ? {}
          : { channelAccountId: query.channel_account_id }),
        ...(query.q === undefined ? {} : { q: query.q }),
      };
      const { items, total } = await repo.listListings(tenant, filter, TOTAL_COUNT_CAP + 1);
      return {
        status: 200,
        body: await pageResult({
          items: items.map(listing),
          page: query.page,
          limit: query.limit,
          countUpTo: () => Promise.resolve(total),
        }),
      };
    },

    mapListing: async ({ tenant, session, params, body: input, request }) => {
      const at = now();
      let change;
      try {
        change = await repo.mapListing(
          tenant,
          params.listingId,
          input.master_sku_id,
          'manual',
          session.userId,
          at,
        );
      } catch (err) {
        refused(err);
      }
      if (change !== null) {
        await o.audit.record(tenant, {
          action: 'listing.mapped',
          actor: { kind: 'user', userId: session.userId },
          entityId: params.listingId,
          after: { master_sku_id: input.master_sku_id, source: 'manual' },
          ip: request.ip,
        });
        await o.mappingChanged(tenant, change, at);
      }
      return { status: 200, body: listing(await mustListing(repo, tenant, params.listingId)) };
    },

    unmapListing: async ({ tenant, session, params, request }) => {
      const at = now();
      let change;
      try {
        change = await repo.unmapListing(tenant, params.listingId, at);
      } catch (err) {
        refused(err);
      }
      if (change !== null) {
        await o.audit.record(tenant, {
          action: 'listing.unmapped',
          actor: { kind: 'user', userId: session.userId },
          entityId: params.listingId,
          before: { master_sku_id: change.previousMasterSkuId },
          ip: request.ip,
        });
        await o.mappingChanged(tenant, change, at);
      }
      return { status: 200, body: listing(await mustListing(repo, tenant, params.listingId)) };
    },

    importMappings: async ({ tenant, session, body: input, request }) => {
      const read = readCsv(input.csv, ['listing_id', 'sku'] as const);
      if ('error' in read) return report(0, [read.error], false);
      const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      const ids = read.rows.map((r) => r.cells.listing_id).filter((id) => uuid.test(id));
      const listings = await repo.listingsById(tenant, ids);
      const skus = await repo.skusByCode(
        tenant,
        read.rows.map((r) => r.cells.sku).filter((s) => s !== ''),
      );
      const errors: ImportError[] = [];
      const seen = new Set<string>();
      const wanted: { listingId: string; current: string | null; skuId: string | null }[] = [];
      for (const { line, cells } of read.rows) {
        const found = uuid.test(cells.listing_id) ? listings.get(cells.listing_id) : undefined;
        const sku = cells.sku === '' ? null : skus.get(cells.sku);
        const before = errors.length;
        if (found === undefined) {
          errors.push({ line, code: 'listing_unknown', column: 'listing_id' });
        }
        if (sku === undefined) errors.push({ line, code: 'sku_unknown', column: 'sku' });
        if (seen.has(cells.listing_id)) errors.push({ line, code: 'duplicate', column: null });
        seen.add(cells.listing_id);
        if (errors.length === before && found !== undefined && sku !== undefined) {
          wanted.push({
            listingId: cells.listing_id,
            current: found.masterSkuId,
            skuId: sku?.id ?? null,
          });
        }
      }
      const apply = !input.dry_run && errors.length === 0 && wanted.length > 0;
      if (apply) {
        const at = now();
        let changed = 0;
        for (const row of wanted) {
          if (row.current === row.skuId) continue;
          // A CSV row sets the mapping it names: a remap is an unmap then a map (CAT-5).
          if (row.current !== null) await repo.unmapListing(tenant, row.listingId, at);
          if (row.skuId !== null) {
            await repo.mapListing(tenant, row.listingId, row.skuId, 'manual', session.userId, at);
          }
          await o.mappingChanged(
            tenant,
            { listingId: row.listingId, masterSkuId: row.skuId, previousMasterSkuId: row.current },
            at,
          );
          changed += 1;
        }
        await o.audit.record(tenant, {
          action: 'catalogue.imported',
          actor: { kind: 'user', userId: session.userId },
          after: { kind: 'mappings', row_count: changed },
          ip: request.ip,
        });
      }
      return report(read.rows.length, errors, apply);
    },

    exportMappings: async ({ tenant }) => {
      const rows = await repo.exportListings(tenant);
      const text =
        UTF8_BOM +
        toCsv(
          ['listing_id', 'account', 'provider', 'external_sku', 'external_id', 'title', 'sku'],
          rows.map((r) => [
            r.id,
            // A child user may not see the account's company (ARCHITECTURE 6.1).
            r.accountName ?? 'another company',
            r.provider,
            r.externalSku,
            r.externalId,
            r.title ?? '',
            r.sku ?? '',
          ]),
        );
      const bytes = Buffer.from(text, 'utf8');
      return {
        status: 200,
        body: {
          stream: Readable.from([bytes]),
          contentType: 'text/csv; charset=utf-8',
          sizeBytes: bytes.length,
        },
      };
    },
  };
}

async function mustListing(repo: CatalogueRepository, tenant: TenantContext, id: string) {
  const found = await repo.getListing(tenant, id);
  if (found === undefined) throw new ApiError({ status: 404, code: 'not_found' });
  return found;
}

function dims(d: { length_mm: number; width_mm: number; height_mm: number } | null) {
  return d === null ? null : { lengthMm: d.length_mm, widthMm: d.width_mm, heightMm: d.height_mm };
}

function reorder(r: { lead_time_days: number; safety_days: number; target_cover_days: number }) {
  return {
    leadTimeDays: r.lead_time_days,
    safetyDays: r.safety_days,
    targetCoverDays: r.target_cover_days,
  };
}
