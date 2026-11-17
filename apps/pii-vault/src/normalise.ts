/**
 * Normalising and masking (DP-7, ORD-5, ORD-9). Blind indexes are exact matches on the normalised
 * form, never fuzzy (ORD-9); masks are computed on request and never stored (invariant 8).
 */

const collapse = (s: string) => s.replace(/\s+/g, ' ').trim();

/** Lower case, no accents, letters, digits and single spaces only. */
export function normaliseName(value: string): string {
  return collapse(
    value
      .normalize('NFKD')
      .replace(/\p{M}/gu, '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' '),
  );
}

/** Upper case, no spaces: "g2 1aa " and "G21AA" are the same postcode. */
export function normalisePostcode(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function normaliseEmail(value: string): string {
  return value.trim().toLowerCase();
}

/** Digits only, with a UK +44 prefix read as the leading 0. */
export function normalisePhone(value: string): string {
  const digits = value.replace(/\D/g, '');
  // "+44 (0)7700 …" and "0044 7700 …" are the same number as "07700 …".
  const national = digits.startsWith('0044')
    ? digits.slice(4)
    : digits.startsWith('44') && digits.length >= 11
      ? digits.slice(2)
      : undefined;
  return national === undefined ? digits : `0${national.replace(/^0/, '')}`;
}

export function normaliseBuyer(value: string): string {
  return value.trim().toLowerCase();
}

/** The blind-indexed fields of a record, normalised; empty results are left out. */
export function indexValues(fields: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  const add = (key: string, value: string | undefined, fn: (v: string) => string) => {
    if (value === undefined) return;
    const n = fn(value);
    if (n !== '') out[key] = n;
  };
  add('name', fields.name, normaliseName);
  add('email', fields.email, normaliseEmail);
  add('phone', fields.phone, normalisePhone);
  add('postcode', fields.postcode, normalisePostcode);
  add('buyer', fields.channel_buyer_id ?? fields.channel_username, normaliseBuyer);
  // ORD-9: same buyer and same delivery address, exact after normalising.
  const name = fields.name === undefined ? '' : normaliseName(fields.name);
  const line1 = fields.address_line1 === undefined ? '' : normaliseName(fields.address_line1);
  const postcode = fields.postcode === undefined ? '' : normalisePostcode(fields.postcode);
  if (name !== '' && line1 !== '' && postcode !== '') out.match = [name, line1, postcode].join('|');
  return out;
}

/** The search query's identifiers, normalised the same way as at ingest. */
export function queryValues(query: {
  name?: string | undefined;
  email?: string | undefined;
  phone?: string | undefined;
  postcode?: string | undefined;
  buyer?: string | undefined;
}): Record<string, string> {
  const out: Record<string, string> = {};
  if (query.name !== undefined) out.name = normaliseName(query.name);
  if (query.email !== undefined) out.email = normaliseEmail(query.email);
  if (query.phone !== undefined) out.phone = normalisePhone(query.phone);
  if (query.postcode !== undefined) out.postcode = normalisePostcode(query.postcode);
  if (query.buyer !== undefined) out.buyer = normaliseBuyer(query.buyer);
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== ''));
}

const STARS = '***';

/** ORD-5: "Jane Smith" → "J. S***". One word → "J***". */
export function maskName(value: string): string {
  const words = collapse(value).split(' ').filter(Boolean);
  const first = words[0]?.charAt(0).toUpperCase() ?? '';
  const last = words.length > 1 ? (words.at(-1)?.charAt(0).toUpperCase() ?? '') : '';
  if (first === '') return STARS;
  return last === '' ? `${first}${STARS}` : `${first}. ${last}${STARS}`;
}

/** ORD-5: the outward code only, "G2 1AA" → "G2". */
export function maskPostcode(value: string): string {
  const n = normalisePostcode(value);
  if (n.length <= 3) return STARS;
  return n.slice(0, n.length - 3);
}

/** "jane@example.com" → "j***@e***". */
export function maskEmail(value: string): string {
  const [local = '', domain = ''] = normaliseEmail(value).split('@');
  return `${local.charAt(0)}${STARS}@${domain.charAt(0)}${STARS}`;
}

/** The last 3 digits only. */
export function maskPhone(value: string): string {
  const digits = normalisePhone(value);
  return digits.length <= 3 ? STARS : `${STARS}${digits.slice(-3)}`;
}

/** The masked form of each field; anything without a rule shows only stars. */
export function maskFields(fields: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(fields)) {
    if (name === 'name') out[name] = maskName(value);
    else if (name === 'postcode') out[name] = maskPostcode(value);
    else if (name === 'email') out[name] = maskEmail(value);
    else if (name === 'phone') out[name] = maskPhone(value);
    else if (name === 'country') out[name] = value.trim().toUpperCase().slice(0, 2);
    else out[name] = STARS;
  }
  return out;
}
