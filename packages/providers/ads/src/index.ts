/**
 * Amazon Ads as an AdsAdapter (INT-1), thin in M07: an LWA access token, the profiles read and the
 * Sponsored Products campaign state write. M19 builds the rule engine on it.
 */
import { Secret } from '@omnibridge/crypto';
import {
  AuthFailed,
  defineParser,
  ProviderRejected,
  readJson,
  type AccessToken,
  type AdsAdapter,
  type ProviderHttp,
} from '@omnibridge/provider-kit';
import { z } from 'zod';

export const PACKAGE_NAME = '@omnibridge/provider-ads';

const TokenV1 = defineParser(
  'amazon_ads',
  'lwa_token',
  1,
  z.object({ access_token: z.string().min(1), expires_in: z.number().int().positive() }),
);
const ProfilesV1 = defineParser(
  'amazon_ads',
  'profiles',
  1,
  z.array(z.object({ profileId: z.number().int(), countryCode: z.string() })),
);
const CampaignsV1 = defineParser(
  'amazon_ads',
  'campaigns',
  1,
  z.object({
    campaigns: z.object({
      success: z.array(z.object({ campaignId: z.string() })),
      error: z.array(z.object({ index: z.number().int() })),
    }),
  }),
);

const SP_CAMPAIGN = 'application/vnd.spCampaign.v3+json';

export function createAdsAdapter(options: {
  http: ProviderHttp;
  clientId: Secret;
  clientSecret: Secret;
  now?: () => Date;
}): AdsAdapter {
  const now = options.now ?? (() => new Date());
  const lwa = options.http.base('amazon_ads', 'lwa');
  const api = options.http.base('amazon_ads', 'api');
  const headers = (t: AccessToken, profileId?: string) => ({
    authorization: `Bearer ${t.token.reveal()}`,
    'amazon-advertising-api-clientid': options.clientId.reveal(),
    ...(profileId === undefined ? {} : { 'amazon-advertising-api-scope': profileId }),
  });
  return {
    provider: 'amazon_ads',

    async authenticate(credential) {
      const res = await options.http.request('amazon_ads', {
        url: new URL('auth/o2/token', lwa),
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: credential.reveal(),
          client_id: options.clientId.reveal(),
          client_secret: options.clientSecret.reveal(),
        }).toString(),
      });
      if (res.status === 400) {
        const err = (await res.json().catch(() => ({}))) as { error?: unknown };
        if (err.error === 'invalid_grant') throw new AuthFailed('amazon_ads', true);
        throw new ProviderRejected('amazon_ads', 'http_400');
      }
      const t = TokenV1.parse(await readJson('amazon_ads', res));
      return {
        token: new Secret(t.access_token),
        expiresAt: new Date(now().getTime() + t.expires_in * 1000),
      };
    },

    async profiles(token) {
      const res = await options.http.request('amazon_ads', {
        url: new URL('v2/profiles', api),
        headers: headers(token),
      });
      return ProfilesV1.parse(await readJson('amazon_ads', res)).map((p) => ({
        profileId: String(p.profileId),
        countryCode: p.countryCode,
      }));
    },

    async setCampaignStates(token, profileId, changes) {
      const res = await options.http.request('amazon_ads', {
        url: new URL('sp/campaigns', api),
        method: 'PUT',
        headers: {
          ...headers(token, profileId),
          'content-type': SP_CAMPAIGN,
          accept: SP_CAMPAIGN,
        },
        body: JSON.stringify({
          campaigns: changes.map((c) => ({
            campaignId: c.campaignId,
            state: c.state.toUpperCase(),
          })),
        }),
      });
      const body = CampaignsV1.parse(await readJson('amazon_ads', res));
      return {
        accepted: body.campaigns.success.map((s) => s.campaignId),
        refused: body.campaigns.error.map((e) => ({
          sku: changes[e.index]?.campaignId ?? '',
          code: 'amazon_ads.rejected',
        })),
      };
    },
  };
}
