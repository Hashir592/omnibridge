/**
 * Provider adapter for eBay. Only packages/providers may call provider APIs (invariant 10).
 */
export const PACKAGE_NAME = '@omnibridge/provider-ebay';
export {
  challengeResponse,
  ebayPublicKeyFetcher,
  isVerificationToken,
  PublicKeyCache,
  verifyNotification,
  type EbayApiOptions,
  type PublicKeySource,
} from './account-deletion.ts';
export { EBAY_SDK_SAMPLE } from './sample.ts';
