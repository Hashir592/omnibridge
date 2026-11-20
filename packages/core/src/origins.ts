/**
 * Origin tags (INT-6): every provider-sourced record carries one, with its channel account, so all
 * data from one source can be found and deleted. The database rule is written by the
 * app.add_origin_columns migration helper (db-main 0037) from this same list.
 */
export const ORIGIN_TAGS = [
  'amazon',
  'amazon_ads',
  'ebay',
  'website',
  'evri',
  'dpd',
  'manual',
] as const;
export type OriginTag = (typeof ORIGIN_TAGS)[number];

/** The origins that are providers: every tag but `manual`, one per kind of channel account. */
export const PROVIDERS = ORIGIN_TAGS.filter(
  (tag): tag is Exclude<OriginTag, 'manual'> => tag !== 'manual',
);
export type Provider = Exclude<OriginTag, 'manual'>;

/** Providers whose accounts connect with OAuth; the rest take an API key. */
export const OAUTH_PROVIDERS = ['amazon', 'amazon_ads', 'ebay'] as const satisfies readonly Provider[];
export type OAuthProvider = (typeof OAUTH_PROVIDERS)[number];

/** Carriers and the website: a concurrency cap per account instead of a governor (RL-4). */
export const CAPPED_PROVIDERS = ['website', 'evri', 'dpd'] as const satisfies readonly Provider[];

/** Where provider calls go: dev and CI (mock), staging (sandbox) or production (live). INT-3. */
export const PROVIDER_MODES = ['mock', 'sandbox', 'live'] as const;
export type ProviderMode = (typeof PROVIDER_MODES)[number];

export function isProvider(value: string): value is Provider {
  return (PROVIDERS as readonly string[]).includes(value);
}

/** Reads PROVIDER_MODE; unset means `mock`, so nothing but production ever reaches a provider. */
export function providerModeFrom(value: string | undefined): ProviderMode {
  const mode = value ?? 'mock';
  if (!(PROVIDER_MODES as readonly string[]).includes(mode)) {
    throw new Error(`PROVIDER_MODE must be one of ${PROVIDER_MODES.join(', ')}`);
  }
  return mode as ProviderMode;
}
