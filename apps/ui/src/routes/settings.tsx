import { Link, getRouteApi, useNavigate } from '@tanstack/react-router';
import { KeyRound, LogOut, Monitor, Smartphone } from 'lucide-react';
import { useState } from 'react';
import { useAppState } from '../app/session.tsx';
import { ChannelMark, CompanySwatch } from '../components/badges.tsx';
import { Card, DetailRow, PageHeader, SimpleTable, Stack, Td, Tr } from '../components/Card.tsx';
import { TabGate } from '../components/TabGate.tsx';
import { Badge, StatusLabel } from '../kit/Badge.tsx';
import { Button, buttonClass } from '../kit/Button.tsx';
import { ConfirmDialog } from '../kit/Dialog.tsx';
import { Select } from '../kit/Select.tsx';
import { Tabs } from '../kit/Tabs.tsx';
import { useToast } from '../kit/Toast.tsx';

export type SettingsSection = 'workspace' | 'companies' | 'notifications' | 'stock' | 'security';

export interface SettingsSearch {
  section?: SettingsSection | undefined;
}

const route = getRouteApi('/settings');

export function SettingsPage() {
  return (
    <TabGate tab="admin">
      <Settings />
    </TabGate>
  );
}

function Settings() {
  const search = route.useSearch();
  const navigate = useNavigate({ from: '/settings' });
  const section = search.section ?? 'workspace';
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[1080px] px-4 pt-3 pb-12 lg:px-6">
        <PageHeader title="Settings" />
        <div className="mt-3">
          <Tabs<SettingsSection>
            label="Settings sections"
            value={section}
            onChange={(v) => {
              void navigate({
                search: { section: v === 'workspace' ? undefined : v },
                replace: true,
              });
            }}
            items={[
              { value: 'workspace', label: 'Workspace', content: <Workspace /> },
              { value: 'companies', label: 'Companies', content: <Companies /> },
              { value: 'notifications', label: 'Notifications', content: <Notifications /> },
              { value: 'stock', label: 'Stock sync', content: <StockSync /> },
              { value: 'security', label: 'My account', content: <Security /> },
            ]}
          />
        </div>
      </div>
    </div>
  );
}

function Workspace() {
  const { session } = useAppState();
  return (
    <Card title="Workspace">
      <dl className="px-5 py-1.5">
        <DetailRow label="Name">{session?.workspace}</DetailRow>
        <DetailRow label="Time zone">Europe/London</DetailRow>
        <DetailRow label="Currency">
          <span className="flex items-center justify-end gap-2">
            GBP <Badge>Fixed</Badge>
          </span>
        </DetailRow>
        <DetailRow label="Default VAT rate">20%</DetailRow>
        <DetailRow label="Date format">DD/MM/YYYY</DetailRow>
        <DetailRow label="Customer details kept">
          <Stack
            value={
              <span className="flex items-center justify-end gap-2">
                25 days after delivery <Badge>Fixed</Badge>
              </span>
            }
            sub="Every copy, backups included, is gone by day 30"
          />
        </DetailRow>
      </dl>
    </Card>
  );
}

function Companies() {
  const { session } = useAppState();
  const companies = session?.companies ?? [];
  return (
    <Card title="Companies" aside={<Button size="sm">Add company</Button>}>
      <SimpleTable
        label="Companies"
        head={[
          { label: 'Company' },
          { label: 'VAT period' },
          { label: 'Roles' },
          { label: 'Channel accounts', align: 'right' },
          { label: '' },
        ]}
      >
        {companies.map((c, i) => (
          <Tr key={c.id}>
            <Td>
              <span className="flex items-center gap-2.5">
                <CompanySwatch company={c} />
                <Stack
                  value={<span className="font-medium">{c.tradingName}</span>}
                  sub={`${c.tradingName} Ltd · badge ${c.code}`}
                />
              </span>
            </Td>
            <Td>
              {i === 0 ? (
                <StatusLabel tone="success">Stagger 1, confirmed</StatusLabel>
              ) : (
                <StatusLabel tone="warning">Stagger 1, not confirmed</StatusLabel>
              )}
            </Td>
            <Td className="text-ink-muted">
              {i === 0 ? 'Purchasing and fulfilment' : 'Sells only'}
            </Td>
            <Td align="right">
              {(session?.channelAccounts ?? []).filter((a) => a.companyId === c.id).length}
            </Td>
            <Td>
              <Button size="sm" variant="ghost">
                Edit
              </Button>
            </Td>
          </Tr>
        ))}
      </SimpleTable>
      <p className="border-t border-divider px-5 py-3 text-xs text-ink-muted">
        A channel account cannot move to another company once it has orders. Archive it instead.
      </p>
    </Card>
  );
}

const TYPES: Array<{ type: string; severity: 'Critical' | 'Warning' | 'Info' }> = [
  { type: 'Channel authorisation lost', severity: 'Critical' },
  { type: 'Oversold', severity: 'Critical' },
  { type: 'Tracking not confirmed in 4 hours', severity: 'Critical' },
  { type: 'Account status or seller level change', severity: 'Critical' },
  { type: 'Health metric changed band', severity: 'Warning' },
  { type: 'Stock sync failed or drift', severity: 'Warning' },
  { type: 'Neutral or negative feedback', severity: 'Warning' },
  { type: 'Unpaid bill due or overdue', severity: 'Info' },
  { type: 'Low stock and reorder', severity: 'Info' },
  { type: 'New eBay message', severity: 'Info' },
  { type: 'Reminder due', severity: 'Info' },
];

function Notifications() {
  const toast = useToast();
  const [email, setEmail] = useState<Record<string, boolean>>({});
  return (
    <Card
      title="Email me about"
      aside={<span className="text-xs text-ink-muted">Everything also appears under the bell</span>}
    >
      <SimpleTable
        label="Notification emails"
        head={[{ label: 'Type' }, { label: 'Severity' }, { label: 'Email' }]}
      >
        {TYPES.map((t) => {
          const locked = t.severity === 'Critical';
          const on = locked || (email[t.type] ?? t.severity === 'Warning');
          return (
            <Tr key={t.type}>
              <Td className="font-medium">{t.type}</Td>
              <Td>
                <StatusLabel
                  tone={
                    t.severity === 'Critical'
                      ? 'danger'
                      : t.severity === 'Warning'
                        ? 'warning'
                        : 'info'
                  }
                >
                  {t.severity}
                </StatusLabel>
              </Td>
              <Td>
                <label className="flex items-center gap-2 text-13">
                  <input
                    type="checkbox"
                    className="size-4"
                    checked={on}
                    disabled={locked}
                    onChange={(e) => {
                      setEmail({ ...email, [t.type]: e.target.checked });
                      toast({
                        title: e.target.checked ? 'Emails on' : 'Emails off',
                        description: t.type,
                        tone: 'success',
                      });
                    }}
                  />
                  {locked ? 'Always on for admins' : on ? 'On' : 'Off'}
                </label>
              </Td>
            </Tr>
          );
        })}
      </SimpleTable>
    </Card>
  );
}

const BUFFERS = ['0', '1', '2', '3', '5'].map((v) => ({
  value: v,
  label: v === '0' ? 'No buffer' : `${v} units`,
}));

function StockSync() {
  const { session, company } = useAppState();
  const [buffer, setBuffer] = useState<Record<string, string>>({});
  return (
    <Card title="Safety buffer per channel account">
      <SimpleTable
        label="Safety buffers"
        head={[
          { label: 'Channel account' },
          { label: 'Default buffer' },
          { label: 'Pushed quantity' },
        ]}
      >
        {(session?.channelAccounts ?? []).map((a) => {
          const c = company(a.companyId);
          const v = buffer[a.id] ?? (a.channel === 'ebay' ? '1' : '0');
          return (
            <Tr key={a.id}>
              <Td>
                <span className="grid grid-cols-[18px_minmax(0,1fr)] items-center gap-x-2 gap-y-1">
                  <ChannelMark channel={a.channel} />
                  {c && (
                    <>
                      <span aria-hidden className="grid place-items-center">
                        <CompanySwatch company={c} />
                      </span>
                      <span className="truncate text-xs text-ink-muted">{a.name}</span>
                    </>
                  )}
                </span>
              </Td>
              <Td className="w-48">
                <Select
                  label={`Safety buffer for ${a.name}`}
                  options={BUFFERS}
                  value={v}
                  onChange={(x) => {
                    setBuffer({ ...buffer, [a.id]: x ?? '0' });
                  }}
                />
              </Td>
              <Td className="text-ink-muted">Available − {v}, never below 0</Td>
            </Tr>
          );
        })}
      </SimpleTable>
      <p className="border-t border-divider px-5 py-3 text-xs text-ink-muted">
        A listing can override its account’s buffer from the SKU page. FBA listings are never
        pushed.
      </p>
    </Card>
  );
}

function Security() {
  const { session } = useAppState();
  const toast = useToast();
  const [asking, setAsking] = useState(false);
  return (
    <div className="flex flex-col gap-5">
      <Card title="Sign-in">
        <dl className="px-5 py-1.5">
          <DetailRow label="Email">{session?.user.email}</DetailRow>
          <DetailRow label="Password">
            <span className="flex items-center justify-end gap-3">
              <span className="text-ink-muted">Changed 02/11/2025, expires 02/11/2026</span>
              <Link to="/sign-in/password-change" className={buttonClass('secondary', 'sm')}>
                <KeyRound className="size-4" aria-hidden /> Change password
              </Link>
            </span>
          </DetailRow>
          <DetailRow label="Two-step sign-in">
            <StatusLabel tone="success">Authenticator app, 8 recovery codes left</StatusLabel>
          </DetailRow>
        </dl>
      </Card>
      <Card
        title="Where you are signed in"
        aside={
          <Button
            size="sm"
            variant="danger"
            icon={<LogOut />}
            onClick={() => {
              setAsking(true);
            }}
          >
            Sign out everywhere
          </Button>
        }
      >
        <ul>
          {[
            { icon: Monitor, name: 'Windows · Chrome', where: 'This device', at: 'Now' },
            { icon: Smartphone, name: 'iPad · Safari', where: 'Shipping desk', at: 'Today, 08:12' },
          ].map((d) => (
            <li
              key={d.name}
              className="flex items-center gap-3 border-b border-divider px-5 py-3 text-13 last:border-0"
            >
              <d.icon className="size-4 text-ink-muted" aria-hidden />
              <span className="flex-1">
                <span className="font-medium">{d.name}</span>
                <span className="block text-xs text-ink-muted">{d.where}</span>
              </span>
              <span className="num text-ink-muted">{d.at}</span>
            </li>
          ))}
        </ul>
        <p className="border-t border-divider px-5 py-3 text-xs text-ink-muted">
          Sessions end after 30 minutes without use, and after 12 hours at most.
        </p>
      </Card>
      <ConfirmDialog
        open={asking}
        onOpenChange={setAsking}
        destructive
        title="Sign out on every device?"
        description="Every session ends at once, including this one. You will need your password and authenticator code to sign in again."
        confirmLabel="Sign out everywhere"
        onConfirm={() => {
          toast({ title: 'Signed out everywhere (mock)', tone: 'success' });
        }}
      />
    </div>
  );
}
