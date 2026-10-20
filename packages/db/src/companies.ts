import { randomUUID } from 'node:crypto';
import type { TenantContext } from '@omnibridge/core';
import type { Kysely } from 'kysely';
import type { MainDb, VatPeriod } from './schema.ts';
import { withTenantTransaction } from './tenant.ts';

export interface CompanyAddress {
  line1: string;
  line2?: string;
  city: string;
  postcode: string;
  /** ISO 3166-1 alpha-2; GB when left out. */
  country?: string;
}

/** A company's TEN-2 fields. */
export interface NewCompany {
  /** Chosen by the caller only for seed data with fixed ids. */
  id?: string;
  legalName: string;
  tradingName: string;
  companyNumber?: string | null;
  vatNumber?: string | null;
  registeredAddress: CompanyAddress;
  vatPeriod?: VatPeriod;
  /** Left out: false, except for the workspace's first company, which is both (TEN-2). */
  isFulfilmentProvider?: boolean;
  isPurchasingCompany?: boolean;
  /** `#RRGGBB`, upper case. */
  badgeColour?: string;
}

export interface Company {
  id: string;
  legalName: string;
  tradingName: string;
  companyNumber: string | null;
  vatNumber: string | null;
  registeredAddress: {
    line1: string;
    line2?: string;
    city: string;
    postcode: string;
    country: string;
  };
  vatPeriod: VatPeriod;
  isFulfilmentProvider: boolean;
  isPurchasingCompany: boolean;
  badgeColour: string;
}

/**
 * app.companies (TEN-2). Reads see only the companies in `ctx.companyIds` (the restrictive
 * company policy); a new company is limited by the workspace policy alone.
 */
export class CompanyRepository {
  readonly #db: Kysely<MainDb>;

  constructor(db: Kysely<MainDb>) {
    this.#db = db;
  }

  /** Returns the new company's id. */
  async create(ctx: TenantContext, input: NewCompany): Promise<string> {
    const id = input.id ?? randomUUID();
    const address = input.registeredAddress;
    await withTenantTransaction(this.#db, ctx, (trx) =>
      trx
        .insertInto('app.companies')
        .values({
          id,
          workspace_id: ctx.workspaceId,
          legal_name: input.legalName,
          trading_name: input.tradingName,
          company_number: input.companyNumber ?? null,
          vat_number: input.vatNumber ?? null,
          address_line1: address.line1,
          address_line2: address.line2 ?? null,
          address_city: address.city,
          address_postcode: address.postcode,
          ...(address.country === undefined ? {} : { address_country: address.country }),
          ...(input.vatPeriod === undefined ? {} : { vat_period: input.vatPeriod }),
          ...(input.isFulfilmentProvider === undefined
            ? {}
            : { is_fulfilment_provider: input.isFulfilmentProvider }),
          ...(input.isPurchasingCompany === undefined
            ? {}
            : { is_purchasing_company: input.isPurchasingCompany }),
          ...(input.badgeColour === undefined ? {} : { badge_colour: input.badgeColour }),
        })
        .execute(),
    );
    return id;
  }

  /** The companies in scope, oldest first. */
  async list(ctx: TenantContext): Promise<Company[]> {
    const rows = await withTenantTransaction(this.#db, ctx, (trx) =>
      trx
        .selectFrom('app.companies')
        .selectAll()
        .where('workspace_id', '=', ctx.workspaceId)
        .orderBy('created_at')
        .orderBy('id')
        .execute(),
    );
    return rows.map((row) => ({
      id: row.id,
      legalName: row.legal_name,
      tradingName: row.trading_name,
      companyNumber: row.company_number,
      vatNumber: row.vat_number,
      registeredAddress: {
        line1: row.address_line1,
        ...(row.address_line2 === null ? {} : { line2: row.address_line2 }),
        city: row.address_city,
        postcode: row.address_postcode,
        country: row.address_country,
      },
      vatPeriod: row.vat_period,
      isFulfilmentProvider: row.is_fulfilment_provider,
      isPurchasingCompany: row.is_purchasing_company,
      badgeColour: row.badge_colour,
    }));
  }
}
