import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { useAppState } from '../../app/session.tsx';
import { catalogueApi, type VatRate } from '../../auth/api.ts';
import { Card, PageHeader } from '../../components/Card.tsx';
import { TabGate } from '../../components/TabGate.tsx';
import { Button } from '../../kit/Button.tsx';
import { EmptyState, ErrorState } from '../../kit/states.tsx';
import { useToast } from '../../kit/Toast.tsx';
import { cn } from '../../lib/cn.ts';
import { formatUkDate, todayLondon } from '../../lib/dates.ts';
import { AddVatRateDialog } from './forms.tsx';
import { SectionNav } from './parts.tsx';
import { VAT_NAME, VAT_TYPES, formatRate, ratesOn } from './rules.ts';

export function VatRatesPage() {
  return (
    <TabGate tab="stock">
      <VatRates />
    </TabGate>
  );
}

/** Rows grouped by VAT type in the CAT-2 order, newest first, each marked past, current or scheduled. */
export function rateRows(rates: VatRate[], today: string) {
  const current = ratesOn(rates, today);
  return VAT_TYPES.flatMap((t) =>
    rates
      .filter((r) => r.vat_type === t)
      .sort((a, b) => b.effective_from.localeCompare(a.effective_from))
      .map((r) => ({
        rate: r,
        state:
          r.effective_from > today
            ? ('scheduled' as const)
            : current[t] === r
              ? ('current' as const)
              : ('past' as const),
      })),
  );
}

function VatRates() {
  const { session, persona } = useAppState();
  const qc = useQueryClient();
  const toast = useToast();
  const [adding, setAdding] = useState(false);
  const rates = useQuery({
    queryKey: ['vat-rates', persona],
    queryFn: catalogueApi.vatRates,
    enabled: !!session,
  });
  // createVatRate is the settings tab, admins only (PERM-4): members never see the button.
  const admin = session?.user.isAdmin ?? false;
  const rows = rateRows(rates.data ?? [], todayLondon());

  return (
    <div className="h-full overflow-y-auto">
      <div className="px-4 pt-2 pb-12 lg:px-6">
        <PageHeader
          title="Stock & Catalogue"
          actions={
            admin ? (
              <Button
                variant="primary"
                icon={<Plus />}
                onClick={() => {
                  setAdding(true);
                }}
              >
                Add rate
              </Button>
            ) : undefined
          }
        />
        <SectionNav />
        <Card className="mt-4 max-w-3xl">
          {rates.isError ? (
            <ErrorState
              title="VAT rates could not load"
              body="The server did not answer. Try again."
              action={{ label: 'Try again', onClick: () => void rates.refetch() }}
            />
          ) : rates.isPending ? (
            <div aria-busy className="h-40" />
          ) : rows.length === 0 ? (
            <EmptyState
              title="No VAT rates yet"
              body={
                admin
                  ? 'Add the rate for each VAT type, starting from the day it applies.'
                  : 'Ask an admin to add the VAT rates.'
              }
            />
          ) : (
            <table className="w-full text-left text-13" aria-label="VAT rates">
              <thead className="text-xs text-ink-muted">
                <tr className="border-b border-divider">
                  <th scope="col" className="px-5 py-2.5 font-medium">
                    VAT type
                  </th>
                  <th scope="col" className="px-5 py-2.5 text-right font-medium">
                    Rate
                  </th>
                  <th scope="col" className="px-5 py-2.5 font-medium">
                    From
                  </th>
                  <th scope="col" className="px-5 py-2.5 font-medium">
                    In force
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ rate, state }) => (
                  <tr
                    key={`${rate.vat_type}-${rate.effective_from}`}
                    className="border-b border-divider last:border-0"
                  >
                    <td className={cn('px-5 py-3', state === 'past' && 'text-ink-muted')}>
                      {VAT_NAME[rate.vat_type]}
                    </td>
                    <td
                      className={cn(
                        'num px-5 py-3 text-right',
                        state === 'current'
                          ? 'font-semibold'
                          : state === 'past' && 'text-ink-muted',
                      )}
                    >
                      {formatRate(rate.rate_bp)}
                    </td>
                    <td className={cn('num px-5 py-3', state === 'past' && 'text-ink-muted')}>
                      {formatUkDate(rate.effective_from)}
                    </td>
                    <td className="px-5 py-3 text-ink-muted">
                      {state === 'current' ? (
                        <span className="text-ink">Current</span>
                      ) : state === 'scheduled' ? (
                        'Scheduled'
                      ) : (
                        'Replaced'
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="border-t border-divider px-5 py-3 text-xs text-ink-muted">
            Each order line keeps the rate of the day it was placed. Zero-rated and No VAT are both
            0% but stay separate on the VAT return.
          </p>
        </Card>
      </div>
      <AddVatRateDialog
        open={adding}
        onOpenChange={setAdding}
        onSaved={() => {
          void qc.invalidateQueries({ queryKey: ['vat-rates'] });
          toast({ title: 'VAT rate added', tone: 'success' });
        }}
      />
    </div>
  );
}
