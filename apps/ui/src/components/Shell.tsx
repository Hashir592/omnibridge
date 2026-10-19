import { Dialog } from '@base-ui/react/dialog';
import { Menu } from '@base-ui/react/menu';
import { Popover } from '@base-ui/react/popover';
import { useQuery } from '@tanstack/react-query';
import { Link, Outlet, useNavigate } from '@tanstack/react-router';
import { Bell, Check, ChevronsUpDown, Menu as MenuIcon, Search, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useAppState } from '../app/session.tsx';
import { NAV, type NavItem } from '../app/nav.ts';
import { cn } from '../lib/cn.ts';
import { formatInt } from '../lib/format.ts';
import { mockApi } from '../mocks/api.ts';
import { CompanySwatch } from './badges.tsx';

function useVisibleNav(): { main: NavItem[]; admin: NavItem[] } {
  const { session } = useAppState();
  return useMemo(() => {
    if (!session) return { main: [], admin: [] };
    const tabs = new Set<string>(session.tabs);
    return {
      // PERM-3: a child sees only the tabs the admin ticked; admin-only tabs need admin (PERM-4).
      main: NAV.filter((n) => !n.adminOnly && tabs.has(n.key)),
      admin: session.user.isAdmin ? NAV.filter((n) => n.adminOnly) : [],
    };
  }, [session]);
}

const popup =
  'min-w-56 rounded-card border border-border bg-card p-1.5 text-sm text-ink shadow-pop outline-none';
const menuItem =
  'flex h-8 cursor-default items-center gap-2 rounded-[6px] px-2 outline-none select-none data-[highlighted]:bg-hover';

export function Shell() {
  const [drawer, setDrawer] = useState(false);
  const [palette, setPalette] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPalette(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, []);

  return (
    <div className="flex h-dvh overflow-hidden">
      <Sidebar className="hidden lg:flex" />
      {drawer && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <button
            aria-label="Close menu"
            className="absolute inset-0 bg-ink/30"
            onClick={() => {
              setDrawer(false);
            }}
          />
          <Sidebar
            className="relative flex h-full"
            onNavigate={() => {
              setDrawer(false);
            }}
          />
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border bg-card px-4 lg:px-6">
          <button
            className="grid size-10 place-items-center rounded-ctl text-ink-muted hover:bg-hover lg:hidden"
            aria-label="Open menu"
            onClick={() => {
              setDrawer(true);
            }}
          >
            <MenuIcon className="size-5" aria-hidden />
          </button>
          <CompanySwitcher />
          <button
            onClick={() => {
              setPalette(true);
            }}
            className="mx-auto flex h-9 w-full max-w-[460px] items-center gap-2 rounded-full border border-border bg-surface px-3.5 text-left text-ink-muted hover:border-[#c8cdd5]"
          >
            <Search className="size-4 shrink-0" aria-hidden />
            <span className="flex-1 truncate text-13">Search orders, SKUs and pages</span>
            <kbd className="hidden rounded-full border border-border bg-card px-2 py-px font-sans text-xs text-ink-muted sm:inline">
              Ctrl K
            </kbd>
          </button>
          <NotificationBell />
        </header>
        <main className="min-h-0 flex-1 overflow-hidden">
          <Outlet />
        </main>
      </div>
      <CommandPalette open={palette} onOpenChange={setPalette} />
    </div>
  );
}

function Sidebar({ className, onNavigate }: { className?: string; onNavigate?: () => void }) {
  const { main, admin } = useVisibleNav();
  const { session, persona, companyId } = useAppState();
  const { data } = useQuery({
    queryKey: ['order-counts', persona, companyId],
    queryFn: () => mockApi.orders({ company: companyId, view: 'awaiting', cursor: 0 }),
    enabled: !!session,
  });
  const awaiting = data?.counts.awaiting;

  const item = (n: NavItem) => {
    const Icon = n.icon;
    return (
      <li key={n.key}>
        <Link
          to={n.path}
          onClick={onNavigate}
          activeOptions={{ exact: n.path === '/' }}
          className="flex h-9 items-center gap-2.5 rounded-ctl px-2.5 text-sm text-side-text hover:bg-side-hover hover:text-white"
          activeProps={{
            className: 'bg-side-active !text-white font-medium shadow-[inset_2px_0_0_#ffffff]',
            'aria-current': 'page',
          }}
        >
          <Icon className="size-4 shrink-0" aria-hidden strokeWidth={1.75} />
          <span className="flex-1 truncate">{n.label}</span>
          {n.key === 'shipping' && awaiting !== undefined && (
            <span
              className="num rounded-full bg-white/12 px-1.5 text-[11px] leading-[18px] font-medium text-white"
              aria-label={`${String(awaiting)} awaiting dispatch`}
            >
              {formatInt(awaiting)}
            </span>
          )}
        </Link>
      </li>
    );
  };

  return (
    <aside className={cn('w-[224px] shrink-0 flex-col bg-side text-white', className)}>
      <div className="flex h-14 shrink-0 items-center gap-2.5 px-4">
        <span
          aria-hidden
          className="grid size-7 place-items-center rounded-[8px] bg-white text-[11px] font-semibold tracking-[0.02em] text-side"
        >
          OB
        </span>
        <span className="min-w-0">
          <span className="block text-[15px] leading-5 font-semibold tracking-[-0.01em]">
            OmniBridge
          </span>
          <span className="block truncate text-xs leading-4 text-side-muted">
            {session?.workspace}
          </span>
        </span>
      </div>
      <nav aria-label="Main" className="min-h-0 flex-1 overflow-y-auto px-2 pt-2 pb-3">
        <ul className="space-y-px">{main.map(item)}</ul>
        {admin.length > 0 && (
          <>
            <div className="mt-5 mb-1 px-2.5 text-xs font-medium text-side-muted">Admin</div>
            <ul className="space-y-px">{admin.map(item)}</ul>
          </>
        )}
      </nav>
      <PersonaMenu />
      {persona === 'packer' && (
        <p className="px-4 pb-3 text-xs text-side-muted">
          Viewing as a child user: 3 tabs, 2 companies.
        </p>
      )}
    </aside>
  );
}

function PersonaMenu() {
  const { session, persona, setPersona } = useAppState();
  if (!session) return null;
  return (
    <Menu.Root>
      <Menu.Trigger className="mx-2 mb-2 flex items-center gap-2.5 rounded-ctl px-2 py-2 text-left hover:bg-side-hover">
        <span className="grid size-7 shrink-0 place-items-center rounded-full bg-white/12 text-xs font-semibold text-white">
          {session.user.initials}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-13 font-medium">{session.user.name}</span>
          <span className="block truncate text-xs text-side-muted">
            {session.user.isAdmin ? 'Admin' : 'Packer'}
          </span>
        </span>
        <ChevronsUpDown className="size-4 text-side-muted" aria-hidden />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner side="top" align="start" sideOffset={4} className="z-50">
          <Menu.Popup className={popup}>
            <Menu.RadioGroup
              value={persona}
              onValueChange={(v) => {
                setPersona(v as typeof persona);
              }}
            >
              <Menu.GroupLabel className="px-2 pt-1 pb-1.5 text-xs text-ink-muted">
                Mock persona (mock-ups only)
              </Menu.GroupLabel>
              {(
                [
                  ['admin', 'Sam Admin', 'All tabs and companies'],
                  ['packer', 'Pat Packer', 'Orders and Shipping, 2 companies'],
                ] as const
              ).map(([v, name, sub]) => (
                <Menu.RadioItem key={v} value={v} className={cn(menuItem, 'h-auto py-1.5')}>
                  <span className="flex-1">
                    <span className="block">{name}</span>
                    <span className="block text-xs text-ink-muted">{sub}</span>
                  </span>
                  <Menu.RadioItemIndicator>
                    <Check className="size-4 text-brand-700" aria-hidden />
                  </Menu.RadioItemIndicator>
                </Menu.RadioItem>
              ))}
            </Menu.RadioGroup>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

function CompanySwitcher() {
  const { session, companyId, setCompanyId, company } = useAppState();
  if (!session) return <div className="h-8 w-44" />;
  const current = companyId === 'all' ? undefined : company(companyId);
  return (
    <Menu.Root>
      <Menu.Trigger className="flex h-9 shrink-0 items-center gap-2 rounded-full border border-border bg-card px-3 text-sm hover:bg-hover">
        <span className="sr-only">Company:</span>
        {current ? (
          <>
            <CompanySwatch company={current} />
            <span className="max-w-40 truncate font-medium">{current.tradingName}</span>
          </>
        ) : (
          <>
            <span aria-hidden className="flex gap-0.5">
              {session.companies.map((c) => (
                <CompanySwatch key={c.id} company={c} />
              ))}
            </span>
            <span className="font-medium">Combined</span>
            <span className="hidden text-ink-muted sm:inline">
              {session.companies.length} companies
            </span>
          </>
        )}
        <ChevronsUpDown className="size-4 text-ink-muted" aria-hidden />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner align="start" sideOffset={4} className="z-50">
          <Menu.Popup className={popup}>
            <Menu.RadioGroup
              value={companyId}
              onValueChange={(v) => {
                setCompanyId(String(v));
              }}
            >
              <Menu.RadioItem value="all" className={cn(menuItem, 'h-auto py-1.5')}>
                <span className="flex-1">
                  <span className="block">Combined</span>
                  <span className="block text-xs text-ink-muted">
                    All {session.companies.length} companies you can see
                  </span>
                </span>
                <Menu.RadioItemIndicator>
                  <Check className="size-4 text-brand-700" aria-hidden />
                </Menu.RadioItemIndicator>
              </Menu.RadioItem>
              <div role="separator" className="my-1 h-px bg-divider" />
              {session.companies.map((c) => (
                <Menu.RadioItem key={c.id} value={c.id} className={menuItem}>
                  <CompanySwatch company={c} />
                  <span className="flex-1">{c.tradingName}</span>
                  <Menu.RadioItemIndicator>
                    <Check className="size-4 text-brand-700" aria-hidden />
                  </Menu.RadioItemIndicator>
                </Menu.RadioItem>
              ))}
            </Menu.RadioGroup>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

/** Placeholder until the notification centre lands in M05. The count is mock data. */
function NotificationBell() {
  return (
    <Popover.Root>
      <Popover.Trigger
        className="relative grid size-9 place-items-center rounded-full text-ink-muted hover:bg-hover hover:text-ink"
        aria-label="Notifications, 4 unread"
      >
        <Bell className="size-[18px]" aria-hidden />
        <span className="num absolute -top-0.5 -right-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-brand-700 px-1 text-[10px] leading-none font-semibold text-white ring-2 ring-card">
          4
        </span>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner align="end" sideOffset={6} className="z-50">
          <Popover.Popup className="w-80 rounded-card border border-border bg-card shadow-pop outline-none">
            <div className="flex h-11 items-center border-b border-divider px-4">
              <Popover.Title className="text-sm font-semibold">Notifications</Popover.Title>
            </div>
            <div className="flex flex-col items-center gap-1.5 px-6 py-8 text-center">
              <Bell className="size-5 text-ink-muted" aria-hidden />
              <Popover.Description className="text-13 text-ink-muted">
                Alerts such as oversold stock and failed labels will appear here once the
                notification centre is built.
              </Popover.Description>
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

function CommandPalette({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const { main, admin } = useVisibleNav();
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  const results = [...main, ...admin].filter((n) =>
    n.label.toLowerCase().includes(q.trim().toLowerCase()),
  );
  const go = (n: NavItem | undefined) => {
    if (!n) return;
    onOpenChange(false);
    void navigate({ to: n.path });
  };

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (o) {
          setQ('');
          setActive(0);
        }
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-ink/25" />
        <Dialog.Popup
          initialFocus={input}
          className="fixed top-[12vh] left-1/2 z-50 w-[min(560px,calc(100vw-32px))] -translate-x-1/2 overflow-hidden rounded-card border border-border bg-card shadow-pop outline-none"
        >
          <Dialog.Title className="sr-only">Search</Dialog.Title>
          <div className="flex items-center gap-2 border-b border-border px-3">
            <Search className="size-4 text-ink-muted" aria-hidden />
            <input
              ref={input}
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                setActive(0);
              }}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') setActive((a) => Math.min(a + 1, results.length - 1));
                else if (e.key === 'ArrowUp') setActive((a) => Math.max(a - 1, 0));
                else if (e.key === 'Enter') go(results[active]);
                else return;
                e.preventDefault();
              }}
              role="combobox"
              aria-expanded
              aria-controls="palette-list"
              aria-activedescendant={results[active] ? `palette-${results[active].key}` : undefined}
              placeholder="Search orders, SKUs and pages"
              className="h-11 flex-1 bg-transparent text-sm outline-none placeholder:text-ink-muted"
            />
            <Dialog.Close
              className="grid size-7 place-items-center rounded-ctl text-ink-muted hover:bg-hover"
              aria-label="Close search"
            >
              <X className="size-4" aria-hidden />
            </Dialog.Close>
          </div>
          <div className="px-3 pt-2 pb-1 text-xs text-ink-muted">Go to</div>
          <ul
            id="palette-list"
            role="listbox"
            aria-label="Pages"
            className="max-h-80 overflow-y-auto px-1.5 pb-1.5"
          >
            {results.map((n, i) => {
              const Icon = n.icon;
              return (
                <li
                  key={n.key}
                  id={`palette-${n.key}`}
                  role="option"
                  aria-selected={i === active}
                  onMouseMove={() => {
                    setActive(i);
                  }}
                  onClick={() => {
                    go(n);
                  }}
                  className={cn(
                    'flex h-9 cursor-default items-center gap-2.5 rounded-ctl px-2 text-sm',
                    i === active && 'bg-brand-50 text-brand-900',
                  )}
                >
                  <Icon className="size-4 text-ink-muted" aria-hidden />
                  {n.label}
                </li>
              );
            })}
            {results.length === 0 && (
              <li className="px-2 py-3 text-sm text-ink-muted">
                No page called “{q}”. Order and SKU search arrives with the Orders module.
              </li>
            )}
          </ul>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
