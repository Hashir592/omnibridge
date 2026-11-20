/**
 * Shared provider plumbing (T-0701): the one HTTP client, versioned parsers and incremental
 * cursors. No provider-specific code lives here.
 */
export { applyPoll, OVERLAP_MS, pollSince, type CursorState, type SyncItem } from './cursor.ts';
export { EgressRefused, ProviderParserError } from './errors.ts';
export { ProviderHttp, type ProviderHttpOptions, type ProviderRequest } from './http.ts';
export { defineParser, parserRecordKind, type VersionedParser } from './parser.ts';
