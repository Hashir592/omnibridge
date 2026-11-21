import type { stockRoutes } from '@omnibridge/contract';
import { ApiError } from '@omnibridge/core';
import type { Handlers } from './contract.ts';

const notFound = () => Promise.reject(new ApiError({ status: 404, code: 'not_found' }));

/**
 * The stock engine's routes (M09: INV-1 to INV-10). The contract PR answers every route 404 until
 * T-0901 builds them; the route walks cover them from now on.
 */
export function stockHandlers(): Handlers<typeof stockRoutes> {
  return {
    listStock: notFound,
    getStock: notFound,
    listMovements: notFound,
    exportMovements: notFound,
    stockIn: notFound,
    adjustStock: notFound,
    importStockTake: notFound,
    listBuffers: notFound,
    setAccountBuffer: notFound,
    setListingBuffer: notFound,
    saveAllocation: notFound,
    backToAuto: notFound,
  };
}
