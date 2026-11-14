import { useQuery } from '@tanstack/react-query';
import { getRouteApi, useNavigate } from '@tanstack/react-router';
import { CircleCheck, CirclePause, Archive, FlaskConical, Plus } from 'lucide-react';
import { useState } from 'react';
import { useAppState } from '../app/session.tsx';
import { Card, Figure, PageHeader, SimpleTable, Stack, Td, Tr } from '../components/Card.tsx';
import { TabGate } from '../components/TabGate.tsx';
import { SignalLabel, StatusLabel } from '../kit/Badge.tsx';
import { Button } from '../kit/Button.tsx';
import { ConfirmDialog } from '../kit/Dialog.tsx';
import { Tabs } from '../kit/Tabs.tsx';
import { EmptyState, ErrorState } from '../kit/states.tsx';
import { useToast } from '../kit/Toast.tsx';
import { ViewTabs } from '../kit/table/Toolbar.tsx';
import { cn } from '../lib/cn.ts';
import { formatDateTime, formatInt, formatPence } from '../lib/format.ts';
import type { AdsOverview, Campaign } from '../mocks/ads.ts';
import { mockApi } from '../mocks/api.ts';

export type AdsSection = 'campaigns' | 'rules' | 'negatives';

export interface AdsSearch {
  section?: AdsSection | undefined;
  days?: 7 | 14 | undefined;
}

const route = getRouteApi('/advertising');

const acos = (c: Pick<Campaign, 'spendPence' | 'salesPence'>) =>
  c.salesPence === 0 ? null : (c.spendPence / c.salesPence) * 100;
const roas = (c: Pick<Campaign, 'spendPence' | 'salesPence'>) =>
  c.spendPence === 0 ? null : c.salesPence / c.spendPence;
const pct = (n: number | null) => (n === null ? '-' : `${n.toFixed(1)}%`);

export function AdvertisingPage() {
  return (
    <TabGate tab="advertising">
      <Advertising />
    </TabGate>
  );
}

function Advertising() {
  const search = route.useSearch();
  const navigate = useNavigate({ from: '/advertising' });
  const { session, persona, companyId } = useAppState();
  const section = search.section ?? 'campaigns';
  const days = search.days ?? 30;
  const set = (patch: Partial<AdsSearch>) =>
    void navigate({ search: (prev: AdsSearch) => ({ ...prev, ...patch }), replace: true });
  const q = useQuery({
    queryKey: ['ads', persona, companyId, days],
    queryFn: () => mockApi.ads({ company: companyId, days }),
    enabled: !!session,
  });
  const d = q.data;

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[1280px] px-4 pt-3 pb-12 lg:px-6">
        <PageHeader
          title="Advertising"
          sub={
            d && d.profiles.length > 0
              ? `Ads profile: ${d.profiles.map((p) => p.name).join(', ')}`
              : undefined
          }
          actions={
            section === 'campaigns' ? (
              <Button variant="primary" icon={<Plus />}>
                New Sponsored Products campaign
              </Button>
            ) : section === 'rules' ? (
              <Button variant="primary" icon={<Plus />}>
                New rule
              </Button>
            ) : undefined
          }
        />
        {q.isError ? (
          <Card className="mt-4">
            <ErrorState
              title="Advertising could not load"
              body="The server did not answer. Try again; if it keeps failing, check Status."
              action={{ label: 'Try again', onClick: () => void q.refetch() }}
            />
          </Card>
        ) : !d ? (
          <div aria-busy className="mt-4 h-96" />
        ) : d.profiles.length === 0 ? (
          <Card className="mt-4">
            <EmptyState
              title="No Amazon Ads profile for this company"
              body="Connect Amazon Ads in Connections, or switch to Combined to see the companies that have one."
            />
          </Card>
        ) : (
          <div className="mt-3">
            <Tabs<AdsSection>
              label="Advertising sections"
              value={section}
              onChange={(v) => {
                set({ section: v === 'campaigns' ? undefined : v });
              }}
              items={[
                {
                  value: 'campaigns',
                  label: 'Campaigns',
                  content: (
                    <Campaigns
                      d={d}
                      days={days}
                      onDays={(v) => {
                        set({ days: v === 30 ? undefined : v });
                      }}
                    />
                  ),
                },
                { value: 'rules', label: 'Rules', content: <Rules d={d} /> },
                {
                  value: 'negatives',
                  label: 'Negative keyword finder',
                  content: <Negatives d={d} />,
                },
              ]}
            />
          </div>
        )}
      </div>
    </div>
  );
}

function CampaignState({ c }: { c: Campaign }) {
  if (c.state === 'enabled')
    return (
      <StatusLabel tone="success" icon={CircleCheck}>
        Enabled
      </StatusLabel>
    );
  if (c.state === 'paused')
    return (
      <StatusLabel tone="neutral" icon={CirclePause}>
        Paused
      </StatusLabel>
    );
  return (
    <StatusLabel tone="neutral" icon={Archive}>
      Archived
    </StatusLabel>
  );
}

function Campaigns({
  d,
  days,
  onDays,
}: {
  d: AdsOverview;
  days: number;
  onDays: (v: 7 | 14 | 30) => void;
}) {
  const t = d.campaigns.reduce(
    (s, c) => ({
      spendPence: s.spendPence + c.spendPence,
      salesPence: s.salesPence + c.salesPence,
      clicks: s.clicks + c.clicks,
      orders: s.orders + c.orders,
      impressions: s.impressions + c.impressions,
    }),
    { spendPence: 0, salesPence: 0, clicks: 0, orders: 0, impressions: 0 },
  );
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <ViewTabs<'7' | '14' | '30'>
          label="Date range"
          value={String(days) as '7' | '14' | '30'}
          onChange={(v) => {
            onDays(Number(v) as 7 | 14 | 30);
          }}
          tabs={[
            { id: '7', label: '7 days' },
            { id: '14', label: '14 days' },
            { id: '30', label: '30 days' },
          ]}
        />
        <span className="flex items-center gap-1.5 text-xs text-ink-muted">
          <SignalLabel signal="Provisional" /> The last {d.provisionalDays} days can still change as
          Amazon finalises attribution.
        </span>
      </div>
      <Card>
        <div className="grid grid-cols-2 gap-x-6 gap-y-4 px-5 py-4 md:grid-cols-3 lg:grid-cols-6">
          <Figure label="Spend" value={formatPence(t.spendPence)} />
          <Figure label="Ad sales" value={formatPence(t.salesPence)} />
          <Figure label="ACOS" value={pct(acos(t))} sub="Spend ÷ ad sales" />
          <Figure label="ROAS" value={roas(t)?.toFixed(2) ?? '-'} sub="Ad sales ÷ spend" />
          <Figure
            label="Clicks"
            value={formatInt(t.clicks)}
            sub={`CTR ${pct(t.impressions ? (t.clicks / t.impressions) * 100 : null)}`}
          />
          <Figure label="Orders" value={formatInt(t.orders)} />
        </div>
      </Card>
      <Card
        title="Campaigns"
        aside={
          <span className="text-xs text-ink-muted">
            Open a campaign for ad groups, keywords, search terms and products
          </span>
        }
      >
        <SimpleTable
          label="Campaigns"
          head={[
            { label: 'Campaign' },
            { label: 'State' },
            { label: 'Budget / day', align: 'right' },
            { label: 'Spend', align: 'right' },
            { label: 'Sales', align: 'right' },
            { label: 'ACOS', align: 'right' },
            { label: 'ROAS', align: 'right' },
            { label: 'Clicks', align: 'right' },
            { label: 'CPC', align: 'right' },
            { label: 'Orders', align: 'right' },
          ]}
        >
          {d.campaigns.map((c) => {
            const a = acos(c);
            return (
              <Tr key={c.id} className={cn(c.state === 'archived' && 'text-ink-muted')}>
                <Td className="max-w-[260px]">
                  <Stack
                    value={
                      <button className="font-medium hover:text-brand-600 hover:underline">
                        {c.name}
                      </button>
                    }
                    sub={
                      c.type === 'SP'
                        ? `Sponsored Products, ${c.targeting ?? ''}`
                        : c.type === 'SB'
                          ? 'Sponsored Brands'
                          : 'Sponsored Display'
                    }
                  />
                </Td>
                <Td>
                  <CampaignState c={c} />
                </Td>
                <Td align="right">{formatPence(c.budgetPence)}</Td>
                <Td align="right">{formatPence(c.spendPence)}</Td>
                <Td align="right">{formatPence(c.salesPence)}</Td>
                <Td align="right">
                  <span className={cn(a !== null && a > 40 && 'font-medium text-warning')}>
                    {pct(a)}
                  </span>
                </Td>
                <Td align="right">{roas(c)?.toFixed(2) ?? '-'}</Td>
                <Td align="right">{formatInt(c.clicks)}</Td>
                <Td align="right">
                  {c.clicks ? formatPence(Math.round(c.spendPence / c.clicks)) : '-'}
                </Td>
                <Td align="right">{formatInt(c.orders)}</Td>
              </Tr>
            );
          })}
        </SimpleTable>
        <p className="border-t border-divider px-5 py-3 text-xs text-ink-muted">
          ACOS above 40% is marked. Every edit goes through the queue and the audit log; bulk edits
          ask first.
        </p>
      </Card>
    </div>
  );
}

function Rules({ d }: { d: AdsOverview }) {
  const toast = useToast();
  const [enabled, setEnabled] = useState<Record<string, boolean>>({});
  return (
    <div className="flex flex-col gap-4">
      {d.rules.map((rule) => {
        const on = enabled[rule.id] ?? rule.enabled;
        return (
          <Card
            key={rule.id}
            title={rule.name}
            aside={
              on ? (
                <StatusLabel tone="success">Enabled</StatusLabel>
              ) : (
                <StatusLabel tone="neutral" icon={CirclePause}>
                  Off
                </StatusLabel>
              )
            }
          >
            <dl className="grid gap-x-8 gap-y-3 px-5 py-4 text-13 md:grid-cols-2">
              {(
                [
                  ['Applies to', rule.scope],
                  ['When', rule.condition],
                  ['Then', rule.action],
                  ['Runs', rule.schedule],
                  ['Safety caps', rule.caps],
                  [
                    'Last run',
                    rule.lastRun
                      ? `${formatDateTime(rule.lastRun.at)}, ${String(rule.lastRun.changes)} changes`
                      : 'Never run',
                  ],
                ] as const
              ).map(([k, v]) => (
                <div key={k}>
                  <dt className="text-xs text-ink-muted">{k}</dt>
                  <dd className="mt-0.5">{v}</dd>
                </div>
              ))}
            </dl>
            <div className="flex flex-wrap justify-end gap-2 border-t border-divider px-5 py-3">
              <Button size="sm" variant="ghost">
                Run log
              </Button>
              <Button
                size="sm"
                icon={<FlaskConical />}
                onClick={() => {
                  toast({
                    title: 'Dry run ready',
                    description: 'It would change 12 bids. Nothing was sent.',
                    tone: 'info',
                  });
                }}
              >
                Dry run
              </Button>
              <Button
                size="sm"
                onClick={() => {
                  setEnabled({ ...enabled, [rule.id]: !on });
                }}
              >
                {on ? 'Turn off' : 'Turn on'}
              </Button>
            </div>
          </Card>
        );
      })}
    </div>
  );
}

function Negatives({ d }: { d: AdsOverview }) {
  const toast = useToast();
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [asking, setAsking] = useState(false);
  const n = d.negatives;
  return (
    <Card
      title="Search terms that cost money and sold nothing"
      aside={
        <span className="text-xs text-ink-muted">
          Spend at least {formatPence(n.minSpendPence)} and 0 orders over {n.days} days
        </span>
      }
    >
      {n.items.length === 0 ? (
        <EmptyState
          title="No suggestions"
          body="No search term reached the spend threshold without an order."
        />
      ) : (
        <>
          <SimpleTable
            label="Negative keyword suggestions"
            head={[
              { label: 'Pick' },
              { label: 'Search term' },
              { label: 'Campaign' },
              { label: 'Spend', align: 'right' },
              { label: 'Clicks', align: 'right' },
              { label: 'Orders', align: 'right' },
            ]}
          >
            {n.items.map((s) => (
              <Tr key={s.id}>
                <Td className="w-12">
                  <input
                    type="checkbox"
                    className="size-4"
                    aria-label={`Pick ${s.term}`}
                    checked={picked.has(s.id)}
                    onChange={(e) => {
                      const next = new Set(picked);
                      if (e.target.checked) next.add(s.id);
                      else next.delete(s.id);
                      setPicked(next);
                    }}
                  />
                </Td>
                <Td className="font-medium">{s.term}</Td>
                <Td className="text-ink-muted">{s.campaign}</Td>
                <Td align="right">{formatPence(s.spendPence)}</Td>
                <Td align="right">{s.clicks}</Td>
                <Td align="right">{s.orders}</Td>
              </Tr>
            ))}
          </SimpleTable>
          <div className="flex justify-end gap-2 border-t border-divider px-5 py-3">
            <Button
              variant="primary"
              disabled={picked.size === 0}
              onClick={() => {
                setAsking(true);
              }}
            >
              Add {picked.size > 0 ? String(picked.size) : ''} as exact negatives
            </Button>
          </div>
        </>
      )}
      <ConfirmDialog
        open={asking}
        onOpenChange={setAsking}
        title={`Add ${String(picked.size)} negative keywords?`}
        description="Each term is added as an exact negative to its campaign, so ads stop showing for it. You can remove them later."
        confirmLabel={`Add ${String(picked.size)} negatives`}
        onConfirm={() => {
          setPicked(new Set());
          toast({ title: 'Negatives queued', tone: 'success' });
        }}
      />
    </Card>
  );
}
