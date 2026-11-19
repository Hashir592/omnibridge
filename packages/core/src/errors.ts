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
  'precondition_failed',
  'payload_too_large',
  'unsupported_media_type',
  'rate_limited',
  'internal_error',
  'service_unavailable',
  // A-001 (ADR-069): a search matched more than one answer holds; narrow it and search again.
  'too_many_matches',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ApiErrorInit {
  status: number;
  code: ErrorCode;
  /** Shown to the user. Never put buyer PII, secrets or internal details here. */
  detail?: string;
  /** With `validation_failed`: one entry per field the caller must change. */
  errors?: readonly ApiFieldError[];
  /** With `rate_limited`: seconds until a retry can work, sent as `Retry-After`. */
  retryAfterSeconds?: number;
}

export interface ApiFieldError {
  location: 'params' | 'query' | 'body' | 'headers';
  path: string;
  message: string;
}

/** Throw from a route handler to answer with a problem+json response. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly detail: string | undefined;
  readonly errors: readonly ApiFieldError[] | undefined;
  readonly retryAfterSeconds: number | undefined;

  constructor({ status, code, detail, errors, retryAfterSeconds }: ApiErrorInit) {
    if (!Number.isInteger(status) || status < 400 || status > 599) {
      throw new RangeError(`ApiError status must be 400-599, got ${String(status)}`);
    }
    super(detail ?? code);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.detail = detail;
    this.errors = errors;
    this.retryAfterSeconds =
      retryAfterSeconds === undefined ? undefined : Math.max(1, Math.ceil(retryAfterSeconds));
  }
}
