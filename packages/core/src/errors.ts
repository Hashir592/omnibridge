/**
 * Stable error codes for RFC 9457 problem responses. Clients branch on `code`, never on text, so
 * a code is never renamed or reused; add new ones at the end of the list.
 */
export const ERROR_CODES = [
  'bad_request',
  'validation_failed',
  'unauthorized',
  'forbidden',
  'not_found',
  'method_not_allowed',
  'conflict',
  'payload_too_large',
  'unsupported_media_type',
  'rate_limited',
  'internal_error',
  'service_unavailable',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ApiErrorInit {
  status: number;
  code: ErrorCode;
  /** Shown to the user. Never put buyer PII, secrets or internal details here. */
  detail?: string;
}

/** Throw from a route handler to answer with a problem+json response. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly detail: string | undefined;

  constructor({ status, code, detail }: ApiErrorInit) {
    if (!Number.isInteger(status) || status < 400 || status > 599) {
      throw new RangeError(`ApiError status must be 400-599, got ${String(status)}`);
    }
    super(detail ?? code);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}
