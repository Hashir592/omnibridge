import type { TenantContext } from '@omnibridge/core';
import type { Logger } from '@omnibridge/logger';
import {
  runOutboundSend,
  type ChannelAdapter,
  type OutboundOperation,
  type OutboundPorts,
  type OutboundResult,
} from '@omnibridge/provider-kit';
import {
  outboundRecoverJob,
  type JobHandler,
  type JobQueue,
  type OutboundQueue,
  type PhasedHandler,
} from '@omnibridge/queue';
import { WEBSITE_ORDER_ID_MAX, WebsiteShipmentSchema } from '@omnibridge/contract';
import { WEBSITE_RETRY, type WebsiteAdapter } from '@omnibridge/provider-website';
import { z } from 'zod';

/** A stock push: SKUs and whole quantities only (invariant 7a), at most 50 per write. */
const StockPush = z
  .object({
    levels: z
      .array(z.object({ sku: z.string().min(1).max(200), quantity: z.number().int().min(0) }))
      .min(1)
      .max(50),
  })
  .strict();
type StockPushPayload = z.infer<typeof StockPush>;

/** WEB-4: a shipment for the website: the carrier, service, tracking numbers and when (IDs only). */
const Shipment = z
  .object({
    externalOrderId: z.string().min(1).max(WEBSITE_ORDER_ID_MAX),
    shipment: WebsiteShipmentSchema,
  })
  .strict();

type StockAdapter = Pick<ChannelAdapter, 'authenticate' | 'pushStock'>;

/** A stock push to one channel: the adapter is built when a write needs it (app secrets then). */
function stockPush(
  operation: string,
  provider: 'ebay' | 'website',
  api: string,
  adapter: () => Promise<StockAdapter>,
  more: Pick<OutboundOperation<unknown>, 'authApi' | 'retry' | 'deadLetterAlert'> = {},
): OutboundOperation<StockPushPayload> {
  return {
    operation,
    provider,
    api,
    ...more,
    payload: StockPush,
    authenticate: async (credential) => (await adapter()).authenticate(credential),
    send: async (token, payload, write) => {
      const result = await (await adapter()).pushStock(token, payload.levels, write?.id);
      // SKUs and stable codes only, never a provider message.
      return { accepted: result.accepted.length, refused: result.refused.map((r) => r.code) };
    },
  };
}

/**
 * The provider writes M07 can send. M09 queues stock pushes through them; Amazon (seller id, M18)
 * and Amazon Ads (M19) add theirs with their modules.
 */
export function outboundOperations(adapters: {
  ebay: () => Promise<ChannelAdapter>;
  website: () => Promise<WebsiteAdapter>;
}): Readonly<Record<string, OutboundOperation<unknown>>> {
  // WEB-5: website writes retry from 1 minute up to 24 hours, then dead-letter with one alert.
  const website = { retry: WEBSITE_RETRY, deadLetterAlert: 'website.delivery_failed' };
  return {
    'ebay.stock_push': stockPush('ebay.stock_push', 'ebay', 'sell.inventory', adapters.ebay, {
      authApi: 'identity.user_token',
    }),
    'website.stock_push': stockPush(
      'website.stock_push',
      'website',
      'omnibridge.stock',
      adapters.website,
      website,
    ),
    // WEB-4, TRK-1: M12 queues one when a website order ships; nothing of eBay ever goes (WEB-6).
    'website.shipment': {
      operation: 'website.shipment',
      provider: 'website',
      api: 'omnibridge.shipment',
      ...website,
      payload: Shipment,
      authenticate: async (credential) => (await adapters.website()).authenticate(credential),
      send: async (token, payload, write) => {
        await (
          await adapters.website()
        ).pushShipment(token, payload.externalOrderId, payload.shipment, write?.id ?? '');
        return { accepted: 1 };
      },
    } satisfies OutboundOperation<z.infer<typeof Shipment>>,
  };
}

/**
 * outbound.send (T-0702: SAFE-2, SAFE-3, INT-2). The whole send runs in `prepare`, in short
 * transactions of its own and never one across the provider call (invariant 3).
 */
export function outboundSendHandler(deps: {
  ports: OutboundPorts;
  operations: Readonly<Record<string, OutboundOperation<unknown>>>;
  /**
   * INV-8 (T-0901): told once a write is settled (sent or given up), in a short transaction of
   * its own, so the stock engine records the quantity sent or sets Sync failed.
   */
  settled?: (ctx: TenantContext, writeId: string) => Promise<void>;
  logger: Logger;
}): PhasedHandler<{ write_id: string }, OutboundResult> {
  return {
    prepare: async (job) => {
      const result = await runOutboundSend(deps.ports, deps.operations, {
        workspaceId: job.envelope.workspace_id,
        writeId: job.payload.write_id,
      });
      deps.logger.info(
        {
          event: 'outbound.result',
          workspaceId: job.envelope.workspace_id,
          channelAccountId: job.envelope.channel_account_id,
          status: Object.keys(result)[0],
        },
        'outbound write handled',
      );
      return result;
    },
    commit: async (job, result) => {
      // A retry after a failed commit finds the write already settled (skipped): tell it again,
      // the hook is idempotent.
      const settled =
        'sent' in result ||
        'failed' in result ||
        ('skipped' in result && (result.skipped === 'sent' || result.skipped === 'failed'));
      if (settled) await deps.settled?.(job.ctx, job.payload.write_id);
      return result;
    },
  };
}

/** outbound.recover: stale claims and writes whose switch is now off are sent again. */
export function outboundRecoverHandler(deps: {
  outbound: Pick<OutboundQueue, 'recover'>;
  maintenance: (ctx: Parameters<OutboundQueue['recover']>[0]) => Promise<{ on: boolean }>;
}): JobHandler<Record<string, never>> {
  return async ({ ctx }) => {
    const { on } = await deps.maintenance(ctx);
    return { recovered: await deps.outbound.recover(ctx, { maintenance: on }) };
  };
}

/** Every ten minutes: one outbound.recover job per workspace. */
export async function sweepOutboundRecover({
  directory,
  queue,
  now = new Date(),
}: {
  directory: { listIds(): Promise<string[]> };
  queue: Pick<JobQueue, 'send'>;
  now?: Date;
}): Promise<number> {
  const slot = new Date(Math.floor(now.getTime() / 600_000) * 600_000).toISOString().slice(0, 16);
  const ids = await directory.listIds();
  for (const workspaceId of ids) {
    await queue.send(outboundRecoverJob, {
      ctx: { workspaceId, companyIds: [] },
      idempotencyKey: `outbound.recover:${slot}`,
      payload: {},
    });
  }
  return ids.length;
}
