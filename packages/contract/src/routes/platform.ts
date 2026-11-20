import { z } from 'zod';
import { defineRoute } from '../route.ts';
import { IncidentSchema, WorkspaceModulesSchema } from './auth.ts';

/**
 * The platform console (T-0504: PLAT-1, PLAT-2, PLAT-3, OPS-6; PS-032). Platform admins only, with
 * MFA, from an allowlisted network; the flag is checked again on every request. Every answer
 * holds IDs, workspace names, statuses, dates and counts, never a tenant's orders, customers,
 * finance or messages (PLAT-3), and there is no impersonation.
 */
const platformConsole = {
  auth: 'platform',
  tab: 'none',
  adminOnly: false,
  companyScoped: false,
} as const;

const NoBody = z.null();
const WorkspaceParams = z.object({ workspaceId: z.uuid() });
const Day = z.iso.date();

export const WorkspaceStatusSchema = z.enum(['active', 'suspended', 'archived']);

export const ConsoleWorkspaceSchema = z
  .object({
    id: z.uuid(),
    name: z.string(),
    status: WorkspaceStatusSchema,
    status_changed_at: z.iso.datetime().nullable(),
    created_at: z.iso.datetime(),
    modules: WorkspaceModulesSchema,
    /** Counts only (PLAT-2); orders per day is null until orders exist (M10). */
    counts: z.object({
      users: z.number().int().min(0),
      channel_accounts: z.number().int().min(0),
      orders_per_day: z.number().int().min(0).nullable(),
    }),
  })
  .meta({ id: 'ConsoleWorkspace' });

const WorkspaceStatusChange = z
  .object({ id: z.uuid(), status: WorkspaceStatusSchema })
  .meta({ id: 'WorkspaceStatusChange' });

/** Every workspace with its status, modules and counts. */
export const listConsoleWorkspaces = defineRoute({
  id: 'listConsoleWorkspaces',
  method: 'GET',
  path: '/platform/workspaces',
  summary: 'List workspaces with counts only',
  responses: { 200: z.object({ items: z.array(ConsoleWorkspaceSchema) }) },
  ...platformConsole,
});

/** Suspends an active workspace: every session in it ends and nobody can sign in to it. 409 otherwise. */
export const suspendWorkspace = defineRoute({
  id: 'suspendWorkspace',
  method: 'POST',
  path: '/platform/workspaces/:workspaceId/suspend',
  summary: 'Suspend a workspace',
  params: WorkspaceParams,
  responses: { 202: WorkspaceStatusChange },
  ...platformConsole,
});

/** Reactivates a suspended workspace. An archived one answers 409: archive is final. */
export const reactivateWorkspace = defineRoute({
  id: 'reactivateWorkspace',
  method: 'POST',
  path: '/platform/workspaces/:workspaceId/reactivate',
  summary: 'Reactivate a suspended workspace',
  params: WorkspaceParams,
  responses: { 202: WorkspaceStatusChange },
  ...platformConsole,
});

/**
 * Archives (closes) an active or suspended workspace for good: sessions end, then a background
 * job runs the workspace_closure deletion, removes every membership and deletes the terms of
 * people left with no workspace (DEL-1). 409 if already archived.
 */
export const archiveWorkspace = defineRoute({
  id: 'archiveWorkspace',
  method: 'POST',
  path: '/platform/workspaces/:workspaceId/archive',
  summary: 'Archive (close) a workspace',
  params: WorkspaceParams,
  responses: { 202: WorkspaceStatusChange },
  ...platformConsole,
});

/** Turns a workspace's modules on or off (PLAT-2, WEB-1); audited. 409 for an archived workspace. */
export const setWorkspaceModules = defineRoute({
  id: 'setWorkspaceModules',
  method: 'PUT',
  path: '/platform/workspaces/:workspaceId/modules',
  summary: "Set a workspace's module toggles",
  params: WorkspaceParams,
  body: WorkspaceModulesSchema.strict(),
  responses: { 200: WorkspaceModulesSchema },
  ...platformConsole,
});

export const PlatformFlagsSchema = z
  .object({
    /** TEN-8: open self sign-up; off at launch. */
    public_signup: z.boolean(),
    updated_at: z.iso.datetime().nullable(),
  })
  .meta({ id: 'PlatformFlags' });

export const getPlatformFlags = defineRoute({
  id: 'getPlatformFlags',
  method: 'GET',
  path: '/platform/flags',
  summary: 'Platform feature flags',
  responses: { 200: PlatformFlagsSchema },
  ...platformConsole,
});

/** Sets the platform flags; every change is audited. */
export const setPlatformFlags = defineRoute({
  id: 'setPlatformFlags',
  method: 'PUT',
  path: '/platform/flags',
  summary: 'Set platform feature flags',
  body: z.object({ public_signup: z.boolean() }).strict(),
  responses: { 200: PlatformFlagsSchema },
  ...platformConsole,
});

export const QueueOverviewSchema = z
  .object({
    type: z.string(),
    queued: z.number().int().min(0),
    active: z.number().int().min(0),
    failed: z.number().int().min(0),
    dead_letter: z.number().int().min(0),
  })
  .meta({ id: 'QueueOverview' });

/** Depth per job type (pg-boss's cached counts, which lag by up to a minute). */
export const getQueueOverview = defineRoute({
  id: 'getQueueOverview',
  method: 'GET',
  path: '/platform/jobs',
  summary: 'Job queue depth per type',
  responses: { 200: z.object({ items: z.array(QueueOverviewSchema) }) },
  ...platformConsole,
});

export const DeadLetterSchema = z
  .object({
    /** The id redrive takes. */
    id: z.uuid(),
    type: z.string(),
    workspace_id: z.uuid().nullable(),
    attempt: z.number().int().min(0).nullable(),
    /** The job record's code, e.g. handler_failed or invalid_envelope; never an error text. */
    error_code: z.string().nullable(),
    dead_lettered_at: z.iso.datetime(),
  })
  .meta({ id: 'DeadLetter' });

/** Dead-lettered jobs, newest first: IDs, type and error code only. */
export const listDeadLetters = defineRoute({
  id: 'listDeadLetters',
  method: 'GET',
  path: '/platform/jobs/dead-letters',
  summary: 'Dead-lettered jobs',
  query: z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }),
  responses: { 200: z.object({ items: z.array(DeadLetterSchema) }) },
  ...platformConsole,
});

/** Moves one dead-lettered job back to its queue (NFR-3); the others stay. 404 if it is not there. */
export const redriveDeadLetter = defineRoute({
  id: 'redriveDeadLetter',
  method: 'POST',
  path: '/platform/jobs/:type/dead-letters/:id/redrive',
  summary: 'Redrive one dead-lettered job',
  params: z.object({
    type: z
      .string()
      .regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/)
      .max(64),
    id: z.uuid(),
  }),
  responses: { 202: z.object({ id: z.uuid() }) },
  ...platformConsole,
});

export const ApiUsageSchema = z
  .object({
    workspace_id: z.uuid(),
    channel_account_id: z.uuid(),
    provider: z.string(),
    api: z.string(),
    /** The provider's own day: US Pacific for eBay, UTC for the rest. */
    day: Day,
    calls: z.number().int().min(0),
    cap: z.number().int().min(0).nullable(),
  })
  .meta({ id: 'ApiUsage' });

/** API usage against limits per provider and account (PLAT-2), fed by M07 onwards. */
export const listApiUsage = defineRoute({
  id: 'listApiUsage',
  method: 'GET',
  path: '/platform/api-usage',
  summary: 'API usage per provider and account',
  query: z.object({ from: Day.optional(), to: Day.optional() }),
  responses: { 200: z.object({ items: z.array(ApiUsageSchema) }) },
  ...platformConsole,
});

export const CredentialExpirySchema = z
  .object({
    workspace_id: z.uuid(),
    channel_account_id: z.uuid().nullable(),
    kind: z.string(),
    slot: z.enum(['current', 'next']),
    expires_at: z.iso.datetime(),
  })
  .meta({ id: 'CredentialExpiry' });

/** The credential-expiry calendar (PLAT-2): what expires within `within_days`. Never a value. */
export const listCredentialExpiry = defineRoute({
  id: 'listCredentialExpiry',
  method: 'GET',
  path: '/platform/credential-expiry',
  summary: 'Credentials expiring soon',
  query: z.object({ within_days: z.coerce.number().int().min(1).max(365).default(30) }),
  responses: { 200: z.object({ items: z.array(CredentialExpirySchema) }) },
  ...platformConsole,
});

const ServiceState = z.enum(['ok', 'error']);

export const PlatformHealthSchema = z
  .object({
    status: z.enum(['ok', 'degraded']),
    services: z.object({
      web: ServiceState,
      db_main: ServiceState,
      pii_vault: ServiceState,
      /** The worker finished its minute heartbeat in the last 150 seconds. */
      worker: ServiceState,
    }),
    worker_heartbeat_at: z.iso.datetime().nullable(),
    queue: z.object({
      queued: z.number().int().min(0),
      dead_letter: z.number().int().min(0),
    }),
    version: z.string(),
  })
  .meta({ id: 'PlatformHealth' });

/** System health (PLAT-2): the /healthz checks per service, the worker and the queue backlog. */
export const getPlatformHealth = defineRoute({
  id: 'getPlatformHealth',
  method: 'GET',
  path: '/platform/health',
  summary: 'System health',
  responses: { 200: PlatformHealthSchema },
  ...platformConsole,
});

export const getIncidentBanner = defineRoute({
  id: 'getIncidentBanner',
  method: 'GET',
  path: '/platform/incident-banner',
  summary: 'The incident banner',
  responses: { 200: z.object({ incident: IncidentSchema.nullable() }) },
  ...platformConsole,
});

/** Shows a banner to every signed-in user (GET /auth/session carries it); audited. */
export const setIncidentBanner = defineRoute({
  id: 'setIncidentBanner',
  method: 'PUT',
  path: '/platform/incident-banner',
  summary: 'Set the incident banner',
  body: z
    .object({
      message: z
        .string()
        .trim()
        .min(1)
        .max(200)
        .refine((m) => !m.includes('@'), 'No email addresses in the banner'),
      severity: z.enum(['info', 'warning', 'critical']),
    })
    .strict(),
  responses: { 200: z.object({ incident: IncidentSchema }) },
  ...platformConsole,
});

export const clearIncidentBanner = defineRoute({
  id: 'clearIncidentBanner',
  method: 'DELETE',
  path: '/platform/incident-banner',
  summary: 'Clear the incident banner',
  responses: { 204: NoBody },
  ...platformConsole,
});

export const platformRoutes = [
  listConsoleWorkspaces,
  suspendWorkspace,
  reactivateWorkspace,
  archiveWorkspace,
  setWorkspaceModules,
  getPlatformFlags,
  setPlatformFlags,
  getQueueOverview,
  listDeadLetters,
  redriveDeadLetter,
  listApiUsage,
  listCredentialExpiry,
  getPlatformHealth,
  getIncidentBanner,
  setIncidentBanner,
  clearIncidentBanner,
] as const;
