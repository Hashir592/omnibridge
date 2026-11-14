import { useQuery } from '@tanstack/react-query';
import { getRouteApi, useNavigate } from '@tanstack/react-router';
import { Lock, Plus, Users } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useAppState } from '../app/session.tsx';
import { Card, PageHeader } from '../components/Card.tsx';
import { DetailsWarning, NoCustomerDetails } from '../components/NoCustomerDetails.tsx';
import { TabGate } from '../components/TabGate.tsx';
import { Button } from '../kit/Button.tsx';
import { Field, Input } from '../kit/Field.tsx';
import { EmptyState } from '../kit/states.tsx';
import { useToast } from '../kit/Toast.tsx';
import { cn } from '../lib/cn.ts';
import { daysFromToday, formatDate, formatTime } from '../lib/format.ts';
import { findPersonalDetails } from '../lib/piiCheck.ts';
import { mockApi } from '../mocks/api.ts';
import type { Note } from '../mocks/tools.ts';

export interface NotesSearch {
  n?: string | undefined;
}

const route = getRouteApi('/notes');

const edited = (iso: string) => {
  const d = daysFromToday(iso);
  return d === 0
    ? `Today, ${formatTime(iso)}`
    : d === -1
      ? `Yesterday, ${formatTime(iso)}`
      : formatDate(iso);
};

export function NotesPage() {
  return (
    <TabGate tab="notes">
      <Notes />
    </TabGate>
  );
}

function Notes() {
  const search = route.useSearch();
  const navigate = useNavigate({ from: '/notes' });
  const { session, persona } = useAppState();
  const q = useQuery({ queryKey: ['notes', persona], queryFn: mockApi.notes, enabled: !!session });
  const notes = q.data ?? [];
  const selected = notes.find((n) => n.id === search.n) ?? notes[0];
  const open = (id: string) => void navigate({ search: { n: id }, replace: true });

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[1280px] px-4 pt-3 pb-12 lg:px-6">
        <PageHeader
          title="Notes"
          actions={
            <Button variant="primary" icon={<Plus />}>
              New note
            </Button>
          }
        />
        <div className="mt-3">
          <NoCustomerDetails />
        </div>
        <Card className="mt-5 grid min-h-[560px] overflow-hidden lg:grid-cols-[320px_minmax(0,1fr)]">
          <div className="border-b border-divider lg:border-r lg:border-b-0">
            {q.data && notes.length === 0 ? (
              <EmptyState
                title="No notes yet"
                body="Write down how your team does things: packing rules, supplier contacts, checklists."
              />
            ) : (
              <ul aria-label="Notes">
                {notes.map((n) => (
                  <li key={n.id} className="border-b border-divider last:border-0">
                    <button
                      onClick={() => {
                        open(n.id);
                      }}
                      aria-current={n.id === selected?.id ? 'true' : undefined}
                      className={cn(
                        'w-full px-4 py-3 text-left hover:bg-hover',
                        n.id === selected?.id && 'bg-selected hover:bg-selected',
                      )}
                    >
                      <span className="block truncate text-13 font-medium">{n.title}</span>
                      <span className="num mt-0.5 flex items-center gap-2 text-xs text-ink-muted">
                        {n.shared ? (
                          <Users className="size-3" aria-hidden />
                        ) : (
                          <Lock className="size-3" aria-hidden />
                        )}
                        {n.shared ? 'Shared' : 'Private'} · {n.owner} · {edited(n.updatedAt)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          {selected ? <Editor key={selected.id} note={selected} /> : <div />}
        </Card>
      </div>
    </div>
  );
}

function Editor({ note }: { note: Note }) {
  const toast = useToast();
  const { session } = useAppState();
  const [title, setTitle] = useState(note.title);
  const [body, setBody] = useState(note.body);
  const [shared, setShared] = useState(note.shared);
  const [warned, setWarned] = useState<string[] | null>(null);
  useEffect(() => {
    setWarned(null);
  }, [title, body]);
  const mine = note.owner === session?.user.name;

  const save = () => {
    const found = findPersonalDetails(`${title} ${body}`);
    if (found.length > 0 && warned === null) {
      setWarned(found);
      return;
    }
    setWarned(null);
    toast({ title: 'Note saved', tone: 'success' });
  };

  return (
    <div className="flex min-w-0 flex-col gap-4 px-5 py-4">
      <Field label="Title">
        <Input value={title} onChange={setTitle} />
      </Field>
      <Field label="Note" hint="Plain text. Use new lines for lists.">
        <textarea
          aria-label="Note"
          value={body}
          onChange={(e) => {
            setBody(e.target.value);
          }}
          rows={12}
          className="w-full rounded-ctl border border-border bg-card px-3 py-2 text-13 leading-5 shadow-card outline-none focus:border-brand-600"
        />
      </Field>
      <label className={cn('flex items-center gap-2 text-13', !mine && 'text-ink-muted')}>
        <input
          type="checkbox"
          className="size-4"
          checked={shared}
          disabled={!mine}
          onChange={(e) => {
            setShared(e.target.checked);
          }}
        />
        Share with everyone in the workspace
        {!mine && <span className="text-xs">(only {note.owner} can change this)</span>}
      </label>
      {warned && <DetailsWarning found={warned} />}
      <div className="flex items-center justify-between gap-3">
        <span className="num text-xs text-ink-muted">
          Last edited {edited(note.updatedAt)} by {note.owner}
        </span>
        <div className="flex gap-2">
          <Button variant="danger">Delete</Button>
          <Button variant="primary" onClick={save}>
            Save note
          </Button>
        </div>
      </div>
    </div>
  );
}
