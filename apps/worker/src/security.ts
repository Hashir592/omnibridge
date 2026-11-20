import type { Notifier, TenantContext } from '@omnibridge/core';
import type {
  NotificationRepository,
  PlatformSecuritySignals,
  SecuritySignals,
} from '@omnibridge/db';
import type { Logger } from '@omnibridge/logger';
import { securityScanJob, type JobQueue, type PhasedHandler } from '@omnibridge/queue';
import type { SignalsResponse, VaultClient } from '@omnibridge/vault-client';

/**
 * Security alerts (T-0503, SEC-12). Every five minutes each workspace is scanned: counter rules
 * over the last hour or 15 minutes, which raise an alert to the workspace's admins at or above
 * their threshold and resolve it once the count drops below (NTF-1), and event rules (a sign-in
 * from a new network, a lockout, a canary read), one alert per event. Canary reads are
 * platform-level and critical. Alerts carry IDs and counts only (invariant 7).
 */

export interface SecurityThresholds {
  /** Failed sign-ins of one user in 15 minutes (USR-5 locks at 10). */
  loginFailures: number;
  /** Exports by one user in an hour. */
  exportsPerHour: number;
  /** Buyer records one user opened in full in an hour (DP-7). */
  piiViewsPerHour: number;
}

export const DEFAULT_SECURITY_THRESHOLDS: SecurityThresholds = {
  loginFailures: 5,
  exportsPerHour: 10,
  piiViewsPerHour: 50,
};

/** Thresholds from SECURITY_LOGIN_FAILURES, SECURITY_EXPORTS_PER_HOUR, SECURITY_PII_VIEWS_PER_HOUR. */
export function securityThresholdsFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): SecurityThresholds {
  const read = (name: string, fallback: number): number => {
    const raw = env[name];
    if (raw === undefined || raw === '') return fallback;
    if (!/^[1-9]\d{0,5}$/.test(raw)) {
      throw new Error(`${name} must be a whole number from 1 to 999999`);
    }
    return Number(raw);
  };
  return {
    loginFailures: read('SECURITY_LOGIN_FAILURES', DEFAULT_SECURITY_THRESHOLDS.loginFailures),
    exportsPerHour: read('SECURITY_EXPORTS_PER_HOUR', DEFAULT_SECURITY_THRESHOLDS.exportsPerHour),
    piiViewsPerHour: read(
      'SECURITY_PII_VIEWS_PER_HOUR',
      DEFAULT_SECURITY_THRESHOLDS.piiViewsPerHour,
    ),
  };
}

const MINUTE = 60_000;
/** Event rules look back further than the five-minute cadence, so a late run misses nothing. */
const EVENT_WINDOW_MS = 15 * MINUTE;
/** A new network is one not seen in this many days before the sign-in. */
const LOGIN_LOOKBACK_DAYS = 90;
/** S1 (19 Nov 2026): canary reads of the last day, so worker downtime loses none. */
const CANARY_WINDOW_MS = 24 * 60 * MINUTE;

interface Scan {
  at: string;
  signals: SignalsResponse;
}

export interface SecurityScanDeps {
  /** A client with the worker's token (capability `signals`). */
  vault: Pick<VaultClient, 'signals'>;
  signals: Pick<SecuritySignals, 'exportCounts' | 'newNetworkLogins' | 'loginFailures' | 'locks'>;
  notifications: Pick<NotificationRepository, 'openRecordIds'>;
  notifier: Pick<Notifier, 'raise' | 'resolve' | 'raisePlatform'>;
  thresholds: SecurityThresholds;
  logger: Logger;
  now?: () => Date;
}

/**
 * security.scan: `prepare` asks the vault (no db-main transaction open), `commit` reads the audit
 * log and auth events and raises or resolves in the job's one transaction.
 */
export function securityScanHandler(
  deps: SecurityScanDeps,
): PhasedHandler<Record<string, never>, Scan> {
  const now = deps.now ?? (() => new Date());
  return {
    prepare: async (job) => {
      const at = now();
      const signals = await deps.vault.signals({
        workspace_id: job.envelope.workspace_id,
        read_full_since: new Date(at.getTime() - 60 * MINUTE).toISOString(),
        canary_since: new Date(at.getTime() - CANARY_WINDOW_MS).toISOString(),
      });
      return { at: at.toISOString(), signals };
    },
    commit: async (job, scan) => {
      const ctx = job.ctx;
      const at = new Date(scan.at);
      const t = deps.thresholds;
      const raised: string[] = [];

      /** A counter rule: raise for each user at or above the threshold, resolve the rest. */
      const counter = async (
        type: string,
        counts: readonly { userId: string; count: number }[],
        threshold: number,
        windowMinutes: number,
      ) => {
        const over = counts.filter((c) => c.count >= threshold);
        for (const c of over) {
          await deps.notifier.raise(ctx, {
            type,
            record: { kind: 'user', id: c.userId },
            params: { userId: c.userId, count: c.count, windowMinutes, threshold },
          });
          raised.push(type);
        }
        const still = new Set(over.map((c) => c.userId));
        for (const id of await deps.notifications.openRecordIds(ctx, type, 'user')) {
          if (!still.has(id)) await deps.notifier.resolve(ctx, type, { kind: 'user', id });
        }
      };

      // Mass PII views (DP-7): full reads per user in the last hour, from the vault's log.
      await counter(
        'security.mass_pii_view',
        scan.signals.read_full.map((r) => ({ userId: r.actor_user_id, count: r.count })),
        t.piiViewsPerHour,
        60,
      );
      // Mass exports: every export kind in the audit log, per user, in the last hour.
      await counter(
        'security.mass_export',
        await deps.signals.exportCounts(ctx, new Date(at.getTime() - 60 * MINUTE)),
        t.exportsPerHour,
        60,
      );
      // A burst of failed sign-ins (USR-5) for one member in 15 minutes.
      await counter(
        'security.unusual_login',
        (await deps.signals.loginFailures(ctx, new Date(at.getTime() - 15 * MINUTE))).map((f) => ({
          userId: f.userId,
          count: f.failures,
        })),
        t.loginFailures,
        15,
      );

      const since = new Date(at.getTime() - EVENT_WINDOW_MS);
      // A sign-in from a network this user has not used in 90 days: one alert per sign-in.
      for (const login of await deps.signals.newNetworkLogins(ctx, since, LOGIN_LOOKBACK_DAYS)) {
        await deps.notifier.raise(ctx, {
          type: 'security.unusual_login',
          record: { kind: 'login', id: login.eventId },
          params: { userId: login.userId, newNetwork: true },
        });
        raised.push('security.unusual_login');
      }
      // Every lockout (USR-5), one alert each.
      for (const lock of await deps.signals.locks(ctx, since)) {
        await deps.notifier.raise(ctx, {
          type: 'security.account_locked',
          record: { kind: 'lock', id: lock.eventId },
          params: { userId: lock.userId },
        });
        raised.push('security.account_locked');
      }
      // Canary reads: critical and platform-level, one notice per read (NTF-5 keeps it one).
      for (const read of scan.signals.canary) {
        await raiseCanary(deps.notifier, ctx, read);
        raised.push('security.canary_read');
      }
      if (raised.length > 0) {
        deps.logger.warn(
          { event: 'security.alerts', workspaceId: ctx.workspaceId, count: raised.length },
          'security alerts raised',
        );
      }
      return { alerts: raised.length };
    },
  };
}

async function raiseCanary(
  notifier: Pick<Notifier, 'raisePlatform'>,
  ctx: TenantContext,
  read: SignalsResponse['canary'][number],
): Promise<void> {
  await notifier.raisePlatform(ctx, {
    type: 'security.canary_read',
    record: { kind: 'canary_event', id: read.id },
    params: {
      workspaceId: ctx.workspaceId,
      readFull: read.capability === 'read_full',
      byUser: read.actor_user_id !== null,
      ...(read.actor_user_id === null ? {} : { userId: read.actor_user_id }),
    },
  });
}

/**
 * S1 (21 Nov 2026, ADR-076): console entries and lockouts of platform admins are read over the
 * last day, as canary reads are, so worker downtime loses none; NTF-5 keeps one notice each.
 */
const PLATFORM_EVENT_WINDOW_MS = 24 * 60 * MINUTE;

export interface PlatformSecurityScanDeps {
  signals: Pick<PlatformSecuritySignals, 'newNetworkConsoleEntries' | 'loginFailures' | 'locks'>;
  notifications: Pick<NotificationRepository, 'openPlatformRecordIds'>;
  notifier: Pick<Notifier, 'raisePlatform' | 'resolvePlatform'>;
  thresholds: Pick<SecurityThresholds, 'loginFailures'>;
  logger: Logger;
  now?: () => Date;
}

/**
 * The platform-level rule (T-0507, SEC-12, S5-20261121-01), once per sweep: platform admins'
 * sign-ins are platform notices to platform admins, never alerts in a workspace. A console entry
 * from a network unseen in 90 days is critical (emailed); failed sign-ins at or above the
 * threshold in 15 minutes and every lockout are warnings. Params are IDs and counts only.
 * Returns how many notices it raised.
 */
export async function scanPlatformSecurity(deps: PlatformSecurityScanDeps): Promise<number> {
  const at = (deps.now ?? (() => new Date()))();
  let raised = 0;

  const failures = await deps.signals.loginFailures(new Date(at.getTime() - 15 * MINUTE));
  const threshold = deps.thresholds.loginFailures;
  const over = failures.filter((f) => f.failures >= threshold);
  for (const f of over) {
    await deps.notifier.raisePlatform(null, {
      type: 'security.platform_login_failures',
      record: { kind: 'user', id: f.userId },
      params: { userId: f.userId, count: f.failures, windowMinutes: 15, threshold },
    });
    raised += 1;
  }
  const still = new Set(over.map((f) => f.userId));
  for (const id of await deps.notifications.openPlatformRecordIds(
    'security.platform_login_failures',
    'user',
  )) {
    if (!still.has(id)) {
      await deps.notifier.resolvePlatform(null, 'security.platform_login_failures', {
        kind: 'user',
        id,
      });
    }
  }

  const since = new Date(at.getTime() - PLATFORM_EVENT_WINDOW_MS);
  for (const entry of await deps.signals.newNetworkConsoleEntries(since, LOGIN_LOOKBACK_DAYS)) {
    await deps.notifier.raisePlatform(null, {
      type: 'security.platform_unusual_login',
      record: { kind: 'console_entry', id: entry.eventId },
      params: { userId: entry.userId, newNetwork: true },
    });
    raised += 1;
  }
  for (const lock of await deps.signals.locks(since)) {
    await deps.notifier.raisePlatform(null, {
      type: 'security.platform_account_locked',
      record: { kind: 'lock', id: lock.eventId },
      params: { userId: lock.userId },
    });
    raised += 1;
  }
  if (raised > 0) {
    deps.logger.warn(
      { event: 'security.platform_alerts', count: raised },
      'platform security alerts raised',
    );
  }
  return raised;
}

/** security.scan-sweep: one security.scan job per workspace, keyed by the five-minute slot. */
export async function sweepSecurityScan({
  directory,
  queue,
  now = new Date(),
}: {
  directory: { listIds(): Promise<string[]> };
  queue: Pick<JobQueue, 'send'>;
  now?: Date;
}): Promise<number> {
  const slot = new Date(Math.floor(now.getTime() / (5 * MINUTE)) * 5 * MINUTE)
    .toISOString()
    .slice(0, 16);
  const ids = await directory.listIds();
  for (const workspaceId of ids) {
    await queue.send(securityScanJob, {
      ctx: { workspaceId, companyIds: [] },
      idempotencyKey: `security.scan:${slot}`,
      payload: {},
    });
  }
  return ids.length;
}
