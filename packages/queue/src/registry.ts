import { DELETION_TRIGGERS, DeletionScope } from '@omnibridge/vault-client/schemas';
import { PII_DELETE_JOB_TYPE } from '@omnibridge/core';
import { z } from 'zod';
import {
  defineJob,
  definePlatformJob,
  type JobDefinition,
  type PlatformJobDefinition,
} from './job.ts';
import { outboundRecoverJob, outboundRecoverSweepJob, outboundSendJob } from './outbound.ts';

/**
 * Virus scan of an uploaded file (SEC-2, T-0105). If clamd is unreachable the job fails and
 * retries with backoff, and the file stays `scanning`: never clean by default (ADR-021).
 */
export const filesScanJob = defineJob({
  type: 'files.scan',
  payload: z.object({ file_id: z.uuid() }),
  retry: { limit: 8, delaySeconds: 15, backoff: true, maxDelaySeconds: 1_800 },
  expireInSeconds: 600,
});

/**
 * Audit retention for one workspace (AUD-3): deletes its events older than 6 years. Sent once a
 * day per workspace by the sweep below; running it twice the same day deletes nothing more.
 */
export const auditRetentionJob = defineJob({
  type: 'audit.retention',
  payload: z.object({}),
  retry: { limit: 5, delaySeconds: 60, backoff: true, maxDelaySeconds: 3_600 },
  expireInSeconds: 900,
});

/**
 * Lock notice (USR-5): the worker emails the locked user and the admins of this workspace. Web
 * only enqueues it, so a lock costs the same time for a real email and an unknown one (ADR-050).
 */
export const authLockNoticeJob = defineJob({
  type: 'auth.lock_notice',
  payload: z.object({ user_id: z.uuid(), locked_until: z.iso.datetime() }),
  retry: { limit: 5, delaySeconds: 30, backoff: true, maxDelaySeconds: 900 },
  expireInSeconds: 120,
});

/**
 * Password reset email (USR-7): the worker makes the 30-minute token and sends the link, so the
 * token never sits in the queue or the database.
 */
export const authPasswordResetJob = defineJob({
  type: 'auth.password_reset',
  payload: z.object({ user_id: z.uuid() }),
  // Few retries: a link sent late is little use, and the user can ask again.
  retry: { limit: 2, delaySeconds: 30 },
  expireInSeconds: 120,
});

/**
 * Invite email (USR-1, TEN-7): the worker makes the token, stores only its hash on the invite and
 * mails the link, so the token never sits in the queue. A retry makes a new link.
 */
export const authInviteJob = defineJob({
  type: 'auth.invite',
  payload: z.object({ invite_id: z.uuid() }),
  retry: { limit: 5, delaySeconds: 30, backoff: true, maxDelaySeconds: 900 },
  expireInSeconds: 120,
});

/**
 * The quarterly access review for one workspace (USR-9): creates the next review task when the
 * last one is 90 days old. Sent once a day per workspace by the sweep; a repeat creates nothing.
 */
export const accessReviewJob = defineJob({
  type: 'users.access_review',
  payload: z.object({}),
  retry: { limit: 5, delaySeconds: 60, backoff: true, maxDelaySeconds: 3_600 },
  expireInSeconds: 300,
});

/**
 * Job record retention for one workspace (F-M01-end-05): deletes finished job records and expired
 * leases older than 30 days. Sent once a day per workspace by the housekeeping sweep.
 */
export const jobsRetentionJob = defineJob({
  type: 'jobs.retention',
  payload: z.object({}),
  retry: { limit: 5, delaySeconds: 60, backoff: true, maxDelaySeconds: 3_600 },
  expireInSeconds: 300,
});

/** INV-5: the stock change log of one workspace past its 3 years, sent by the housekeeping sweep. */
export const stockRetentionJob = defineJob({
  type: 'stock.retention',
  payload: z.object({}).strict(),
  retry: { limit: 5, delaySeconds: 60, backoff: true, maxDelaySeconds: 3_600 },
  expireInSeconds: 300,
});

/**
 * One run of the deletion service (DEL-1): the vault hard-deletes the scope, then db-main keeps
 * the run log and tombstones (T-0403). The payload is a trigger and IDs, never PII (invariant 7a).
 * Sent through `requestDeletion`, which checks the trigger and scope fit.
 */
export const piiDeleteJob = defineJob({
  type: PII_DELETE_JOB_TYPE,
  payload: z.object({ trigger: z.enum(DELETION_TRIGGERS), scope: DeletionScope }).strict(),
  retry: { limit: 10, delaySeconds: 30, backoff: true, maxDelaySeconds: 3_600 },
  expireInSeconds: 900,
});

/** The hourly PII expiry of one workspace (DEL-1 trigger 1, AT-8): records past delete_after. */
export const piiExpiryJob = defineJob({
  type: 'pii.expiry',
  payload: z.object({}).strict(),
  retry: { limit: 5, delaySeconds: 60, backoff: true, maxDelaySeconds: 1_800 },
  expireInSeconds: 900,
});

/**
 * One notification email to one recipient (T-0502: NTF-3, NTF-4): IDs only (invariant 7a). The
 * version is the notification's at raise time, so a re-raise that is not new, higher or
 * reopened queues nothing, and a retried job never sends twice (the sent record is per version).
 */
export const notifyEmailJob = defineJob({
  type: 'notify.email',
  payload: z
    .object({ notification_id: z.uuid(), user_id: z.uuid(), version: z.number().int().min(1) })
    .strict(),
  retry: { limit: 6, delaySeconds: 30, backoff: true, maxDelaySeconds: 1_800 },
  expireInSeconds: 120,
});

/**
 * The security scan of one workspace (T-0503, SEC-12): counter rules over the audit log, the
 * auth events and the vault's read counts and canary reads. Every five minutes, keyed by slot.
 */
export const securityScanJob = defineJob({
  type: 'security.scan',
  payload: z.object({}).strict(),
  retry: { limit: 2, delaySeconds: 30, backoff: true, maxDelaySeconds: 120 },
  expireInSeconds: 240,
});

/**
 * Notification retention for one workspace (ADR-071 4a): hard-deletes notifications resolved more
 * than 90 days ago, with their read and email rows. Sent once a day by the housekeeping sweep.
 */
export const notifyRetentionJob = defineJob({
  type: 'notify.retention',
  payload: z.object({}).strict(),
  retry: { limit: 5, delaySeconds: 60, backoff: true, maxDelaySeconds: 3_600 },
  expireInSeconds: 300,
});

/**
 * Closing an archived workspace (PLAT-2, DEL-1): queues the workspace_closure deletion, removes
 * every membership, then deletes the terms of people left with no workspace (ADR-058b). Sent once
 * by the console's archive, keyed `closure:<workspace>`; every step is safe to repeat.
 */
export const workspaceCloseJob = defineJob({
  type: 'workspace.close',
  payload: z.object({}).strict(),
  retry: { limit: 10, delaySeconds: 60, backoff: true, maxDelaySeconds: 3_600 },
  expireInSeconds: 300,
});

/** The incremental sync streams (INT-8); each adds its name here with its module. */
export const SYNC_STREAMS = ['ebay.orders', 'website.orders'] as const;
export type SyncStreamName = (typeof SYNC_STREAMS)[number];

/**
 * One incremental poll of one account and stream (T-0701: INT-2, INT-8): the job → governor →
 * parser → cursor path. Polls of one account run one at a time, in order. A parser failure ends
 * the job at once (PermanentJobError, INT-5). The order streams are sent every 5 minutes by
 * `orders.sync_accounts` (M10, CAP-6).
 */
export const syncPollJob = defineJob({
  type: 'sync.poll',
  payload: z.object({ stream: z.enum(SYNC_STREAMS) }).strict(),
  serialPerAccount: true,
  retry: { limit: 4, delaySeconds: 60, backoff: true, maxDelaySeconds: 1_800 },
  expireInSeconds: 600,
});

/**
 * CAT-6: a listing's mapping changed (map, remap or unmap), sent in the same transaction as the
 * change. IDs only. Its handler runs the listeners M09 (stock back-fill, mode reset) and M10
 * (write-once snapshots) register; each listener is idempotent.
 */
export const listingMappedJob = defineJob({
  type: 'catalogue.listing_mapped',
  payload: z
    .object({
      listing_id: z.uuid(),
      master_sku_id: z.uuid().nullable(),
      previous_master_sku_id: z.uuid().nullable(),
    })
    .strict(),
  retry: { limit: 10, delaySeconds: 30, backoff: true, maxDelaySeconds: 1_800 },
  expireInSeconds: 300,
});

/**
 * CAT-5: one complete listing scan of one account (on connect and daily). Provider calls run
 * outside any transaction; each page is upserted by (account, external SKU) in its own short one.
 */
export const listingsDiscoverJob = defineJob({
  type: 'listings.discover',
  payload: z.object({}).strict(),
  serialPerAccount: true,
  retry: { limit: 4, delaySeconds: 120, backoff: true, maxDelaySeconds: 3_600 },
  expireInSeconds: 1_800,
});

/** CAT-5: the daily fan-out inside one workspace: one listings.discover job per sales account. */
export const listingsDiscoverAccountsJob = defineJob({
  type: 'listings.discover_accounts',
  payload: z.object({}).strict(),
  retry: { limit: 4, delaySeconds: 60, backoff: true, maxDelaySeconds: 1_800 },
  expireInSeconds: 300,
});

/**
 * M10 (CAP-6, EBAY-6): one sync.poll per connected eBay and website account for its order stream,
 * every 5 minutes, keyed by the 5-minute slot so a second sweep in the slot sends none.
 */
export const ordersSyncAccountsJob = defineJob({
  type: 'orders.sync_accounts',
  payload: z.object({}).strict(),
  retry: { limit: 2, delaySeconds: 30, backoff: true, maxDelaySeconds: 120 },
  expireInSeconds: 240,
});

/**
 * DEL-1 (ADR-068): an order was dispatched or delivered, so its buyer record's expiry moves to
 * that date plus the PII window. IDs only (invariant 7a); the vault journals the change.
 */
export const ordersPiiExpiryJob = defineJob({
  type: 'orders.pii_expiry',
  payload: z.object({ order_id: z.uuid(), reason: z.enum(['dispatch', 'delivery']) }).strict(),
  retry: { limit: 10, delaySeconds: 60, backoff: true, maxDelaySeconds: 3_600 },
  expireInSeconds: 300,
});

/**
 * ORD-9 (C3.2): recompute one channel account's same-buyer groups after its orders changed. The
 * vault's `match` capability names the orders that share a buyer, then db-main links them under an
 * advisory lock per account. IDs only; one account at a time.
 */
export const ordersGroupRecomputeJob = defineJob({
  type: 'orders.group_recompute',
  payload: z.object({}).strict(),
  serialPerAccount: true,
  retry: { limit: 5, delaySeconds: 30, backoff: true, maxDelaySeconds: 600 },
  expireInSeconds: 300,
});

/**
 * FA-10: the nightly orphan sweep of one workspace. Vault order records that no db-main order
 * points at (a db-main write failed after the vault write) are expired now, so the hourly expiry
 * run deletes them. Compared by ID only.
 */
export const ordersOrphanSweepJob = defineJob({
  type: 'orders.orphan_sweep',
  payload: z.object({}).strict(),
  retry: { limit: 4, delaySeconds: 300, backoff: true, maxDelaySeconds: 3_600 },
  expireInSeconds: 1_800,
});

/**
 * Every workspace job type the app runs. The migrate job creates a queue and a dead-letter queue
 * for each one as ob_owner (ADR-032), and the worker registers a handler for each. Provider
 * modules add their job types here (M07 onwards).
 */
/**
 * SHIP-3, EVRI-3 (T-1201): buy the labels of one shipment, then store their files in pii-vault.
 * The envelope's account is the carrier account. Each parcel row exists before the call and is
 * moved on from the state it is in, so a retry never buys a parcel twice; a full carrier cap is a
 * governor wait (RL-4). IDs only.
 */
export const labelsCreateJob = defineJob({
  type: 'labels.create',
  payload: z.object({ shipment_id: z.uuid() }).strict(),
  retry: { limit: 8, delaySeconds: 30, backoff: true, maxDelaySeconds: 900 },
  expireInSeconds: 900,
});

/** SHP-5, EVRI-5: fetch a stored shipment's labels again by barcode. Never buys a parcel. */
export const labelsFetchJob = defineJob({
  type: 'labels.fetch',
  payload: z.object({ shipment_id: z.uuid() }).strict(),
  retry: { limit: 5, delaySeconds: 30, backoff: true, maxDelaySeconds: 600 },
  expireInSeconds: 600,
});

/** SHP-5: a voided shipment's label files go from the vault at once (invariant 11). */
export const labelsDiscardJob = defineJob({
  type: 'labels.discard',
  payload: z.object({ shipment_id: z.uuid() }).strict(),
  retry: { limit: 10, delaySeconds: 60, backoff: true, maxDelaySeconds: 3_600 },
  expireInSeconds: 300,
});

export const JOBS: readonly JobDefinition[] = [
  filesScanJob,
  auditRetentionJob,
  authLockNoticeJob,
  authPasswordResetJob,
  authInviteJob,
  accessReviewJob,
  jobsRetentionJob,
  piiDeleteJob,
  piiExpiryJob,
  notifyEmailJob,
  securityScanJob,
  notifyRetentionJob,
  workspaceCloseJob,
  syncPollJob,
  outboundSendJob,
  outboundRecoverJob,
  listingMappedJob,
  listingsDiscoverJob,
  listingsDiscoverAccountsJob,
  stockRetentionJob,
  ordersSyncAccountsJob,
  ordersPiiExpiryJob,
  ordersOrphanSweepJob,
  ordersGroupRecomputeJob,
  labelsCreateJob,
  labelsFetchJob,
  labelsDiscardJob,
];

/**
 * The daily audit retention sweep (AUD-3): lists every workspace as ob_platform and sends one
 * audit.retention job each. Heavy, so it runs in the low-traffic window (02:30 London).
 */
export const auditRetentionSweepJob = definePlatformJob({
  type: 'audit.retention-sweep',
  cron: '30 2 * * *',
  heavy: true,
});

/** The daily access review sweep (USR-9): one users.access_review job per workspace (03:00). */
export const accessReviewSweepJob = definePlatformJob({
  type: 'users.access-review-sweep',
  cron: '0 3 * * *',
  heavy: false,
});

/**
 * The daily housekeeping sweep (T-0207, 02:45 London): deletes ended sessions and used or expired
 * reset links (user-level, no workspace), then sends one jobs.retention job per workspace.
 */
export const housekeepingSweepJob = definePlatformJob({
  type: 'housekeeping.daily-sweep',
  cron: '45 2 * * *',
  heavy: true,
});

/**
 * The hourly PII expiry sweep (ARCHITECTURE 6.2): one pii.expiry job per workspace, five minutes
 * past every hour. Light, so it runs around the clock (records past delete_after go within the hour).
 */
export const piiExpirySweepJob = definePlatformJob({
  type: 'pii.expiry-sweep',
  cron: '5 * * * *',
  heavy: false,
});

/**
 * Critical platform notices (NTF-2, NTF-3): every minute, emails each platform admin about each
 * one not yet sent at its current version. Light, and a run with nothing to send is one query.
 */
export const notifyPlatformEmailSweepJob = definePlatformJob({
  type: 'notify.platform-email-sweep',
  cron: '* * * * *',
  heavy: false,
});

/** SEC-12: one security.scan job per workspace every five minutes (T-0503). */
export const securityScanSweepJob = definePlatformJob({
  type: 'security.scan-sweep',
  cron: '*/5 * * * *',
  heavy: false,
});

/**
 * OPS-6: the daily health digest to every platform admin at 07:00 London (counts only). Light;
 * a second run the same day sends nothing (one sent record per admin and day).
 */
export const platformDigestJob = definePlatformJob({
  type: 'platform.health-digest',
  cron: '0 7 * * *',
  heavy: false,
});

/** CAT-5: the daily listing discovery, one listings.discover job per connected sales account. */
export const listingsDiscoverSweepJob = definePlatformJob({
  type: 'listings.discover-sweep',
  cron: '15 3 * * *',
  heavy: true,
});

/** M10 (CAP-6): one orders.sync_accounts job per workspace every 5 minutes. Light. */
export const ordersSyncSweepJob = definePlatformJob({
  type: 'orders.sync-sweep',
  cron: '*/5 * * * *',
  heavy: false,
});

/** FA-10: the nightly orphan sweep, one orders.orphan_sweep job per workspace (03:40 London). */
export const ordersOrphanSweepPlatformJob = definePlatformJob({
  type: 'orders.orphan-sweep',
  cron: '40 3 * * *',
  heavy: true,
});

/**
 * Every platform job with a cron (no workspace). The migrate job creates their queues, and the
 * worker schedules and consumes each one.
 */
export const PLATFORM_JOBS: readonly PlatformJobDefinition[] = [
  auditRetentionSweepJob,
  accessReviewSweepJob,
  housekeepingSweepJob,
  piiExpirySweepJob,
  notifyPlatformEmailSweepJob,
  securityScanSweepJob,
  platformDigestJob,
  outboundRecoverSweepJob,
  listingsDiscoverSweepJob,
  ordersSyncSweepJob,
  ordersOrphanSweepPlatformJob,
];
