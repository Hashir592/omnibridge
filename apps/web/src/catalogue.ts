import type { catalogueRoutes } from '@omnibridge/contract';
import { ApiError } from '@omnibridge/core';
import type { Handlers } from './contract.ts';

const notFound = () => Promise.reject(new ApiError({ status: 404, code: 'not_found' }));

/**
 * The catalogue (M08: CAT-1 to CAT-6). The contract PR answers every route 404 until T-0801
 * builds them; the route walks cover them from now on.
 */
export function catalogueHandlers(): Handlers<typeof catalogueRoutes> {
  return {
    listMasterSkus: notFound,
    getMasterSku: notFound,
    createMasterSku: notFound,
    updateMasterSku: notFound,
    listManufacturers: notFound,
    listVatRates: notFound,
    createVatRate: notFound,
    listCogs: notFound,
    setCogs: notFound,
    importCogs: notFound,
    listListings: notFound,
    mapListing: notFound,
    unmapListing: notFound,
    importMappings: notFound,
    exportMappings: notFound,
  };
}
