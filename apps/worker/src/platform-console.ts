import { formatLondonDate, londonDate } from '@omnibridge/core';
import type { PlatformHousekeeping } from '@omnibridge/db';
import type { Logger } from '@omnibridge/logger';
import { isPlainAddress, renderPlatformDigest } from '@omnibridge/mail';
import { requestDeletion, type JobHandler, type JobQueue } from '@omnibridge/queue';
import type { MailSender } from './auth-mail.ts';

const DAY_MS = 86_400_000;

/** ADR-071 4a: notifications resolved longer ago than this are hard-deleted; open ones stay. */
export const NOTIFICATION_RETENTION_DAYS = 90;

/** OPS-6: the digest counts credentials expiring within this many days. */
export const DIGEST_EXPIRY_DAYS = 30;

/** notify.retention for one workspace: resolved notifications past retention, with their rows. */
export function notifyRetentionHandler(deps: {
  housekeeping: Pick<PlatformHousekeeping, 'purgeNotifications'>;
  logger: Logger;
  now?: () => Date;
}): JobHandler<Record<string, never>> {
  return async (job) => {
    const now = (deps.now ?? (() => new Date()))();
    const cutoff = new Date(now.getTime() - NOTIFICATION_RETENTION_DAYS * DAY_MS);
    const deleted = await deps.housekeeping.purgeNotifications(job.ctx, cutoff);
    deps.logger.info(
      { event: 'notify.retention', workspaceId: job.ctx.workspaceId, count: deleted },
      'resolved notifications past retention deleted',
    );
    return { deleted };
  };
}

/**
 * workspace.close (PLAT-2, DEL-1): the console archived the workspace. In the job's one tenant
 * transaction it queues the workspace_closure deletion (the vault deletes the PII in its own job),
 * removes every membership, then deletes the terms acceptances of people left with no workspace
 * (ADR-058b). A retry repeats nothing: the deletion is keyed, and nobody is left to remove.
 */
export function workspaceCloseHandler(deps: {
  queue: Pick<JobQueue, 'send'>;
  housekeeping: Pick<PlatformHousekeeping, 'closeMembers' | 'deleteUnattachedTerms'>;
  logger: Logger;
}): JobHandler<Record<string, never>> {
  return async (job) => {
    const workspaceId = job.ctx.workspaceId;
    await requestDeletion(deps.queue, job.ctx, {
      trigger: 'workspace_closure',
      scope: { type: 'workspace' },
      idempotencyKey: `closure:${workspaceId}`,
    });
    const removed = await deps.housekeeping.closeMembers(job.ctx);
    const termsDeleted = await deps.housekeeping.deleteUnattachedTerms(job.ctx, removed);
    deps.logger.info(
      {
        event: 'workspace.closed',
        workspaceId,
        count: removed.length,
        termsDeleted,
      },
      'workspace closed: deletion queued, memberships removed',
    );
    return { members_removed: removed.length, terms_deleted: termsDeleted };
  };
}

/**
 * platform.health-digest (OPS-6): one email a day to each platform admin with counts only (jobs
 * failed, API usage against limits, credentials expiring in 30 days, deletion runs). Recorded per
 * admin and London day as it is sent, so a second run that day sends nothing.
 */
export async function sendPlatformDigest(deps: {
  housekeeping: Pick<PlatformHousekeeping, 'digestCounts' | 'digestRecipients' | 'digestSent'>;
  mailer: MailSender;
  appOrigin: string;
  logger: Logger;
  now?: () => Date;
}): Promise<number> {
  const now = (deps.now ?? (() => new Date()))();
  const day = londonDate(now);
  const recipients = await deps.housekeeping.digestRecipients(day);
  if (recipients.length === 0) return 0;
  const numbers = await deps.housekeeping.digestCounts(
    new Date(now.getTime() - DAY_MS),
    new Date(now.getTime() + DIGEST_EXPIRY_DAYS * DAY_MS),
  );
  let sent = 0;
  for (const admin of recipients) {
    if (isPlainAddress(admin.email)) {
      await deps.mailer.send(
        admin.email,
        renderPlatformDigest({
          recipientName: admin.name,
          date: formatLondonDate(now),
          numbers,
          consoleUrl: new URL('/platform', deps.appOrigin).href,
          appOrigin: deps.appOrigin,
        }),
      );
      sent += 1;
    } else {
      deps.logger.warn(
        { event: 'platform.digest_skipped', userId: admin.userId },
        'digest not sent: address refused',
      );
    }
    // Recorded either way, so an address that can never be sent to is not retried all day.
    await deps.housekeeping.digestSent(day, admin.userId, now);
  }
  deps.logger.info({ event: 'platform.digest', count: sent }, 'daily health digest sent');
  return sent;
}
