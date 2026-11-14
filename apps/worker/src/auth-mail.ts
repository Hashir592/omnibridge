import { formatLondonDateTime } from '@omnibridge/core';
import {
  issuePasswordReset,
  type AuthStore,
  type MembershipRepository,
  type UserRepository,
} from '@omnibridge/db';
import type { Logger } from '@omnibridge/logger';
import {
  isPlainAddress,
  renderLockNotice,
  renderPasswordReset,
  type Email,
} from '@omnibridge/mail';
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
    // Recipients are checked before anything is sent, so one address the mailer refuses can
    // never fail the job after others were mailed (a retry would mail them twice).
    const recipients = [
      { user: locked, email: renderLockNotice({ recipientName: locked.name, lockedUntil }) },
      ...(await deps.members.admins(job.ctx))
        .filter((admin) => admin.id !== locked.id)
        .map((admin) => ({
          user: admin,
          email: renderLockNotice({
            recipientName: admin.name,
            lockedName: locked.name,
            lockedUntil,
          }),
        })),
    ].filter(({ user }) => sendable(user, job.ctx.workspaceId, deps.logger));
    let sent = 0;
    for (const { user, email } of recipients) {
      await deps.mailer.send(user.email, email);
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
    if (user === undefined || !sendable(user, job.ctx.workspaceId, deps.logger)) {
      return { sent: 0 };
    }
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

/**
 * False, logged without the address, for an email the mailer would refuse (not a plain
 * local@domain address, F-M02h-10): skipped rather than failed, so the job is not retried.
 */
function sendable(user: { id: string; email: string }, workspaceId: string, logger: Logger) {
  if (isPlainAddress(user.email)) return true;
  logger.warn(
    { event: 'auth.mail_skipped', workspaceId, userId: user.id },
    'recipient address is not plain: mail not sent',
  );
  return false;
}
