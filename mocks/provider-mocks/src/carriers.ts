import type { FastifyReply } from 'fastify';
import {
  accessToken,
  accountOf,
  form,
  MOCK_LISTINGS,
  MOCK_ORDERS,
  type MockApp,
  type ScenarioStore,
} from './scenarios.ts';

/*
 * Carriers and the website. Shapes are provisional until each module checks them against the
 * provider's own pack (Evri and DPD onboarding documents, M12 and M13; the website connector
 * protocol, M11). They are enough for M07's adapter path: auth, one read, one write, and the
 * INVALID parcel scenario.
 *
 * - Evri: client-credentials token; POST parcels (label request) answers { parcelId, barcode,
 *   labelRef } or 400 { errors: [{ code: 'INVALID', field }] }; GET parcels/{barcode}/events.
 * - DPD (DPD UK web services): POST user/?action=login with Basic auth answers
 *   { data: { geoSession } }; GET shipping/network/ lists services; POST shipping/shipment answers
 *   { data: { shipmentId, consignmentDetail[] }, error: null }; GET shipping/shipment/{id}/label/.
 * - Website: an API key in x-api-key; GET api/orders?updated_since; POST api/stock.
 */
const PDF = Buffer.from('%PDF-1.7\n% mock label\n%%EOF\n');

function carrierAccount(
  scenarios: ScenarioStore,
  provider: 'evri' | 'dpd',
  token: string | undefined,
  reply: FastifyReply,
): string | undefined {
  const account = accountOf(provider, token);
  if (account === undefined || scenarios.on(provider, account, 'revoked')) {
    void reply.code(401).send({ error: 'unauthorised' });
    return undefined;
  }
  if (scenarios.take(provider, account, 'rate_limit_storm')) {
    void reply.code(429).header('retry-after', '1').send({ error: 'too_many_requests' });
    return undefined;
  }
  return account;
}

export function evriRoutes(app: MockApp, scenarios: ScenarioStore): void {
  app.post('/evri/oauth/token', (request, reply) => {
    const key = form(request.body).get('client_secret');
    if (key === null || scenarios.on('evri', key, 'revoked')) {
      return reply.code(401).send({ error: 'invalid_client' });
    }
    return { access_token: accessToken('evri', key), expires_in: 3600, token_type: 'Bearer' };
  });
  const bearer = (h: string | undefined) => h?.replace(/^Bearer /, '');
  app.get('/evri/services', (request, reply) => {
    if (
      carrierAccount(scenarios, 'evri', bearer(request.headers.authorization), reply) === undefined
    ) {
      return reply;
    }
    return {
      services: [
        { code: 'EVRI-48', name: 'Evri 48' },
        { code: 'EVRI-NEXTDAY', name: 'Evri Next Day' },
      ],
    };
  });
  app.post('/evri/parcels', (request, reply) => {
    const account = carrierAccount(scenarios, 'evri', bearer(request.headers.authorization), reply);
    if (account === undefined) return reply;
    if (scenarios.take('evri', account, 'invalid_parcel')) {
      return reply.code(400).send({ errors: [{ code: 'INVALID', field: 'postcode' }] });
    }
    return reply
      .code(201)
      .send({ parcelId: 'EVRI-P-1', barcode: 'H00MOCK0000001', labelRef: 'EVRI-L-1' });
  });
  app.get<{ Params: { ref: string } }>('/evri/labels/:ref', (request, reply) => {
    if (
      carrierAccount(scenarios, 'evri', bearer(request.headers.authorization), reply) === undefined
    ) {
      return reply;
    }
    return reply.type('application/pdf').send(PDF);
  });
  app.get<{ Params: { barcode: string } }>('/evri/parcels/:barcode/events', (request, reply) => {
    if (
      carrierAccount(scenarios, 'evri', bearer(request.headers.authorization), reply) === undefined
    ) {
      return reply;
    }
    return { events: [{ code: 'COLLECTED', dateTime: '2026-11-20T15:00:00.000Z' }] };
  });
}

export function dpdRoutes(app: MockApp, scenarios: ScenarioStore): void {
  app.post('/dpd/user/', (request, reply) => {
    const auth = request.headers.authorization ?? '';
    const user = auth.startsWith('Basic ') ? Buffer.from(auth.slice(6), 'base64').toString() : '';
    if (user === '' || scenarios.on('dpd', user, 'revoked')) {
      return reply
        .code(401)
        .send({ error: [{ errorCode: '1100', errorType: 'Authentication' }], data: null });
    }
    return { error: null, data: { geoSession: accessToken('dpd', user) } };
  });
  const session = (h: unknown) => (typeof h === 'string' ? h : undefined);
  app.get('/dpd/shipping/network/', (request, reply) => {
    if (
      carrierAccount(scenarios, 'dpd', session(request.headers.geosession), reply) === undefined
    ) {
      return reply;
    }
    return {
      error: null,
      data: [
        { network: { networkCode: '1^12', networkDescription: 'DPD Next Day' } },
        { network: { networkCode: '1^32', networkDescription: 'DPD Express' } },
      ],
    };
  });
  app.post('/dpd/shipping/shipment', (request, reply) => {
    const account = carrierAccount(scenarios, 'dpd', session(request.headers.geosession), reply);
    if (account === undefined) return reply;
    if (scenarios.take('dpd', account, 'invalid_parcel')) {
      return reply.code(400).send({
        error: [{ errorCode: '1008', errorType: 'Validation', obj: 'postcode' }],
        data: null,
      });
    }
    return {
      error: null,
      data: {
        shipmentId: 99_000_001,
        consolidated: false,
        consignmentDetail: [{ consignmentNumber: '6504000001', parcelNumbers: ['15500000000001'] }],
      },
    };
  });
  app.get<{ Params: { id: string } }>('/dpd/shipping/shipment/:id/label/', (request, reply) => {
    if (
      carrierAccount(scenarios, 'dpd', session(request.headers.geosession), reply) === undefined
    ) {
      return reply;
    }
    return reply.type('application/pdf').send(PDF);
  });
  app.get<{ Params: { parcel: string } }>(
    '/dpd/shipping/parcel/:parcel/events',
    (request, reply) => {
      if (
        carrierAccount(scenarios, 'dpd', session(request.headers.geosession), reply) === undefined
      ) {
        return reply;
      }
      return { error: null, data: [{ code: '001', date: '2026-11-20T15:00:00.000Z' }] };
    },
  );
}

export function websiteRoutes(app: MockApp, scenarios: ScenarioStore): void {
  const key = (h: unknown, reply: FastifyReply): string | undefined => {
    const value = typeof h === 'string' ? h : undefined;
    if (value === undefined || scenarios.on('website', value, 'revoked')) {
      void reply.code(401).send({ error: 'unauthorised' });
      return undefined;
    }
    if (scenarios.take('website', value, 'rate_limit_storm')) {
      void reply.code(429).header('retry-after', '1').send({ error: 'too_many_requests' });
      return undefined;
    }
    return value;
  };
  app.get<{ Querystring: { updated_since?: string } }>('/website/api/orders', (request, reply) => {
    if (key(request.headers['x-api-key'], reply) === undefined) return reply;
    const since = request.query.updated_since;
    return {
      orders: MOCK_ORDERS.filter((o) => since === undefined || o.updatedAt >= since).map((o) => ({
        id: o.id,
        updated_at: o.updatedAt,
        status: 'processing',
        customer: { email: 'PIIMARK-web@example.test' },
        lines: [{ id: `${o.id}-1`, sku: o.sku, quantity: o.quantity }],
      })),
      next_cursor: null,
    };
  });
  // CAT-5: the products the website sells (provisional until M11).
  app.get('/website/api/products', (request, reply) => {
    if (key(request.headers['x-api-key'], reply) === undefined) return reply;
    return {
      products: MOCK_LISTINGS.filter((l) => !l.fba).map((l) => ({
        id: l.id,
        sku: l.sku,
        title: l.title,
        quantity: l.quantity,
      })),
      next_cursor: null,
    };
  });
  app.post<{ Body: { items?: { sku?: string }[] } }>('/website/api/stock', (request, reply) => {
    if (key(request.headers['x-api-key'], reply) === undefined) return reply;
    return { updated: (request.body.items ?? []).map((i) => i.sku ?? '') };
  });
}
