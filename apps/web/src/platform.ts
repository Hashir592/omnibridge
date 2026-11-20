/**
 * The platform console (T-0504: PLAT-1, PLAT-2, PLAT-3, OPS-6). The contract layer has already
 * checked the caller: a platform admin with MFA, from an allowlisted network, read again on this
 * request (AuthService.resolvePlatform). Every database call checks the admin once more, and every
 * answer holds IDs, workspace names, statuses, dates and counts only (PLAT-3).
 */
import { ApiError, type TenantRunner } from '@omnibridge/core';
import type { platformRoutes } from '@omnibridge/contract';
import type { AuditLog, PlatformConsole, WorkspaceStatus } from '@omnibridge/db';
import type { Logger } from '@omnibridge/logger';
import { workspaceCloseJob, type JobAdmin, type JobQueue } from '@omnibridge/queue';
import type { Handlers } from './contract.ts';

export interface PlatformOptions {
  console: Pick<
    PlatformConsole,
    | 'workspaces'
    | 'setWorkspaceStatus'
    | 'setModule'
    | 'flags'
    | 'setPublicSignup'
    | 'incidentBanner'
    | 'setIncidentBanner'
    | 'audit'
    | 'apiUsage'
    | 'credentialExpiry'
    | 'jobRecords'
  >;
  /** The queue as the console sees it; without it the job routes answer 503. */
  jobs?: Pick<JobAdmin, 'overview' | 'deadLetters' | 'redrive' | 'lastHeartbeat'>;
  /** Queues the workspace.close job in the archive's own transaction. */
  queue: Pick<JobQueue, 'send'>;
  /** The workspace's own audit log: a status or module change shows there too (T-0211). */
  audit: Pick<AuditLog, 'record'>;
  tenancy: TenantRunner;
  /** The /healthz checks (PLAT-2 system health). */
  checks: { dbMain: () => Promise<boolean>; dbPii: () => Promise<boolean> };
  version: string;
  logger: Logger;
  now?: () => Date;
}

/** The worker finishes its heartbeat job every minute; older than this, it is down. */
export const WORKER_HEARTBEAT_MAX_AGE_MS = 150_000;
/** The longest API usage range one call may ask for. */
const MAX_USAGE_DAYS = 92;
const DAY_MS = 86_400_000;

const unavailable = () =>
  Promise.reject(new ApiError({ status: 503, code: 'service_unavailable' }));
const notFound = () => new ApiError({ status: 404, code: 'not_found' });
const conflict = (detail: string) => new ApiError({ status: 409, code: 'conflict', detail });

async function check(fn: () => Promise<boolean>): Promise<'ok' | 'error'> {
  try {
    return (await fn()) ? 'ok' : 'error';
  } catch {
    return 'error';
  }
}

const iso = (d: Date | null) => (d === null ? null : d.toISOString());
const utcDay = (d: Date) => d.toISOString().slice(0, 10);

const AUDIT_ACTION: Readonly<Record<WorkspaceStatus, string>> = {
  suspended: 'workspace.suspended',
  active: 'workspace.reactivated',
  archived: 'workspace.archived',
};

export function platformHandlers(
  options: PlatformOptions | undefined,
): Handlers<typeof platformRoutes> {
  if (options === undefined) {
    return {
      listConsoleWorkspaces: unavailable,
      suspendWorkspace: unavailable,
      reactivateWorkspace: unavailable,
      archiveWorkspace: unavailable,
      setWorkspaceModules: unavailable,
      getPlatformFlags: unavailable,
      setPlatformFlags: unavailable,
      getQueueOverview: unavailable,
      listDeadLetters: unavailable,
      redriveDeadLetter: unavailable,
      listApiUsage: unavailable,
      listCredentialExpiry: unavailable,
      getPlatformHealth: unavailable,
      getIncidentBanner: unavailable,
      setIncidentBanner: unavailable,
      clearIncidentBanner: unavailable,
    };
  }
  const p: PlatformOptions = options;
  const now = p.now ?? (() => new Date());
  const needJobs = () => {
    if (p.jobs === undefined) throw new ApiError({ status: 503, code: 'service_unavailable' });
    return p.jobs;
  };

  /**
   * One status move in the workspace's own transaction: the status, the workspace's audit row,
   * the console's audit row and, for an archive, the closure job commit together or not at all.
   */
  async function move(
    userId: string,
    workspaceId: string,
    to: WorkspaceStatus,
    ip: string,
  ): Promise<{ status: 202; body: { id: string; status: WorkspaceStatus } }> {
    const at = now();
    const result = await p.tenancy.runWorkspace({ workspaceId }, async (ctx) => {
      const outcome = await p.console.setWorkspaceStatus(userId, workspaceId, to, at, ctx);
      if (outcome.outcome !== 'ok') return outcome;
      await p.audit.record(ctx, {
        action: 'workspace.status_changed',
        actor: { kind: 'platform', userId },
        entityId: workspaceId,
        before: { status: outcome.previous },
        after: { status: to },
        ip,
      });
      await p.console.audit(
        userId,
        { action: AUDIT_ACTION[to], workspaceId, params: { from: outcome.previous }, ip },
        at,
        ctx,
      );
      if (to === 'archived') {
        // DEL-1: the closure runs in the worker (deletion, memberships, terms), once per workspace.
        await p.queue.send(workspaceCloseJob, {
          ctx,
          idempotencyKey: `closure:${workspaceId}`,
          payload: {},
        });
      }
      return outcome;
    });
    if (result.outcome === 'not_found') throw notFound();
    if (result.outcome === 'conflict') {
      throw conflict(
        result.previous === 'archived'
          ? 'The workspace is archived; archiving is final'
          : `The workspace is ${result.previous}`,
      );
    }
    p.logger.info(
      { event: 'workspace.status_changed', workspaceId, userId, status: to },
      'workspace status changed',
    );
    return { status: 202, body: { id: workspaceId, status: to } };
  }

  return {
    listConsoleWorkspaces: async ({ platform }) => {
      const rows = await p.console.workspaces(platform.userId);
      return {
        status: 200,
        body: {
          items: rows.map((w) => ({
            id: w.id,
            name: w.name,
            status: w.status,
            status_changed_at: iso(w.statusChangedAt),
            created_at: w.createdAt.toISOString(),
            modules: w.modules,
            counts: {
              users: w.users,
              channel_accounts: w.channelAccounts,
              // Orders arrive in M10; until then there is nothing to count.
              orders_per_day: null,
            },
          })),
        },
      };
    },

    suspendWorkspace: ({ platform, params, request }) =>
      move(platform.userId, params.workspaceId, 'suspended', request.ip),
    reactivateWorkspace: ({ platform, params, request }) =>
      move(platform.userId, params.workspaceId, 'active', request.ip),
    archiveWorkspace: ({ platform, params, request }) =>
      move(platform.userId, params.workspaceId, 'archived', request.ip),

    setWorkspaceModules: async ({ platform, params, body, request }) => {
      const at = now();
      const outcome = await p.tenancy.runWorkspace(
        { workspaceId: params.workspaceId },
        async (ctx) => {
          const result = await p.console.setModule(
            platform.userId,
            params.workspaceId,
            'website_connector',
            body.website_connector,
            ctx,
          );
          if (result !== 'ok') return result;
          await p.audit.record(ctx, {
            action: 'workspace.module_changed',
            actor: { kind: 'platform', userId: platform.userId },
            entityId: params.workspaceId,
            after: { module: 'website_connector', enabled: body.website_connector },
            ip: request.ip,
          });
          await p.console.audit(
            platform.userId,
            {
              action: 'workspace.module_changed',
              workspaceId: params.workspaceId,
              params: { module: 'website_connector', enabled: body.website_connector },
              ip: request.ip,
            },
            at,
            ctx,
          );
          return result;
        },
      );
      if (outcome === 'not_found') throw notFound();
      if (outcome === 'archived') throw conflict('The workspace is archived');
      return { status: 200, body: { website_connector: body.website_connector } };
    },

    getPlatformFlags: async ({ platform }) => {
      const flags = await p.console.flags(platform.userId);
      return {
        status: 200,
        body: { public_signup: flags.publicSignup, updated_at: iso(flags.updatedAt) },
      };
    },

    setPlatformFlags: async ({ platform, body, request }) => {
      const at = now();
      await p.console.setPublicSignup(platform.userId, body.public_signup, at, {
        action: 'platform.flag_changed',
        params: { flag: 'public_signup', enabled: body.public_signup },
        ip: request.ip,
      });
      const flags = await p.console.flags(platform.userId);
      return {
        status: 200,
        body: { public_signup: flags.publicSignup, updated_at: iso(flags.updatedAt) },
      };
    },

    getQueueOverview: async () => {
      const rows = await needJobs().overview();
      return {
        status: 200,
        body: {
          items: rows.map((q) => ({
            type: q.type,
            queued: q.queued,
            active: q.active,
            failed: q.failed,
            dead_letter: q.deadLetter,
          })),
        },
      };
    },

    listDeadLetters: async ({ platform, query }) => {
      const dead = await needJobs().deadLetters(query.limit);
      const keys = dead.flatMap((d) =>
        d.workspaceId === null || d.idempotencyKey === null
          ? []
          : [{ workspaceId: d.workspaceId, type: d.type, idempotencyKey: d.idempotencyKey }],
      );
      const records = new Map(
        (await p.console.jobRecords(platform.userId, keys)).map((r) => [
          `${r.workspaceId}|${r.type}|${r.idempotencyKey}`,
          r,
        ]),
      );
      return {
        status: 200,
        body: {
          items: dead.map((d) => {
            const r = records.get(`${d.workspaceId ?? ''}|${d.type}|${d.idempotencyKey ?? ''}`);
            return {
              id: d.id,
              type: d.type,
              workspace_id: d.workspaceId,
              attempt: r?.attempt ?? null,
              error_code: r?.errorCode ?? null,
              dead_lettered_at: d.deadLetteredAt.toISOString(),
            };
          }),
        },
      };
    },

    redriveDeadLetter: async ({ platform, params, request }) => {
      const result = await needJobs().redrive(params.type, params.id);
      if (result.outcome === 'not_found') throw notFound();
      await p.console.audit(
        platform.userId,
        {
          action: 'job.redriven',
          workspaceId: result.workspaceId,
          params: { type: params.type, job_id: params.id },
          ip: request.ip,
        },
        now(),
      );
      return { status: 202, body: { id: params.id } };
    },

    listApiUsage: async ({ platform, query }) => {
      const today = now();
      const to = query.to ?? utcDay(today);
      const from = query.from ?? utcDay(new Date(today.getTime() - 6 * DAY_MS));
      const span = (Date.parse(to) - Date.parse(from)) / DAY_MS;
      if (span < 0 || span >= MAX_USAGE_DAYS) {
        throw new ApiError({
          status: 400,
          code: 'validation_failed',
          detail: `Ask for 1 to ${String(MAX_USAGE_DAYS)} days, from before to`,
          errors: [{ location: 'query', path: 'from', message: 'Out of range' }],
        });
      }
      const rows = await p.console.apiUsage(platform.userId, from, to);
      return {
        status: 200,
        body: {
          items: rows.map((r) => ({
            workspace_id: r.workspaceId,
            channel_account_id: r.channelAccountId,
            provider: r.provider,
            api: r.api,
            day: r.day,
            calls: r.calls,
            cap: r.cap,
          })),
        },
      };
    },

    listCredentialExpiry: async ({ platform, query }) => {
      const until = new Date(now().getTime() + query.within_days * DAY_MS);
      const rows = await p.console.credentialExpiry(platform.userId, until);
      return {
        status: 200,
        body: {
          items: rows.map((r) => ({
            workspace_id: r.workspaceId,
            channel_account_id: r.channelAccountId,
            kind: r.kind,
            slot: r.slot,
            expires_at: r.expiresAt.toISOString(),
          })),
        },
      };
    },

    getPlatformHealth: async () => {
      const [dbMain, piiVault, heartbeat, queues] = await Promise.all([
        check(p.checks.dbMain),
        check(p.checks.dbPii),
        p.jobs?.lastHeartbeat().catch(() => null) ?? Promise.resolve(null),
        p.jobs?.overview().catch(() => []) ?? Promise.resolve([]),
      ]);
      const worker =
        heartbeat !== null && now().getTime() - heartbeat.getTime() < WORKER_HEARTBEAT_MAX_AGE_MS
          ? 'ok'
          : 'error';
      const healthy = dbMain === 'ok' && piiVault === 'ok' && worker === 'ok';
      return {
        status: 200,
        body: {
          status: healthy ? 'ok' : 'degraded',
          services: { web: 'ok', db_main: dbMain, pii_vault: piiVault, worker },
          worker_heartbeat_at: iso(heartbeat),
          queue: {
            queued: queues.reduce((n, q) => n + q.queued, 0),
            dead_letter: queues.reduce((n, q) => n + q.deadLetter, 0),
          },
          version: p.version,
        },
      };
    },

    getIncidentBanner: async () => {
      const banner = await p.console.incidentBanner();
      return {
        status: 200,
        body: {
          incident:
            banner === null
              ? null
              : {
                  message: banner.message,
                  severity: banner.severity,
                  set_at: banner.setAt.toISOString(),
                },
        },
      };
    },

    setIncidentBanner: async ({ platform, body, request }) => {
      const at = now();
      // The text is the operator's own; the audit keeps its length and severity, not the words.
      await p.console.setIncidentBanner(
        platform.userId,
        { message: body.message, severity: body.severity },
        at,
        {
          action: 'platform.incident_set',
          params: { severity: body.severity, length: body.message.length },
          ip: request.ip,
        },
      );
      return {
        status: 200,
        body: {
          incident: { message: body.message, severity: body.severity, set_at: at.toISOString() },
        },
      };
    },

    clearIncidentBanner: async ({ platform, request }) => {
      const at = now();
      await p.console.setIncidentBanner(platform.userId, null, at, {
        action: 'platform.incident_cleared',
        ip: request.ip,
      });
      return { status: 204, body: null };
    },
  };
}
