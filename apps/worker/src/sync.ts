import type { Logger } from '@omnibridge/logger';
import {
  AuthFailed,
  EgressRefused,
  ProviderParserError,
  runIncrementalSync,
  type SyncPorts,
  type SyncResult,
  type SyncStream,
} from '@omnibridge/provider-kit';
import type { OrderSummary } from '@omnibridge/provider-kit';
import { PermanentJobError, type PhasedHandler, type SyncStreamName } from '@omnibridge/queue';

type Payload = { stream: SyncStreamName };

/** Builds a stream when a job needs it: app secrets (client ids) are read then, not at boot. */
export type StreamFactory = () => Promise<SyncStream<OrderSummary>>;

/**
 * sync.poll (T-0701: INT-1, INT-2, INT-5, INT-8). The whole poll runs in `prepare`, in short
 * transactions of its own and never one across a provider call (invariant 3); `commit` only hands
 * back the counts. A parser failure, a refused host or a refused token ends the job at once: no
 * retry can mend it, and the job waits in the dead-letter queue for a redrive after the fix.
 */
export function syncPollHandler(deps: {
  ports: SyncPorts;
  streams: Readonly<Record<SyncStreamName, StreamFactory>>;
  logger: Logger;
}): PhasedHandler<Payload, SyncResult> {
  return {
    prepare: async (job) => {
      const channelAccountId = job.envelope.channel_account_id;
      if (channelAccountId === undefined) throw new PermanentJobError('sync.no_account');
      const stream = await deps.streams[job.payload.stream]();
      try {
        return await runIncrementalSync(deps.ports, stream, {
          workspaceId: job.envelope.workspace_id,
          channelAccountId,
        });
      } catch (err) {
        if (err instanceof ProviderParserError) {
          // INT-5: provider, parser, version and field path; never a value.
          deps.logger.error(
            {
              event: 'provider.parser_failed',
              workspaceId: job.envelope.workspace_id,
              channelAccountId,
              provider: err.provider,
              parser: err.parser,
              parserVersion: err.version,
              fieldPath: err.path,
            },
            'provider answer failed its parser',
          );
          throw new PermanentJobError('provider.parser_failed');
        }
        if (err instanceof EgressRefused) throw new PermanentJobError('provider.egress_refused');
        // Retrying a refused token spends provider calls and mends nothing: the failure is
        // recorded (AMZ-12) and the next scheduled poll tries again once.
        if (err instanceof AuthFailed) throw new PermanentJobError('provider.auth_failed');
        throw err;
      }
    },
    commit: (_job, result) => Promise.resolve(result),
  };
}

/**
 * The sink of `ebay.orders` until M10's order ingest replaces it: it only counts, so the path is
 * real end to end while nothing is stored.
 */
export function countingSink(logger: Logger): SyncStream<OrderSummary>['sink'] {
  return (ctx, channelAccountId, items) => {
    logger.info(
      {
        event: 'sync.received',
        workspaceId: ctx.workspaceId,
        channelAccountId,
        count: items.length,
      },
      'sync changes received',
    );
    return Promise.resolve();
  };
}
