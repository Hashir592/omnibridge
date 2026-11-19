import {
  authInviteJob,
  authLockNoticeJob,
  authPasswordResetJob,
  type JobQueue,
} from '@omnibridge/queue';
import type { AuthNotifier } from './service.ts';

/**
 * Auth mail through the queue (ADR-050): web enqueues, the worker sends. Every job carries a
 * workspace (invariant 12), so a lock notice goes out once per workspace of the user, to that
 * workspace's admins and the user.
 *
 * A-002 (ADR-069): a job must never be visible before the data it reads. The invite job goes
 * through the request's transaction (`within`). The lock notice and the reset mail are sent
 * after the lock and the reset allowance have committed in their own calls, so they read only
 * committed data.
 */
export function queueNotifier(
  queue: Pick<JobQueue, 'send'>,
  now: () => Date = () => new Date(),
): AuthNotifier {
  return {
    async locked({ userId, workspaceIds, lockedUntil }) {
      for (const workspaceId of workspaceIds) {
        await queue.send(authLockNoticeJob, {
          ctx: { workspaceId, companyIds: [] },
          // One notice per lock: a retry of the same lock is the same job.
          idempotencyKey: `lock:${userId}:${lockedUntil.toISOString()}`,
          payload: { user_id: userId, locked_until: lockedUntil.toISOString() },
        });
      }
    },
    async passwordReset({ userId, workspaceId }) {
      await queue.send(authPasswordResetJob, {
        ctx: { workspaceId, companyIds: [] },
        // At most one reset email a minute for a user, however often the form is sent.
        idempotencyKey: `reset:${userId}:${String(Math.floor(now().getTime() / 60_000))}`,
        payload: { user_id: userId },
      });
    },
    async invite({ workspaceId, inviteId, within }) {
      if (within !== undefined && within.workspaceId !== workspaceId) {
        throw new Error('invite job: the request context is for another workspace');
      }
      await queue.send(authInviteJob, {
        ctx: within ?? { workspaceId, companyIds: [] },
        idempotencyKey: `invite:${inviteId}`,
        payload: { invite_id: inviteId },
      });
    },
  };
}
