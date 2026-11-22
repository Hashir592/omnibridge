import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useAppState } from '../../app/session.tsx';
import { stockApi, type StockBuffer } from '../../auth/api.ts';
import { Card, PageHeader } from '../../components/Card.tsx';
import { ChannelMark } from '../../components/badges.tsx';
import { TabGate } from '../../components/TabGate.tsx';
import { Button } from '../../kit/Button.tsx';
import { Input } from '../../kit/Field.tsx';
import { EmptyState, ErrorState } from '../../kit/states.tsx';
import { useToast } from '../../kit/Toast.tsx';
import { InlineError, SectionNav } from '../catalogue/parts.tsx';
import { wholeUnits } from './rules.ts';

export function BuffersPage() {
  return (
    <TabGate tab="stock">
      <Buffers />
    </TabGate>
  );
}

/** INV-2: the safety buffer per sales account; a listing may override it on the SKU page. */
function Buffers() {
  const { session, persona } = useAppState();
  const list = useQuery({
    queryKey: ['stock-buffers', persona],
    queryFn: stockApi.buffers,
    enabled: !!session,
  });
  return (
    <div className="h-full overflow-y-auto">
      <div className="px-4 pt-2 pb-12 lg:px-6">
        <PageHeader title="Stock & Catalogue" />
        <SectionNav />
        <Card className="mt-4 max-w-3xl">
          <p className="border-b border-divider px-5 py-3 text-13 text-ink-muted">
            A buffer keeps units back from a channel: a listing shows available minus its buffer,
            never below 0. Set one per account here; a listing can use its own on the SKU page.
            Amazon FBA listings have no buffer.
          </p>
          {list.isError ? (
            <ErrorState
              title="Buffers could not load"
              body="The server did not answer. Try again."
              action={{ label: 'Try again', onClick: () => void list.refetch() }}
            />
          ) : list.isPending ? (
            <div aria-busy className="h-40" />
          ) : list.data.length === 0 ? (
            <EmptyState
              title="No sales accounts"
              body="Connect an Amazon, eBay or website account in Connections, then set its buffer here."
            />
          ) : (
            <ul aria-label="Buffers per account" className="px-5 py-1.5">
              {list.data.map((b) => (
                <BufferRow key={b.channel_account_id} b={b} />
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}

function BufferRow({ b }: { b: StockBuffer }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [value, setValue] = useState(String(b.buffer));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const n = wholeUnits(value);
  const changed = n !== b.buffer;
  const save = async () => {
    if (n === null) {
      setError('Enter a whole number, 0 or more');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await stockApi.setAccountBuffer(b.channel_account_id, n);
      if (!r.ok) {
        setError('The buffer could not be saved. Try again.');
        return;
      }
      void qc.invalidateQueries({ queryKey: ['stock-buffers'] });
      void qc.invalidateQueries({ queryKey: ['stock-detail'] });
      void qc.invalidateQueries({ queryKey: ['stock'] });
      toast({
        title: 'Buffer saved',
        description: `${b.display_name}: listings are updated where their quantity changes.`,
        tone: 'success',
      });
    } catch {
      setError('The server did not answer. Try again.');
    } finally {
      setBusy(false);
    }
  };
  const channel =
    b.provider === 'amazon' || b.provider === 'ebay' || b.provider === 'website'
      ? b.provider
      : null;
  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-divider py-3 last:border-0">
      <span className="grid min-w-0 flex-1 grid-cols-[18px_minmax(0,1fr)] items-center gap-x-2">
        {channel ? (
          <ChannelMark channel={channel} />
        ) : (
          <span className="col-span-2">{b.provider}</span>
        )}
        <span className="col-start-2 truncate text-xs text-ink-muted">{b.display_name}</span>
      </span>
      <span className="flex items-center gap-2">
        <span className="w-20">
          <Input
            aria-label={`Buffer for ${b.display_name}`}
            value={value}
            onChange={setValue}
            inputMode="numeric"
            className="num text-right"
          />
        </span>
        <span className="text-13 text-ink-muted">units</span>
        <Button size="sm" disabled={!changed || busy} onClick={() => void save()}>
          Save
        </Button>
      </span>
      {error && (
        <div className="basis-full">
          <InlineError>{error}</InlineError>
        </div>
      )}
    </li>
  );
}
