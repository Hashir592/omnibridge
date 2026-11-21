import {
  pino,
  type Bindings,
  type ChildLoggerOptions,
  type DestinationStream,
  type Logger,
} from 'pino';

type ChildOptions = ChildLoggerOptions;

export type { Logger };

/**
 * Fields that may appear in a log line (DP-8). Anything else is dropped before the line is written,
 * so a new field reaches the logs only by being added here on purpose.
 */
export const ALLOWED_FIELDS: ReadonlySet<string> = new Set([
  'level',
  'time',
  'pid',
  'msg',
  'service',
  'version',
  'component',
  'event',
  'reqId',
  'req',
  'res',
  'responseTime',
  'route',
  'method',
  'statusCode',
  'durationMs',
  'jobId',
  'jobName',
  'queue',
  'attempt',
  'workspaceId',
  // Tenancy (T-0201): ids only. A user id is a random UUID, never a name or an email.
  'companyId',
  'userId',
  'channelAccountId',
  'migration',
  'status',
  'db_main',
  'db_pii',
  'err',
  // Credential store (T-0103): ids, kinds, slots and counts only, never values.
  'credentialId',
  'credentialKind',
  'slot',
  'keyVersion',
  'kekVersion',
  'count',
  // Provider webhooks (T-0602): the notice topic and whether it verified, never its ids.
  'topic',
  'verified',
  // Providers (T-0701, INT-5): names, versions, field paths and stable codes, never a value.
  'provider',
  'api',
  'stream',
  'parser',
  'parserVersion',
  'fieldPath',
  'errorCode',
]);

const REDACTED = '[REDACTED]';
/**
 * What a PII marker is replaced with (S5-20261118-03, ADR-068). It still holds the marker, so the
 * AT-9 scans of logs flag the line: a marker that reached the logger at all is a leak, because in
 * production the same path would log the real value (scrubbed only up to the first space).
 */
export const MARKER_REDACTED = '[PIIMARK-REDACTED]';
/**
 * Synthetic PII in fixtures carries this marker so leaks can be found (ARCHITECTURE.md
 * invariant 7). An already scrubbed token is left as it is.
 */
const PII_MARKER = /PIIMARK-(?!REDACTED\])[^\s"'`,;:()[\]{}<>]*/g;
const EMAIL = /\b[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}\b/gi;
/**
 * A path segment that is a secret token (F-M02h-01, SEC-5): the segment after one of these route
 * prefixes is redacted wherever a request path appears in a log line. Add new token routes here.
 * `/invite/` is the SPA page an invite email links to, which web now serves (ADR-060).
 */
const PATH_TOKEN = /(\/(?:auth\/(?:password\/reset|invites)|invite)\/)[^/?#\s"']+/g;
/** A `token` query value, as on the SPA's /reset-password?token=… page (ADR-060). */
const QUERY_TOKEN = /([?&]token=)[^&#\s"']+/g;
const MAX_DEPTH = 6;

/** Replaces PII markers, email addresses and path tokens in free text. */
export function scrubString(value: string): string {
  return value
    .replace(PII_MARKER, MARKER_REDACTED)
    .replace(EMAIL, REDACTED)
    .replace(PATH_TOKEN, `$1${REDACTED}`)
    .replace(QUERY_TOKEN, `$1${REDACTED}`);
}

function scrubValue(value: unknown, depth: number): unknown {
  if (typeof value === 'string') return scrubString(value);
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH) return REDACTED;
  if (value instanceof Error) {
    return {
      type: value.name,
      message: scrubString(value.message),
      ...(value.stack === undefined ? {} : { stack: scrubString(value.stack) }),
    };
  }
  if (Array.isArray(value)) return value.map((item: unknown) => scrubValue(item, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) out[key] = scrubValue(item, depth + 1);
  return out;
}

/** `req` and `res` arrive as raw Node objects; their serializers below reduce and scrub them. */
const SERIALIZED_FIELDS: ReadonlySet<string> = new Set(['req', 'res']);

function filterFields(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (!ALLOWED_FIELDS.has(key)) continue;
    out[key] = SERIALIZED_FIELDS.has(key) ? value : scrubValue(value, 0);
  }
  return out;
}

interface RequestLike {
  method?: string;
  url?: string;
}

interface ResponseLike {
  statusCode?: number;
}

function serializeRequest(req: RequestLike): Record<string, unknown> {
  // The query string is dropped entirely: search terms and filters may hold PII.
  const path = (req.url ?? '').split('?')[0] ?? '';
  return { method: req.method, url: scrubString(path) };
}

function serializeResponse(res: ResponseLike): Record<string, unknown> {
  return { statusCode: res.statusCode };
}

export interface LoggerOptions {
  service: string;
  version: string;
  level?: string;
  /** Where lines go. Defaults to stdout. Tests pass a capturing stream. */
  destination?: DestinationStream;
}

function errorField(value: unknown): Error | undefined {
  if (value === null || typeof value !== 'object' || !('err' in value)) return undefined;
  return value.err instanceof Error ? value.err : undefined;
}

/**
 * pino passes child bindings (for example Fastify's per-request child) straight to the output
 * without `formatters.bindings`, so every child is filtered here, recursively.
 */
function guardChildren(logger: Logger): Logger {
  const child = logger.child.bind(logger);
  const guarded = (bindings: Bindings, opts?: ChildOptions): Logger =>
    guardChildren(child(filterFields(bindings), opts));
  Object.defineProperty(logger, 'child', { value: guarded, writable: true, configurable: true });
  return logger;
}

export function createLogger(options: LoggerOptions): Logger {
  const logger = pino(
    {
      level: options.level ?? 'info',
      base: { service: options.service, version: options.version },
      messageKey: 'msg',
      formatters: {
        bindings: filterFields,
        log: filterFields,
      },
      serializers: {
        // Errors were already reduced to { type, message, stack } and scrubbed by formatters.log.
        err: (err: unknown) => (err instanceof Error ? scrubValue(err, 0) : err),
        req: serializeRequest,
        res: serializeResponse,
      },
      redact: {
        paths: ['*.password', '*.token', '*.secret', '*.authorization', '*.cookie'],
        censor: REDACTED,
      },
      hooks: {
        logMethod(args, method) {
          const scrubbed = args.map((arg: unknown) =>
            typeof arg === 'string' ? scrubString(arg) : arg,
          ) as typeof args;
          // With no message argument pino copies err.message into msg unscrubbed, so supply one.
          const first: unknown = scrubbed[0];
          const err = first instanceof Error ? first : errorField(first);
          if (err !== undefined && typeof scrubbed[1] !== 'string') {
            scrubbed.splice(1, 0, scrubString(err.message));
          }
          method.apply(this, scrubbed);
        },
      },
    },
    options.destination ?? pino.destination(1),
  );
  return guardChildren(logger);
}
