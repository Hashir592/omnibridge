import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { ApiError } from '@omnibridge/core';
import type { privacyRoutes } from '@omnibridge/contract';
import type { AuditLog, ErasureRequest, ErasureRequestRepository } from '@omnibridge/db';
import { requestDeletion, type JobQueue } from '@omnibridge/queue';
import type { VaultClient } from '@omnibridge/vault-client';
import type { Handlers } from './contract.ts';

/**
 * Erasure and subject access requests (T-0404: DEL-4, DEL-5). The buyer's identifiers go to the
 * vault's logged search and nowhere else: db-main keeps the matching refs (an erasure) or nothing
 * (an access export, streamed to the admin and stored nowhere). Deletion runs through the one
 * deletion service, by ref (FA-14, invariant 7a). Audit rows hold kinds and counts only.
 */
export interface PrivacyOptions {
  vault: Pick<VaultClient, 'search' | 'mask' | 'readFull'>;
  erasures: Pick<
    ErasureRequestRepository,
    'create' | 'get' | 'list' | 'claim' | 'setJob' | 'withdraw'
  >;
  queue: Pick<JobQueue, 'send'>;
  audit: Pick<AuditLog, 'record'>;
  now?: () => Date;
  /** Most records one access export reads (default MAX_EXPORT_RECORDS); tests only. */
  maxExportRecords?: number;
}

/**
 * One export reads each record in full, one vault call each, inside the request: past this many
 * the admin narrows the identifiers instead (one buyer never has this many records).
 */
export const MAX_EXPORT_RECORDS = 500;

/** The vault masks at most this many refs per call. */
const MASK_BATCH = 200;

const unavailable = () =>
  Promise.reject(new ApiError({ status: 503, code: 'service_unavailable' }));

function requestBody(request: ErasureRequest, now: Date) {
  return {
    id: request.id,
    requestedAt: request.requestedAt.toISOString(),
    dueAt: request.dueAt.toISOString(),
    overdue: request.state === 'open' && now.getTime() > request.dueAt.getTime(),
    state: request.state,
    matchCount: request.piiRefs.length,
    confirmedAt: request.confirmedAt?.toISOString() ?? null,
    jobId: request.jobId,
    withdrawnAt: request.withdrawnAt?.toISOString() ?? null,
    withdrawReason: request.withdrawReason,
  };
}

export function privacyHandlers(
  options: PrivacyOptions | undefined,
): Handlers<typeof privacyRoutes> {
  if (options === undefined) {
    return {
      createErasureRequest: unavailable,
      listErasureRequests: unavailable,
      confirmErasureRequest: unavailable,
      withdrawErasureRequest: unavailable,
      exportSubjectAccess: unavailable,
    };
  }
  const o = options;
  const now = () => (o.now ?? (() => new Date()))();

  return {
    createErasureRequest: async ({ body, session, tenant, request }) => {
      const found = await o.vault.search({
        workspaceId: tenant.workspaceId,
        purpose: 'erasure',
        query: body.identifiers,
        actorUserId: session.userId,
      });
      const refs = found.matches.map((m) => m.pii_ref);
      const masked = new Map<string, Record<string, string>>();
      for (let i = 0; i < refs.length; i += MASK_BATCH) {
        const page = await o.vault.mask(tenant.workspaceId, refs.slice(i, i + MASK_BATCH));
        for (const r of page.records) masked.set(r.pii_ref, r.fields);
      }
      const at = now();
      const created = await o.erasures.create(tenant, {
        id: randomUUID(),
        requestedBy: session.userId,
        piiRefs: refs,
        at,
      });
      await o.audit.record(tenant, {
        action: 'deletion.run',
        actor: { kind: 'user', userId: session.userId },
        entityId: created.id,
        after: { kind: 'erasure_requested', row_count: refs.length },
        ip: request.ip,
      });
      return {
        status: 201,
        body: {
          ...requestBody(created, at),
          matches: found.matches.map((m) => ({
            piiRef: m.pii_ref,
            kind: m.kind,
            subjectType: m.subject_type,
            subjectId: m.subject_id,
            channelAccountId: m.channel_account_id,
            masked: masked.get(m.pii_ref) ?? {},
          })),
          truncated: found.truncated,
        },
      };
    },

    listErasureRequests: async ({ tenant }) => {
      const at = now();
      const items = await o.erasures.list(tenant);
      return { status: 200, body: { items: items.map((r) => requestBody(r, at)) } };
    },

    // S5-20261118-02: claim first (committed), then queue, then record the job. A withdraw that
    // comes in between finds the request no longer open. A claimed request whose queue call
    // failed has no job yet: confirming it again queues it (same key, so it runs once).
    confirmErasureRequest: async ({ params, session, tenant, request }) => {
      const existing = await o.erasures.get(tenant, params.id);
      if (existing === undefined) throw new ApiError({ status: 404, code: 'not_found' });
      const at = now();
      let claimed =
        existing.state === 'open'
          ? await o.erasures.claim(tenant, existing.id, { by: session.userId, at })
          : undefined;
      if (claimed === undefined) {
        // Not open, or claimed by someone else just now: only a claim with no job yet is retried.
        const current =
          existing.state === 'open' ? await o.erasures.get(tenant, existing.id) : existing;
        const retry =
          current?.state === 'confirmed' && current.jobId === null && current.piiRefs.length > 0;
        if (!retry) {
          throw new ApiError({
            status: 409,
            code: 'conflict',
            detail: `This erasure request is ${current?.state ?? 'gone'}, not open.`,
          });
        }
        claimed = current;
      }
      let confirmed = claimed;
      if (claimed.piiRefs.length > 0) {
        // One deletion of exactly the refs the admin saw, keyed by the request so it runs once.
        const job = await requestDeletion(o.queue, tenant, {
          trigger: 'erasure',
          scope: { type: 'refs', pii_refs: claimed.piiRefs },
          idempotencyKey: claimed.id,
        });
        confirmed = (await o.erasures.setJob(tenant, claimed.id, job.id)) ?? {
          ...claimed,
          jobId: job.id,
        };
      }
      // Audited with the response that queued it (a failed queue call rolls its audit row back).
      await o.audit.record(tenant, {
        action: 'deletion.run',
        actor: { kind: 'user', userId: session.userId },
        entityId: claimed.id,
        after: { kind: 'erasure_confirmed', row_count: claimed.piiRefs.length },
        ip: request.ip,
      });
      return { status: 202, body: requestBody(confirmed, at) };
    },

    // ADR-067: an open request is closed with a reason code; nothing is queued or deleted.
    withdrawErasureRequest: async ({ params, body, session, tenant, request }) => {
      const existing = await o.erasures.get(tenant, params.id);
      if (existing === undefined) throw new ApiError({ status: 404, code: 'not_found' });
      const at = now();
      const withdrawn =
        existing.state === 'open'
          ? await o.erasures.withdraw(tenant, existing.id, {
              by: session.userId,
              at,
              reason: body.reason,
            })
          : undefined;
      if (withdrawn === undefined) {
        throw new ApiError({
          status: 409,
          code: 'conflict',
          detail: 'Only an open erasure request can be withdrawn.',
        });
      }
      await o.audit.record(tenant, {
        action: 'deletion.run',
        actor: { kind: 'user', userId: session.userId },
        entityId: existing.id,
        after: { kind: 'erasure_withdrawn', row_count: existing.piiRefs.length },
        reason: body.reason,
        ip: request.ip,
      });
      return { status: 200, body: requestBody(withdrawn, at) };
    },

    exportSubjectAccess: async ({ body, session, tenant, request }) => {
      const found = await o.vault.search({
        workspaceId: tenant.workspaceId,
        purpose: 'access_request',
        query: body.identifiers,
        actorUserId: session.userId,
      });
      if (found.truncated || found.matches.length > (o.maxExportRecords ?? MAX_EXPORT_RECORDS)) {
        throw new ApiError({
          status: 422,
          code: 'validation_failed',
          detail: 'Too many records match. Add more details of the buyer and try again.',
        });
      }
      // Every record read in full is logged by the vault (purpose subject_access, DP-7).
      const records = [];
      for (const m of found.matches) {
        const full = await o.vault.readFull({
          workspaceId: tenant.workspaceId,
          piiRef: m.pii_ref,
          purpose: 'subject_access',
          actorUserId: session.userId,
        });
        records.push({
          kind: full.kind,
          subjectType: full.subject_type,
          subjectId: full.subject_id,
          channelAccountId: m.channel_account_id,
          fields: full.fields,
        });
      }
      const file = Buffer.from(
        `${JSON.stringify(
          {
            exportedAt: now().toISOString(),
            note: 'Everything OmniBridge holds about this buyer in this workspace (DEL-5).',
            records,
            // Order records join here once orders are stored (M10): by subjectType and subjectId.
            linkedOrders: [],
          },
          null,
          2,
        )}\n`,
        'utf8',
      );
      await o.audit.record(tenant, {
        action: 'export.created',
        actor: { kind: 'user', userId: session.userId },
        entityId: randomUUID(),
        after: { kind: 'subject_access', row_count: records.length },
        ip: request.ip,
      });
      return {
        status: 200,
        body: {
          stream: Readable.from([file]),
          contentType: 'application/json; charset=utf-8',
          sizeBytes: file.length,
        },
      };
    },
  };
}
