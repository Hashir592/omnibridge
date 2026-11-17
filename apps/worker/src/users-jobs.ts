import { randomBytes, createHash } from 'node:crypto';
import { londonDate } from '@omnibridge/core';
import {
  INVITE_LIFETIME_MS,
  type AccessReviewRepository,
  type InviteRepository,
  type UserRepository,
  type WorkspaceRepository,
} from '@omnibridge/db';
import type { Logger } from '@omnibridge/logger';
import { isPlainAddress, renderInvite } from '@omnibridge/mail';
import { accessReviewJob, type JobHandler, type JobQueue } from '@omnibridge/queue';
import type { MailSender } from './auth-mail.ts';

/**
 * auth.invite (USR-1, TEN-7): makes the link here, just before sending, and stores only the
 * token's SHA-256 on the invite, so the token is never queued or kept. A retry makes a new link
 * (the old one stops working). A revoked or accepted invite sends nothing.
 */
export function inviteHandler(deps: {
  invites: Pick<InviteRepository, 'get' | 'setToken'>;
  users: Pick<UserRepository, 'get'>;
  workspaces: Pick<WorkspaceRepository, 'get'>;
  mailer: MailSender;
  appOrigin: string;
  logger: Logger;
}): JobHandler<{ invite_id: string }> {
  return async (job) => {
    const invite = await deps.invites.get(job.ctx, job.payload.invite_id);
    if (invite === undefined || invite.acceptedAt !== null || invite.revokedAt !== null) {
      return { sent: 0 };
    }
    if (!isPlainAddress(invite.email)) {
      deps.logger.warn(
        { event: 'auth.mail_skipped', workspaceId: job.ctx.workspaceId },
        'invite address is not plain: mail not sent',
      );
      return { sent: 0 };
    }
    const token = randomBytes(32).toString('base64url');
    if (
      !(await deps.invites.setToken(
        job.ctx,
        invite.id,
        createHash('sha256').update(token).digest(),
      ))
    ) {
      return { sent: 0 };
    }
    const workspace = await deps.workspaces.get(job.ctx);
    const inviter =
      invite.invitedBy === null ? undefined : await deps.users.get(job.ctx, invite.invitedBy);
    await deps.mailer.send(
      invite.email,
      renderInvite({
        inviterName: inviter?.name ?? 'OmniBridge',
        workspaceName: workspace?.name ?? 'OmniBridge',
        acceptUrl: new URL(`/invite/${token}`, deps.appOrigin).href,
        appOrigin: deps.appOrigin,
        validForMs: INVITE_LIFETIME_MS,
      }),
    );
    deps.logger.info(
      { event: 'auth.invite_sent', workspaceId: job.ctx.workspaceId },
      'invite sent',
    );
    return { sent: 1 };
  };
}

/** users.access_review (USR-9): opens the next review when the last is 90 days old. */
export function accessReviewHandler(deps: {
  reviews: Pick<AccessReviewRepository, 'ensureDue'>;
  logger: Logger;
  now?: () => Date;
}): JobHandler<Record<string, never>> {
  return async (job) => {
    const review = await deps.reviews.ensureDue(job.ctx, (deps.now ?? (() => new Date()))());
    if (review !== undefined) {
      deps.logger.info(
        { event: 'users.access_review_due', workspaceId: job.ctx.workspaceId },
        'access review due',
      );
    }
    return { created: review === undefined ? 0 : 1 };
  };
}

/** The daily sweep: one users.access_review job per workspace, once per London day. */
export async function sweepAccessReviews({
  directory,
  queue,
  now = new Date(),
}: {
  directory: { listIds(): Promise<string[]> };
  queue: Pick<JobQueue, 'send'>;
  now?: Date;
}): Promise<number> {
  const day = londonDate(now);
  const ids = await directory.listIds();
  for (const workspaceId of ids) {
    await queue.send(accessReviewJob, {
      ctx: { workspaceId, companyIds: [] },
      idempotencyKey: `users.access_review:${day}`,
      payload: {},
    });
  }
  return ids.length;
}
