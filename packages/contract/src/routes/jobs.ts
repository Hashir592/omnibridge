import { z } from 'zod';
import { defineRoute } from '../route.ts';

export const JobProgressSchema = z
  .object({
    id: z.uuid(),
    type: z.string(),
    state: z.enum(['queued', 'active', 'retrying', 'completed', 'failed']),
    attempt: z.number().int().min(0),
    percent: z.number().int().min(0).max(100),
    /** Counts and ids only; job results never hold buyer PII (invariant 7). */
    result: z.record(z.string(), z.unknown()).nullable(),
    error_code: z.string().nullable(),
    created_at: z.iso.datetime(),
    updated_at: z.iso.datetime(),
  })
  .meta({ id: 'JobProgress' });

export type JobProgress = z.infer<typeof JobProgressSchema>;

/** Progress and result of a background job in the caller's workspace (NFR-4). */
export const getJob = defineRoute({
  id: 'getJob',
  method: 'GET',
  path: '/jobs/:id',
  summary: 'Progress and result of a background job',
  params: z.object({ id: z.uuid() }),
  responses: { 200: JobProgressSchema },
  auth: 'session',
  tab: 'none',
  adminOnly: false,
  companyScoped: false,
});
