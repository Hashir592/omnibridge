import type { websiteRoutes } from '@omnibridge/contract';
import { ApiError } from '@omnibridge/core';
import type { Handlers } from './contract.ts';

/*
 * M11 website connector and Disconnect (T-1101: WEB-1 to WEB-6, OPS-12, AT-14). The contract
 * lands first so the setup screen can be built against it (ADR-077); the handlers arrive with
 * T-1101. Until then every route answers 404.
 */

const notFound = () => Promise.reject(new ApiError({ status: 404, code: 'not_found' }));

export function websiteHandlers(): Handlers<typeof websiteRoutes> {
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
