import { randomUUID } from 'node:crypto';
import type { FastifyReply } from 'fastify';
import {
  accessToken,
  accountOf,
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
 * - Evri: checked against the official specification in T-1201 (evriRoutes below).
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

/**
 * A one-page PDF a real reader opens (4 x 6 inches, the barcode as text), so label files can be
 * stored and merged end to end. Offsets in the cross-reference table are worked out, not typed.
 */
export function mockLabelPdf(barcode: string): Buffer {
  const text = barcode.replace(/[()\\]/g, '');
  const stream = `BT /F1 18 Tf 36 216 Td (${text}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 288 432] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${String(stream.length)} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${String(i + 1)} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${String(objects.length + 1)}\n0000000000 65535 f \n`;
  for (const at of offsets) out += `${String(at).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${String(objects.length + 1)} /Root 1 0 R >>\nstartxref\n${String(xref)}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

const EVRI_PARCELS_TYPE = 'application/vnd.myhermes.parcels-v1+json';
const EVRI_SUMMARIES_TYPE = 'application/vnd.myhermes.parcelsummaries-v1+json';
const EVRI_FORMATS = ['DEFAULT', 'THERMAL', 'TWO_PER_PAGE', 'LARGE_SINGLE', 'LARGE_MULTI'];

interface EvriParcelBody {
  clientUID?: unknown;
  parcelDetails?: Record<string, unknown>;
  deliveryDetails?: Record<string, unknown> & { deliveryAddress?: Record<string, unknown> };
}

interface EvriError {
  error: string;
  error_description: string;
  error_paths: string[];
}

/** EVRI-3: the checks the specification lists, as error codes and paths. */
function evriErrors(p: EvriParcelBody): EvriError[] {
  const errors: EvriError[] = [];
  const missing = (path: string) =>
    errors.push({
      error: 'missing_property',
      error_description: 'Property value is missing or null',
      error_paths: [path],
    });
  const invalid = (path: string) =>
    errors.push({
      error: 'invalid_property',
      error_description: 'Specified property value violates validation rules',
      error_paths: [path],
    });
  const d = p.parcelDetails ?? {};
  for (const k of [
    'weightKg',
    'itemDescription',
    'deliveryReference',
    'estimatedParcelValuePounds',
  ]) {
    if (d[k] === undefined || d[k] === null || d[k] === '') missing(`parcelDetails.${k}`);
  }
  const del = p.deliveryDetails ?? {};
  const addr = del.deliveryAddress ?? {};
  for (const k of ['line1', 'postcode']) {
    if (typeof addr[k] !== 'string' || addr[k] === '') {
      missing(`deliveryDetails.deliveryAddress.${k}`);
    }
  }
  for (const k of ['line1', 'line2', 'line3', 'line4']) {
    const v = addr[k];
    if (typeof v === 'string' && v.length > 32) invalid(`deliveryDetails.deliveryAddress.${k}`);
  }
  for (const k of ['firstName', 'lastName']) {
    if (typeof del[k] !== 'string' || del[k] === '') missing(`deliveryDetails.${k}`);
  }
  const limits: Record<string, number> = {
    firstName: 32,
    lastName: 32,
    email: 80,
    telephone: 32,
    deliveryInstructions: 32,
    deliverySafePlace: 32,
  };
  for (const [k, max] of Object.entries(limits)) {
    const v = del[k];
    if (typeof v === 'string' && v.length > max) invalid(`deliveryDetails.${k}`);
  }
  return errors;
}

/**
 * Evri Business Accounts (myHermes) API, as its specification v1.4 describes it (EVRI-1 to
 * EVRI-6), checked against the official document in T-1201. The mock keeps only client UIDs and
 * barcodes per account, never an address. `GET /_mock/evri/parcels` lets tests count the parcel
 * requests (a reprint must make none).
 */
export function evriRoutes(app: MockApp, scenarios: ScenarioStore): void {
  const byAccount = new Map<string, { posts: number; parcels: Map<string, string> }>();
  const state = (account: string) => {
    let s = byAccount.get(account);
    if (s === undefined) {
      s = { posts: 0, parcels: new Map() };
      byAccount.set(account, s);
    }
    return s;
  };
  let next = 1;
  const bearer = (h: string | undefined) => h?.replace(/^Bearer /, '');
  // Evri's versioned media types are JSON (application/vnd.myhermes.<type>-v<n>+json).
  app.addContentTypeParser(
    /^application\/vnd\.myhermes\.[a-z]+-v\d+\+json$/,
    { parseAs: 'string' },
    (_request, body, done) => {
      try {
        done(null, JSON.parse(String(body)) as unknown);
      } catch {
        done(Object.assign(new Error('invalid JSON'), { statusCode: 400 }), undefined);
      }
    },
  );

  // EVRI-2 step 1: the sign-in page sends the browser back with a code in the address bar.
  app.get<{ Querystring: { redirect_uri?: string; client_id?: string } }>(
    '/evri/customer/authorize',
    (request, reply) => {
      const target = request.query.redirect_uri;
      if (target === undefined || request.query.client_id === undefined) {
        return reply.code(400).send({ error: 'invalid_request' });
      }
      const url = new URL(target);
      url.searchParams.set('code', randomUUID());
      return reply.redirect(url.href, 302);
    },
  );

  // EVRI-2 step 4: the code, client ID and secret come in the query; the answer is a token only.
  app.post<{ Querystring: Record<string, string | undefined> }>(
    '/evri/oauth/token',
    (request, reply) => {
      const q = request.query;
      if (
        q.grant_type !== 'authorization_code' ||
        q.code === undefined ||
        q.client_id === undefined ||
        q.client_secret === undefined
      ) {
        return reply.code(400).send({ error: 'invalid_request' });
      }
      if (scenarios.on('evri', q.code, 'revoked')) {
        return reply.code(401).send({ error: 'invalid_grant' });
      }
      return { access_token: accessToken('evri', q.code) };
    },
  );

  // EVRI-3: POST /api/parcels.
  app.post<{ Body: { parcels?: EvriParcelBody[] } }>('/evri/api/parcels', (request, reply) => {
    const account = carrierAccount(scenarios, 'evri', bearer(request.headers.authorization), reply);
    if (account === undefined) return reply;
    if (request.headers['content-type'] !== EVRI_PARCELS_TYPE) return reply.code(415).send({});
    const parcels = Array.isArray(request.body.parcels) ? request.body.parcels : [];
    const s = state(account);
    s.posts += 1;
    const uids = parcels.map((p) => (typeof p.clientUID === 'string' ? p.clientUID : ''));
    // A missing, empty or duplicated clientUID refuses the whole request.
    if (
      parcels.length === 0 ||
      uids.some((u) => u === '' || u.length > 255 || s.parcels.has(u)) ||
      new Set(uids).size !== uids.length
    ) {
      return reply.code(400).send({ error: 'invalid_client_uid' });
    }
    const summaries = parcels.map((p, i) => {
      const clientUID = uids[i] ?? '';
      const errors = evriErrors(p);
      if (errors.length === 0 && scenarios.take('evri', account, 'invalid_parcel')) {
        errors.push({
          error: 'delivery_unavailable',
          error_description: 'The parcel is considered undeliverable',
          error_paths: ['deliveryDetails.deliveryAddress.postcode'],
        });
      }
      if (errors.length > 0) return { clientUID, status: 'INVALID', errors };
      const barcode = `H00MOCK${String(next++).padStart(9, '0')}`;
      s.parcels.set(clientUID, barcode);
      return { clientUID, barcode, status: 'CREATED' };
    });
    if (scenarios.take('evri', account, 'lost_answer')) return reply.code(502).send({});
    return reply.type(EVRI_SUMMARIES_TYPE).send({ parcelSummaries: summaries });
  });

  // EVRI-5: GET /api/labels/{barcode}; errors need application/json in Accept, else 406.
  app.get<{ Params: { barcode: string }; Querystring: { format?: string } }>(
    '/evri/api/labels/:barcode',
    (request, reply) => {
      const account = carrierAccount(
        scenarios,
        'evri',
        bearer(request.headers.authorization),
        reply,
      );
      if (account === undefined) return reply;
      const accept = request.headers.accept ?? '';
      const fail = (status: number) =>
        accept.includes('application/json')
          ? reply.code(status).send({ error: String(status) })
          : reply.code(406).send();
      const format = request.query.format ?? 'DEFAULT';
      if (!EVRI_FORMATS.includes(format)) return fail(400);
      const known = [...state(account).parcels.values()].includes(request.params.barcode);
      if (!known) return fail(404);
      if (scenarios.take('evri', account, 'not_printable')) return fail(403);
      if (!accept.includes('application/pdf')) return reply.code(406).send();
      return reply.type('application/pdf').send(mockLabelPdf(request.params.barcode));
    },
  );

  // Tests only: how many parcel requests an account made and the parcels it holds (IDs only).
  app.get<{ Querystring: { account?: string } }>('/_mock/evri/parcels', (request) => {
    const s = state(request.query.account ?? '');
    return {
      posts: s.posts,
      parcels: [...s.parcels].map(([clientUID, barcode]) => ({ clientUID, barcode })),
    };
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

/** Decimal pounds as a mock order holds them, in integer pence (the website protocol, WEB-3). */
const pence = (pounds: string) => Math.round(Number(pounds) * 100);

/**
 * The website side of the signed contract (M11, `@omnibridge/contract` routes/website.ts): what a
 * seller's website answers OmniBridge. A call must carry the Bearer key, a timestamp within 5
 * minutes, a hex signature and an Idempotency-Key. The mock holds no signing secret, so it checks
 * the signature's form only; the web app's own tests check real signatures both ways.
 */
export function websiteRoutes(app: MockApp, scenarios: ScenarioStore): void {
  const signed = (headers: Record<string, unknown>, reply: FastifyReply): string | undefined => {
    const auth = headers.authorization;
    const key = typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7) : '';
    const at = Number(headers['x-ob-timestamp']);
    const signature = headers['x-ob-signature'];
    const fresh = Number.isFinite(at) && Math.abs(Date.now() / 1000 - at) <= 300;
    const signedOk = typeof signature === 'string' && /^[0-9a-f]{64}$/.test(signature);
    const keyed = typeof headers['idempotency-key'] === 'string';
    if (key === '' || !fresh || !signedOk || !keyed || scenarios.on('website', key, 'revoked')) {
      void reply.code(401).send({ error: 'unauthorised' });
      return undefined;
    }
    if (scenarios.take('website', key, 'rate_limit_storm')) {
      void reply.code(429).header('retry-after', '1').send({ error: 'too_many_requests' });
      return undefined;
    }
    return key;
  };
  // WEB-4: the nightly read of orders changed since a time (the shape of the push, WEB-3).
  app.get<{ Querystring: { updatedSince?: string } }>(
    '/website/omnibridge/orders',
    (request, reply) => {
      if (signed(request.headers, reply) === undefined) return reply;
      const since = request.query.updatedSince;
      return {
        orders: MOCK_ORDERS.filter((o) => since === undefined || o.updatedAt >= since).map((o) => ({
          externalOrderId: o.id,
          status: 'paid',
          currency: 'GBP',
          placedAt: o.placedAt,
          updatedAt: o.updatedAt,
          paidAt: o.placedAt,
          lines: [
            {
              externalLineId: `${o.id}-1`,
              externalSku: o.sku,
              title: 'Mock item',
              quantity: o.quantity,
              unitPriceGross: Math.round(pence(o.lineTotal) / o.quantity),
            },
          ],
          shippingGross: pence(o.shipping),
          discountGross: 0,
          buyer: {
            customerId: `cust-${o.id}`,
            name: 'PIIMARK-Web Buyer',
            email: 'PIIMARK-web@example.test',
            phone: '07700900456',
          },
          shippingAddress: {
            name: 'PIIMARK-Web Buyer',
            line1: 'PIIMARK-2 Mock Road',
            city: 'Testville',
            postcode: 'TE2 2ND',
            country: 'GB',
          },
        })),
        nextCursor: null,
      };
    },
  );
  // WEB-4: stock levels, at most 100 per call.
  app.put<{ Body: unknown }>('/website/omnibridge/stock', (request, reply) => {
    if (signed(request.headers, reply) === undefined) return reply;
    const body = request.body;
    if (!Array.isArray(body) || body.length === 0 || body.length > 100) {
      return reply.code(422).send({ error: 'invalid' });
    }
    return {};
  });
  // WEB-4: a shipment of one order.
  app.post<{ Params: { id: string } }>(
    '/website/omnibridge/orders/:id/shipment',
    (request, reply) => {
      if (signed(request.headers, reply) === undefined) return reply;
      return {};
    },
  );
}
