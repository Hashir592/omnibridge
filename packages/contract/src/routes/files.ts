import { z } from 'zod';
import { FileDownloadSchema } from '../download.ts';
import { defineRoute } from '../route.ts';

/**
 * Downloads a clean file through a signed link (NFR-5). The link is valid for 5 minutes and only
 * for the session it was issued to; a changed or expired link is 403.
 */
export const getFile = defineRoute({
  id: 'getFile',
  method: 'GET',
  path: '/files/:id',
  summary: 'Download a file through a signed link',
  params: z.object({ id: z.uuid() }),
  query: z.object({
    exp: z.coerce.number().int().positive(),
    sig: z.string().min(1).max(128),
  }),
  responses: { 200: FileDownloadSchema },
  auth: 'session',
  tab: 'none',
  adminOnly: false,
  companyScoped: false,
});
