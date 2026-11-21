import {
  ApiError,
  NotAMember,
  OAUTH_PROVIDERS,
  type Notifier,
  type OAuthProvider,
  type TenantRunner,
} from '@omnibridge/core';
import type { connectionRoutes, OAuthReturnError } from '@omnibridge/contract';
import type {
  AccountCredentials,
  AuditLog,
  Connection,
  ConnectionDetail,
  ConnectionRepository,
  OAuthStateRepository,
} from '@omnibridge/db';
import { oauthStateWorkspace } from '@omnibridge/db';
import type { Logger } from '@omnibridge/logger';
import type { Handlers } from './contract.ts';
import type { OAuthFlows } from './oauth-exchange.ts';

/**
 * Connections (T-0701: INT-4) and the OAuth connect flow (INT-2, INT-3). The kill switch and bulk
 * confirmation are T-0702's; until then they find nothing (404).
 */
export interface ConnectionOptions {
  connections: Pick<ConnectionRepository, 'list' | 'get' | 'recordSuccess'>;
  /** The global maintenance switch as users see it (SAFE-3); off until T-0702 adds it. */
  maintenance?: () => Promise<{ on: boolean; since: Date | null }>;
  oauth: {
    flows: OAuthFlows;
    states: Pick<OAuthStateRepository, 'create' | 'take'>;
    credentials: Pick<AccountCredentials, 'replace'>;
    /** The public tenancy for the OAuth return, which has no session (SameSite=Strict). */
    tenancy: TenantRunner;
    audit: Pick<AuditLog, 'record'>;
    notifier: Pick<Notifier, 'resolve'>;
    /** https://app.example: the provider sends the browser back under it. */
    appOrigin: string;
  };
  logger: Logger;
  now?: () => Date;
}

const notFound = () => Promise.reject(new ApiError({ status: 404, code: 'not_found' }));
const iso = (d: Date | null) => (d === null ? null : d.toISOString());

function body(c: Connection) {
  return {
    id: c.id,
    provider: c.provider,
    display_name: c.displayName,
    company_id: c.companyId,
    status: c.status,
    last_success_at: iso(c.lastSuccessAt),
    last_token_refresh_at: iso(c.lastTokenRefreshAt),
    consecutive_auth_failures: c.authFailures,
    usage_today: c.usageToday.map((u) => ({ api: u.api, calls: u.calls, cap: u.cap })),
    kill_switch: { paused: c.pausedAt !== null, paused_at: iso(c.pausedAt) },
  };
}

function detail(c: ConnectionDetail) {
  return {
    ...body(c),
    needs_reauth_at: iso(c.needsReauthAt),
    last_error:
      c.lastError === null ? null : { code: c.lastError.code, at: c.lastError.at.toISOString() },
    streams: c.streams.map((s) => ({
      stream: s.stream,
      cursor_at: iso(s.cursorAt),
      last_success_at: iso(s.lastSuccessAt),
    })),
    credentials: c.credentials.map((k) => ({
      kind: k.kind,
      slot: k.slot,
      expires_at: iso(k.expiresAt),
    })),
  };
}

const isOAuth = (provider: string): provider is OAuthProvider =>
  (OAUTH_PROVIDERS as readonly string[]).includes(provider);

export function connectionHandlers(options?: ConnectionOptions): Handlers<typeof connectionRoutes> {
  if (options === undefined) {
    return {
      listConnections: notFound,
      getConnection: notFound,
      setKillSwitch: notFound,
      startAuthorisation: notFound,
      oauthCallback: () =>
        Promise.reject(new ApiError({ status: 503, code: 'service_unavailable' })),
      previewBulkWrite: notFound,
      confirmBulkWrite: notFound,
    };
  }
  const o = options;
  const now = o.now ?? (() => new Date());
  const callback = (provider: OAuthProvider) =>
    `${o.oauth.appOrigin}/api/oauth/${provider}/callback`;
  const back = (query: string) => ({
    status: 303 as const,
    body: null,
    headers: { location: `${o.oauth.appOrigin}/connections?${query}` },
  });
  const fail = (code: OAuthReturnError) => back(`error=${code}`);

  return {
    listConnections: async ({ tenant }) => {
      const items = await o.connections.list(tenant, now());
      const maintenance = (await o.maintenance?.()) ?? { on: false, since: null };
      return {
        status: 200,
        body: {
          items: items.map(body),
          maintenance: { on: maintenance.on, since: iso(maintenance.since) },
        },
      };
    },

    getConnection: async ({ tenant, params }) => {
      const found = await o.connections.get(tenant, params.accountId, now());
      if (found === undefined) throw new ApiError({ status: 404, code: 'not_found' });
      return { status: 200, body: detail(found) };
    },

    setKillSwitch: notFound,

    startAuthorisation: async ({ tenant, session, params }) => {
      const found = await o.connections.get(tenant, params.accountId, now());
      if (found === undefined) throw new ApiError({ status: 404, code: 'not_found' });
      if (!isOAuth(found.provider)) {
        throw new ApiError({
          status: 409,
          code: 'conflict',
          detail: 'This account connects with an API key, not a provider sign-in',
        });
      }
      const state = await o.oauth.states.create(
        tenant,
        { channelAccountId: found.id, userId: session.userId, provider: found.provider },
        now(),
      );
      const url = await o.oauth.flows.consent(found.provider, state, callback(found.provider));
      if (url === undefined) {
        throw new ApiError({
          status: 409,
          code: 'conflict',
          detail: 'Connecting this provider is not available here yet',
        });
      }
      return { status: 200, body: { redirect_url: url } };
    },

    oauthCallback: async ({ params, query }) => {
      const provider = params.provider;
      const workspaceId = oauthStateWorkspace(query.state);
      if (workspaceId === undefined) return fail('state_invalid');
      // Single use: the state is taken first, whatever happens next.
      const taken = await o.oauth.tenancy.runWorkspace({ workspaceId }, (ctx) =>
        o.oauth.states.take(ctx, query.state, provider, now()),
      );
      if (taken === undefined) return fail('state_invalid');
      const code = query.code ?? query.spapi_oauth_code;
      if (query.error !== undefined || code === undefined) return fail('access_denied');
      let grant;
      try {
        // The one web provider call (INT-2), with no transaction open (invariant 3).
        grant = await o.oauth.flows.exchange(provider, code, callback(provider));
      } catch (err) {
        o.logger.warn(
          {
            event: 'oauth.exchange_failed',
            workspaceId,
            channelAccountId: taken.channelAccountId,
            provider,
            err,
          },
          'OAuth code exchange failed',
        );
        return fail('exchange_failed');
      }
      try {
        await o.oauth.tenancy.runMember(
          { workspaceId, userId: taken.userId },
          async (ctx, access) => {
            // Only an admin who is still one may connect an account (Connections is admin-only).
            if (access.role !== 'admin') throw new ApiError({ status: 403, code: 'forbidden' });
            await o.oauth.credentials.replace(
              ctx,
              taken.channelAccountId,
              provider,
              grant.refreshToken,
              grant.refreshTokenExpiresAt ?? undefined,
            );
            const { reauthCleared } = await o.connections.recordSuccess(
              ctx,
              taken.channelAccountId,
              now(),
              { tokenRefreshed: true },
            );
            if (reauthCleared) {
              await o.oauth.notifier.resolve(ctx, 'channel.auth_lost', {
                kind: 'channel_account',
                id: taken.channelAccountId,
              });
            }
            await o.oauth.audit.record(ctx, {
              action: 'connection.reauthorised',
              actor: { kind: 'user', userId: taken.userId },
              entityId: taken.channelAccountId,
              after: {
                provider,
                expires_at: grant.refreshTokenExpiresAt?.toISOString() ?? null,
              },
            });
          },
        );
      } catch (err) {
        // No longer an admin, or no longer a member at all: the token is not stored.
        if (err instanceof ApiError || err instanceof NotAMember) return fail('forbidden');
        throw err;
      }
      return back(`connected=${encodeURIComponent(taken.channelAccountId)}`);
    },

    previewBulkWrite: notFound,
    confirmBulkWrite: notFound,
  };
}
