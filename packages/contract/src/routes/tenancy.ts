import { z } from 'zod';
import { defineRoute } from '../route.ts';

const Name = z.string().trim().min(1).max(200);

export const AddressSchema = z
  .object({
    line1: Name,
    line2: Name.optional(),
    city: z.string().trim().min(1).max(100),
    postcode: z.string().trim().toUpperCase().min(2).max(10),
    /** ISO 3166-1 alpha-2; GB when left out. */
    country: z
      .string()
      .regex(/^[A-Z]{2}$/)
      .optional(),
  })
  .meta({ id: 'Address' });

const VatPeriod = z.enum(['stagger_1', 'stagger_2', 'stagger_3', 'monthly']);

/** A new company (TEN-2). Created by a platform admin today; the first-run wizard later (TEN-9). */
export const NewCompanySchema = z
  .object({
    legal_name: Name,
    trading_name: Name,
    company_number: z
      .string()
      .regex(/^[A-Z0-9]{8}$/)
      .nullable()
      .optional(),
    vat_number: z
      .string()
      .regex(/^GB([0-9]{9}|[0-9]{12})$/)
      .nullable()
      .optional(),
    registered_address: AddressSchema,
    /** VAT quarter stagger (section 5.8); stagger 1 when left out. */
    vat_period: VatPeriod.optional(),
    /** Left out: false, except for the first company of a workspace, which is both (TEN-2). */
    is_fulfilment_provider: z.boolean().optional(),
    is_purchasing_company: z.boolean().optional(),
    badge_colour: z
      .string()
      .regex(/^#[0-9A-F]{6}$/)
      .optional(),
  })
  .meta({ id: 'NewCompany' });

export const CompanySchema = z
  .object({
    id: z.uuid(),
    legal_name: z.string(),
    trading_name: z.string(),
    company_number: z.string().nullable(),
    vat_number: z.string().nullable(),
    vat_period: VatPeriod,
    is_fulfilment_provider: z.boolean(),
    is_purchasing_company: z.boolean(),
    badge_colour: z.string(),
  })
  .meta({ id: 'Company' });

export type Company = z.infer<typeof CompanySchema>;

const Created = z.object({ id: z.uuid() }).meta({ id: 'Created' });

/**
 * Creates a workspace (PLAT-2, TEN-7). The plan is `free_internal` and limits are optional
 * (TEN-10). The answer carries the new id only.
 */
export const createWorkspace = defineRoute({
  id: 'createWorkspace',
  method: 'POST',
  path: '/platform/workspaces',
  summary: 'Create a workspace',
  body: z.object({
    name: Name,
    max_channel_accounts: z.number().int().min(1).nullable().optional(),
    max_users: z.number().int().min(1).nullable().optional(),
  }),
  responses: { 201: Created },
  auth: 'platform',
  tab: 'none',
  adminOnly: false,
  companyScoped: false,
});

/** Adds a company to a workspace (TEN-2). The answer carries the new id only (PLAT-3). */
export const createCompany = defineRoute({
  id: 'createCompany',
  method: 'POST',
  path: '/platform/workspaces/:workspaceId/companies',
  summary: 'Add a company to a workspace',
  params: z.object({ workspaceId: z.uuid() }),
  body: NewCompanySchema,
  responses: { 201: Created },
  auth: 'platform',
  tab: 'none',
  adminOnly: false,
  companyScoped: false,
});

/**
 * The companies the signed-in user may see, for the company switcher (TEN-5): their permitted
 * companies only, never the whole workspace (invariant 4).
 */
export const listCompanies = defineRoute({
  id: 'listCompanies',
  method: 'GET',
  path: '/companies',
  summary: 'Companies the signed-in user may see',
  responses: { 200: z.object({ items: z.array(CompanySchema) }) },
  auth: 'session',
  tab: 'none',
  adminOnly: false,
  companyScoped: true,
});
