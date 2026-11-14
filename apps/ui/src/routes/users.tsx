import { useQuery } from '@tanstack/react-query';
import { Link, getRouteApi, useNavigate } from '@tanstack/react-router';
import {
  ChevronLeft,
  CircleAlert,
  KeyRound,
  Lock,
  Mail,
  ShieldCheck,
  ShieldOff,
  UserPlus,
} from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { useAppState } from '../app/session.tsx';
import { CompanySwatch } from '../components/badges.tsx';
import { Card, PageHeader, SimpleTable, Stack, Td, Tr } from '../components/Card.tsx';
import { TabGate } from '../components/TabGate.tsx';
import { Badge, StatusLabel } from '../kit/Badge.tsx';
import { Button } from '../kit/Button.tsx';
import { ConfirmDialog, Dialog } from '../kit/Dialog.tsx';
import { Field, Input } from '../kit/Field.tsx';
import { EmptyState, ErrorState } from '../kit/states.tsx';
import { useToast } from '../kit/Toast.tsx';
import { cn } from '../lib/cn.ts';
import { formatDate, formatTime } from '../lib/format.ts';
import { TICKABLE_TABS, type WorkspaceUser } from '../mocks/admin.ts';
import { mockApi } from '../mocks/api.ts';
import type { Tab } from '../mocks/types.ts';

const ADMIN_TABS = ['Connections', 'Users', 'Settings', 'Audit Log'];

function lastSeen(iso: string | null): string {
  if (!iso) return 'Never signed in';
  const d = Math.floor((Date.now() - Date.parse(iso)) / 86_400_000);
  return d === 0
    ? `Today, ${formatTime(iso)}`
    : d === 1
      ? `Yesterday, ${formatTime(iso)}`
      : formatDate(iso);
}

function UserState({ u }: { u: WorkspaceUser }) {
  if (u.state === 'locked')
    return (
      <StatusLabel tone="danger" icon={Lock}>
        Locked
      </StatusLabel>
    );
  if (u.state === 'invited')
    return (
      <StatusLabel tone="info" icon={Mail}>
        Invited until {u.inviteExpiresAt ? formatDate(u.inviteExpiresAt) : ''}
      </StatusLabel>
    );
  return <StatusLabel tone="success">Active</StatusLabel>;
}

export function UsersPage() {
  return (
    <TabGate tab="admin">
      <UsersList />
    </TabGate>
  );
}

function UsersList() {
  const { session, persona, company } = useAppState();
  const [inviting, setInviting] = useState(false);
  const q = useQuery({ queryKey: ['users', persona], queryFn: mockApi.users, enabled: !!session });
  const total = session?.companies.length ?? 0;

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[1280px] px-4 pt-3 pb-12 lg:px-6">
        <PageHeader
          title="Users"
          sub="Admins see everything. Each child user sees only the tabs and companies ticked for them."
          actions={
            <Button
              variant="primary"
              icon={<UserPlus />}
              onClick={() => {
                setInviting(true);
              }}
            >
              Invite user
            </Button>
          }
        />
        <Card className="mt-5">
          {q.isError ? (
            <ErrorState
              title="Users could not load"
              body="The server did not answer. Try again; if it keeps failing, check Status."
              action={{ label: 'Try again', onClick: () => void q.refetch() }}
            />
          ) : !q.data ? (
            <div aria-busy className="h-64" />
          ) : q.data.length === 0 ? (
            <EmptyState title="No users yet" body="Invite the people who work in this workspace." />
          ) : (
            <SimpleTable
              label="Users"
              head={[
                { label: 'Name' },
                { label: 'Role' },
                { label: 'Tabs' },
                { label: 'Companies' },
                { label: 'Two-step sign-in' },
                { label: 'Last sign-in' },
                { label: 'Status' },
              ]}
            >
              {q.data.map((u) => {
                const admin = u.role === 'admin';
                return (
                  <Tr key={u.id} className="hover:bg-hover">
                    <Td>
                      <Stack
                        value={
                          <Link
                            to="/users/$userId"
                            params={{ userId: u.id }}
                            className="font-medium text-ink hover:text-brand-600 hover:underline"
                          >
                            {u.name}
                          </Link>
                        }
                        sub={u.email}
                      />
                    </Td>
                    <Td>{admin ? 'Admin' : 'Child'}</Td>
                    <Td className="max-w-[240px]">
                      <Stack
                        value={
                          admin
                            ? 'All tabs'
                            : `${String(u.tabs.length)} of ${String(TICKABLE_TABS.length)}`
                        }
                        sub={
                          admin
                            ? 'Including admin pages'
                            : u.tabs.length === 0
                              ? 'None yet'
                              : TICKABLE_TABS.filter((t) => u.tabs.includes(t.key))
                                  .map((t) => t.label)
                                  .join(', ')
                        }
                      />
                    </Td>
                    <Td className="whitespace-nowrap">
                      {admin ? (
                        'All companies'
                      ) : u.companyIds.length === 0 ? (
                        <span className="text-ink-muted">None yet</span>
                      ) : (
                        <span className="flex items-center gap-2">
                          <span className="flex gap-1">
                            {u.companyIds.map((id) => {
                              const c = company(id);
                              return c ? <CompanySwatch key={id} company={c} /> : null;
                            })}
                          </span>
                          <span className="num">
                            {u.companyIds.length} of {total}
                          </span>
                        </span>
                      )}
                    </Td>
                    <Td>
                      {u.mfa ? (
                        <StatusLabel tone="success" icon={ShieldCheck}>
                          On
                        </StatusLabel>
                      ) : (
                        <StatusLabel tone="neutral" icon={ShieldOff}>
                          Not set up yet
                        </StatusLabel>
                      )}
                    </Td>
                    <Td className="num whitespace-nowrap text-ink-muted">
                      {lastSeen(u.lastSignInAt)}
                    </Td>
                    <Td>
                      <UserState u={u} />
                    </Td>
                  </Tr>
                );
              })}
            </SimpleTable>
          )}
        </Card>
        <p className="mt-3 text-xs text-ink-muted">
          Admin-only pages ({ADMIN_TABS.join(', ')}) cannot be ticked for a child user.
        </p>
      </div>
      {inviting && <InviteDialog open onOpenChange={setInviting} />}
    </div>
  );
}

function InviteDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const toast = useToast();
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [tried, setTried] = useState(false);
  const emailError = !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)
    ? 'Enter an email address, for example name@example.com'
    : undefined;
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Invite a user"
      description="The invite link works once and expires after 72 hours. A new child user starts with no tabs and no companies; tick them after inviting."
      footer={
        <>
          <Button
            onClick={() => {
              onOpenChange(false);
            }}
          >
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              setTried(true);
              if (emailError) return;
              onOpenChange(false);
              toast({
                title: 'Invite sent',
                description: `${email} has 72 hours to accept.`,
                tone: 'success',
              });
            }}
          >
            Send invite
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="Name">
          <Input value={name} onChange={setName} autoComplete="off" />
        </Field>
        <Field label="Email" required error={tried ? emailError : undefined}>
          <Input value={email} onChange={setEmail} type="email" autoComplete="off" />
        </Field>
      </div>
    </Dialog>
  );
}

/* ---------- one user: role, tab ticks and company ticks (PERM-1..7) ---------- */

const userRoute = getRouteApi('/users/$userId');

export function UserDetailPage() {
  return (
    <TabGate tab="admin">
      <UserDetail />
    </TabGate>
  );
}

function UserDetail() {
  const { userId } = userRoute.useParams();
  const { session, persona } = useAppState();
  const q = useQuery({ queryKey: ['users', persona], queryFn: mockApi.users, enabled: !!session });
  const u = q.data?.find((x) => x.id === userId);
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[960px] px-4 pt-3 pb-12 lg:px-6">
        <Link
          to="/users"
          className="-ml-1 inline-flex h-8 items-center gap-1 rounded-ctl px-1 text-13 text-ink-muted hover:text-ink"
        >
          <ChevronLeft className="size-4" aria-hidden /> Back to users
        </Link>
        {q.data && !u ? (
          <Card className="mt-4">
            <EmptyState
              title="This user is not in the workspace"
              body="They may have been removed. Go back to the list."
            />
          </Card>
        ) : u && q.data ? (
          <UserForm u={u} admins={q.data.filter((x) => x.role === 'admin').length} />
        ) : (
          <div aria-busy className="mt-4 h-64" />
        )}
      </div>
    </div>
  );
}

function Tick({
  checked,
  disabled,
  onChange,
  children,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: (v: boolean) => void;
  children: ReactNode;
}) {
  return (
    <label
      className={cn(
        'flex h-10 items-center gap-2.5 rounded-ctl border px-3 text-13',
        checked ? 'border-[#c3c8d0] bg-selected' : 'border-border bg-card hover:bg-hover',
        disabled && 'pointer-events-none opacity-60',
      )}
    >
      <input
        type="checkbox"
        className="size-4"
        checked={checked}
        disabled={disabled}
        onChange={(e) => {
          onChange(e.target.checked);
        }}
      />
      {children}
    </label>
  );
}

function UserForm({ u, admins }: { u: WorkspaceUser; admins: number }) {
  const { session } = useAppState();
  const toast = useToast();
  const navigate = useNavigate();
  const [role, setRole] = useState(u.role);
  const [tabs, setTabs] = useState<Set<Tab>>(new Set(u.tabs));
  const [companies, setCompanies] = useState<Set<string>>(new Set(u.companyIds));
  const [removing, setRemoving] = useState(false);
  useEffect(() => {
    setRole(u.role);
    setTabs(new Set(u.tabs));
    setCompanies(new Set(u.companyIds));
  }, [u]);
  const admin = role === 'admin';
  // PERM-7: the last admin cannot be demoted or removed.
  const lastAdmin = u.role === 'admin' && admins <= 1;
  const demoteError =
    lastAdmin && role !== 'admin'
      ? 'This is the only admin. Make another user an admin first, then change this role.'
      : undefined;
  const toggle = <T,>(set: Set<T>, v: T, on: boolean) => {
    const n = new Set(set);
    if (on) n.add(v);
    else n.delete(v);
    return n;
  };
  const allCompanies = session?.companies ?? [];

  return (
    <>
      <div className="mt-2 flex flex-wrap items-start gap-x-6 gap-y-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-[22px] leading-7 font-semibold tracking-[-0.015em]">{u.name}</h1>
            <UserState u={u} />
          </div>
          <p className="mt-0.5 text-13 text-ink-muted">
            {u.email} · Last sign-in {lastSeen(u.lastSignInAt).toLowerCase()}
          </p>
        </div>
        <div className="ml-auto flex flex-wrap gap-2">
          {u.state === 'locked' && <Button icon={<KeyRound />}>Unlock and send reset link</Button>}
          {u.state === 'invited' && <Button icon={<Mail />}>Resend invite</Button>}
          <Button
            variant="danger"
            disabled={lastAdmin}
            title={lastAdmin ? 'The only admin cannot be removed' : undefined}
            onClick={() => {
              setRemoving(true);
            }}
          >
            Remove user
          </Button>
        </div>
      </div>

      <Card title="Role" className="mt-5">
        <fieldset className="flex flex-col gap-3 px-5 py-4">
          <legend className="sr-only">Role</legend>
          {(
            [
              [
                'admin',
                'Admin',
                'Every tab and company, settings, users, connections, finance edits and deletes.',
              ],
              [
                'child',
                'Child',
                'Only the tabs and companies ticked below, including in Combined view, search, exports and notifications.',
              ],
            ] as const
          ).map(([value, label, sub]) => (
            <label key={value} className="flex items-start gap-3 text-13">
              <input
                type="radio"
                name="role"
                value={value}
                checked={role === value}
                onChange={() => {
                  setRole(value);
                }}
                className="mt-0.5 size-4 accent-[var(--color-side)]"
              />
              <span>
                <span className="font-medium">{label}</span>
                <span className="block text-ink-muted">{sub}</span>
              </span>
            </label>
          ))}
          {demoteError && (
            <p className="flex items-center gap-1.5 text-13 font-medium text-danger" role="alert">
              <CircleAlert className="size-4 shrink-0" aria-hidden />
              {demoteError}
            </p>
          )}
        </fieldset>
      </Card>

      <Card
        title="Tabs this user can see"
        className="mt-5"
        aside={
          admin ? (
            <Badge>Admins see every tab</Badge>
          ) : (
            <span className="num text-ink-muted">
              {tabs.size} of {TICKABLE_TABS.length} ticked
            </span>
          )
        }
      >
        <fieldset className="px-5 py-4">
          <legend className="sr-only">Tabs</legend>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {TICKABLE_TABS.map((t) => (
              <Tick
                key={t.key}
                checked={admin || tabs.has(t.key)}
                disabled={admin}
                onChange={(on) => {
                  setTabs(toggle(tabs, t.key, on));
                }}
              >
                {t.label}
              </Tick>
            ))}
          </div>
          <p className="mt-3 text-xs text-ink-muted">
            {ADMIN_TABS.join(', ')} are admin-only and cannot be ticked.
          </p>
        </fieldset>
      </Card>

      <Card
        title="Companies this user can see"
        className="mt-5"
        aside={
          admin ? (
            <Badge>Admins see every company</Badge>
          ) : (
            <span className="num text-ink-muted">
              {companies.size} of {allCompanies.length} ticked
            </span>
          )
        }
      >
        <fieldset className="px-5 py-4">
          <legend className="sr-only">Companies</legend>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {allCompanies.map((c) => (
              <Tick
                key={c.id}
                checked={admin || companies.has(c.id)}
                disabled={admin}
                onChange={(on) => {
                  setCompanies(toggle(companies, c.id, on));
                }}
              >
                <CompanySwatch company={c} />
                {c.tradingName}
              </Tick>
            ))}
          </div>
          {!admin && (tabs.size === 0 || companies.size === 0) && (
            <p className="mt-3 flex items-center gap-1.5 text-13 text-ink-muted">
              <CircleAlert className="size-4 shrink-0" aria-hidden />
              With no {tabs.size === 0 ? 'tabs' : 'companies'} ticked, this user sees nothing after
              signing in.
            </p>
          )}
        </fieldset>
      </Card>

      <div className="mt-5 flex justify-end gap-2">
        <Button
          onClick={() => {
            void navigate({ to: '/users' });
          }}
        >
          Cancel
        </Button>
        <Button
          variant="primary"
          disabled={!!demoteError}
          onClick={() => {
            toast({
              title: 'Access saved',
              description:
                'The change applies to the next page this user opens, and is in the audit log.',
              tone: 'success',
            });
          }}
        >
          Save access
        </Button>
      </div>

      <ConfirmDialog
        open={removing}
        onOpenChange={setRemoving}
        destructive
        title={`Remove ${u.name}?`}
        description="They are signed out everywhere at once and can no longer sign in to this workspace. Their past actions stay in the audit log."
        confirmLabel={`Remove ${u.name}`}
        onConfirm={() => {
          toast({ title: 'User removed', tone: 'success' });
          void navigate({ to: '/users' });
        }}
      />
    </>
  );
}
