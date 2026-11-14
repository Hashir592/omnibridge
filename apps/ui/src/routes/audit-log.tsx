import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { getRouteApi, useNavigate } from '@tanstack/react-router';
import { Download, Lock } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useAppState } from '../app/session.tsx';
import { PageHeader } from '../components/Card.tsx';
import { TabGate } from '../components/TabGate.tsx';
import { Button } from '../kit/Button.tsx';
import { EmptyState, ErrorState } from '../kit/states.tsx';
import { DateCell, EmptyCell, Sub } from '../kit/table/cells.tsx';
import { DataTable, type DataColumn } from '../kit/table/DataTable.tsx';
import { Pager } from '../kit/table/Pager.tsx';
import {
  FilterChips,
  FilterMenu,
  ListToolbar,
  SearchBox,
  type Chip,
} from '../kit/table/Toolbar.tsx';
import type { PageSize } from '../lib/paging.ts';
import { mockApi } from '../mocks/api.ts';
import { AREA_LABEL, type AuditArea, type AuditEntry } from '../mocks/audit.ts';

export interface AuditSearch {
  q?: string | undefined;
  area?: string | undefined;
  user?: string | undefined;
  page?: number | undefined;
  size?: PageSize | undefined;
}

const route = getRouteApi('/audit-log');
const split = (v: string | undefined) => (v ? v.split(',').filter(Boolean) : []);

const columns: Array<DataColumn<AuditEntry>> = [
  { id: 'at', header: 'When', width: 120, cell: (e) => <DateCell iso={e.at} /> },
  {
    id: 'user',
    header: 'Who',
    width: 156,
    cell: (e) => (
      <>
        <span className="truncate text-13 leading-[18px] font-medium">{e.user}</span>
        <Sub className="ref">{e.ip}</Sub>
      </>
    ),
  },
  {
    id: 'action',
    header: 'Action',
    width: 220,
    cell: (e) => (
      <>
        <span className="ref truncate text-13 leading-[18px]">{e.action}</span>
        <Sub>{AREA_LABEL[e.area]}</Sub>
      </>
    ),
  },
  {
    id: 'entity',
    header: 'Record',
    width: 260,
    cell: (e) => <span className="truncate text-13">{e.entity}</span>,
  },
  {
    id: 'change',
    header: 'Before → after',
    width: 'minmax(220px,1fr)',
    cell: (e) =>
      e.change || e.reason ? (
        <>
          <span className="num truncate text-13 leading-[18px]">{e.change ?? ''}</span>
          {e.reason && <Sub>Reason: {e.reason}</Sub>}
        </>
      ) : (
        <EmptyCell label="No change recorded" />
      ),
  },
];

export function AuditLogPage() {
  return (
    <TabGate tab="admin">
      <AuditLog />
    </TabGate>
  );
}

function AuditLog() {
  const search = route.useSearch();
  const navigate = useNavigate({ from: '/audit-log' });
  const { session, persona } = useAppState();
  const [qDraft, setQDraft] = useState(search.q ?? '');
  const size: PageSize = search.size ?? 50;
  const page = search.page ?? 1;
  const setSearch = (patch: Partial<AuditSearch>) =>
    void navigate({
      search: (prev: AuditSearch) => ({ ...prev, page: undefined, ...patch }),
      replace: !('page' in patch),
    });
  useEffect(() => {
    const t = setTimeout(() => {
      if ((search.q ?? '') !== qDraft) setSearch({ q: qDraft || undefined });
    }, 200);
    return () => {
      clearTimeout(t);
    };
  }, [qDraft]);
  const q = useQuery({
    queryKey: ['audit', persona, search.q, search.area, search.user, page, size],
    queryFn: () =>
      mockApi.audit({
        q: search.q,
        area: search.area,
        user: search.user,
        cursor: (page - 1) * size,
        limit: size,
      }),
    placeholderData: keepPreviousData,
    enabled: !!session,
  });
  const cols = useMemo(() => columns, []);
  const clearAll = () => {
    setQDraft('');
    void navigate({ search: {}, replace: true });
  };
  const chips: Chip[] = [
    ...split(search.area).map((a) => ({
      key: `a-${a}`,
      label: `Area: ${a in AREA_LABEL ? AREA_LABEL[a as AuditArea] : a}`,
      onRemove: () => {
        setSearch({
          area:
            split(search.area)
              .filter((x) => x !== a)
              .join(',') || undefined,
        });
      },
    })),
    ...split(search.user).map((u) => ({
      key: `u-${u}`,
      label: `Who: ${u}`,
      onRemove: () => {
        setSearch({
          user:
            split(search.user)
              .filter((x) => x !== u)
              .join(',') || undefined,
        });
      },
    })),
  ];

  return (
    <div className="flex h-full flex-col px-4 pt-2 pb-3 lg:px-6">
      <PageHeader
        title="Audit Log"
        sub={
          <span className="flex items-center gap-1.5">
            <Lock className="size-3.5" aria-hidden /> Append-only. Nobody can edit or delete an
            entry. Kept for 6 years. Times are UK time.
          </span>
        }
        actions={<Button icon={<Download />}>Export CSV</Button>}
      />
      <ListToolbar>
        <SearchBox
          label="Search by record or action"
          placeholder="Record or action"
          value={qDraft}
          onChange={setQDraft}
        />
        <FilterMenu
          label="Area"
          options={Object.entries(AREA_LABEL).map(([value, label]) => ({ value, label }))}
          value={split(search.area)}
          onChange={(v) => {
            setSearch({ area: v.join(',') || undefined });
          }}
        />
        <FilterMenu
          label="Who"
          options={(q.data?.users ?? []).map((u) => ({ value: u, label: u }))}
          value={split(search.user)}
          onChange={(v) => {
            setSearch({ user: v.join(',') || undefined });
          }}
        />
      </ListToolbar>
      <FilterChips chips={chips} onClearAll={clearAll} />
      <DataTable
        label="Audit log"
        rows={q.data?.items ?? []}
        rowId={(e) => e.id}
        columns={cols}
        rowOffset={(page - 1) * size}
        totalRows={q.data?.total ?? 0}
        scrollKey={JSON.stringify([search.q, search.area, search.user, page, size])}
        status={q.isError ? 'error' : q.isPending ? 'loading' : 'ready'}
        empty={
          <EmptyState
            title="No entries match these filters"
            body="Remove a filter or clear the search."
            action={{ label: 'Clear filters', onClick: clearAll }}
          />
        }
        error={
          <ErrorState
            title="The audit log could not load"
            body="The server did not answer. Try again; if it keeps failing, check Status."
            action={{ label: 'Try again', onClick: () => void q.refetch() }}
          />
        }
      />
      <Pager
        page={page}
        size={size}
        total={q.data?.total ?? 0}
        noun="entries"
        onPage={(p) => {
          setSearch({ page: p === 1 ? undefined : p });
        }}
        onSize={(s) => {
          setSearch({ size: s === 50 ? undefined : s });
        }}
      />
    </div>
  );
}
