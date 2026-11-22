import type { ordersRoutes } from '@omnibridge/contract';
import { ApiError } from '@omnibridge/core';
import type { Handlers } from './contract.ts';

/*
 * M10 order routes (ORD-1 to ORD-9). The contract lands first so the screens can be built against
 * it (ADR-077); the handlers arrive with T-1002. Until then every route answers 404.
 */

const notFound = () => Promise.reject(new ApiError({ status: 404, code: 'not_found' }));

export function ordersHandlers(): Handlers<typeof ordersRoutes> {
  return {
    listOrders: notFound,
    searchOrders: notFound,
    exportOrders: notFound,
    getOrder: notFound,
    viewOrderCustomer: notFound,
    setOrderNotes: notFound,
    listReturns: notFound,
    dismissOrderGroup: notFound,
    removeOrderGroupMember: notFound,
  };
}
