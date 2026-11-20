/**
 * Shared provider plumbing (T-0701): the adapter interfaces (INT-1), the one HTTP client with the
 * egress allowlist (invariant 17), versioned parsers (INT-5), incremental cursors and the sync
 * runner (INT-8). No provider-specific code lives here.
 */
export type {
  AccessToken,
  AdsAdapter,
  AdsProfile,
  CarrierService,
  ChannelAdapter,
  OrderSummary,
  Page,
  Parcel,
  Shipment,
  ShipmentAddress,
  ShippingProvider,
  StockLevel,
  TokenGrant,
  TrackingEvent,
  WriteResult,
} from './adapters.ts';
export { applyPoll, OVERLAP_MS, pollSince, type CursorState, type SyncItem } from './cursor.ts';
export {
  AuthFailed,
  EgressRefused,
  ProviderParserError,
  ProviderRejected,
  ProviderUnavailable,
  providerErrorCode,
  RateLimited,
} from './errors.ts';
export { ProviderHttp, type ProviderHttpOptions, type ProviderRequest } from './http.ts';
export { defineParser, parserRecordKind, type VersionedParser } from './parser.ts';
export { readJson, retryAfterMs } from './respond.ts';
export {
  runIncrementalSync,
  type CallGovernor,
  type SyncPorts,
  type SyncResult,
  type SyncStream,
} from './sync.ts';
export { AccessTokenCache } from './tokens.ts';
