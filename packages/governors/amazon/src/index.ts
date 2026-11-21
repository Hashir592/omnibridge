/**
 * Amazon reactive token-bucket governor (RL-1). Must share no code with the eBay governor (RL-3).
 */
export const PACKAGE_NAME = '@omnibridge/governor-amazon';
export {
  AMAZON_BACKOFF,
  AMAZON_OPERATION_LIMITS,
  AmazonBackoffSpent,
  amazonBackoffMs,
  AmazonGovernor,
  withAmazonBackoff,
  type AmazonBucketStore,
  type BucketTake,
} from './governor.ts';
