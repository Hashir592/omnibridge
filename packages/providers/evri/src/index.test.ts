import { Secret } from '@omnibridge/crypto';
import { AuthFailed, ProviderHttp, ProviderRejected } from '@omnibridge/provider-kit';
import { describe, expect, it } from 'vitest';
import {
  createEvriAdapter,
  EVRI_SERVICES,
  evriKg,
  evriPounds,
  PACKAGE_NAME,
  reflowAddress,
  type EvriParcelInput,
} from './index.ts';

const P = 'PIIMARK-';

/** A fetch that records each request and answers from `answer`. */
function fakeFetch(answer: (url: URL, init: RequestInit) => Response) {
  const calls: { url: URL; init: RequestInit }[] = [];
  const fn = (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    calls.push({ url, init: init ?? {} });
    return Promise.resolve(answer(url, init ?? {}));
  };
  return { calls, fetch: fn };
}

const json = (status: number, body: unknown, type = 'application/json') =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': type } });

function adapter(answer: (url: URL, init: RequestInit) => Response) {
  const f = fakeFetch(answer);
  const http = new ProviderHttp({ mode: 'mock', mocksUrl: 'http://mocks.test', fetch: f.fetch });
  const evri = createEvriAdapter({
    http,
    clientId: new Secret('client-id-for-tests'),
    clientSecret: new Secret('client-secret-for-tests'),
  });
  return { evri, calls: f.calls };
}

const token = { token: new Secret('tok-0001'), expiresAt: new Date('2099-01-01T00:00:00Z') };

const parcel = (over: Partial<EvriParcelInput> = {}): EvriParcelInput => ({
  clientUid: 'W18400-1',
  deliveryReference: 'W18400',
  itemDescription: 'Mug',
  weightGrams: 1124,
  valuePence: 1499n,
  service: 'standard',
  recipient: {
    firstName: `${P}Jo`,
    lastName: `${P}Bloggs`,
    lines: [`${P}1 Capitol House`, 'Morley'],
    postcode: 'LS27 0AB',
    email: `${P}jo@example.test`,
    phone: '07700900123',
    instructions: 'Building on the left',
  },
  ...over,
});

describe('@omnibridge/provider-evri (EVRI-1 to EVRI-6)', () => {
  it('[NFR-1] the package is importable', () => {
    expect(PACKAGE_NAME).toBe('@omnibridge/provider-evri');
  });

  it('[EVRI-4] a line that fits is kept; a 33-character line re-flows into the next empty line', () => {
    expect(reflowAddress(['1 High Street', 'Leeds']).lines).toEqual(['1 High Street', 'Leeds']);
    const long = 'Flat 12 Riverside Court Mill Lane'; // 33 characters
    expect(long).toHaveLength(33);
    const r = reflowAddress([long, 'Leeds']);
    expect(r.shortened).toBe(false);
    expect(r.lines.every((l) => l.length <= 32)).toBe(true);
    expect(r.lines.join(' ')).toBe(`${long} Leeds`);
    expect(r.lines).toEqual(['Flat 12 Riverside Court Mill', 'Lane', 'Leeds']);
  });

  it('[EVRI-4] real UK address shapes: a full four lines that overflow are cut at a word and flagged', () => {
    const shapes = [
      [
        'The Old Rectory Cottage Annexe Building',
        'Upper Little Snoring Road',
        'Fakenham',
        'Norfolk',
      ],
      [
        'Unit 4B Westgate Industrial Estate Phase Two',
        'Brindley Way',
        'Wakefield',
        'West Yorkshire',
      ],
    ];
    for (const shape of shapes) {
      const r = reflowAddress(shape);
      expect(r.lines.length).toBeLessThanOrEqual(4);
      expect(r.lines.every((l) => l.length <= 32 && l === l.trim())).toBe(true);
      expect(r.shortened).toBe(true);
    }
    // One word longer than a line is cut and flagged.
    const word = reflowAddress(['Llanfairpwllgwyngyllgogerychwyrndrobwll', 'Anglesey']);
    expect(word.shortened).toBe(true);
    expect(word.lines[0]).toHaveLength(32);
    // Empty lines are dropped, spaces are collapsed.
    expect(reflowAddress(['  2  Mill   Lane ', '', 'York']).lines).toEqual(['2 Mill Lane', 'York']);
  });

  it('[EVRI-3][FIN-1] weight and value are written as decimal text from grams and pence, never floats', () => {
    expect(evriKg(1124)).toBe('1.124');
    expect(evriKg(1)).toBe('0.001');
    expect(evriKg(4000)).toBe('4.000');
    expect(evriPounds(1499n)).toBe('14.99');
    expect(evriPounds(10n)).toBe('0.10');
  });

  it('[EVRI-3][SHIP-4] POST /api/parcels sends one parcel with the documented media types and fields', async () => {
    const { evri, calls } = adapter(() =>
      json(
        200,
        {
          parcelSummaries: [
            { clientUID: 'W18400-1', barcode: 'H00YDA0000000614', status: 'CREATED' },
          ],
        },
        'application/vnd.myhermes.parcelsummaries-v1+json',
      ),
    );
    const result = await evri.createParcel(token, parcel());
    expect(result).toEqual({ state: 'created', barcode: 'H00YDA0000000614' });
    const call = calls[0];
    expect(call?.url.pathname).toBe('/evri/api/parcels');
    expect(call?.init.method).toBe('POST');
    const headers = call?.init.headers as Record<string, string>;
    expect(headers['content-type']).toBe('application/vnd.myhermes.parcels-v1+json');
    expect(headers.accept).toBe('application/vnd.myhermes.parcelsummaries-v1+json');
    expect(headers.authorization).toBe('Bearer tok-0001');
    const raw = call?.init.body as string;
    // Numbers as JSON numbers written from text: no float rounding can creep in.
    expect(raw).toContain('"weightKg":1.124');
    expect(raw).toContain('"estimatedParcelValuePounds":14.99');
    const body = JSON.parse(raw) as { parcels: Record<string, Record<string, unknown>>[] };
    expect(body.parcels).toHaveLength(1);
    const sent = body.parcels[0] ?? {};
    expect(sent.clientUID).toBe('W18400-1');
    expect(sent.parcelDetails).toMatchObject({
      itemDescription: 'Mug',
      deliveryReference: 'W18400',
    });
    expect(sent.deliveryDetails).toEqual({
      deliveryAddress: {
        line1: `${P}1 Capitol House`,
        line2: 'Morley',
        postcode: 'LS27 0AB',
      },
      firstName: `${P}Jo`,
      lastName: `${P}Bloggs`,
      email: `${P}jo@example.test`,
      telephone: '07700900123',
      deliveryInstructions: 'Building on the left',
    });
  });

  it('[EVRI-3] an email over 80 or a phone over 32 characters is left out, not cut (ADR-089)', async () => {
    const { evri, calls } = adapter(() =>
      json(200, { parcelSummaries: [{ clientUID: 'W18400-1', barcode: 'H1', status: 'CREATED' }] }),
    );
    await evri.createParcel(
      token,
      parcel({
        recipient: {
          ...parcel().recipient,
          email: `${'a'.repeat(75)}@example.test`,
          phone: '0'.repeat(33),
        },
      }),
    );
    const details = (
      JSON.parse(calls[0]?.init.body as string) as {
        parcels: { deliveryDetails: Record<string, unknown> }[];
      }
    ).parcels[0]?.deliveryDetails;
    expect(details).not.toHaveProperty('email');
    expect(details).not.toHaveProperty('telephone');
  });

  it('[AT-12][EVRI-3][SHIP-4] a 200 answer with an INVALID parcel is a failed parcel with its codes and paths', async () => {
    const { evri } = adapter(() =>
      json(200, {
        parcelSummaries: [
          {
            clientUID: 'W18400-1',
            status: 'INVALID',
            errors: [
              {
                error: 'invalid_property',
                error_description: 'Specified property value violates validation rules',
                error_paths: ['deliveryDetails.deliveryAddress.postcode'],
              },
            ],
          },
        ],
      }),
    );
    const result = await evri.createParcel(token, parcel());
    expect(result).toEqual({
      state: 'invalid',
      errors: [
        { code: 'evri.invalid_property', fields: ['deliveryDetails.deliveryAddress.postcode'] },
      ],
    });
  });

  it('[EVRI-3] a 400 is a duplicate clientUID: never a new parcel, the caller must check the carrier', async () => {
    const { evri } = adapter(() => json(400, { error: 'duplicate' }));
    await expect(evri.createParcel(token, parcel())).resolves.toEqual({ state: 'duplicate' });
  });

  it('[EVRI-2] a 401 is a lost authorisation (Evri has no refresh)', async () => {
    const { evri } = adapter(() => json(401, { error: 'unauthorised' }));
    const err = await evri.createParcel(token, parcel()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AuthFailed);
    expect((err as AuthFailed).revoked).toBe(true);
  });

  it('[EVRI-2] the code is exchanged at /oauth/token with the platform credentials in the query', async () => {
    const { evri, calls } = adapter(() => json(200, { access_token: 'tok-new-0001' }));
    const grant = await evri.exchangeCode('0a1b2c3d-4e5f-6a7b-8c9d-0e1f2a3b4c5d');
    expect(grant.token.reveal()).toBe('tok-new-0001');
    const url = calls[0]?.url;
    expect(url?.pathname).toBe('/evri/oauth/token');
    expect(calls[0]?.init.method).toBe('POST');
    expect(url?.searchParams.get('grant_type')).toBe('authorization_code');
    expect(url?.searchParams.get('code')).toBe('0a1b2c3d-4e5f-6a7b-8c9d-0e1f2a3b4c5d');
    expect(url?.searchParams.get('client_id')).toBe('client-id-for-tests');
    expect(url?.searchParams.get('client_secret')).toBe('client-secret-for-tests');
    expect(url?.searchParams.get('scope')).toBe('all');
  });

  it('[EVRI-5] a label is fetched by barcode with Accept: application/pdf,application/json and the format', async () => {
    const pdf = Buffer.from('%PDF-1.7\n%%EOF\n');
    const { evri, calls } = adapter(
      () => new Response(pdf, { status: 200, headers: { 'content-type': 'application/pdf' } }),
    );
    const bytes = await evri.fetchLabel(token, 'H00YDA0000000614', 'THERMAL');
    expect(Buffer.from(bytes).toString()).toBe(pdf.toString());
    expect(calls[0]?.url.pathname).toBe('/evri/api/labels/H00YDA0000000614');
    expect(calls[0]?.url.searchParams.get('format')).toBe('THERMAL');
    expect((calls[0]?.init.headers as Record<string, string>).accept).toBe(
      'application/pdf,application/json',
    );
  });

  it('[EVRI-5] a 403 on a label means it cannot be printed, not a lost authorisation', async () => {
    const { evri } = adapter(() => json(403, { error: 'forbidden' }));
    const err = await evri.fetchLabel(token, 'H1', 'THERMAL').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderRejected);
    expect((err as ProviderRejected).code).toBe('evri.label_not_printable');
  });

  it('[EVRI-6][SHIP-3] Evri has no void, no tracking and a fixed service list, ranked', () => {
    const { evri } = adapter(() => json(500, {}));
    expect(evri.canVoid).toBe(false);
    expect(evri.canTrack).toBe(false);
    expect(evri.needsManifest).toBe(false);
    expect(EVRI_SERVICES.map((s) => [s.code, s.rank])).toEqual([
      ['standard', 0],
      ['signature', 1],
      ['next_day', 2],
    ]);
  });
});
