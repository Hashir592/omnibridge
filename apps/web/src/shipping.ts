import type { shippingRoutes } from '@omnibridge/contract';
import { ApiError } from '@omnibridge/core';
import type { Handlers } from './contract.ts';

/*
 * M12 shipping desk, Evri and tracking (T-1201, T-1202: SHIP-1 to SHIP-4, EVRI-1 to EVRI-7,
 * SHP-1 to SHP-9, TRK-1 to TRK-3). The contract lands first so the screens can be built against
 * it (ADR-077); the handlers arrive with T-1201 and T-1202. Until then every route answers 404.
 */

const notFound = () => Promise.reject(new ApiError({ status: 404, code: 'not_found' }));

export function shippingHandlers(): Handlers<typeof shippingRoutes> {
  return {
    listCarrierAccounts: notFound,
    getEvriAuthoriseUrl: notFound,
    connectEvri: notFound,
    reauthoriseEvri: notFound,
    getServiceCosts: notFound,
    putServiceCosts: notFound,
    getShippingSettings: notFound,
    putShippingSettings: notFound,
    getShippingRules: notFound,
    putShippingRules: notFound,
    getShippingDesk: notFound,
    createLabels: notFound,
    shipTogether: notFound,
    getLabelBatch: notFound,
    printLabels: notFound,
    getShipment: notFound,
    reprintShipment: notFound,
    voidShipment: notFound,
    listReconcile: notFound,
    markReconciled: notFound,
    confirmAddressCheck: notFound,
    packingSlips: notFound,
    listOrderTracking: notFound,
    resendTracking: notFound,
  };
}
