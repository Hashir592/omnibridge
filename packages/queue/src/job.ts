import type { PgBoss, Queue } from 'pg-boss';
import { z } from 'zod';

/** Thrown at definition time, so a bad job type stops the process at boot, not at first send. */
export class JobDefinitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JobDefinitionError';
  }
}

export interface RetryPolicy {
  /** Retries after the first attempt; the job dead-letters after limit + 1 attempts. */
  readonly limit: number;
  readonly delaySeconds: number;
  /** Exponential backoff with jitter (pg-boss retryBackoff). */
  readonly backoff?: boolean;
  readonly maxDelaySeconds?: number;
}

const DEFAULT_RETRY: RetryPolicy = {
  limit: 5,
  delaySeconds: 10,
  backoff: true,
  maxDelaySeconds: 900,
};

/** Job type names: dotted lower-case words, for example `orders.sync`. */
const TYPE_NAME = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
const DLQ_SUFFIX = '.dlq';

export interface JobDefinition<P extends z.ZodType = z.ZodType> {
  readonly kind: 'workspace';
  readonly type: string;
  readonly payload: P;
  readonly retry: RetryPolicy;
  /** Jobs of one channel account run one at a time, in order (pg-boss key_strict_fifo). */
  readonly serialPerAccount: boolean;
  /** At most this many jobs of one channel account run at once, across all workers (OPS-10). */
  readonly perAccountCap: number | undefined;
  /** pg-boss heartbeat: a job whose worker died is retried after this many seconds (min 10). */
  readonly heartbeatSeconds: number;
  readonly expireInSeconds: number;
}

export interface JobDefinitionInput<P extends z.ZodType> {
  type: string;
  payload: P;
  retry?: RetryPolicy;
  serialPerAccount?: boolean;
  perAccountCap?: number;
  heartbeatSeconds?: number;
  expireInSeconds?: number;
}

function assertTypeName(type: string): void {
  if (!TYPE_NAME.test(type) || type.endsWith(DLQ_SUFFIX)) {
    throw new JobDefinitionError(
      `Job type "${type}" must be dotted lower-case words and must not end in ${DLQ_SUFFIX}`,
    );
  }
}

/**
 * A workspace job type (NFR-3). Every job of it carries the envelope of invariant 19, and its
 * payload is checked against `payload` when sent and again when received.
 */
export function defineJob<P extends z.ZodType>(input: JobDefinitionInput<P>): JobDefinition<P> {
  assertTypeName(input.type);
  if (input.serialPerAccount === true && input.perAccountCap !== undefined) {
    throw new JobDefinitionError(
      `Job type ${input.type}: serialPerAccount already means one at a time; drop perAccountCap`,
    );
  }
  if (
    input.perAccountCap !== undefined &&
    (!Number.isInteger(input.perAccountCap) || input.perAccountCap < 1)
  ) {
    throw new JobDefinitionError(
      `Job type ${input.type}: perAccountCap must be a positive integer`,
    );
  }
  const heartbeatSeconds = input.heartbeatSeconds ?? 30;
  if (heartbeatSeconds < 10) {
    throw new JobDefinitionError(`Job type ${input.type}: heartbeatSeconds must be at least 10`);
  }
  return {
    kind: 'workspace',
    type: input.type,
    payload: input.payload,
    retry: input.retry ?? DEFAULT_RETRY,
    serialPerAccount: input.serialPerAccount ?? false,
    perAccountCap: input.perAccountCap,
    heartbeatSeconds,
    expireInSeconds: input.expireInSeconds ?? 900,
  };
}

export function deadLetterName(def: { type: string }): string {
  return `${def.type}${DLQ_SUFFIX}`;
}

/** The pg-boss queue a job type runs on. Created by the migrate job as ob_owner (ADR-032). */
export function queueOptions(def: JobDefinition): Queue {
  return {
    name: def.type,
    policy: def.serialPerAccount ? 'key_strict_fifo' : 'standard',
    retryLimit: def.retry.limit,
    retryDelay: def.retry.delaySeconds,
    retryBackoff: def.retry.backoff ?? false,
    ...(def.retry.maxDelaySeconds === undefined
      ? {}
      : { retryDelayMax: def.retry.maxDelaySeconds }),
    heartbeatSeconds: def.heartbeatSeconds,
    expireInSeconds: def.expireInSeconds,
    deadLetter: deadLetterName(def),
  };
}

/** Dead-letter queues keep failed jobs for 30 days, so they can be inspected and redriven. */
export function deadLetterOptions(def: JobDefinition): Queue {
  return { name: deadLetterName(def), retentionSeconds: 30 * 86_400 };
}

const envelopeBase = z.object({
  workspace_id: z.uuid(),
  channel_account_id: z.uuid().optional(),
  idempotency_key: z.string().min(1).max(200),
  attempt: z.number().int().min(0),
  type: z.string(),
});

export type JobEnvelope<T> = Omit<z.infer<typeof envelopeBase>, never> & { payload: T };

/** Validates a job envelope (invariant 19) and its payload against the job type. */
export function parseEnvelope<P extends z.ZodType>(
  def: JobDefinition<P>,
  data: unknown,
): JobEnvelope<z.infer<P>> {
  const base = envelopeBase.extend({ payload: def.payload }).parse(data);
  if (base.type !== def.type) {
    throw new JobDefinitionError(`Envelope type ${base.type} sent to job type ${def.type}`);
  }
  return base as JobEnvelope<z.infer<P>>;
}

/** Low-traffic hours (London) in which heavy jobs may be scheduled: [fromHour, toHour). */
export interface HeavyWindow {
  readonly fromHour: number;
  readonly toHour: number;
}

export const DEFAULT_HEAVY_WINDOW: HeavyWindow = { fromHour: 1, toHour: 5 };

/**
 * Refuses a cron expression for a heavy job unless every hour it can fire at lies in the window.
 * Only fixed hours, lists and ranges are accepted; `*` and steps could fire at any hour.
 */
export function assertHeavyCron(cron: string, window: HeavyWindow = DEFAULT_HEAVY_WINDOW): void {
  const fields = cron.trim().split(/\s+/);
  const hourField = fields.length === 5 ? fields[1] : undefined;
  if (hourField === undefined || !/^\d{1,2}(-\d{1,2})?(,\d{1,2}(-\d{1,2})?)*$/.test(hourField)) {
    throw new JobDefinitionError(
      `Heavy job cron "${cron}" must name its hours (no * or steps) inside ${String(window.fromHour)}:00-${String(window.toHour)}:00 London`,
    );
  }
  for (const part of hourField.split(',')) {
    const [from, to] = part.split('-').map(Number);
    const last = to ?? from ?? -1;
    if ((from ?? -1) < window.fromHour || last >= window.toHour || last < (from ?? 0)) {
      throw new JobDefinitionError(
        `Heavy job cron "${cron}" fires outside ${String(window.fromHour)}:00-${String(window.toHour)}:00 London`,
      );
    }
  }
}

/**
 * A platform job: no workspace, optionally on a cron in Europe/London time. Workspace-wide cron
 * work is fanned out by a platform job once the workspace list exists (T-0201).
 */
export interface PlatformJobDefinition {
  readonly kind: 'platform';
  readonly type: string;
  readonly heavy: boolean;
  readonly schedule: { cron: string; tz: 'Europe/London' } | undefined;
}

export function definePlatformJob(input: {
  type: string;
  cron?: string;
  heavy?: boolean;
  window?: HeavyWindow;
}): PlatformJobDefinition {
  if (!/^[a-z][a-z0-9_-]*(\.[a-z][a-z0-9_-]*)*$/.test(input.type)) {
    throw new JobDefinitionError(`Platform job type "${input.type}" must be lower-case`);
  }
  const heavy = input.heavy ?? false;
  if (heavy) {
    if (input.cron === undefined)
      throw new JobDefinitionError(`Heavy job ${input.type} needs a cron`);
    assertHeavyCron(input.cron, input.window);
  }
  return {
    kind: 'platform',
    type: input.type,
    heavy,
    schedule: input.cron === undefined ? undefined : { cron: input.cron, tz: 'Europe/London' },
  };
}

/**
 * Registers a platform job's cron with pg-boss in Europe/London time (NFR-3). The heavy-job window
 * was already checked when the job was defined, so a heavy job can only land in low-traffic hours.
 */
export async function schedulePlatformJob(boss: PgBoss, def: PlatformJobDefinition): Promise<void> {
  if (def.schedule === undefined)
    throw new JobDefinitionError(`Platform job ${def.type} has no cron`);
  await boss.schedule(def.type, def.schedule.cron, null, { tz: def.schedule.tz });
}
