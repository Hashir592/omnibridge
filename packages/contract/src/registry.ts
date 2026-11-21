import { exportAuditEvents, listAuditEvents } from './routes/audit.ts';
import { authRoutes } from './routes/auth.ts';
import { catalogueRoutes } from './routes/catalogue.ts';
import { connectionRoutes } from './routes/connections.ts';
import { getDeletionCertificate } from './routes/deletion.ts';
import { getHealth } from './routes/health.ts';
import { getFile } from './routes/files.ts';
import { getJob } from './routes/jobs.ts';
import { notificationRoutes } from './routes/notifications.ts';
import { platformRoutes } from './routes/platform.ts';
import { privacyRoutes } from './routes/privacy.ts';
import { stockRoutes } from './routes/stock.ts';
import { createCompany, createWorkspace, listCompanies } from './routes/tenancy.ts';
import { userRoutes } from './routes/users.ts';
import { webhookRoutes } from './routes/webhooks.ts';

/**
 * Every route the web app serves. The server registers routes only from this list, and the
 * route walker (packages/testkit) checks every entry. Add new routes here.
 */
export const contractRoutes = [
  getHealth,
  getJob,
  getFile,
  listCompanies,
  createWorkspace,
  createCompany,
  listAuditEvents,
  exportAuditEvents,
  getDeletionCertificate,
  ...authRoutes,
  ...webhookRoutes,
  ...userRoutes,
  ...privacyRoutes,
  ...notificationRoutes,
  ...platformRoutes,
  ...connectionRoutes,
  ...catalogueRoutes,
  ...stockRoutes,
] as const;

export type ContractRoutes = typeof contractRoutes;

/** Fixed document info, so openapi.json changes only when the contract does. */
export const OPENAPI_INFO = {
  title: 'OmniBridge API',
  version: '0.1.0',
  description: 'Generated from packages/contract. Do not edit by hand: run `pnpm contract:gen`.',
} as const;
