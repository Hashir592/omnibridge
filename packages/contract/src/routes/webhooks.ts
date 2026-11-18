import { z } from 'zod';
import { defineRoute } from '../route.ts';

/*
 * eBay Marketplace Account Deletion (EBAY-2, T-0602). eBay calls these from its servers: the
 * challenge GET when the endpoint is subscribed, then a signed POST for each deletion.
 */

const outsideTabs = { tab: 'none', adminOnly: false, companyScoped: false } as const;
export const EBAY_ACCOUNT_DELETION_PATH = '/webhooks/ebay/account-deletion';

/** The subscription challenge: answered with a hash that proves we hold the token. */
export const ebayAccountDeletionChallenge = defineRoute({
  id: 'ebayAccountDeletionChallenge',
  method: 'GET',
  path: EBAY_ACCOUNT_DELETION_PATH,
  summary: 'eBay account deletion: subscription challenge',
  query: z.object({ challenge_code: z.string().min(1).max(256) }),
  responses: {
    200: z.object({ challengeResponse: z.string() }).meta({ id: 'EbayChallengeResponse' }),
  },
  auth: 'public',
  ...outsideTabs,
});

/** One deletion notice, signed by eBay (X-EBAY-SIGNATURE, checked before the handler runs). */
export const ebayAccountDeletion = defineRoute({
  id: 'ebayAccountDeletion',
  method: 'POST',
  path: EBAY_ACCOUNT_DELETION_PATH,
  summary: 'eBay account deletion notice',
  body: z
    .looseObject({
      metadata: z.looseObject({ topic: z.string() }),
      notification: z.looseObject({}),
    })
    .meta({ id: 'EbayAccountDeletionNotice' }),
  /** EBAY-2: 200 within 3 seconds; the deletion itself is queued. */
  responses: { 200: z.null() },
  auth: 'signed-webhook',
  ...outsideTabs,
});

export const webhookRoutes = [ebayAccountDeletionChallenge, ebayAccountDeletion] as const;
