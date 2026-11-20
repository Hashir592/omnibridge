import { z } from 'zod';
import { defineRoute } from '../route.ts';

/*
 * M07: the Connections page (INT-4), the kill switch (SAFE-2), the OAuth return (INT-2's one
 * exception) and bulk-write confirmation (SAFE-1). Admins only: Connections is an admin tab.
 */

const connectionsTab = {
  auth: 'session',
  tab: 'connections',
  adminOnly: true,
  companyScoped: true,
} as const;

const At = z.iso.datetime();
const AccountParams = z.object({ accountId: z.uuid() });

/** Every provider an account can belong to: the origin tags minus `manual` (INT-6). */
export const ProviderSchema = z
  .enum(['amazon', 'amazon_ads', 'ebay', 'website', 'evri', 'dpd'])
  .meta({ id: 'Provider' });

/** The providers whose accounts are connected with OAuth (the others take an API key). */
export const OAuthProviderSchema = z.enum(['amazon', 'amazon_ads', 'ebay']).meta({
  id: 'OAuthProvider',
});

/**
 * INT-4. Worked out in this order: disconnected (no active token, or archived), needs_reauth
 * (AMZ-12, EBAY-5), paused (the kill switch), error (the last call failed), active.
 */
export const ConnectionStatusSchema = z
  .enum(['active', 'needs_reauth', 'paused', 'error', 'disconnected'])
  .meta({ id: 'ConnectionStatus' });

/** Calls today against the limit, per API, in the provider's own day (RL-5). */
export const ApiUsageTodaySchema = z
  .object({
    api: z.string(),
    calls: z.number().int().min(0),
    /** Null when the provider sets no daily cap for this API (Amazon and carriers limit by rate). */
    cap: z.number().int().min(0).nullable(),
  })
  .meta({ id: 'ApiUsageToday' });

export const KillSwitchSchema = z
  .object({ paused: z.boolean(), paused_at: At.nullable() })
  .meta({ id: 'KillSwitch' });

/** One channel or carrier account as the Connections page lists it (INT-4). */
export const ConnectionSchema = z
  .object({
    id: z.uuid(),
    provider: ProviderSchema,
    display_name: z.string(),
    company_id: z.uuid(),
    status: ConnectionStatusSchema,
    last_success_at: At.nullable(),
    last_token_refresh_at: At.nullable(),
    consecutive_auth_failures: z.number().int().min(0),
    usage_today: z.array(ApiUsageTodaySchema),
    kill_switch: KillSwitchSchema,
  })
  .meta({ id: 'Connection' });

export const ConnectionDetailSchema = ConnectionSchema.extend({
  needs_reauth_at: At.nullable(),
  /** The last failed call: a stable code only, never a provider message or a value. */
  last_error: z.object({ code: z.string(), at: At }).nullable(),
  /** Incremental sync streams (INT-8). */
  streams: z.array(
    z.object({
      stream: z.string(),
      cursor_at: At.nullable(),
      last_success_at: At.nullable(),
    }),
  ),
  /** Stored tokens by kind and slot, with the provider's expiry; never a value (INT-3). */
  credentials: z.array(
    z.object({
      kind: z.string(),
      slot: z.enum(['current', 'next']),
      expires_at: At.nullable(),
    }),
  ),
}).meta({ id: 'ConnectionDetail' });

/** The global maintenance switch as workspace users see it (SAFE-3). */
export const MaintenanceStateSchema = z
  .object({ on: z.boolean(), since: At.nullable() })
  .meta({ id: 'MaintenanceState' });

/** Every account of the companies in scope, with the maintenance switch. */
export const listConnections = defineRoute({
  id: 'listConnections',
  method: 'GET',
  path: '/connections',
  summary: 'Channel and carrier accounts with their health',
  responses: {
    200: z.object({ items: z.array(ConnectionSchema), maintenance: MaintenanceStateSchema }),
  },
  ...connectionsTab,
});

export const getConnection = defineRoute({
  id: 'getConnection',
  method: 'GET',
  path: '/connections/:accountId',
  summary: 'One account with usage, sync streams and token expiry',
  params: AccountParams,
  responses: { 200: ConnectionDetailSchema },
  ...connectionsTab,
});

/**
 * Pauses or resumes every automated write to one account: stock, tracking, ads and review
 * requests (SAFE-2). Reads go on. Audited. Resuming sends the paused writes at once.
 */
export const setKillSwitch = defineRoute({
  id: 'setKillSwitch',
  method: 'PUT',
  path: '/connections/:accountId/kill-switch',
  summary: "Pause or resume an account's automated writes",
  params: AccountParams,
  body: z.object({ paused: z.boolean() }).strict(),
  responses: { 200: ConnectionSchema },
  ...connectionsTab,
});

/**
 * Starts the provider's consent flow for an OAuth account: answers the URL to send the browser
 * to, carrying a signed single-use state (10 minutes). 409 for an API-key provider.
 */
export const startAuthorisation = defineRoute({
  id: 'startAuthorisation',
  method: 'POST',
  path: '/connections/:accountId/authorise',
  summary: 'Start connecting or re-authorising an account',
  params: AccountParams,
  responses: { 200: z.object({ redirect_url: z.url() }).meta({ id: 'AuthorisationStart' }) },
  ...connectionsTab,
});

/**
 * The provider sends the browser back here. Public: the SameSite=Strict session cookie is not
 * sent on that cross-site redirect, so the single-use state names the account and the admin.
 * The code is exchanged for tokens (the one provider call web makes, INT-2), stored encrypted,
 * and the browser goes on to /connections with `connected` or `error` in the query.
 */
export const oauthCallback = defineRoute({
  id: 'oauthCallback',
  method: 'GET',
  path: '/oauth/:provider/callback',
  summary: 'OAuth return from a provider',
  params: z.object({ provider: OAuthProviderSchema }),
  query: z.object({
    state: z.string().min(1).max(512),
    /** eBay and Amazon Ads. */
    code: z.string().min(1).max(2048).optional(),
    /** Amazon SP-API's website authorisation workflow. */
    spapi_oauth_code: z.string().min(1).max(2048).optional(),
    selling_partner_id: z.string().min(1).max(64).optional(),
    /** The seller declined, or the provider failed. */
    error: z.string().min(1).max(200).optional(),
  }),
  responses: { 303: z.null() },
  auth: 'public',
  tab: 'none',
  adminOnly: false,
  companyScoped: false,
});

/** Writes that reach more than one account at once (SAFE-1). Modules register their handlers. */
export const BulkActionSchema = z
  .enum(['stock_push', 'tracking_resend', 'ads_change'])
  .meta({ id: 'BulkAction' });

const BulkParamValue = z.union([
  z.string().max(200),
  z.number().int(),
  z.boolean(),
  z.array(z.uuid()).max(1000),
]);

export const BulkPreviewSchema = z
  .object({
    /** Single use, 10 minutes, for this user only. */
    token: z.string(),
    expires_at: At,
    action: BulkActionSchema,
    /** Every account the write will reach, by name: the dialog lists each one (SAFE-1). */
    accounts: z.array(
      z.object({
        id: z.uuid(),
        provider: ProviderSchema,
        display_name: z.string(),
        company_id: z.uuid(),
        /** Paused by its kill switch: its writes wait until it is resumed. */
        paused: z.boolean(),
      }),
    ),
  })
  .meta({ id: 'BulkPreview' });

const bulkRoute = {
  auth: 'session',
  // The action's own tab is checked by the handler (stock_push: stock-catalogue, and so on).
  tab: 'none',
  adminOnly: false,
  companyScoped: true,
} as const;

/** Names every account a bulk write would reach, and issues the token that confirms it. */
export const previewBulkWrite = defineRoute({
  id: 'previewBulkWrite',
  method: 'POST',
  path: '/bulk-writes/preview',
  summary: 'Preview a write to several accounts',
  body: z
    .object({
      action: BulkActionSchema,
      channel_account_ids: z.array(z.uuid()).min(2).max(100),
      /** IDs, numbers and flags only, checked by the action's own schema. */
      params: z.record(z.string(), BulkParamValue).optional(),
    })
    .strict(),
  responses: { 200: BulkPreviewSchema },
  ...bulkRoute,
});

/**
 * Runs exactly what the preview named, once. 404 for a token this user's workspace never issued;
 * 409 for one that has expired, was used, belongs to another user, or whose accounts are no
 * longer all in scope.
 */
export const confirmBulkWrite = defineRoute({
  id: 'confirmBulkWrite',
  method: 'POST',
  path: '/bulk-writes/confirm',
  summary: 'Confirm a previewed write to several accounts',
  body: z.object({ token: z.string().min(20).max(200) }).strict(),
  responses: {
    202: z
      .object({
        action: BulkActionSchema,
        account_count: z.number().int().min(2),
        queued: z.number().int().min(0),
      })
      .meta({ id: 'BulkConfirmed' }),
  },
  ...bulkRoute,
});

export const connectionRoutes = [
  listConnections,
  getConnection,
  setKillSwitch,
  startAuthorisation,
  oauthCallback,
  previewBulkWrite,
  confirmBulkWrite,
] as const;
