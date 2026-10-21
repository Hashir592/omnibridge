import { formatLondonDateTime } from '@omnibridge/core';
import {
  issuePasswordReset,
  type AuthStore,
  type MembershipRepository,
  type UserRepository,
} from '@omnibridge/db';
import type { Logger } from '@omnibridge/logger';
import { renderLockNotice, renderPasswordReset, type Email } from '@omnibridge/mail';
import type { JobHandler } from '@omnibridge/queue';

/** What sending needs: the Mailer of packages/mail, or a fake in tests. */
export interface MailSender {
  send(to: string, email: Email): Promise<string>;
}

/**
 * auth.lock_notice (USR-5): emails the locked user and every admin of the job's workspace, once
 * each. The job runs in that workspace's tenant transaction, where the user is a co-member.
 */
export function lockNoticeHandler(deps: {
  users: Pick<UserRepository, 'get'>;
  members: Pick<MembershipRepository, 'admins'>;
  mailer: MailSender;
  logger: Logger;
}): JobHandler<{ user_id: string; locked_until: string }> {
  return async (job) => {
    const locked = await deps.users.get(job.ctx, job.payload.user_id);
    if (locked === undefined) {
      // No longer a member here: nothing to tell this workspace.
      deps.logger.info(
        { event: 'auth.lock_notice_skipped', workspaceId: job.ctx.workspaceId },
        'locked user is not a member of this workspace',
      );
      return { sent: 0 };
    }
    const lockedUntil = formatLondonDateTime(new Date(job.payload.locked_until));
    let sent = 0;
    await deps.mailer.send(
      locked.email,
      renderLockNotice({ recipientName: locked.name, lockedUntil }),
    );
    sent += 1;
    for (const admin of await deps.members.admins(job.ctx)) {
      if (admin.id === locked.id) continue;
      await deps.mailer.send(
        admin.email,
        renderLockNotice({ recipientName: admin.name, lockedName: locked.name, lockedUntil }),
      );
      sent += 1;
    }
    deps.logger.info(
      { event: 'auth.lock_notice_sent', workspaceId: job.ctx.workspaceId, count: sent },
      'lock notice sent',
    );
    return { sent };
  };
}

/**
 * auth.password_reset (USR-7): makes the 30-minute link here, just before sending, so the token
 * itself is never stored or queued; only its SHA-256 is kept. A retry makes a new link.
 */
export function passwordResetHandler(deps: {
  store: Pick<AuthStore, 'createReset'>;
  users: Pick<UserRepository, 'get'>;
  mailer: MailSender;
  appOrigin: string;
  logger: Logger;
  now?: () => Date;
}): JobHandler<{ user_id: string }> {
  return async (job) => {
    const user = await deps.users.get(job.ctx, job.payload.user_id);
    if (user === undefined) return { sent: 0 };
    const { token, expiresAt } = await issuePasswordReset(
      deps.store,
      user.id,
      (deps.now ?? (() => new Date()))(),
    );
    const resetUrl = new URL('/reset-password', deps.appOrigin);
    resetUrl.searchParams.set('token', token);
    await deps.mailer.send(
      user.email,
      renderPasswordReset({
        recipientName: user.name,
        resetUrl: resetUrl.href,
        appOrigin: deps.appOrigin,
        expiresAt: formatLondonDateTime(expiresAt),
      }),
    );
    deps.logger.info(
      { event: 'auth.reset_sent', workspaceId: job.ctx.workspaceId, userId: user.id },
      'password reset link sent',
    );
    return { sent: 1 };
  };
}
