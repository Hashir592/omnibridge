/**
 * Pieces the catalogue screens share (T-0316): the section links, the SKU picker, the CSV import
 * dialog with its dry-run report, and the plain inline error line (no tinted boxes).
 */
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { CircleAlert, CircleCheck, FileUp } from 'lucide-react';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { useAppState } from '../../app/session.tsx';
import {
  catalogueApi,
  type ApiReply,
  type CatalogueListing,
  type CsvImportReport,
} from '../../auth/api.ts';
import { ChannelMark } from '../../components/badges.tsx';
import { Button } from '../../kit/Button.tsx';
import { Combobox } from '../../kit/Combobox.tsx';
import { Dialog } from '../../kit/Dialog.tsx';
import { Sub } from '../../kit/table/cells.tsx';
import { cn } from '../../lib/cn.ts';
import { formatInt } from '../../lib/format.ts';
import { csvErrorText, reportState } from './rules.ts';

const SECTIONS = [
  { to: '/stock', label: 'Stock' },
  { to: '/stock/movements', label: 'Change log' },
  { to: '/stock/buffers', label: 'Buffers' },
  { to: '/stock/skus', label: 'Master SKUs' },
  { to: '/stock/listings', label: 'Listings' },
  { to: '/stock/vat-rates', label: 'VAT rates' },
] as const;

/** The parts of the Stock & Catalogue tab, as links (each has its own URL). */
export function SectionNav() {
  return (
    <nav aria-label="Stock and catalogue" className="mt-3 flex gap-5 border-b border-border">
      {SECTIONS.map((s) => (
        <Link
          key={s.to}
          to={s.to}
          activeOptions={{ exact: s.to === '/stock', includeSearch: false }}
          className="-mb-px flex h-10 items-center border-b-2 border-transparent text-13 font-medium text-ink-muted outline-none hover:text-ink focus-visible:outline-2 focus-visible:outline-brand-600"
          activeProps={{ className: '!border-side !text-ink', 'aria-current': 'page' }}
        >
          {s.label}
        </Link>
      ))}
    </nav>
  );
}

/** A plain inline error: icon and text, no tinted box. */
export function InlineError({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="flex items-start gap-2 text-13 text-danger">
      <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
      <span>{children}</span>
    </p>
  );
}

/** Provider glyph and account name; a member may not hold the account's company (6.1). */
export function AccountCell({
  listing,
}: {
  listing: Pick<CatalogueListing, 'provider' | 'channel_account_id'>;
}) {
  const { session } = useAppState();
  const name = session?.channelAccounts.find((a) => a.id === listing.channel_account_id)?.name;
  const channel = listing.provider === 'amazon_ads' ? 'amazon' : listing.provider;
  return (
    <span className="grid min-w-0 grid-cols-[18px_minmax(0,1fr)] items-center gap-x-2">
      {channel === 'amazon' || channel === 'ebay' || channel === 'website' ? (
        <ChannelMark channel={channel} />
      ) : (
        <span className="col-span-2 text-13">{listing.provider}</span>
      )}
      <Sub className="col-start-2">{name ?? 'Another company’s account'}</Sub>
    </span>
  );
}

/**
 * Picks one Master SKU by typing: the server searches code, title and barcode (listMasterSkus q).
 * `plainOnly` leaves bundles out (a bundle's component is always a plain SKU, CAT-3).
 */
export function SkuPicker({
  value,
  onChange,
  initialQuery,
  plainOnly,
  exclude,
  label,
}: {
  value: string | null;
  onChange: (id: string | null) => void;
  initialQuery?: string;
  plainOnly?: boolean;
  exclude?: string;
  label?: string;
}) {
  const { session, persona } = useAppState();
  const [typed, setTyped] = useState(initialQuery ?? '');
  const [q, setQ] = useState(initialQuery ?? '');
  useEffect(() => {
    const t = setTimeout(() => {
      setQ(typed.trim());
    }, 200);
    return () => {
      clearTimeout(t);
    };
  }, [typed]);
  const found = useQuery({
    queryKey: ['sku-picker', persona, q, plainOnly],
    queryFn: () =>
      catalogueApi.skus({
        limit: 20,
        q: q || undefined,
        active: 'true',
        bundles: plainOnly ? 'false' : undefined,
      }),
    enabled: !!session,
    placeholderData: (prev) => prev,
  });
  const [chosen, setChosen] = useState<{ value: string; label: string } | null>(null);
  const options = (found.data?.items ?? [])
    .filter((s) => s.id !== exclude)
    .map((s) => ({ value: s.id, label: `${s.sku} · ${s.title}` }));
  if (chosen && chosen.value === value && !options.some((o) => o.value === chosen.value))
    options.unshift(chosen);
  return (
    <Combobox
      value={value}
      onChange={(id) => {
        setChosen(options.find((o) => o.value === id) ?? null);
        onChange(id);
      }}
      onInputChange={(text) => {
        // Picking an option writes its label into the input: that is not a search.
        if (options.some((o) => o.label === text)) return;
        setTyped(text.slice(0, 100));
      }}
      options={options}
      placeholder="Type a SKU code or title"
      emptyText={found.isFetching ? 'Searching…' : 'No active SKU matches. Check the spelling.'}
      {...(label ? { label } : {})}
    />
  );
}

const MAX_CSV = 1_000_000;

/**
 * CSV import with a dry run first (CAT-4, CAT-5): choosing a file checks it without writing; the
 * import button appears only when every row is valid, and the server applies all rows or none.
 */
export function ImportCsvDialog({
  open,
  onOpenChange,
  title,
  columns,
  noun,
  run,
  onApplied,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  /** What the file must hold, shown above the picker. */
  columns: ReactNode;
  /** "COGS rows", "mappings": used in the button and the result. */
  noun: string;
  run: (csv: string, dryRun: boolean) => Promise<ApiReply<CsvImportReport>>;
  onApplied: (report: CsvImportReport) => void;
}) {
  const inputId = useId();
  const [file, setFile] = useState<{ name: string; text: string } | null>(null);
  const [report, setReport] = useState<CsvImportReport | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Each request gets a number; an answer that arrives after a reset or close is dropped.
  const ticket = useRef(0);

  const reset = () => {
    ticket.current += 1;
    setBusy(false);
    setFile(null);
    setReport(null);
    setFailure(null);
  };
  const send = async (text: string, dryRun: boolean) => {
    const mine = ++ticket.current;
    setBusy(true);
    setFailure(null);
    try {
      const r = await run(text, dryRun);
      if (mine !== ticket.current) return;
      if (!r.ok) {
        setFailure('The server could not check this file. Try again.');
        return;
      }
      const body = r.body as CsvImportReport;
      setReport(body);
      if (body.applied) onApplied(body);
    } catch {
      if (mine === ticket.current) setFailure('The server did not answer. Try again.');
    } finally {
      if (mine === ticket.current) setBusy(false);
    }
  };
  const choose = async (f: File | undefined) => {
    reset();
    if (!f) return;
    if (f.size > MAX_CSV) {
      setFailure('The file is over 1 MB. Split it into smaller files.');
      return;
    }
    const text = await f.text();
    setFile({ name: f.name, text });
    await send(text, true);
  };

  const state = report ? reportState(report) : null;
  const shown = report?.errors.slice(0, 50) ?? [];

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) reset();
        onOpenChange(o);
      }}
      size="lg"
      title={title}
      description="The file is checked first. Nothing changes until you import, and an import applies every row or none."
      footer={
        <>
          <Button
            onClick={() => {
              reset();
              onOpenChange(false);
            }}
          >
            {state === 'applied' ? 'Close' : 'Cancel'}
          </Button>
          {state === 'ready' && file && report && (
            <Button variant="primary" disabled={busy} onClick={() => void send(file.text, false)}>
              Import {formatInt(report.rows)} {noun}
            </Button>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="text-13 text-ink">{columns}</div>
        <div className="flex flex-wrap items-center gap-3">
          <label
            htmlFor={inputId}
            className="inline-flex h-9 cursor-pointer items-center gap-2 rounded-ctl border border-border bg-card px-3 text-13 font-medium shadow-card hover:bg-hover focus-within:outline-2 focus-within:outline-brand-600"
          >
            <FileUp className="size-4" aria-hidden />
            {file ? 'Choose another file' : 'Choose a CSV file'}
            <input
              id={inputId}
              type="file"
              accept=".csv,text/csv"
              className="sr-only"
              onChange={(e) => {
                void choose(e.target.files?.[0]);
                e.target.value = '';
              }}
            />
          </label>
          {file && <span className="ref truncate text-13 text-ink-muted">{file.name}</span>}
          {busy && <span className="text-13 text-ink-muted">Checking…</span>}
        </div>

        {failure && <InlineError>{failure}</InlineError>}

        {report && state === 'applied' && (
          <p role="status" className="flex items-start gap-2 text-13 text-success">
            <CircleCheck className="mt-0.5 size-4 shrink-0" aria-hidden />
            <span className="text-ink">
              Imported {formatInt(report.rows)} {noun}.
            </span>
          </p>
        )}
        {report && state === 'ready' && (
          <p role="status" className="flex items-start gap-2 text-13">
            <CircleCheck className="mt-0.5 size-4 shrink-0 text-success" aria-hidden />
            <span>
              All {formatInt(report.rows)} rows are valid. Import them to apply the change.
            </span>
          </p>
        )}
        {report && state === 'empty' && (
          <InlineError>The file has a header row but no data rows.</InlineError>
        )}
        {report && state === 'errors' && (
          <div className="flex flex-col gap-2">
            <InlineError>
              {formatInt(report.rows - report.valid)} of {formatInt(report.rows)} rows have a
              problem. Fix the file and choose it again; nothing was imported.
            </InlineError>
            <table className="w-full text-left text-13" aria-label="Rows with a problem">
              <thead className="text-xs text-ink-muted">
                <tr className="border-b border-divider">
                  <th scope="col" className="w-16 py-2 font-medium">
                    Line
                  </th>
                  <th scope="col" className="w-32 py-2 font-medium">
                    Column
                  </th>
                  <th scope="col" className="py-2 font-medium">
                    Problem
                  </th>
                </tr>
              </thead>
              <tbody>
                {shown.map((e, i) => (
                  <tr
                    key={`${String(e.line)}-${e.code}-${String(i)}`}
                    className="border-b border-divider last:border-0"
                  >
                    <td className="num py-2">{e.line}</td>
                    <td className={cn('ref py-2', !e.column && 'text-ink-muted')}>
                      {e.column ?? 'whole row'}
                    </td>
                    <td className="py-2">{csvErrorText(e.code)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {report.errors.length > shown.length && (
              <p className="text-xs text-ink-muted">
                And {formatInt(report.errors.length - shown.length)} more. Fix these first.
              </p>
            )}
          </div>
        )}
      </div>
    </Dialog>
  );
}
