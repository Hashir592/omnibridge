import { AUDIT_ACTIONS, AUDIT_ENTITY_TYPES } from '@omnibridge/core';
import { z } from 'zod';
import { FileDownloadSchema } from '../download.ts';
import { listQuery, pageOf } from '../pagination.ts';
import { defineRoute } from '../route.ts';

const AuditValue = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(z.union([z.string(), z.number()])),
]);

export const AuditEventSchema = z
  .object({
    id: z.uuid(),
    /** UTC; shown in Europe/London. */
    occurred_at: z.iso.datetime(),
    actor_kind: z.enum(['user', 'system', 'platform']),
    user_id: z.uuid().nullable(),
    /** The user's name while they are still a member; null after they leave. */
    user_name: z.string().nullable(),
    action: z.string(),
    entity_type: z.string(),
    entity_id: z.string().nullable(),
    /** Only the fields that changed, from the audit catalogue; never buyer PII (AUD-3). */
    before: z.record(z.string(), AuditValue).nullable(),
    after: z.record(z.string(), AuditValue).nullable(),
    reason: z.string().nullable(),
    ip: z.string().nullable(),
  })
  .meta({ id: 'AuditEvent' });

export type AuditEvent = z.infer<typeof AuditEventSchema>;

/** Filters shared by the list and the export (AUD-4). */
export const auditFilters = z.object({
  user_id: z.uuid().optional(),
  action: z.enum(AUDIT_ACTIONS).optional(),
  entity_type: z.enum(AUDIT_ENTITY_TYPES).optional(),
  entity_id: z.string().min(1).max(200).optional(),
  /** From this instant, inclusive. */
  from: z.iso.datetime({ offset: true }).optional(),
  /** Up to this instant, exclusive. */
  to: z.iso.datetime({ offset: true }).optional(),
});

export type AuditFilters = z.infer<typeof auditFilters>;

/** The workspace's audit log, newest first (AUD-4). Admins only; nobody can edit it. */
export const listAuditEvents = defineRoute({
  id: 'listAuditEvents',
  method: 'GET',
  path: '/audit-events',
  summary: 'List audit events',
  query: listQuery.extend(auditFilters.shape),
  responses: { 200: pageOf(AuditEventSchema) },
  auth: 'session',
  tab: 'audit-log',
  adminOnly: true,
  companyScoped: false,
});

/**
 * The matching audit events as CSV (AUD-4), newest first. The export is itself audited. Too many
 * matches is a 400: narrow the date range.
 */
export const exportAuditEvents = defineRoute({
  id: 'exportAuditEvents',
  method: 'GET',
  path: '/audit-events/export',
  summary: 'Export audit events as CSV',
  query: auditFilters,
  responses: { 200: FileDownloadSchema },
  auth: 'session',
  tab: 'audit-log',
  adminOnly: true,
  companyScoped: false,
});
