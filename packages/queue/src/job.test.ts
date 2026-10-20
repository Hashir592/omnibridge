import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  assertHeavyCron,
  deadLetterName,
  defineJob,
  definePlatformJob,
  JobDefinitionError,
  parseEnvelope,
  queueOptions,
} from './job.ts';

const WS = '0a0a0a0a-0000-4000-8000-00000000000a';
const ACCOUNT = '0c0c0c0c-0000-4000-8000-00000000000c';

const syncOrders = defineJob({
  type: 'orders.sync',
  payload: z.object({ since: z.string() }),
  retry: { limit: 3, delaySeconds: 5, backoff: true, maxDelaySeconds: 300 },
  perAccountCap: 4,
});

describe('job envelope (NFR-3, invariant 19)', () => {
  it('[NFR-3] envelope requires workspace, idempotency key and attempt; account is optional', () => {
    const ok = {
      workspace_id: WS,
      channel_account_id: ACCOUNT,
      idempotency_key: 'orders.sync:2026-10-20',
      attempt: 0,
      type: 'orders.sync',
      payload: { since: '2026-10-19' },
    };
    expect(parseEnvelope(syncOrders, ok).payload.since).toBe('2026-10-19');
    const noAccount = Object.fromEntries(
      Object.entries(ok).filter(([key]) => key !== 'channel_account_id'),
    );
    expect(parseEnvelope(syncOrders, noAccount).channel_account_id).toBeUndefined();

    for (const field of ['workspace_id', 'idempotency_key', 'attempt', 'type'] as const) {
      const bad = Object.fromEntries(Object.entries(ok).filter(([key]) => key !== field));
      expect(() => parseEnvelope(syncOrders, bad), field).toThrow();
    }
    expect(() => parseEnvelope(syncOrders, { ...ok, workspace_id: 'not-a-uuid' })).toThrow();
    expect(() => parseEnvelope(syncOrders, { ...ok, idempotency_key: '' })).toThrow();
  });

  it('[NFR-3] the payload is validated against the job type, and the type must match', () => {
    const base = {
      workspace_id: WS,
      idempotency_key: 'k',
      attempt: 0,
      type: 'orders.sync',
    };
    expect(() => parseEnvelope(syncOrders, { ...base, payload: { since: 5 } })).toThrow();
    expect(() =>
      parseEnvelope(syncOrders, { ...base, type: 'other.job', payload: { since: 'x' } }),
    ).toThrow(/orders\.sync/);
  });
});

describe('queue options (NFR-3, OPS-10)', () => {
  it('[NFR-3] each job type retries with backoff and has its own dead-letter queue', () => {
    expect(deadLetterName(syncOrders)).toBe('orders.sync.dlq');
    expect(queueOptions(syncOrders)).toMatchObject({
      name: 'orders.sync',
      policy: 'standard',
      retryLimit: 3,
      retryDelay: 5,
      retryBackoff: true,
      retryDelayMax: 300,
      deadLetter: 'orders.sync.dlq',
    });
  });

  it('[OPS-10] serial-per-account jobs use strict FIFO per channel account', () => {
    const serial = defineJob({
      type: 'listings.push',
      payload: z.object({}),
      serialPerAccount: true,
    });
    expect(queueOptions(serial).policy).toBe('key_strict_fifo');
    expect(() =>
      defineJob({
        type: 'bad.both',
        payload: z.object({}),
        serialPerAccount: true,
        perAccountCap: 2,
      }),
    ).toThrow(JobDefinitionError);
  });

  it('[NFR-3] job type names are dotted lower-case and cannot clash with dead-letter names', () => {
    expect(() => defineJob({ type: 'Orders Sync', payload: z.object({}) })).toThrow(
      JobDefinitionError,
    );
    expect(() => defineJob({ type: 'orders.sync.dlq', payload: z.object({}) })).toThrow(
      JobDefinitionError,
    );
  });
});

describe('cron and heavy jobs (NFR-3)', () => {
  it('[NFR-3] platform cron jobs run on London time', () => {
    const job = definePlatformJob({ type: 'platform.tidy', cron: '15 3 * * *', heavy: true });
    expect(job.schedule).toEqual({ cron: '15 3 * * *', tz: 'Europe/London' });
  });

  it('[NFR-3] heavy jobs may only be scheduled inside the low-traffic window', () => {
    const window = { fromHour: 1, toHour: 5 };
    for (const cron of ['0 1 * * *', '30 4 * * *', '0 2,3 * * *', '0 1-4 * * 0']) {
      expect(() => {
        assertHeavyCron(cron, window);
      }, cron).not.toThrow();
    }
    for (const cron of [
      '0 5 * * *',
      '0 12 * * *',
      '* * * * *',
      '0 */2 * * *',
      '0 0-3 * * *',
      'x',
    ]) {
      expect(() => {
        assertHeavyCron(cron, window);
      }, cron).toThrow(JobDefinitionError);
    }
    expect(() =>
      definePlatformJob({ type: 'platform.big', cron: '0 9 * * *', heavy: true }),
    ).toThrow(JobDefinitionError);
  });
});
