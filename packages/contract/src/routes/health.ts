import { z } from 'zod';
import { defineRoute } from '../route.ts';

const CheckStatus = z.enum(['ok', 'error']);

export const HealthSchema = z
  .object({
    status: z.enum(['ok', 'degraded']),
    db_main: CheckStatus,
    db_pii: CheckStatus,
    version: z.string(),
  })
  .meta({ id: 'Health' });

export type Health = z.infer<typeof HealthSchema>;

/** Polled by Docker, the edge and the external uptime check (OPS-11). */
export const getHealth = defineRoute({
  id: 'getHealth',
  method: 'GET',
  path: '/healthz',
  summary: 'Service and database health',
  responses: { 200: HealthSchema, 503: HealthSchema },
  auth: 'public',
  tab: 'none',
  adminOnly: false,
  companyScoped: false,
});
