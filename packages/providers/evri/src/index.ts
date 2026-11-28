/**
 * Evri as a ShippingProvider (SHIP-3, EVRI-1 to EVRI-6), from the Evri Business Accounts API
 * (myHermes) specification v1.4, which Hashir holds privately (it is copyright and never in git).
 *
 * - Auth (EVRI-2): the admin signs in on Evri and copies a single-use code (72 hours) from the
 *   address bar; it is exchanged at `POST /oauth/token` with the platform's client credentials in
 *   the query. The answer is an access token only: no expiry, no refresh. A 401 means re-authorise.
 * - Parcels (EVRI-3): `POST /api/parcels`, one parcel per request here, so a 400 (a duplicate
 *   `clientUID`) names exactly one parcel. A 200 can still hold an INVALID parcel.
 * - Labels (EVRI-5): `GET /api/labels/{barcode}?format=` with `Accept: application/pdf,
 *   application/json`; a reprint fetches again and never posts a parcel.
 * - No void, no tracking, no services endpoint (EVRI-6): the service list is fixed here.
 *
 * Weights and pounds go out as JSON numbers written from integer grams and pence as text, so no
 * float ever carries them (invariant 12). Buyer details pass through for the one call and are
 * never logged or kept (SHIP-4, ADR-089).
 */
import { CARRIER_SERVICES, formatPounds, pence } from '@omnibridge/core';
import { Secret } from '@omnibridge/crypto';
import {
  AuthFailed,
  defineParser,
  ProviderRejected,
  readJson,
  type AccessToken,
  type CarrierService,
  type ProviderHttp,
  type ShippingProvider,
} from '@omnibridge/provider-kit';
import { z } from 'zod';

export const PACKAGE_NAME = '@omnibridge/provider-evri';

/** EVRI-4: Evri's limits. */
export const EVRI_LINE_MAX = 32;
export const EVRI_ADDRESS_LINES = 4;
export const EVRI_EMAIL_MAX = 80;
export const EVRI_PHONE_MAX = 32;

/** EVRI-5: label layouts. */
export const EVRI_LABEL_FORMATS = [
  'THERMAL',
  'DEFAULT',
  'TWO_PER_PAGE',
  'LARGE_SINGLE',
  'LARGE_MULTI',
] as const;
export type EvriLabelFormat = (typeof EVRI_LABEL_FORMATS)[number];

/**
 * EVRI-6: Evri has no services endpoint. Standard; with a signature; next day ("only for certain
 * users"). `rank` orders them for Ship together's "highest service needed" (SHP-9).
 */
export const EVRI_SERVICES: readonly (CarrierService & { readonly rank: number })[] =
  CARRIER_SERVICES.evri;
export type EvriServiceCode = 'standard' | 'signature' | 'next_day';

export function isEvriService(code: string): code is EvriServiceCode {
  return EVRI_SERVICES.some((s) => s.code === code);
}

const PARCELS_TYPE = 'application/vnd.myhermes.parcels-v1+json';
const SUMMARIES_TYPE = 'application/vnd.myhermes.parcelsummaries-v1+json';
const LABEL_ACCEPT = 'application/pdf,application/json';

const clean = (s: string) => s.replace(/\s+/g, ' ').trim();

/** Words into lines of at most `max`; a word longer than a line is cut. */
function wrap(text: string, max: number): { pieces: string[]; cut: boolean } {
  const pieces: string[] = [];
  let cur = '';
  let cut = false;
  for (const raw of text.split(' ')) {
    let word = raw;
    if (word.length > max) {
      word = word.slice(0, max);
      cut = true;
    }
    if (cur === '') cur = word;
    else if (cur.length + 1 + word.length <= max) cur = `${cur} ${word}`;
    else {
      pieces.push(cur);
      cur = word;
    }
  }
  if (cur !== '') pieces.push(cur);
  return { pieces, cut };
}

/**
 * EVRI-4: fits the address lines into Evri's four lines of 32 characters. A line that fits stays;
 * a longer one is split into words and the overflow re-flows into the next empty line. When there
 * is no empty line left, the overflow is cut at a word boundary and `shortened` is set: a user
 * must confirm before a label is bought.
 */
export function reflowAddress(input: readonly string[]): { lines: string[]; shortened: boolean } {
  let lines = input.map(clean).filter((l) => l !== '');
  let shortened = false;
  if (lines.length > EVRI_ADDRESS_LINES) {
    // More lines than Evri takes: the extra ones join the last line, then fit like any other.
    const head = lines.slice(0, EVRI_ADDRESS_LINES - 1);
    lines = [...head, lines.slice(EVRI_ADDRESS_LINES - 1).join(', ')];
  }
  let spare = EVRI_ADDRESS_LINES - lines.length;
  const out: string[] = [];
  for (const line of lines) {
    const { pieces, cut } = wrap(line, EVRI_LINE_MAX);
    if (cut) shortened = true;
    const room = 1 + spare;
    out.push(...pieces.slice(0, room));
    if (pieces.length > room) shortened = true;
    spare -= Math.min(pieces.length, room) - 1;
  }
  return { lines: out, shortened };
}

/** EVRI-4: one field cut at a word boundary to `max`; `shortened` when anything was dropped. */
export function fitField(text: string, max: number): { value: string; shortened: boolean } {
  const value = clean(text);
  if (value.length <= max) return { value, shortened: false };
  const { pieces } = wrap(value, max);
  return { value: pieces[0] ?? value.slice(0, max), shortened: true };
}

/** Grams as kilograms with three decimals, as text ("1.124"). */
export function evriKg(grams: number): string {
  if (!Number.isInteger(grams) || grams < 0) throw new RangeError('grams must be a whole number');
  return `${String(Math.trunc(grams / 1000))}.${String(grams % 1000).padStart(3, '0')}`;
}

/** Pence as pounds with two decimals, as text ("14.99"). */
export function evriPounds(value: bigint): string {
  if (value < 0n) throw new RangeError('a value must not be negative');
  return formatPounds(pence(value));
}

/** The recipient as the label needs it, read from the vault for this one call (SHIP-4). */
export interface EvriRecipient {
  readonly firstName: string;
  readonly lastName: string;
  /** Already fitted by `reflowAddress`: 1 to 4 lines of at most 32 characters. */
  readonly lines: readonly string[];
  readonly postcode: string;
  /** For Evri's delivery messages only (ADR-089); left out when longer than 80. */
  readonly email?: string;
  /** For Evri's delivery messages only (ADR-089); left out when longer than 32. */
  readonly phone?: string;
  readonly instructions?: string;
}

export interface EvriParcelInput {
  /** `{orderRef}-{parcelNo}`, unique per account (EVRI-3). */
  readonly clientUid: string;
  /** The channel order ID; printed on the label. */
  readonly deliveryReference: string;
  readonly itemDescription: string;
  readonly weightGrams: number;
  readonly valuePence: bigint;
  readonly service: EvriServiceCode;
  readonly recipient: EvriRecipient;
}

export interface EvriParcelError {
  /** `evri.<error>`, for example `evri.invalid_property`. */
  readonly code: string;
  /** Request paths Evri named, for example `deliveryDetails.deliveryAddress.postcode`. */
  readonly fields: readonly string[];
}

export type EvriParcelResult =
  | { readonly state: 'created'; readonly barcode: string }
  | { readonly state: 'invalid'; readonly errors: readonly EvriParcelError[] }
  /** A 400: the clientUID is already used; the parcel may exist at Evri. Never re-created. */
  | { readonly state: 'duplicate' };

const TokenV1 = defineParser('evri', 'token', 1, z.object({ access_token: z.string().min(1) }));

const SummariesV1 = defineParser(
  'evri',
  'parcel_summaries',
  1,
  z.object({
    parcelSummaries: z
      .array(
        z.object({
          clientUID: z.string(),
          barcode: z.string().min(1).optional(),
          status: z.enum(['CREATED', 'INVALID']),
          errors: z
            .array(
              z.object({
                error: z.string(),
                error_paths: z.array(z.string()).optional(),
              }),
            )
            .optional(),
        }),
      )
      .min(1),
  }),
);

/** Marks a JSON value to be written as a bare number from its decimal text. */
const NUMBER_TAG = '\u0000num:';
const asNumber = (text: string) => `${NUMBER_TAG}${text}`;
function stringify(body: unknown): string {
  return JSON.stringify(body).replace(/"\\u0000num:(\d+(?:\.\d+)?)"/g, '$1');
}

export interface EvriAdapter extends ShippingProvider {
  readonly provider: 'evri';
  /** EVRI-2: the authorisation code for an access token (no expiry, no refresh). */
  exchangeCode(code: string): Promise<AccessToken>;
  /** EVRI-3: one parcel. Never retried here; the caller keeps the parcel's state. */
  createParcel(token: AccessToken, parcel: EvriParcelInput): Promise<EvriParcelResult>;
  /** EVRI-5: the label PDF by barcode. */
  fetchLabel(token: AccessToken, barcode: string, format: EvriLabelFormat): Promise<Uint8Array>;
}

/** Evri gives no token lifetime; a token is used until a 401 (EVRI-2). */
const NO_EXPIRY = new Date('9999-12-31T00:00:00Z');

export function createEvriAdapter(options: {
  http: ProviderHttp;
  /** The platform's client credentials: needed only to exchange a code (web, EVRI-2). */
  clientId?: Secret;
  clientSecret?: Secret;
  /** EVRI-1: the account's base URL setting; defaults to the specification's host. */
  baseUrl?: URL;
}): EvriAdapter {
  const base = options.baseUrl ?? options.http.base('evri', 'api');
  const auth = (t: AccessToken) => ({ authorization: `Bearer ${t.token.reveal()}` });
  const unauthorised = () => new AuthFailed('evri', true);

  const createParcel = async (
    token: AccessToken,
    p: EvriParcelInput,
  ): Promise<EvriParcelResult> => {
    const r = p.recipient;
    const address: Record<string, string> = { line1: r.lines[0] ?? '' };
    r.lines.slice(1, EVRI_ADDRESS_LINES).forEach((line, i) => {
      address[`line${String(i + 2)}`] = line;
    });
    address.postcode = r.postcode;
    const details: Record<string, unknown> = {
      deliveryAddress: address,
      firstName: r.firstName,
      lastName: r.lastName,
    };
    // ADR-089: email and phone for Evri's delivery messages only; too long is left out, not cut.
    if (r.email !== undefined && r.email.length <= EVRI_EMAIL_MAX) details.email = r.email;
    if (r.phone !== undefined && r.phone.length <= EVRI_PHONE_MAX) details.telephone = r.phone;
    if (p.service === 'signature') details.signatureRequired = true;
    if (p.service === 'next_day') details.nextDay = true;
    if (r.instructions !== undefined && r.instructions !== '') {
      details.deliveryInstructions = r.instructions;
    }
    const body = stringify({
      parcels: [
        {
          clientUID: p.clientUid,
          parcelDetails: {
            weightKg: asNumber(evriKg(p.weightGrams)),
            itemDescription: p.itemDescription,
            deliveryReference: p.deliveryReference,
            estimatedParcelValuePounds: asNumber(evriPounds(p.valuePence)),
          },
          deliveryDetails: details,
        },
      ],
    });
    const res = await options.http.request('evri', {
      url: new URL('api/parcels', base),
      method: 'POST',
      headers: { ...auth(token), 'content-type': PARCELS_TYPE, accept: SUMMARIES_TYPE },
      body,
    });
    if (res.status === 401) {
      await res.body?.cancel();
      throw unauthorised();
    }
    if (res.status === 400) {
      // A missing, empty or duplicated clientUID: ours is always set, so it is a duplicate.
      await res.body?.cancel();
      return { state: 'duplicate' };
    }
    const summary = SummariesV1.parse(await readJson('evri', res)).parcelSummaries.find(
      (s) => s.clientUID === p.clientUid,
    );
    if (summary === undefined) throw new ProviderRejected('evri', 'evri.summary_missing');
    if (summary.status === 'CREATED' && summary.barcode !== undefined) {
      return { state: 'created', barcode: summary.barcode };
    }
    // Only codes and paths: a description is Evri's text and is not kept.
    return {
      state: 'invalid',
      errors: (summary.errors ?? [{ error: 'invalid' }]).map((e) => ({
        code: `evri.${e.error.toLowerCase().replace(/[^a-z0-9_]/g, '_')}`,
        fields: e.error_paths ?? [],
      })),
    };
  };

  const fetchLabel = async (
    token: AccessToken,
    barcode: string,
    format: EvriLabelFormat,
  ): Promise<Uint8Array> => {
    const url = new URL(`api/labels/${encodeURIComponent(barcode)}`, base);
    url.searchParams.set('format', format);
    const res = await options.http.request('evri', {
      url,
      headers: { ...auth(token), accept: LABEL_ACCEPT },
    });
    const rejected: Partial<Record<number, string>> = {
      400: 'evri.bad_label_format',
      403: 'evri.label_not_printable',
      404: 'evri.barcode_unknown',
      406: 'evri.not_acceptable',
    };
    if (res.status === 401) {
      await res.body?.cancel();
      throw unauthorised();
    }
    const code = rejected[res.status];
    if (code !== undefined) {
      await res.body?.cancel();
      throw new ProviderRejected('evri', code);
    }
    if (!res.ok) await readJson('evri', res);
    return new Uint8Array(await res.arrayBuffer());
  };

  return {
    provider: 'evri',
    canVoid: false,
    canTrack: false,
    needsManifest: false,

    async exchangeCode(code) {
      if (options.clientId === undefined || options.clientSecret === undefined) {
        throw new ProviderRejected('evri', 'evri.not_configured');
      }
      const url = new URL('oauth/token', base);
      url.searchParams.set('client_id', options.clientId.reveal());
      url.searchParams.set('client_secret', options.clientSecret.reveal());
      url.searchParams.set('code', code);
      url.searchParams.set('grant_type', 'authorization_code');
      url.searchParams.set('scope', 'all');
      const res = await options.http.request('evri', { url, method: 'POST' });
      // Any refusal of the code (used, expired, mistyped, an account Evri will not link) is the
      // admin's to fix with a new code; only a 5xx or a 429 is Evri's own trouble.
      if (res.status >= 400 && res.status < 500 && res.status !== 429) {
        await res.body?.cancel();
        throw new ProviderRejected('evri', 'evri.code_refused');
      }
      const t = TokenV1.parse(await readJson('evri', res));
      return { token: new Secret(t.access_token), expiresAt: NO_EXPIRY };
    },

    /** The stored access token is the credential itself: there is nothing to refresh. */
    authenticate(credential) {
      return Promise.resolve({ token: credential, expiresAt: NO_EXPIRY });
    },

    listServices() {
      return Promise.resolve(EVRI_SERVICES);
    },

    createParcel,
    fetchLabel,

    /** SHIP-3's generic call; the label job uses `createParcel` per parcel instead. */
    async createShipment(token, order, parcels, service) {
      const code: EvriServiceCode = isEvriService(service) ? service : 'standard';
      const fitted = reflowAddress([
        order.address.line1,
        order.address.line2 ?? '',
        order.address.city,
      ]);
      const [first = order.address.name, ...rest] = clean(order.address.name).split(' ');
      const barcodes: string[] = [];
      for (const [i, p] of parcels.entries()) {
        const result = await createParcel(token, {
          clientUid: `${order.reference}-${String(i + 1)}`,
          deliveryReference: order.reference,
          itemDescription: 'Goods',
          weightGrams: p.weightGrams,
          valuePence: 0n,
          service: code,
          recipient: {
            firstName: first,
            lastName: rest.join(' ') || first,
            lines: fitted.lines,
            postcode: order.address.postcode,
          },
        });
        if (result.state === 'created') barcodes.push(result.barcode);
        else if (result.state === 'duplicate') {
          throw new ProviderRejected('evri', 'evri.duplicate_client_uid');
        } else throw new ProviderRejected('evri', result.errors[0]?.code ?? 'evri.invalid');
      }
      return {
        trackingNumbers: barcodes,
        carrierShipmentRef: barcodes[0] ?? '',
        labels: barcodes.map((b) => ({ format: 'pdf' as const, ref: b })),
      };
    },

    getLabel(token, ref) {
      return fetchLabel(token, ref, 'THERMAL');
    },

    tracking() {
      return Promise.reject(new ProviderRejected('evri', 'evri.no_tracking'));
    },
  };
}
