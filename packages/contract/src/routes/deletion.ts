import { z } from 'zod';
import { FileDownloadSchema } from '../download.ts';
import { defineRoute } from '../route.ts';

/**
 * The deletion certificate of one channel account (DEL-3, T-0403): a text file with the number of
 * buyer records deleted for the account and every deletion run aimed at it (time, trigger,
 * counts, run ID). IDs and counts only, never a deleted value. Admins only; another workspace's
 * account is 404.
 */
export const getDeletionCertificate = defineRoute({
  id: 'getDeletionCertificate',
  method: 'GET',
  path: '/channel-accounts/:id/deletion-certificate',
  summary: 'Download the deletion certificate of a channel account',
  params: z.object({ id: z.uuid() }),
  responses: { 200: FileDownloadSchema },
  auth: 'session',
  tab: 'connections',
  adminOnly: true,
  companyScoped: false,
});
