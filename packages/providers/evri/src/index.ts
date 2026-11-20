/**
 * Evri as a ShippingProvider (SHIP-3, INT-1), thin in M07: a token from the account's API key,
 * the service list, a parcel (label) request, the label file and tracking events. M12 checks the
 * shapes against Evri's onboarding pack and builds the rest. Every answer has a versioned parser.
 */
import { Secret } from '@omnibridge/crypto';
import {
  defineParser,
  ProviderRejected,
  readJson,
  type AccessToken,
  type ProviderHttp,
  type ShippingProvider,
} from '@omnibridge/provider-kit';
import { z } from 'zod';

export const PACKAGE_NAME = '@omnibridge/provider-evri';

const TokenV1 = defineParser(
  'evri',
  'token',
  1,
  z.object({ access_token: z.string().min(1), expires_in: z.number().int().positive() }),
);
const ServicesV1 = defineParser(
  'evri',
  'services',
  1,
  z.object({ services: z.array(z.object({ code: z.string(), name: z.string() })) }),
);
const ParcelV1 = defineParser(
  'evri',
  'parcel',
  1,
  z.object({ parcelId: z.string(), barcode: z.string(), labelRef: z.string() }),
);
const ParcelErrorV1 = defineParser(
  'evri',
  'parcel_error',
  1,
  z.object({ errors: z.array(z.object({ code: z.string() })).min(1) }),
);
const EventsV1 = defineParser(
  'evri',
  'events',
  1,
  z.object({
    events: z.array(z.object({ code: z.string(), dateTime: z.iso.datetime({ offset: true }) })),
  }),
);

export function createEvriAdapter(options: {
  http: ProviderHttp;
  clientId: Secret;
  now?: () => Date;
}): ShippingProvider {
  const now = options.now ?? (() => new Date());
  const base = options.http.base('evri', 'api');
  const auth = (t: AccessToken) => ({ authorization: `Bearer ${t.token.reveal()}` });
  return {
    provider: 'evri',
    canVoid: false,
    canTrack: true,
    needsManifest: false,

    async authenticate(credential) {
      const res = await options.http.request('evri', {
        url: new URL('oauth/token', base),
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: options.clientId.reveal(),
          client_secret: credential.reveal(),
        }).toString(),
      });
      const t = TokenV1.parse(await readJson('evri', res));
      return {
        token: new Secret(t.access_token),
        expiresAt: new Date(now().getTime() + t.expires_in * 1000),
      };
    },

    async listServices(token) {
      const res = await options.http.request('evri', {
        url: new URL('services', base),
        headers: auth(token),
      });
      return ServicesV1.parse(await readJson('evri', res)).services;
    },

    async createShipment(token, order, parcels, service, opts) {
      const res = await options.http.request('evri', {
        url: new URL('parcels', base),
        method: 'POST',
        headers: { ...auth(token), 'content-type': 'application/json' },
        body: JSON.stringify({
          reference: order.reference,
          service,
          signature: opts?.signature ?? false,
          deliveryAddress: order.address,
          parcels: parcels.map((p) => ({ weightGrams: p.weightGrams })),
        }),
      });
      if (res.status === 400) {
        // INVALID parcel: a stable code only; the answer may echo the address, so it is dropped.
        const body = ParcelErrorV1.parse(await res.json());
        throw new ProviderRejected('evri', `evri.${(body.errors[0]?.code ?? 'invalid').toLowerCase()}`);
      }
      const p = ParcelV1.parse(await readJson('evri', res));
      return {
        trackingNumbers: [p.barcode],
        carrierShipmentRef: p.parcelId,
        labels: [{ format: 'pdf', ref: p.labelRef }],
      };
    },

    async getLabel(token, ref) {
      const res = await options.http.request('evri', {
        url: new URL(`labels/${encodeURIComponent(ref)}`, base),
        headers: auth(token),
      });
      if (!res.ok) await readJson('evri', res);
      return new Uint8Array(await res.arrayBuffer());
    },

    async tracking(token, trackingNumber) {
      const res = await options.http.request('evri', {
        url: new URL(`parcels/${encodeURIComponent(trackingNumber)}/events`, base),
        headers: auth(token),
      });
      return EventsV1.parse(await readJson('evri', res)).events.map((e) => ({
        code: e.code,
        at: new Date(e.dateTime),
      }));
    },
  };
}
