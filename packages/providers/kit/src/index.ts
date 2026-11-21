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
  ListingInfo,
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
export {
  applyPoll,
  applyRun,
  OVERLAP_MS,
  pollSince,
  type CursorResume,
  type CursorState,
  type SyncItem,
} from './cursor.ts';
export {
  AuthFailed,
  EgressRefused,
  isProviderError,
  ProviderParserError,
  ProviderRejected,
  ProviderUnavailable,
  providerErrorCode,
  RateLimited,
} from './errors.ts';
export {
  consentUrl,
  ProviderHttp,
  type ProviderHttpOptions,
  type ProviderRequest,
} from './http.ts';
export { defineParser, parserRecordKind, type VersionedParser } from './parser.ts';
export { readJson, retryAfterMs } from './respond.ts';
export { runIncrementalSync, type SyncPorts, type SyncResult, type SyncStream } from './sync.ts';
export { runListingScan, type ListingScan, type ScanResult } from './scan.ts';
export { AccessTokenCache } from './tokens.ts';
export { passThroughGovernor, type CallInput, type ProviderGovernor } from './governor.ts';
export {
  MAX_DEFER_MS,
  MAX_SEND_ATTEMPTS,
  retryDelayMs,
  runOutboundSend,
  type OutboundOperation,
  type OutboundPorts,
  type OutboundResult,
  type OutboundWriteView,
} from './outbound.ts';
// The carrier and website backoff and cap are a subpath of their own,
// `@omnibridge/provider-kit/carrier`, so a build rule can keep them out of the Amazon and eBay
// code paths (RL-3, ADR-078).
