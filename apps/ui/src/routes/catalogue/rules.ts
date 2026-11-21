/**
 * Catalogue rules the screens share (T-0316), kept free of React so they are unit tested.
 * Money is integer pence and rates are basis points (2000 = 20%); no float ever holds money.
 */
import type {
  ApiProblem,
  ApiReply,
  CsvImportReport,
  MasterSkuCreate,
  VatRate,
  VatType,
} from '../../auth/api.ts';

export const VAT_TYPES: VatType[] = ['standard', 'reduced', 'zero', 'no_vat'];

/** CAT-2: zero-rated is not "no VAT"; the four types stay apart everywhere. */
export const VAT_NAME: Record<VatType, string> = {
  standard: 'Standard',
  reduced: 'Reduced',
  zero: 'Zero-rated',
  no_vat: 'No VAT',
};

/** 2000 → "20%", 1750 → "17.5%", 0 → "0%". */
export function formatRate(bp: number): string {
  const whole = Math.trunc(bp / 100);
  const frac = String(bp % 100)
    .padStart(2, '0')
    .replace(/0+$/, '');
  return `${String(whole)}${frac ? `.${frac}` : ''}%`;
}

/** "20", "17.5" or "17.50%" → basis points; null when it is not 0 to 100 with up to 2 decimals. */
export function parseRate(text: string): number | null {
  const m = /^\s*(\d{1,3})(?:\.(\d{1,2}))?\s*%?\s*$/.exec(text);
  if (!m) return null;
  const bp = Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
  return bp <= 10_000 ? bp : null;
}

/**
 * "12.34", "£1,234.5" or "7" → pence, by string arithmetic only (no float). Null when it is not a
 * non-negative amount with at most two decimals, or is over the contract's £1,000,000 cap.
 */
export function parsePounds(text: string): number | null {
  const m = /^\s*£?\s*(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?\s*$/.exec(text);
  if (!m) return null;
  const pounds = Number((m[1] ?? '').replaceAll(',', ''));
  const pence = pounds * 100 + Number((m[2] ?? '').padEnd(2, '0'));
  return Number.isSafeInteger(pence) && pence <= 100_000_000 ? pence : null;
}

/** 1234 → "12.34", for a form field holding pounds. */
export function penceToPounds(pence: number): string {
  return `${String(Math.trunc(pence / 100))}.${String(pence % 100).padStart(2, '0')}`;
}

/**
 * The rate in force on `day` for each VAT type: the latest row whose effective_from is on or
 * before it. A type with no row yet is left out.
 */
export function ratesOn(rates: VatRate[], day: string): Partial<Record<VatType, VatRate>> {
  const out: Partial<Record<VatType, VatRate>> = {};
  for (const r of rates) {
    if (r.effective_from > day) continue;
    const cur = out[r.vat_type];
    if (!cur || r.effective_from > cur.effective_from) out[r.vat_type] = r;
  }
  return out;
}

/** "Standard 20%", or just "Standard" when no rate is known. */
export function vatLabel(type: VatType, current: Partial<Record<VatType, VatRate>>): string {
  const r = current[type];
  return r ? `${VAT_NAME[type]} ${formatRate(r.rate_bp)}` : VAT_NAME[type];
}

/** The newest history row in force on `day` (rows may hold a future date). */
export function currentOf<T extends { effective_from: string }>(rows: T[], day: string): T | null {
  let best: T | null = null;
  for (const r of rows) {
    if (r.effective_from <= day && (!best || r.effective_from > best.effective_from)) best = r;
  }
  return best;
}

/** Plain words for each CSV import error code the server sends (T-0801). */
const CSV_CODE_TEXT: Record<string, string> = {
  csv_invalid: 'The file is not a readable CSV.',
  column_missing: 'A required column is missing from the header row.',
  too_many_rows: 'Too many rows for one import. Split the file.',
  sku_unknown: 'No Master SKU has this code.',
  bundle_cogs: "A bundle's COGS comes from its component. Set the component's instead.",
  cogs_invalid: 'Enter the cost in pounds, for example 12.34.',
  date_invalid: 'Enter the date as DD/MM/YYYY.',
  duplicate: 'This row repeats an earlier one.',
  listing_unknown: 'No listing has this ID. Use the ID from the export.',
};

export function csvErrorText(code: string): string {
  return CSV_CODE_TEXT[code] ?? `The row was refused (${code}).`;
}

/** What the report means for the next step: fix the file, import it, or it is done. */
export function reportState(r: CsvImportReport): 'empty' | 'errors' | 'ready' | 'applied' {
  if (r.applied) return 'applied';
  if (r.errors.length > 0) return 'errors';
  return r.rows === 0 ? 'empty' : 'ready';
}

/** Field errors from a 400 problem, keyed by field path (for example "vat_type"). */
export function fieldErrors(reply: ApiReply<unknown>): Record<string, string> {
  if (reply.status !== 400) return {};
  const p = reply.body as ApiProblem | undefined;
  const out: Record<string, string> = {};
  for (const e of p?.errors ?? []) out[e.path] = e.message;
  return out;
}

/** The server's plain refusal (409 detail), or a fallback for anything else. */
export function refusalText(reply: ApiReply<unknown>, fallback: string): string {
  const p = reply.body as ApiProblem | undefined;
  if (reply.status === 409 && p?.detail) return p.detail;
  return fallback;
}

export interface NewSkuForm {
  kind: 'single' | 'bundle';
  sku: string;
  title: string;
  shortDescription: string;
  weightG: string;
  manufacturer: string;
  barcode: string;
  vatType: VatType | null;
  cogs: string;
  cogsFrom: string | null;
  componentId: string | null;
  packSize: string;
}

export type FormResult<T> = { ok: true; body: T } | { ok: false; errors: Record<string, string> };

const wholeNumber = (text: string, min: number, max: number): number | null => {
  if (!/^\s*\d+\s*$/.test(text)) return null;
  const n = Number(text);
  return n >= min && n <= max ? n : null;
};

/**
 * The create body for a plain SKU or a bundle (CAT-1, CAT-3). A bundle sends its one component and
 * a pack of at least 2, and never a VAT type or COGS: it takes its component's.
 */
export function newSkuBody(f: NewSkuForm): FormResult<MasterSkuCreate> {
  const errors: Record<string, string> = {};
  const sku = f.sku.trim();
  if (!sku) errors.sku = 'Enter a SKU code';
  else if (sku.length > 64) errors.sku = 'Use 64 characters or fewer';
  if (!f.title.trim()) errors.title = 'Enter a title';
  if (!f.shortDescription.trim()) errors.short_description = 'Enter a short description';
  else if (f.shortDescription.trim().length > 100)
    errors.short_description = 'Use 100 characters or fewer';
  const weight = wholeNumber(f.weightG, 0, 1_000_000);
  if (weight === null) errors.weight_g = 'Enter the weight in whole grams';

  const body: MasterSkuCreate = {
    sku,
    title: f.title.trim(),
    short_description: f.shortDescription.trim(),
    weight_g: weight ?? 0,
  };
  if (f.manufacturer.trim()) body.manufacturer = f.manufacturer.trim();
  if (f.barcode.trim()) body.barcode = f.barcode.trim();

  if (f.kind === 'bundle') {
    const pack = wholeNumber(f.packSize, 2, 1_000);
    if (!f.componentId) errors['bundle.component_id'] = 'Choose the SKU this bundle holds';
    if (pack === null) errors['bundle.pack_size'] = 'A bundle holds 2 to 1,000 units';
    if (f.componentId && pack !== null)
      body.bundle = { component_id: f.componentId, pack_size: pack };
  } else {
    if (!f.vatType) errors.vat_type = 'Choose a VAT type';
    else body.vat_type = f.vatType;
    if (f.cogs.trim()) {
      const pence = parsePounds(f.cogs);
      if (pence === null) errors.cogs_pence = 'Enter the cost in pounds, for example 12.34';
      else {
        body.cogs_pence = pence;
        if (f.cogsFrom) body.cogs_effective_from = f.cogsFrom;
      }
    }
  }
  return Object.keys(errors).length > 0 ? { ok: false, errors } : { ok: true, body };
}

/** "3 × CB-OAK-M100" for a bundle's make-up. */
export function bundleText(b: { pack_size: number; component_sku: string }): string {
  return `${String(b.pack_size)} × ${b.component_sku}`;
}
