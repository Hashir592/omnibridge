import type { websiteRoutes } from '@omnibridge/contract';
import { ApiError, type TenantRunner } from '@omnibridge/core';
import type {
  AccountCredentials,
  AuditLog,
  ChannelAccountRepository,
  ConnectionRepository,
  WebsiteConnectionRepository,
} from '@omnibridge/db';
import type { Logger } from '@omnibridge/logger';
import type { Handlers } from './contract.ts';

/*
 * M11 website connector and Disconnect (T-1101: WEB-1 to WEB-6, OPS-12, AT-14). Setup is for
 * admins, behind the website_connector module (ADR-059). Website calls are signed (WEB-2) and are
 * stored in the request, buyer details in pii-vault first (ADR-054 FA-04, invariant 7a).
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
  // Shape only: T-1101 builds the handlers after their failing tests.
  return websiteHandlers();
}
