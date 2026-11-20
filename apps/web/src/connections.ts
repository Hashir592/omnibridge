import { ApiError } from '@omnibridge/core';
import type { connectionRoutes } from '@omnibridge/contract';
import type { Handlers } from './contract.ts';

/**
 * Connections, the kill switch, the OAuth return and bulk confirmation (M07). The contract PR
 * ships the routes only: until T-0701 and T-0702 land, a workspace route finds nothing (404) and
 * the OAuth return is unavailable (503).
 */
const notFound = () => Promise.reject(new ApiError({ status: 404, code: 'not_found' }));
const unavailable = () =>
  Promise.reject(new ApiError({ status: 503, code: 'service_unavailable' }));

export function connectionHandlers(): Handlers<typeof connectionRoutes> {
  return {
    listConnections: notFound,
    getConnection: notFound,
    setKillSwitch: notFound,
    startAuthorisation: notFound,
    oauthCallback: unavailable,
    previewBulkWrite: notFound,
    confirmBulkWrite: notFound,
  };
}
