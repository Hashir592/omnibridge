import type { Kysely } from 'kysely';
import {
  ChannelAccountRepository,
  CompanyRepository,
  Tenancy,
  WorkspaceRepository,
  type ChannelProvider,
  type MainDb,
  type NewCompany,
} from '../index.ts';

/**
 * The launch configuration (PRD §0.3) as synthetic seed data for local development and tests.
 * The client's names appear only in seed files (TEN-4, invariant 6); every other field is made
 * up: no real company number, VAT number or address. Carrier accounts (one Evri and one DPD, both
 * owned by the fulfilment company) arrive with M12.
 *
 * Fixed ids make the seed safe to run again: it only adds what is missing.
 */
export const LAUNCH_WORKSPACE_ID = '5eed0000-0000-4000-8000-000000000001';

const address = { line1: '1 Example Street', city: 'Example Town', postcode: 'EX1 1AA' };

const COMPANIES: (NewCompany & { id: string })[] = [
  {
    // Fulfilment provider: owns all stock purchases, staff and overheads, and the website.
    id: '5eed0000-0000-4000-8000-0000000000c1',
    legalName: 'Jeez Ltd',
    tradingName: 'Jeez',
    registeredAddress: address,
    isFulfilmentProvider: true,
    isPurchasingCompany: true,
    badgeColour: '#0F6B66',
  },
  {
    id: '5eed0000-0000-4000-8000-0000000000c2',
    legalName: 'Sidson Ltd',
    tradingName: 'Sidson',
    registeredAddress: address,
    badgeColour: '#7A4FB8',
  },
  {
    id: '5eed0000-0000-4000-8000-0000000000c3',
    legalName: 'Kyyz Ltd',
    tradingName: 'Kyyz',
    registeredAddress: address,
    badgeColour: '#B85C1F',
  },
];

const PER_COMPANY: [ChannelProvider, string][] = [
  ['amazon', 'Amazon UK'],
  ['amazon_ads', 'Amazon Ads'],
  // The real eBay account count is set at connection time; the seed starts with one each.
  ['ebay', 'eBay'],
];

const ACCOUNTS = [
  ...COMPANIES.flatMap((company, c) =>
    PER_COMPANY.map(([provider, label], p) => ({
      id: `5eed0000-0000-4000-8000-0000000a${String(c + 1)}${String(p + 1).padStart(3, '0')}`,
      companyId: company.id,
      provider,
      displayName: `${company.tradingName} ${label}`,
    })),
  ),
  {
    id: '5eed0000-0000-4000-8000-0000000b0001',
    companyId: '5eed0000-0000-4000-8000-0000000000c1',
    provider: 'website' as const,
    displayName: 'JeezMart',
  },
];

export interface SeedResult {
  workspaceId: string;
  companyIds: string[];
  created: { workspaces: number; companies: number; channelAccounts: number };
}

/** Adds whatever part of the launch configuration is missing; running it twice changes nothing. */
export async function seedLaunch(db: Kysely<MainDb>): Promise<SeedResult> {
  const tenancy = new Tenancy(db);
  const workspaces = new WorkspaceRepository(db);
  const companies = new CompanyRepository(db);
  const accounts = new ChannelAccountRepository(db);
  const created = { workspaces: 0, companies: 0, channelAccounts: 0 };
  const workspaceId = LAUNCH_WORKSPACE_ID;

  await tenancy.run({ workspaceId, companyIds: [] }, async (ctx) => {
    if ((await workspaces.get(ctx)) !== undefined) return;
    await workspaces.create(ctx, { name: 'Jeez Group' });
    created.workspaces += 1;
  });
  await tenancy.runWorkspace({ workspaceId }, async (ctx) => {
    const existing = new Set((await companies.list(ctx)).map((c) => c.id));
    for (const company of COMPANIES.filter((c) => !existing.has(c.id))) {
      await companies.create(ctx, company);
      created.companies += 1;
    }
  });
  // A new transaction, so the companies just added are in the context's company list.
  await tenancy.runWorkspace({ workspaceId }, async (ctx) => {
    const existing = new Set((await accounts.list(ctx)).map((a) => a.id));
    for (const account of ACCOUNTS.filter((a) => !existing.has(a.id))) {
      await accounts.create(ctx, account);
      created.channelAccounts += 1;
    }
  });
  return { workspaceId, companyIds: COMPANIES.map((c) => c.id), created };
}
