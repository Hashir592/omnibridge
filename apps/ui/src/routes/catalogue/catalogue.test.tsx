// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApiReply, CsvImportReport, VatRate } from '../../auth/api.ts';
import { editBody } from './forms.tsx';
import { fulfilmentText, mappedParam } from './listings.tsx';
import { ImportCsvDialog, accountLabel } from './parts.tsx';
import {
  csvErrorText,
  currentOf,
  fieldErrors,
  formatRate,
  newSkuBody,
  parsePounds,
  parseRate,
  penceToPounds,
  rateNumber,
  ratesOn,
  refusalText,
  reportState,
  vatLabel,
  type NewSkuForm,
} from './rules.ts';
import { viewQuery } from './skus.tsx';
import { rateRows } from './vat-rates.tsx';

afterEach(cleanup);

const COMPONENT = '0c0a1e9d-0000-4000-8000-000000000001';

const form = (over: Partial<NewSkuForm> = {}): NewSkuForm => ({
  kind: 'single',
  sku: 'CB-OAK-M100',
  title: 'Oak chopping board, medium',
  shortDescription: 'Oak chopping board',
  weightG: '850',
  manufacturer: '',
  barcode: '',
  vatType: 'standard',
  cogs: '',
  cogsFrom: '2026-11-22',
  componentId: null,
  packSize: '2',
  ...over,
});

describe('money and rates', () => {
  it('[CAT-4] reads pounds into integer pence without a float', () => {
    expect(parsePounds('12.34')).toBe(1234);
    expect(parsePounds('£1,234.5')).toBe(123_450);
    expect(parsePounds('0.1')).toBe(10);
    expect(parsePounds('7')).toBe(700);
    // 0.1 + 0.2 style traps: string arithmetic keeps every penny.
    expect(parsePounds('1.15')).toBe(115);
    expect(parsePounds('12.345')).toBeNull();
    expect(parsePounds('-3')).toBeNull();
    expect(parsePounds('abc')).toBeNull();
    expect(parsePounds('1000000.01')).toBeNull();
    expect(penceToPounds(1205)).toBe('12.05');
  });

  it('[CAT-2] shows rates in basis points as percentages and reads them back', () => {
    expect(formatRate(2000)).toBe('20%');
    expect(formatRate(1750)).toBe('17.5%');
    expect(formatRate(0)).toBe('0%');
    expect(rateNumber(1750)).toBe('17.5');
    expect(parseRate('20')).toBe(2000);
    expect(parseRate('17.5%')).toBe(1750);
    expect(parseRate('101')).toBeNull();
  });

  it('[CAT-2] uses the rate in force on the day, and keeps zero-rated apart from No VAT', () => {
    const rates: VatRate[] = [
      { vat_type: 'standard', rate_bp: 1750, effective_from: '2008-12-01' },
      { vat_type: 'standard', rate_bp: 2000, effective_from: '2011-01-04' },
      { vat_type: 'standard', rate_bp: 2200, effective_from: '2027-04-01' },
      { vat_type: 'zero', rate_bp: 0, effective_from: '1973-04-01' },
      { vat_type: 'no_vat', rate_bp: 0, effective_from: '1973-04-01' },
    ];
    const now = ratesOn(rates, '2026-11-22');
    expect(now.standard?.rate_bp).toBe(2000);
    expect(vatLabel('zero', now)).toBe('Zero-rated 0%');
    expect(vatLabel('no_vat', now)).toBe('No VAT 0%');
    expect(vatLabel('reduced', now)).toBe('Reduced');
    const rows = rateRows(rates, '2026-11-22');
    expect(rows.slice(0, 3).map((r) => r.state)).toEqual(['scheduled', 'current', 'past']);
    expect(
      currentOf(
        rates.filter((r) => r.vat_type === 'standard'),
        '2026-11-22',
      )?.rate_bp,
    ).toBe(2000);
  });
});

describe('Master SKU forms', () => {
  it('[CAT-1] a plain SKU needs a VAT type, and sends its first COGS from the chosen day', () => {
    expect(newSkuBody(form({ vatType: null }))).toEqual({
      ok: false,
      errors: { vat_type: 'Choose a VAT type' },
    });
    const r = newSkuBody(form({ cogs: '4.20' }));
    expect(r).toMatchObject({
      ok: true,
      body: { vat_type: 'standard', cogs_pence: 420, cogs_effective_from: '2026-11-22' },
    });
  });

  it('[CAT-3] a bundle sends one component and a pack of 2 or more, never a VAT type or COGS', () => {
    const r = newSkuBody(
      form({ kind: 'bundle', componentId: COMPONENT, packSize: '3', cogs: '9.99' }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.body.bundle).toEqual({ component_id: COMPONENT, pack_size: 3 });
    expect(r.body).not.toHaveProperty('vat_type');
    expect(r.body).not.toHaveProperty('cogs_pence');
    expect(newSkuBody(form({ kind: 'bundle', componentId: COMPONENT, packSize: '1' }))).toEqual({
      ok: false,
      errors: { 'bundle.pack_size': 'A bundle holds 2 to 1,000 units' },
    });
    expect(newSkuBody(form({ kind: 'bundle', componentId: null }))).toMatchObject({
      ok: false,
      errors: { 'bundle.component_id': 'Choose the SKU this bundle holds' },
    });
  });

  it('[CAT-3] an edit never sends the SKU code or a bundle make-up (both read-only)', () => {
    const r = editBody({
      title: 'Oak board',
      shortDescription: 'Oak board',
      barcode: '',
      manufacturer: 'Penrose Works',
      weightG: '900',
      length: '300',
      width: '200',
      height: '20',
      imageUrl: '',
      purchaseVat: '',
      lead: '14',
      safety: '7',
      cover: '45',
      active: true,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(Object.keys(r.body)).not.toContain('sku');
    expect(Object.keys(r.body)).not.toContain('bundle');
    expect(r.body.dimensions).toEqual({ length_mm: 300, width_mm: 200, height_mm: 20 });
    expect(r.body.barcode).toBeNull();
  });

  it('[CAT-1] shows the server field errors and its plain refusal', () => {
    const bad: ApiReply<unknown> = {
      ok: false,
      status: 400,
      body: {
        code: 'validation_failed',
        errors: [{ path: 'vat_type', message: 'Choose a VAT type' }],
      },
      retryAfter: undefined,
    };
    expect(fieldErrors(bad)).toEqual({ vat_type: 'Choose a VAT type' });
    const taken: ApiReply<unknown> = {
      ok: false,
      status: 409,
      body: { code: 'conflict', detail: 'This SKU code is already used in this workspace.' },
      retryAfter: undefined,
    };
    expect(refusalText(taken, 'fallback')).toBe('This SKU code is already used in this workspace.');
    expect(refusalText({ ...taken, status: 500 }, 'fallback')).toBe('fallback');
  });

  it('[CAT-3] the Bundles view asks the server for bundles only', () => {
    expect(viewQuery('bundles')).toEqual({ bundles: 'true' });
    expect(viewQuery('inactive')).toEqual({ active: 'false' });
    expect(viewQuery('all')).toEqual({});
  });
});

describe('listings and mapping', () => {
  it('[CAT-5] the Unmapped queue is the mapped=false list', () => {
    expect(mappedParam('unmapped')).toBe('false');
    expect(mappedParam('mapped')).toBe('true');
    expect(mappedParam('all')).toBeUndefined();
  });

  it('[CAT-5] names the account, or "Another company’s account" when the user cannot see it', () => {
    expect(accountLabel({ channel_account_name: 'eBay · northfield-trading' })).toBe(
      'eBay · northfield-trading',
    );
    expect(accountLabel({ channel_account_name: null })).toBe('Another company’s account');
  });

  it('[CAT-5] names Amazon fulfilment and eBay Inventory API listings', () => {
    expect(fulfilmentText({ fulfilment: 'fba', inventory_api: null })).toBe('Fulfilled by Amazon');
    expect(fulfilmentText({ fulfilment: 'mfn', inventory_api: null })).toBe('Merchant fulfilled');
    expect(fulfilmentText({ fulfilment: null, inventory_api: true })).toBe('Inventory API');
    expect(fulfilmentText({ fulfilment: null, inventory_api: null })).toBeNull();
  });

  it('[CAT-4] [CAT-5] explains every import error code the server sends', () => {
    for (const code of [
      'csv_invalid',
      'column_missing',
      'too_many_rows',
      'sku_unknown',
      'bundle_cogs',
      'cogs_invalid',
      'date_invalid',
      'duplicate',
      'listing_unknown',
    ]) {
      expect(csvErrorText(code)).not.toContain(code);
    }
    expect(csvErrorText('new_code')).toContain('new_code');
  });
});

const ok = (r: CsvImportReport): ApiReply<CsvImportReport> => ({
  ok: true,
  status: 200,
  body: r,
  retryAfter: undefined,
});

async function chooseFile(text: string) {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]');
  if (!input) throw new Error('no file input');
  const file = new File([text], 'cogs.csv', { type: 'text/csv' });
  await act(async () => {
    fireEvent.change(input, { target: { files: [file] } });
    await Promise.resolve();
  });
}

function dialog(run: (csv: string, dry: boolean) => Promise<ApiReply<CsvImportReport>>) {
  const onApplied = vi.fn();
  render(
    <ImportCsvDialog
      open
      onOpenChange={vi.fn()}
      title="Import COGS"
      noun="COGS rows"
      columns="Columns: sku, cogs, effective_from"
      run={run}
      onApplied={onApplied}
    />,
  );
  return onApplied;
}

describe('CSV import dialog', () => {
  it('[CAT-4] checks the file with a dry run first and lists each bad row; nothing is imported', async () => {
    const run = vi.fn<(csv: string, dry: boolean) => Promise<ApiReply<CsvImportReport>>>(() =>
      Promise.resolve(
        ok({
          rows: 3,
          valid: 2,
          applied: false,
          errors: [{ line: 3, code: 'sku_unknown', column: 'sku' }],
        }),
      ),
    );
    dialog(run);
    await chooseFile('sku,cogs,effective_from\nA,1.00,01/11/2026\n');
    expect(run).toHaveBeenCalledWith(expect.stringContaining('sku,cogs'), true);
    expect(await screen.findByText(/1 of 3 rows have a problem/)).toBeTruthy();
    const table = screen.getByRole('table', { name: 'Rows with a problem' });
    expect(table.textContent).toContain('No Master SKU has this code.');
    expect(screen.queryByRole('button', { name: /^Import 3/ })).toBeNull();
  });

  it('[CAT-4] imports only after a clean dry run, and reports the rows applied', async () => {
    const run = vi.fn((_csv: string, dry: boolean) =>
      Promise.resolve(ok({ rows: 2, valid: 2, applied: !dry, errors: [] })),
    );
    const onApplied = dialog(run);
    await chooseFile('sku,cogs,effective_from\nA,1.00,01/11/2026\nB,2.00,01/11/2026\n');
    const go = await screen.findByRole('button', { name: 'Import 2 COGS rows' });
    await act(async () => {
      fireEvent.click(go);
      await Promise.resolve();
    });
    expect(run).toHaveBeenLastCalledWith(expect.any(String), false);
    expect(await screen.findByText('Imported 2 COGS rows.')).toBeTruthy();
    expect(onApplied).toHaveBeenCalledOnce();
  });

  it('[CAT-4] reports a file with no data rows', async () => {
    const empty = { rows: 0, valid: 0, applied: false, errors: [] };
    expect(reportState(empty)).toBe('empty');
    dialog(() => Promise.resolve(ok(empty)));
    await chooseFile('sku,cogs,effective_from\n');
    expect(await screen.findByText('The file has a header row but no data rows.')).toBeTruthy();
  });
});
