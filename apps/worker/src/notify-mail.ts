import { notificationType, type TenantRunner } from '@omnibridge/core';
import type { NotificationRepository } from '@omnibridge/db';
import type { Logger } from '@omnibridge/logger';
import { isPlainAddress, renderNotificationEmail } from '@omnibridge/mail';
import type { PhasedHandler } from '@omnibridge/queue';
import type { MailSender } from './auth-mail.ts';

type Payload = { notification_id: string; user_id: string; version: number };
type Outcome = { sent: boolean; reason?: string };

/**
 * notify.email (T-0502: NTF-3, NTF-4, MAIL-3). `prepare` reads the notification as it is now in
 * a short read of its own, then sends with no db-main transaction open (F-M04h-05); `commit`
 * records the email as sent for that version. Nothing is sent when it was already sent, the
 * notification has resolved or moved to a newer version (that version has its own job), or the
 * user no longer gets it (preference turned off, a tick removed, left the workspace).
 */
export function notifyEmailHandler(deps: {
  tenancy: Pick<TenantRunner, 'runWorkspace'>;
  notifications: Pick<NotificationRepository, 'emailJob' | 'recordEmailSent'>;
  mailer: MailSender;
  appOrigin: string;
  logger: Logger;
  now?: () => Date;
}): PhasedHandler<Payload, Outcome> {
  const now = deps.now ?? (() => new Date());
  return {
    prepare: async (job) => {
      const workspaceId = job.envelope.workspace_id;
      const { notification_id: notificationId, user_id: userId, version } = job.payload;
      const view = await deps.tenancy.runWorkspace({ workspaceId }, (ctx) =>
        deps.notifications.emailJob(ctx, { notificationId, userId, version }),
      );
      const type = view === undefined ? undefined : notificationType(view.type);
      const skip = (reason: string): Outcome => {
        deps.logger.info(
          { event: 'notify.email_skipped', workspaceId, notificationId, userId, reason },
          'notification email not sent',
        );
        return { sent: false, reason };
      };
      if (view === undefined || type === undefined) return skip('gone');
      if (view.sent) return { sent: false, reason: 'already_sent' };
      if (view.resolved) return skip('resolved');
      if (view.version !== version) return skip('superseded');
      if (!view.recipient) return skip('not_a_recipient');
      if (!isPlainAddress(view.email)) return skip('address');
      await deps.mailer.send(
        view.email,
        renderNotificationEmail({
          recipientName: view.name,
          severity: view.severity,
          title: type.title,
          companyName: view.companyName ?? undefined,
          scope: 'workspace',
          linkUrl: new URL(`/notifications/${notificationId}`, deps.appOrigin).href,
          appOrigin: deps.appOrigin,
        }),
      );
      return { sent: true };
    },
    commit: async (job, prepared) => {
      if (prepared.sent) {
        await deps.notifications.recordEmailSent(
          job.ctx,
          {
            notificationId: job.payload.notification_id,
            userId: job.payload.user_id,
            version: job.payload.version,
          },
          now(),
        );
        deps.logger.info(
          {
            event: 'notify.email_sent',
            workspaceId: job.ctx.workspaceId,
            notificationId: job.payload.notification_id,
            userId: job.payload.user_id,
          },
          'notification email sent',
        );
      }
      return prepared;
    },
  };
}

/**
 * notify.platform-email-sweep (NTF-2, NTF-3): every critical platform notice not yet emailed at
 * its current version goes to every platform admin, one email each, recorded as it is sent.
 */
export async function sweepPlatformEmails(deps: {
  notifications: Pick<NotificationRepository, 'pendingPlatformEmails' | 'platformEmailSent'>;
  mailer: MailSender;
  appOrigin: string;
  logger: Logger;
  now?: () => Date;
}): Promise<number> {
  const now = deps.now ?? (() => new Date());
  let sent = 0;
  for (const pending of await deps.notifications.pendingPlatformEmails(100)) {
    const type = notificationType(pending.type);
    if (type !== undefined && isPlainAddress(pending.email)) {
      await deps.mailer.send(
        pending.email,
        renderNotificationEmail({
          recipientName: pending.name,
          severity: pending.severity,
          title: type.title,
          scope: 'platform',
          linkUrl: new URL('/platform', deps.appOrigin).href,
          appOrigin: deps.appOrigin,
        }),
      );
      sent += 1;
    } else {
      deps.logger.warn(
        { event: 'notify.platform_email_skipped', notificationId: pending.notificationId },
        'platform notice email not sent',
      );
    }
    // Recorded either way, so an address that can never be sent to is not retried every minute.
    await deps.notifications.platformEmailSent(pending, now());
  }
  return sent;
}
