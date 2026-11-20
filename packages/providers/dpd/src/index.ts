/**
 * DPD UK as a ShippingProvider (SHIP-3, INT-1), thin in M07: a geoSession from the account's
 * login, the network (service) list, a shipment, its label and parcel events. M13 builds the rest
 * and checks every shape against DPD's own documents. Every answer has a versioned parser.
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

export const PACKAGE_NAME = '@omnibridge/provider-dpd';

/** A geoSession lasts until DPD ends it; it is renewed every few hours to stay safe. */
const SESSION_MS = 4 * 60 * 60_000;

const LoginV1 = defineParser(
  'dpd',
  'login',
  1,
  z.object({ data: z.object({ geoSession: z.string().min(1) }) }),
);
const NetworkV1 = defineParser(
  'dpd',
  'network',
  1,
  z.object({
    data: z.array(
      z.object({ network: z.object({ networkCode: z.string(), networkDescription: z.string() }) }),
    ),
  }),
);
const ShipmentV1 = defineParser(
  'dpd',
  'shipment',
  1,
  z.object({
    data: z.object({
      shipmentId: z.number().int(),
      consignmentDetail: z.array(
        z.object({ consignmentNumber: z.string(), parcelNumbers: z.array(z.string()) }),
      ),
    }),
  }),
);
const ShipmentErrorV1 = defineParser(
  'dpd',
  'shipment_error',
  1,
  z.object({ error: z.array(z.object({ errorCode: z.string() })).min(1) }),
);
const EventsV1 = defineParser(
  'dpd',
  'events',
  1,
  z.object({
    data: z.array(z.object({ code: z.string(), date: z.iso.datetime({ offset: true }) })),
  }),
);

export function createDpdAdapter(options: {
  http: ProviderHttp;
  now?: () => Date;
}): ShippingProvider {
  const now = options.now ?? (() => new Date());
  const base = options.http.base('dpd', 'api');
  const session = (t: AccessToken) => ({
    geosession: t.token.reveal(),
    accept: 'application/json',
  });
  return {
    provider: 'dpd',
    canVoid: true,
    canTrack: true,
    needsManifest: false,

    /** `credential` is `username:password` for DPD's Basic login. */
    async authenticate(credential) {
      const res = await options.http.request('dpd', {
        url: new URL('user/?action=login', base),
        method: 'POST',
        headers: { authorization: `Basic ${Buffer.from(credential.reveal()).toString('base64')}` },
      });
      const t = LoginV1.parse(await readJson('dpd', res));
      return {
        token: new Secret(t.data.geoSession),
        expiresAt: new Date(now().getTime() + SESSION_MS),
      };
    },

    async listServices(token) {
      const res = await options.http.request('dpd', {
        url: new URL('shipping/network/', base),
        headers: session(token),
      });
      return NetworkV1.parse(await readJson('dpd', res)).data.map((n) => ({
        code: n.network.networkCode,
        name: n.network.networkDescription,
      }));
    },

    async createShipment(token, order, parcels, service) {
      const res = await options.http.request('dpd', {
        url: new URL('shipping/shipment', base),
        method: 'POST',
        headers: { ...session(token), 'content-type': 'application/json' },
        body: JSON.stringify({
          jobId: null,
          collectionOnDelivery: false,
          consignment: [
            {
              networkCode: service,
              numberOfParcels: parcels.length,
              totalWeight: parcels.reduce((sum, p) => sum + p.weightGrams, 0) / 1000,
              shippingRef1: order.reference,
              deliveryDetails: { address: order.address },
            },
          ],
        }),
      });
      if (res.status === 400) {
        const body = ShipmentErrorV1.parse(await res.json());
        throw new ProviderRejected('dpd', `dpd.${body.error[0]?.errorCode ?? 'invalid'}`);
      }
      const s = ShipmentV1.parse(await readJson('dpd', res));
      return {
        trackingNumbers: s.data.consignmentDetail.flatMap((c) => c.parcelNumbers),
        carrierShipmentRef: String(s.data.shipmentId),
        labels: [{ format: 'pdf', ref: String(s.data.shipmentId) }],
      };
    },

    async getLabel(token, ref) {
      const res = await options.http.request('dpd', {
        url: new URL(`shipping/shipment/${encodeURIComponent(ref)}/label/`, base),
        headers: { ...session(token), accept: 'application/pdf' },
      });
      if (!res.ok) await readJson('dpd', res);
      return new Uint8Array(await res.arrayBuffer());
    },

    async tracking(token, trackingNumber) {
      const res = await options.http.request('dpd', {
        url: new URL(`shipping/parcel/${encodeURIComponent(trackingNumber)}/events`, base),
        headers: session(token),
      });
      return EventsV1.parse(await readJson('dpd', res)).data.map((e) => ({
        code: e.code,
        at: new Date(e.date),
      }));
    },
  };
}
