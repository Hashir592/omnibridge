import { createHash, randomBytes } from 'node:crypto';
import type { websiteRoutes } from '@omnibridge/contract';
import { ApiError, type TenantContext, type TenantRunner } from '@omnibridge/core';
import { Secret } from '@omnibridge/crypto';
import type {
  AccountCredentials,
  AuditLog,
  ChannelAccountRepository,
  ConnectionRepository,
  WebsiteConnectionRepository,
} from '@omnibridge/db';
import type { Logger } from '@omnibridge/logger';
import { connectionBody } from './connections.ts';
import type { Handlers } from './contract.ts';

/*
 * M11 website connector and Disconnect (T-1101: WEB-1 to WEB-6, OPS-12, AT-14). Setup is for
 * admins, behind the website_connector module (ADR-059, enforced by the route registry). Website
 * calls are signed (WEB-2) and are stored in the request, buyer details in pii-vault first
 * (ADR-054 FA-04, invariant 7a).
 */

export interface WebsiteOptions {
  connections: Pick<
    WebsiteConnectionRepository,
    'create' | 'settings' | 'setBaseUrl' | 'setKeys' | 'inbound' | 'answered' | 'remember'
  >;
  accounts: Pick<ChannelAccountRepository, 'create'>;
  /** The Connection row an answer carries (INT-4). */
  view: Pick<ConnectionRepository, 'get'>;
  credentials: Pick<AccountCredentials, 'readKind' | 'replaceKind'>;
  audit: Pick<AuditLog, 'record'>;
  /** Opens the tenant transactions of website calls, which have no session. */
  tenancy: TenantRunner;
  /** https://app.example: the website calls `<origin>/api/v1/website/<connection>`. */
  appOrigin: string;
  logger: Logger;
  now?: () => Date;
}

const notFound = () => Promise.reject(new ApiError({ status: 404, code: 'not_found' }));
const missing = () => new ApiError({ status: 404, code: 'not_found' });

/** WEB-1: 32 random bytes, URL-safe; shown once and kept only as a hash or encrypted. */
const newKeys = () => ({
  inbound_api_key: `obw_${randomBytes(32).toString('base64url')}`,
  signing_secret: `obs_${randomBytes(32).toString('base64url')}`,
});
export const keyHash = (key: string): Buffer => createHash('sha256').update(key).digest();

export function websiteHandlers(options?: WebsiteOptions): Handlers<typeof websiteRoutes> {
  if (options === undefined) {
    return {
      createWebsiteConnection: notFound,
      getWebsiteSettings: notFound,
      updateWebsiteSettings: notFound,
      reissueWebsiteKeys: notFound,
      disconnectAccount: notFound,
      websitePushOrder: notFound,
      websiteCancelOrder: notFound,
      websiteRefundOrder: notFound,
      websitePushProducts: notFound,
    };
  }
  const o = options;
  const now = o.now ?? (() => new Date());

  /** The settings the screen shows; never a key. 404 when the account is not a website. */
  const settingsOf = async (tenant: TenantContext, accountId: string) => {
    const row = await o.connections.settings(tenant, accountId);
    if (row === undefined) throw missing();
    const outbound = await o.credentials.readKind(tenant, accountId, 'website.api_key');
    return {
      connection_id: row.channelAccountId,
      inbound_url: `${o.appOrigin}/api/v1/website/${row.channelAccountId}`,
      base_url: row.baseUrl,
      inbound_key_hint: row.inboundKeyHint,
      keys_issued_at: row.keysIssuedAt.toISOString(),
      outbound_key_set: outbound !== undefined,
    };
  };

  /** A new key and secret: the key kept as its hash, the secret encrypted (WEB-1, WEB-2). */
  const issueKeys = async (tenant: TenantContext, accountId: string) => {
    const keys = newKeys();
    await o.credentials.replaceKind(
      tenant,
      accountId,
      'website.signing_secret',
      new Secret(keys.signing_secret),
    );
    return {
      keys,
      keyHash: keyHash(keys.inbound_api_key),
      keyHint: keys.inbound_api_key.slice(-4),
    };
  };

  return {
    createWebsiteConnection: async ({ body, tenant, session, request }) => {
      // A company of another workspace, or one this admin does not see, is not there.
      if (!tenant.companyIds.includes(body.company_id)) throw missing();
      const accountId = await o.accounts.create(tenant, {
        companyId: body.company_id,
        provider: 'website',
        displayName: body.display_name,
        // FA-16: a new account holds its stock writes until its first clean reconciliation.
        holdStockPush: true,
      });
      const { keys, keyHash: hash, keyHint } = await issueKeys(tenant, accountId);
      await o.connections.create(tenant, {
        channelAccountId: accountId,
        companyId: body.company_id,
        baseUrl: body.base_url,
        keyHash: hash,
        keyHint,
      });
      await o.credentials.replaceKind(
        tenant,
        accountId,
        'website.api_key',
        new Secret(body.outbound_api_key),
      );
      await o.audit.record(tenant, {
        action: 'connection.added',
        actor: { kind: 'user', userId: session.userId },
        entityId: accountId,
        after: {
          provider: 'website',
          company_id: body.company_id,
          display_name: body.display_name,
        },
        ip: request.ip,
      });
      const connection = await o.view.get(tenant, accountId, now());
      if (connection === undefined) throw missing();
      return {
        status: 201,
        body: {
          connection: connectionBody(connection),
          settings: await settingsOf(tenant, accountId),
          keys,
        },
      };
    },

    getWebsiteSettings: async ({ params, tenant }) => ({
      status: 200,
      body: await settingsOf(tenant, params.accountId),
    }),

    updateWebsiteSettings: async ({ params, body, tenant, session, request }) => {
      const before = await settingsOf(tenant, params.accountId);
      if (body.base_url !== undefined) {
        await o.connections.setBaseUrl(tenant, params.accountId, body.base_url);
      }
      if (body.outbound_api_key !== undefined) {
        await o.credentials.replaceKind(
          tenant,
          params.accountId,
          'website.api_key',
          new Secret(body.outbound_api_key),
        );
      }
      await o.audit.record(tenant, {
        action: 'website.settings_changed',
        actor: { kind: 'user', userId: session.userId },
        entityId: params.accountId,
        before: { base_url: before.base_url },
        after: {
          base_url: body.base_url ?? before.base_url,
          outbound_key_changed: body.outbound_api_key !== undefined,
        },
        ip: request.ip,
      });
      return { status: 200, body: await settingsOf(tenant, params.accountId) };
    },

    reissueWebsiteKeys: async ({ params, tenant, session, request }) => {
      await settingsOf(tenant, params.accountId);
      const { keys, keyHash: hash, keyHint } = await issueKeys(tenant, params.accountId);
      await o.connections.setKeys(tenant, params.accountId, { keyHash: hash, keyHint });
      const after = await settingsOf(tenant, params.accountId);
      await o.audit.record(tenant, {
        action: 'website.keys_reissued',
        actor: { kind: 'user', userId: session.userId },
        entityId: params.accountId,
        after: { keys_issued_at: after.keys_issued_at },
        ip: request.ip,
      });
      return { status: 200, body: keys };
    },

    disconnectAccount: notFound,
    websitePushOrder: notFound,
    websiteCancelOrder: notFound,
    websiteRefundOrder: notFound,
    websitePushProducts: notFound,
  };
}
