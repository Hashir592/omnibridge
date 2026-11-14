import { Menu } from '@base-ui/react/menu';
import { useQuery } from '@tanstack/react-query';
import { AlarmClock, Check, ChevronDown, Plus, Repeat } from 'lucide-react';
import { useState } from 'react';
import { useAppState } from '../app/session.tsx';
import { Card, PageHeader } from '../components/Card.tsx';
import { DetailsWarning, NoCustomerDetails } from '../components/NoCustomerDetails.tsx';
import { TabGate } from '../components/TabGate.tsx';
import { Button } from '../kit/Button.tsx';
import { DatePicker } from '../kit/DatePicker.tsx';
import { Dialog } from '../kit/Dialog.tsx';
import { Field, Input } from '../kit/Field.tsx';
import { Select } from '../kit/Select.tsx';
import { EmptyState } from '../kit/states.tsx';
import { useToast } from '../kit/Toast.tsx';
import { cn } from '../lib/cn.ts';
import { daysFromToday, formatDate, formatTime, overdueText } from '../lib/format.ts';
import { findPersonalDetails } from '../lib/piiCheck.ts';
import { mockApi } from '../mocks/api.ts';
import type { Recurrence, Reminder } from '../mocks/tools.ts';

const REPEAT: Record<Recurrence, string> = {
  none: 'Does not repeat',
  daily: 'Every day',
  weekly: 'Every week',
  monthly: 'Every month',
  yearly: 'Every year',
};

const popup =
  'min-w-44 rounded-card border border-border bg-card p-1.5 text-13 shadow-pop outline-none';
const item =
  'flex h-8 cursor-default items-center rounded-[6px] px-2 outline-none select-none data-[highlighted]:bg-hover';

export function RemindersPage() {
  return (
    <TabGate tab="reminders">
      <Reminders />
    </TabGate>
  );
}

function Reminders() {
  const { session, persona } = useAppState();
  const toast = useToast();
  const [adding, setAdding] = useState(false);
  const [done, setDone] = useState<Set<string>>(new Set());
  const q = useQuery({
    queryKey: ['reminders', persona],
    queryFn: mockApi.reminders,
    enabled: !!session,
  });
  const all = (q.data ?? []).map((r) => ({ ...r, done: r.done || done.has(r.id) }));
  const now = Date.now();
  const groups: Array<[string, Reminder[]]> = [
    ['Overdue', all.filter((r) => !r.done && Date.parse(r.dueAt) < now)],
    [
      'Today',
      all.filter((r) => !r.done && Date.parse(r.dueAt) >= now && daysFromToday(r.dueAt) === 0),
    ],
    ['Coming up', all.filter((r) => !r.done && daysFromToday(r.dueAt) > 0)],
    ['Done', all.filter((r) => r.done)],
  ];

  const complete = (r: Reminder) => {
    setDone(new Set(done).add(r.id));
    toast({
      title: 'Reminder done',
      description: r.recurrence === 'none' ? r.title : `${r.title}. The next one is scheduled.`,
      tone: 'success',
    });
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[960px] px-4 pt-3 pb-12 lg:px-6">
        <PageHeader
          title="Reminders"
          actions={
            <Button
              variant="primary"
              icon={<Plus />}
              onClick={() => {
                setAdding(true);
              }}
            >
              New reminder
            </Button>
          }
        />
        <div className="mt-3">
          <NoCustomerDetails />
        </div>
        {q.data && q.data.length === 0 && (
          <Card className="mt-5">
            <EmptyState
              title="No reminders yet"
              body="Add one for anything with a date: a supplier call, a stock count, a bill."
              action={{
                label: 'New reminder',
                onClick: () => {
                  setAdding(true);
                },
              }}
            />
          </Card>
        )}
        {groups.map(([title, list]) =>
          list.length === 0 ? null : (
            <Card
              key={title}
              title={title}
              className="mt-5"
              aside={<span className="num text-ink-muted">{list.length}</span>}
            >
              <ul>
                {list.map((r) => {
                  const overdue = !r.done && Date.parse(r.dueAt) < now;
                  const d = daysFromToday(r.dueAt);
                  const due =
                    d === 0
                      ? `Today, ${formatTime(r.dueAt)}`
                      : d === 1
                        ? `Tomorrow, ${formatTime(r.dueAt)}`
                        : `${formatDate(r.dueAt)}, ${formatTime(r.dueAt)}`;
                  return (
                    <li
                      key={r.id}
                      className="flex items-start gap-3 border-b border-divider px-5 py-3.5 last:border-0"
                    >
                      <button
                        aria-label={r.done ? `${r.title} is done` : `Mark ${r.title} done`}
                        disabled={r.done}
                        onClick={() => {
                          complete(r);
                        }}
                        className={cn(
                          'mt-0.5 grid size-5 shrink-0 place-items-center rounded-full border',
                          r.done
                            ? 'border-success bg-success text-white'
                            : 'border-[#c3c8d0] hover:border-ink',
                        )}
                      >
                        {r.done && <Check className="size-3" strokeWidth={3} aria-hidden />}
                      </button>
                      <div className="min-w-0 flex-1">
                        <p
                          className={cn(
                            'text-13 font-medium',
                            r.done && 'text-ink-muted line-through',
                          )}
                        >
                          {r.title}
                        </p>
                        {r.details && <p className="mt-0.5 text-13 text-ink-muted">{r.details}</p>}
                        <p className="num mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-muted">
                          <span className={cn(overdue && 'font-medium text-danger')}>
                            {overdue ? `${overdueText(r.dueAt)}, was ${formatDate(r.dueAt)}` : due}
                          </span>
                          {r.recurrence !== 'none' && (
                            <span className="flex items-center gap-1">
                              <Repeat className="size-3" aria-hidden /> {REPEAT[r.recurrence]}
                            </span>
                          )}
                          <span>For {r.assignee === session?.user.name ? 'you' : r.assignee}</span>
                        </p>
                      </div>
                      {!r.done && (
                        <Menu.Root>
                          <Menu.Trigger className="flex h-8 items-center gap-1 rounded-ctl border border-border bg-card px-2.5 text-13 font-medium shadow-card hover:bg-hover">
                            <AlarmClock className="size-4 text-ink-muted" aria-hidden /> Snooze
                            <ChevronDown className="size-3.5 text-ink-muted" aria-hidden />
                          </Menu.Trigger>
                          <Menu.Portal>
                            <Menu.Positioner align="end" sideOffset={4} className="z-50">
                              <Menu.Popup className={popup}>
                                {['1 hour', 'Tomorrow', 'Next week'].map((s) => (
                                  <Menu.Item
                                    key={s}
                                    className={item}
                                    onClick={() => {
                                      toast({
                                        title: `Snoozed: ${s.toLowerCase()}`,
                                        description: r.title,
                                        tone: 'success',
                                      });
                                    }}
                                  >
                                    {s}
                                  </Menu.Item>
                                ))}
                              </Menu.Popup>
                            </Menu.Positioner>
                          </Menu.Portal>
                        </Menu.Root>
                      )}
                    </li>
                  );
                })}
              </ul>
            </Card>
          ),
        )}
        <p className="mt-3 text-xs text-ink-muted">
          At the due time the person it is for gets an in-app notification and an email.
        </p>
      </div>
      <NewReminder open={adding} onOpenChange={setAdding} />
    </div>
  );
}

function NewReminder({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const toast = useToast();
  const [title, setTitle] = useState('');
  const [details, setDetails] = useState('');
  const [date, setDate] = useState<string | null>(null);
  const [time, setTime] = useState('09:00');
  const [repeat, setRepeat] = useState<string | null>('none');
  const [assignee, setAssignee] = useState<string | null>('me');
  const [tried, setTried] = useState(false);
  const [warned, setWarned] = useState<string[] | null>(null);
  const found = findPersonalDetails(`${title} ${details}`);
  const titleError = title.trim() === '' ? 'Give the reminder a title' : undefined;
  const dateError = !date ? 'Choose a due date' : undefined;

  const save = () => {
    setTried(true);
    if (titleError || dateError) return;
    // TOOL-3: warn once; a second Save keeps the text.
    if (found.length > 0 && warned === null) {
      setWarned(found);
      return;
    }
    onOpenChange(false);
    setTitle('');
    setDetails('');
    setWarned(null);
    setTried(false);
    toast({ title: 'Reminder added', tone: 'success' });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="New reminder"
      description={<NoCustomerDetails />}
      footer={
        <>
          <Button
            onClick={() => {
              onOpenChange(false);
            }}
          >
            Cancel
          </Button>
          <Button variant="primary" onClick={save}>
            Save reminder
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="Title" required error={tried ? titleError : undefined}>
          <Input
            value={title}
            onChange={(v) => {
              setTitle(v);
              setWarned(null);
            }}
          />
        </Field>
        <Field label="Details">
          <Input
            value={details}
            onChange={(v) => {
              setDetails(v);
              setWarned(null);
            }}
          />
        </Field>
        <div className="grid grid-cols-[minmax(0,1fr)_120px] gap-3">
          <Field label="Due date" required error={tried ? dateError : undefined}>
            <DatePicker value={date} onChange={setDate} />
          </Field>
          <Field label="Time">
            <Input value={time} onChange={setTime} type="time" />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Repeat">
            <Select
              options={Object.entries(REPEAT).map(([value, label]) => ({ value, label }))}
              value={repeat}
              onChange={setRepeat}
            />
          </Field>
          <Field label="For">
            <Select
              options={[
                { value: 'me', label: 'Me' },
                { value: 'usr_2', label: 'Pat Packer' },
                { value: 'usr_3', label: 'Alex Accounts' },
                { value: 'usr_5', label: 'Chris Stock' },
              ]}
              value={assignee}
              onChange={setAssignee}
            />
          </Field>
        </div>
        {warned && <DetailsWarning found={warned} />}
      </div>
    </Dialog>
  );
}
