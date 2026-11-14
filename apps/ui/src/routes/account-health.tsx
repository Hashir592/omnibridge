import { useQuery } from '@tanstack/react-query';
import { getRouteApi, useNavigate } from '@tanstack/react-router';
import { CircleCheck, OctagonAlert, Settings2, TriangleAlert, type LucideIcon } from 'lucide-react';
import { useAppState } from '../app/session.tsx';
import { CompanySwatch } from '../components/badges.tsx';
import { Card, PageHeader, SimpleTable, Td, Tr } from '../components/Card.tsx';
import { TabGate } from '../components/TabGate.tsx';
import { SignalLabel, StatusLabel, type StatusTone } from '../kit/Badge.tsx';
import { Button } from '../kit/Button.tsx';
import { Tabs } from '../kit/Tabs.tsx';
import { EmptyState, ErrorState } from '../kit/states.tsx';
import { formatDate } from '../lib/format.ts';
import { mockApi } from '../mocks/api.ts';
import type { AmazonHealth, Band, EbayHealth } from '../mocks/health.ts';

export interface HealthSearch {
  market?: 'amazon' | 'ebay' | undefined;
}

const route = getRouteApi('/account-health');

const BAND: Record<Band, { label: string; tone: StatusTone; icon: LucideIcon }> = {
  good: { label: 'Good', tone: 'success', icon: CircleCheck },
  at_risk: { label: 'At risk', tone: 'warning', icon: TriangleAlert },
  critical: { label: 'Critical', tone: 'danger', icon: OctagonAlert },
};

function BandLabel({ band, label }: { band: Band; label?: string | undefined }) {
  const b = BAND[band];
  return (
    <StatusLabel tone={b.tone} icon={b.icon}>
      {label ?? b.label}
    </StatusLabel>
  );
}

/** HLT-5: data age on every card, "Updated 3 h ago". */
function age(iso: string): string {
  const mins = Math.max(1, Math.round((Date.now() - Date.parse(iso)) / 60_000));
  if (mins < 60) return `Updated ${String(mins)} min ago`;
  const h = Math.round(mins / 60);
  return h < 48 ? `Updated ${String(h)} h ago` : `Updated ${String(Math.round(h / 24))} days ago`;
}

export function AccountHealthPage() {
  return (
    <TabGate tab="account_health">
      <AccountHealth />
    </TabGate>
  );
}

function AccountHealth() {
  const search = route.useSearch();
  const navigate = useNavigate({ from: '/account-health' });
  const market = search.market ?? 'amazon';
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[1280px] px-4 pt-3 pb-12 lg:px-6">
        <PageHeader
          title="Account Health"
          sub="Amazon and eBay are measured differently, so each has its own screen."
          actions={<Button icon={<Settings2 />}>Edit thresholds</Button>}
        />
        <div className="mt-3">
          <Tabs<'amazon' | 'ebay'>
            label="Marketplace"
            value={market}
            onChange={(v) => {
              void navigate({ search: { market: v === 'amazon' ? undefined : v }, replace: true });
            }}
            items={[
              { value: 'amazon', label: 'Amazon', content: <AmazonScreen /> },
              { value: 'ebay', label: 'eBay', content: <EbayScreen /> },
            ]}
          />
        </div>
      </div>
    </div>
  );
}

function useAccount(id: string) {
  const { session, company } = useAppState();
  const a = session?.channelAccounts.find((x) => x.id === id);
  return { account: a, company: a ? company(a.companyId) : undefined };
}

function AccountTitle({ id }: { id: string }) {
  const { account, company } = useAccount(id);
  return (
    <span className="flex items-center gap-2">
      {company && <CompanySwatch company={company} />}
      {account?.name}
    </span>
  );
}

function Failed({ retry }: { retry: () => void }) {
  return (
    <Card>
      <ErrorState
        title="Health figures could not load"
        body="The server did not answer. Try again; if it keeps failing, check Status."
        action={{ label: 'Try again', onClick: retry }}
      />
    </Card>
  );
}

function AmazonScreen() {
  const { session, persona, companyId } = useAppState();
  const q = useQuery({
    queryKey: ['health-amazon', persona, companyId],
    queryFn: () => mockApi.amazonHealth(companyId),
    enabled: !!session,
  });
  if (q.isError) return <Failed retry={() => void q.refetch()} />;
  if (!q.data) return <div aria-busy className="h-80" />;
  if (q.data.length === 0)
    return (
      <Card>
        <EmptyState
          title="No Amazon accounts for this company"
          body="Connect an Amazon account in Connections, or switch to Combined."
        />
      </Card>
    );
  return (
    <div className="flex flex-col gap-5">
      {q.data.map((h) => (
        <AmazonCard key={h.channelAccountId} h={h} />
      ))}
    </div>
  );
}

function AmazonCard({ h }: { h: AmazonHealth }) {
  return (
    <Card
      title={<AccountTitle id={h.channelAccountId} />}
      aside={<span className="num text-xs text-ink-muted">{age(h.updatedAt)}</span>}
    >
      <div className="flex flex-wrap items-center gap-x-8 gap-y-2 border-b border-divider px-5 py-3.5 text-13">
        <span className="flex items-center gap-2">
          <span className="text-ink-muted">Account status</span>
          {h.accountStatus === 'normal' ? (
            <StatusLabel tone="success">Normal</StatusLabel>
          ) : h.accountStatus === 'at_risk' ? (
            <StatusLabel tone="warning">At risk</StatusLabel>
          ) : (
            <StatusLabel tone="danger">Deactivated</StatusLabel>
          )}
        </span>
        {h.rating && (
          <span className="flex items-center gap-2">
            <span className="text-ink-muted">Account health rating</span>
            <span className="num font-semibold">{h.rating.score}</span>
            <BandLabel
              band={h.rating.band}
              label={h.rating.band === 'good' ? 'Healthy' : undefined}
            />
          </span>
        )}
        <SignalLabel signal="Native" title="Straight from Amazon's report" />
      </div>
      <SimpleTable
        label="Amazon metrics"
        head={[
          { label: 'Metric' },
          { label: 'Value', align: 'right' },
          { label: 'Target' },
          { label: 'Period' },
          { label: 'Band' },
        ]}
      >
        {h.metrics.map((m) => (
          <Tr key={m.key}>
            <Td className="font-medium">{m.label}</Td>
            <Td align="right">
              <span className="font-semibold">{m.value}</span>
            </Td>
            <Td className="text-ink-muted">{m.target}</Td>
            <Td className="text-ink-muted">{m.period}</Td>
            <Td>
              <BandLabel band={m.band} />
            </Td>
          </Tr>
        ))}
      </SimpleTable>
    </Card>
  );
}

function EbayScreen() {
  const { session, persona, companyId } = useAppState();
  const q = useQuery({
    queryKey: ['health-ebay', persona, companyId],
    queryFn: () => mockApi.ebayHealth(companyId),
    enabled: !!session,
  });
  if (q.isError) return <Failed retry={() => void q.refetch()} />;
  if (!q.data) return <div aria-busy className="h-80" />;
  if (q.data.length === 0)
    return (
      <Card>
        <EmptyState
          title="No eBay accounts for this company"
          body="Connect an eBay account in Connections, or switch to Combined."
        />
      </Card>
    );
  return (
    <div className="flex flex-col gap-5">
      {q.data.map((h) => (
        <EbayCard key={h.channelAccountId} h={h} />
      ))}
    </div>
  );
}

function EbayCard({ h }: { h: EbayHealth }) {
  return (
    <Card
      title={<AccountTitle id={h.channelAccountId} />}
      aside={<span className="num text-xs text-ink-muted">{age(h.updatedAt)}</span>}
    >
      <div className="flex flex-wrap items-center gap-x-8 gap-y-2 border-b border-divider px-5 py-3.5 text-13">
        <span className="flex items-center gap-2">
          <span className="text-ink-muted">Seller level</span>
          <span className="font-semibold">{h.sellerLevel.current}</span>
        </span>
        <span className="flex items-center gap-2">
          <span className="text-ink-muted">Projected</span>
          <span className="font-medium">{h.sellerLevel.projected}</span>
        </span>
        <span className="num flex items-center gap-2">
          <span className="text-ink-muted">Next evaluation</span>
          {formatDate(h.evaluation.next)}
        </span>
        <SignalLabel signal="Native" title="eBay's own values; no composite score" />
      </div>
      <SimpleTable
        label="eBay metrics"
        head={[
          { label: 'Metric' },
          { label: 'Current', align: 'right' },
          { label: 'Projected', align: 'right' },
          { label: 'Threshold' },
        ]}
      >
        {h.metrics.map((m) => (
          <Tr key={m.key}>
            <Td className="font-medium">{m.label}</Td>
            <Td align="right">
              <span className="flex flex-col items-end">
                <span className="font-semibold">{m.current}</span>
                <BandLabel band={m.currentBand} />
              </span>
            </Td>
            <Td align="right">
              <span className="flex flex-col items-end">
                <span className="font-semibold">{m.projected}</span>
                <BandLabel band={m.projectedBand} />
              </span>
            </Td>
            <Td className="text-ink-muted">{m.threshold}</Td>
          </Tr>
        ))}
      </SimpleTable>
      <p className="border-t border-divider px-5 py-3 text-xs text-ink-muted">
        Evaluation window: {h.evaluation.window}.
      </p>
    </Card>
  );
}
