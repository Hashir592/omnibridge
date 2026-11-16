/**
 * Mock signed-in user (T-0301). Two personas let Hashir see permission mirroring (PERM-3/PERM-4):
 * an admin who sees every tab and company, and a packer child with Orders + Shipping for two companies.
 * A third persona is the admin of a second workspace whose website connector is off (ADR-059), so
 * the Website channel disappears everywhere.
 * The handlers read the same persona, so lists and counts shrink with it, as the server would.
 */
import { channelAccounts, companies } from './data.ts';
import type { Channel, Session, Tab } from './types.ts';

export type Persona = 'admin' | 'packer' | 'starter';

const ALL_TABS: Tab[] = [
  'home',
  'orders',
  'shipping',
  'stock',
  'customer_service',
  'account_health',
  'advertising',
  'sales_profit',
  'forecasting',
  'finance',
  'reminders',
  'notes',
];

let persona: Persona = 'admin';

export function setPersona(p: Persona): void {
  persona = p;
}

export function getPersona(): Persona {
  return persona;
}

/** The website_connector module of the current workspace (ADR-059). */
export function websiteConnector(): boolean {
  return persona !== 'starter';
}

/** False for the Website channel when the workspace's website connector is off. */
export function channelOn(channel: Channel): boolean {
  return channel !== 'website' || websiteConnector();
}

export function currentSession(): Session {
  const modules = { website_connector: websiteConnector() };
  if (persona === 'starter') {
    return {
      user: {
        name: 'Robin Admin',
        initials: 'RA',
        isAdmin: true,
        email: 'robin.admin@example.com',
      },
      workspace: 'Starter workspace',
      tabs: ALL_TABS,
      companies,
      channelAccounts: channelAccounts.filter((a) => channelOn(a.channel)),
      modules,
    };
  }
  if (persona === 'admin') {
    return {
      user: { name: 'Sam Admin', initials: 'SA', isAdmin: true, email: 'sam.admin@example.com' },
      workspace: 'Demo workspace',
      tabs: ALL_TABS,
      companies,
      channelAccounts,
      modules,
    };
  }
  const allowed = new Set(['co_1', 'co_2']);
  return {
    user: { name: 'Pat Packer', initials: 'PP', isAdmin: false, email: 'pat.packer@example.com' },
    workspace: 'Demo workspace',
    tabs: ['home', 'orders', 'shipping'],
    companies: companies.filter((c) => allowed.has(c.id)),
    channelAccounts: channelAccounts.filter((a) => allowed.has(a.companyId)),
    modules,
  };
}
