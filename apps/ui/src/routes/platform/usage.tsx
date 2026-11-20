import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { platformApi } from '../../auth/api.ts';
import { Card, SimpleTable, Stack, Td, Tr } from '../../components/Card.tsx';
import { StatusLabel } from '../../kit/Badge.tsx';
import { Select } from '../../kit/Select.tsx';
import { EmptyState } from '../../kit/states.tsx';
import { addDays, formatUkDate, todayLondon } from '../../lib/dates.ts';
import { formatDateTime, formatInt } from '../../lib/format.ts';
import { CONSOLE, ConsoleFailure, Loading } from './parts.tsx';
import { capShare, daysUntil, SECRET_LABEL } from './rules.ts';
import { useWorkspaceNames } from './workspaces.tsx';

const RANGES = [
  { value: '7', label: 'Last 7 days' },
  { value: '30', label: 'Last 30 days' },
  { value: '92', label: 'Last 92 days' },
];

const PROVIDER: Record<string, string> = { amazon: 'Amazon', ads: 'Amazon Ads', ebay: 'eBay' };

/** PLAT-2: API calls per provider, API and account, per the provider's own day, against the cap. */
export function UsageSection() {
  const name = useWorkspaceNames();
  const [days, setDays] = useState('7');
  const to = todayLondon();
  const from = addDays(to, 1 - Number(days));
  const usage = useQuery({
    queryKey: [CONSOLE, 'api-usage', from, to],
    queryFn: () => platformApi.apiUsage(from, to),
  });

  return (
    <Card
      title="API usage"
      aside={
        <>
          <span className="hidden text-xs text-ink-muted sm:inline">
            eBay days run on US Pacific time
          </span>
          <Select
            label="Period"
            className="w-40"
            options={RANGES}
            value={days}
            onChange={(v) => {
              if (v) setDays(v);
            }}
          />
        </>
      }
    >
      {usage.isError ? (
        <ConsoleFailure error={usage.error} retry={() => void usage.refetch()} />
      ) : usage.isPending ? (
        <Loading />
      ) : usage.data.length === 0 ? (
        <EmptyState
          title="No API calls in this period"
          body="Calls are counted once channel accounts are connected."
        />
      ) : (
        <SimpleTable
          label="API usage"
          head={[
            { label: 'Day' },
            { label: 'Workspace' },
            { label: 'Provider and API' },
            { label: 'Calls', align: 'right' },
            { label: 'Daily cap', align: 'right' },
            { label: 'Used', align: 'right' },
          ]}
        >
          {usage.data.map((u) => {
            const share = capShare(u.calls, u.cap);
            return (
              <Tr key={`${u.channel_account_id}-${u.api}-${u.day}`}>
                <Td className="num whitespace-nowrap">{formatUkDate(u.day)}</Td>
                <Td>
                  <Stack
                    value={name(u.workspace_id)}
                    sub={`Account ${u.channel_account_id.slice(0, 8)}`}
                  />
                </Td>
                <Td>
                  <Stack
                    value={PROVIDER[u.provider] ?? u.provider}
                    sub={<span className="font-mono">{u.api}</span>}
                  />
                </Td>
                <Td align="right">{formatInt(u.calls)}</Td>
                <Td align="right">
                  {u.cap === null ? <span className="text-ink-muted">None</span> : formatInt(u.cap)}
                </Td>
                <Td align="right">
                  {share === null ? (
                    <span className="text-ink-muted">–</span>
                  ) : share >= 80 ? (
                    <StatusLabel tone={share >= 100 ? 'danger' : 'warning'}>
                      {`${String(share)}%`}
                    </StatusLabel>
                  ) : (
                    `${String(share)}%`
                  )}
                </Td>
              </Tr>
            );
          })}
        </SimpleTable>
      )}
    </Card>
  );
}

const WITHIN = [
  { value: '30', label: 'Next 30 days' },
  { value: '90', label: 'Next 90 days' },
  { value: '365', label: 'Next 365 days' },
];

const KIND_LABEL: Record<string, string> = {
  'ebay.refresh_token': 'eBay refresh token',
  'ads.refresh_token': 'Amazon Ads refresh token',
  'amazon.refresh_token': 'Amazon refresh token',
};

/**
 * PLAT-2: what expires soon, never a value. A row with no workspace is an app secret of the
 * platform itself (PS-033), such as Amazon's LWA client secret, 180 days after it was set.
 */
export function CredentialsSection() {
  const name = useWorkspaceNames();
  const [within, setWithin] = useState('30');
  const list = useQuery({
    queryKey: [CONSOLE, 'credential-expiry', within],
    queryFn: () => platformApi.credentialExpiry(Number(within)),
  });

  return (
    <Card
      title="Credential calendar"
      aside={
        <Select
          label="Expiring within"
          className="w-40"
          options={WITHIN}
          value={within}
          onChange={(v) => {
            if (v) setWithin(v);
          }}
        />
      }
    >
      {list.isError ? (
        <ConsoleFailure error={list.error} retry={() => void list.refetch()} />
      ) : list.isPending ? (
        <Loading />
      ) : list.data.length === 0 ? (
        <EmptyState
          title="Nothing expires in this period"
          body="Choose a longer period to look further ahead."
        />
      ) : (
        <SimpleTable
          label="Credential calendar"
          head={[
            { label: 'Expires' },
            { label: 'Credential' },
            { label: 'Belongs to' },
            { label: 'Slot' },
          ]}
        >
          {list.data.map((c) => {
            const left = daysUntil(c.expires_at);
            return (
              <Tr key={`${c.kind}-${c.channel_account_id ?? 'app'}-${c.slot}`}>
                <Td className="whitespace-nowrap">
                  <Stack
                    value={
                      <StatusLabel tone={left < 0 ? 'danger' : left <= 14 ? 'warning' : 'neutral'}>
                        {formatDateTime(c.expires_at)}
                      </StatusLabel>
                    }
                    sub={
                      left < 0
                        ? 'Expired'
                        : left === 0
                          ? 'Today'
                          : `In ${String(left)} ${left === 1 ? 'day' : 'days'}`
                    }
                  />
                </Td>
                <Td>
                  <Stack
                    value={SECRET_LABEL[c.kind] ?? KIND_LABEL[c.kind] ?? c.kind}
                    sub={<span className="font-mono">{c.kind}</span>}
                  />
                </Td>
                <Td>
                  {c.workspace_id === null ? (
                    <Stack value="Platform" sub="App secret" />
                  ) : (
                    <Stack
                      value={name(c.workspace_id)}
                      sub={
                        c.channel_account_id
                          ? `Account ${c.channel_account_id.slice(0, 8)}`
                          : undefined
                      }
                    />
                  )}
                </Td>
                <Td>{c.slot === 'current' ? 'Current' : 'Next'}</Td>
              </Tr>
            );
          })}
        </SimpleTable>
      )}
    </Card>
  );
}
