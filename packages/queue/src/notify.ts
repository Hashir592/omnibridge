import type { RaiseHook, TenantContext } from '@omnibridge/core';
import { notifyEmailJob } from './registry.ts';
import type { JobQueue } from './runtime.ts';

/** Who gets an email about a notification (packages/db NotificationRepository). */
export interface EmailRecipients {
  emailRecipients(ctx: TenantContext, id: string): Promise<string[]>;
}

/**
 * NTF-3, NTF-4, NTF-5: the Notifier hook that emails. A new notification, a severity rise or a
 * reopen queues one `notify.email` job per recipient, in the raiser's own bound context, so the
 * jobs commit with the notification (ADR-069 A-002). A plain re-raise sends nothing. Platform
 * notices are emailed by the worker's minute sweep instead (they have no workspace to queue in).
 */
export function emailOnRaise(deps: {
  queue: Pick<JobQueue, 'send'>;
  recipients: EmailRecipients;
}): RaiseHook {
  return async (ctx, raise, result) => {
    if (ctx === null || raise.type.scope !== 'workspace') return;
    if (!result.created && !result.escalated && !result.reopened) return;
    const users = await deps.recipients.emailRecipients(ctx, result.id);
    for (const userId of users) {
      await deps.queue.send(notifyEmailJob, {
        ctx,
        idempotencyKey: `ntf.email:${result.id}:${userId}:${String(result.version)}`,
        payload: { notification_id: result.id, user_id: userId, version: result.version },
        ...(raise.companyId === null ? {} : { companyId: raise.companyId }),
      });
    }
  };
}
