import { Menu } from '@base-ui/react/menu';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, TriangleAlert, Users } from 'lucide-react';
import { useState } from 'react';
import { Button } from '../kit/Button.tsx';
import { Dialog } from '../kit/Dialog.tsx';
import { Field } from '../kit/Field.tsx';
import { Select } from '../kit/Select.tsx';
import { useToast } from '../kit/Toast.tsx';
import { cn } from '../lib/cn.ts';
import { formatDate, formatInt, formatTime } from '../lib/format.ts';
import { mockApi } from '../mocks/api.ts';
import { PACKAGING_GRAMS, SERVICES, defaultWeightGrams, ruleFor } from '../mocks/shipping.ts';
import type { OrderRowGroup } from '../mocks/types.ts';

/**
 * Same-buyer groups (client change C3, ORD-9 and SHP-9). Members are adjacent rows joined by a
 * petrol rail and a thin bracket at the left edge; the first row carries the chip. No tinted
 * background: each row keeps its own checkbox, status and actions.
 */

/** The rail and bracket for one member row. Place it inside a positioned cell or list item. */
export function GroupRail({ group }: { group: OrderRowGroup }) {
  const first = group.index === 0;
  const last = group.last;
  return (
    <span aria-hidden className="pointer-events-none">
      <span
        className={cn(
          'absolute left-0 w-1 bg-brand-600',
          first ? 'top-0' : '-top-px',
          last ? 'bottom-0' : '-bottom-px',
        )}
      />
      <span
        className={cn(
          'absolute left-[7px] w-[5px] border-l-[1.5px] border-brand-600',
          first ? 'top-[16px] rounded-tl-[3px] border-t-[1.5px]' : 'top-0',
          last ? 'bottom-[16px] rounded-bl-[3px] border-b-[1.5px]' : '-bottom-px',
        )}
      />
    </span>
  );
}

const menuItem =
  'flex h-8 cursor-default items-center gap-2 rounded-[6px] px-2 text-13 outline-none select-none data-[highlighted]:bg-hover';

/** The background of every member row, so a group reads as one block at a glance. */
export const GROUP_TONE = 'bg-brand-50';

/** "2 of 3" with the people icon on the rows after the first, so every member says it belongs. */
export function GroupPosition({ group }: { group: OrderRowGroup }) {
  return (
    <span
      title="Same buyer"
      className="inline-flex shrink-0 items-center gap-1 text-[11px] leading-none font-medium whitespace-nowrap text-brand-900"
    >
      <Users className="size-3" aria-hidden />
      <span className="sr-only">Same buyer, order </span>
      {group.index + 1} of {group.size}
    </span>
  );
}

/** "Same buyer · 3 orders": opens the group's members, warnings and actions. */
export function GroupChip({
  group,
  onShipTogether,
  onNotSame,
  onShowGroup,
}: {
  group: OrderRowGroup;
  onShipTogether: () => void;
  onNotSame: () => void;
  onShowGroup?: () => void;
}) {
  return (
    <Menu.Root>
      <Menu.Trigger
        aria-label={`Same buyer, ${String(group.size)} orders${group.warnings.length ? ', with warnings' : ''}. Open group actions`}
        className="inline-flex h-5 max-w-full shrink-0 items-center gap-1 rounded-full border border-brand-600/40 bg-card px-1.5 text-[11px] leading-none font-medium whitespace-nowrap text-brand-900 hover:bg-brand-50"
      >
        <Users className="size-3" aria-hidden />
        Same buyer · {group.size} orders
        {group.warnings.length > 0 && <TriangleAlert className="size-3 text-warning" aria-hidden />}
        <ChevronDown className="size-3 text-ink-muted" aria-hidden />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner align="start" sideOffset={4} className="z-50">
          <Menu.Popup className="w-72 rounded-card border border-border bg-card p-1.5 text-13 shadow-pop outline-none">
            <div className="px-2 pt-1 pb-2">
              <p className="text-xs font-medium text-ink-muted">Orders in this group</p>
              <ul className="mt-1">
                {group.memberRefs.map((r) => (
                  <li key={r} className="ref text-13">
                    {r}
                  </li>
                ))}
              </ul>
              {group.warnings.length > 0 && (
                <ul className="mt-2 flex flex-col gap-1">
                  {group.warnings.map((w) => (
                    <li key={w} className="flex items-start gap-1.5 text-xs text-warning">
                      <TriangleAlert className="mt-px size-3.5 shrink-0" aria-hidden />
                      <span className="text-ink">{w}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <Menu.Separator className="my-1 h-px bg-divider" />
            <Menu.Item className={menuItem} onClick={onShipTogether}>
              Ship together…
            </Menu.Item>
            {onShowGroup && (
              <Menu.Item className={menuItem} onClick={onShowGroup}>
                Show only this group
              </Menu.Item>
            )}
            <Menu.Item className={menuItem} onClick={onNotSame}>
              Not the same buyer…
            </Menu.Item>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

/** The group's first warning and "+1 related order not shown", for the first row's Flags cell. */
export function GroupNotes({
  group,
  onShowGroup,
}: {
  group: OrderRowGroup;
  onShowGroup: () => void;
}) {
  if (group.index !== 0) return null;
  const first = group.warnings[0];
  return (
    <>
      {first && (
        <span
          title={group.warnings.join('\n')}
          className="flex min-w-0 items-center gap-1 text-xs font-medium whitespace-nowrap text-warning"
        >
          <TriangleAlert className="size-3.5 shrink-0" aria-hidden />
          <span className="truncate">
            {first}
            {group.warnings.length > 1 ? ` (+${String(group.warnings.length - 1)})` : ''}
          </span>
        </span>
      )}
      {group.hidden > 0 && (
        <button
          onClick={onShowGroup}
          title="Show every order in this group"
          className="max-w-full truncate text-left text-xs font-medium text-brand-600 hover:underline"
        >
          +{group.hidden} related order{group.hidden === 1 ? '' : 's'} not shown
        </button>
      )}
    </>
  );
}

/**
 * Ship together (SHP-9): one label for the ticked orders. An order can be left out of this label,
 * or taken out of the group for good when it must ship on its own (for example by another
 * carrier); the rest stay grouped while two or more are left.
 */
export function ShipTogetherDialog({
  groupId: startId,
  onOpenChange,
  onDone,
}: {
  groupId: string;
  onOpenChange: (open: boolean) => void;
  onDone?: (orderIds: string[]) => void;
}) {
  const toast = useToast();
  const qc = useQueryClient();
  const [groupId, setGroupId] = useState(startId);
  const q = useQuery({
    queryKey: ['group-members', groupId],
    queryFn: () => mockApi.orders({ group: groupId, limit: 100 }),
  });
  const all = q.data?.items ?? [];
  const [left, setLeft] = useState<Set<string>>(new Set()); // left out of this label only
  const [asking, setAsking] = useState<string | null>(null); // order awaiting "remove" confirm
  const [busy, setBusy] = useState(false);
  const members = all.filter((o) => !left.has(o.id));

  const remove = async (orderId: string) => {
    setBusy(true);
    const r = await mockApi.removeFromGroup(groupId, orderId, 'Ships separately');
    setBusy(false);
    setAsking(null);
    if (!r.ok) {
      toast({ title: 'The order could not be removed. Try again.', tone: 'error' });
      return;
    }
    const ref = all.find((o) => o.id === orderId)?.ref ?? '';
    const rest = all.filter((o) => o.id !== orderId);
    void qc.invalidateQueries();
    if (rest.length < 2) {
      onOpenChange(false);
      toast({
        title: `${ref} removed from the group`,
        description: 'Fewer than two orders are left, so each order now ships on its own.',
        tone: 'success',
      });
      return;
    }
    // A group is named after its earliest order, so removing that one renames the group.
    setGroupId(`grp_${rest[0]?.id ?? ''}`);
    setLeft((s) => new Set([...s].filter((id) => id !== orderId)));
    toast({
      title: `${ref} removed from the group`,
      description: 'It now ships on its own. The reason is kept in the audit log.',
      tone: 'success',
    });
  };
  const grams =
    members.reduce((s, o) => s + defaultWeightGrams(o) - PACKAGING_GRAMS, 0) + PACKAGING_GRAMS;
  const earliest = members.reduce<(typeof members)[number] | undefined>(
    (a, o) => (!a || o.shipBy < a.shipBy ? o : a),
    undefined,
  );
  // The highest service any member needs: a Next Day order makes the parcel Next Day.
  const needed = members.some((o) => o.delivery === 'next_day')
    ? 'evri-nd'
    : earliest
      ? ruleFor(earliest, grams).serviceId
      : 'evri-48';
  const [service, setService] = useState<string | null>(null);
  const chosen = service ?? needed;
  const neededName = SERVICES.find((s) => s.id === needed);

  return (
    <Dialog
      open
      onOpenChange={onOpenChange}
      title="Ship together"
      description="One label and one parcel for the ticked orders. Each order gets the same tracking number on its channel."
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
            disabled={members.length < 2 || busy}
            onClick={() => {
              onOpenChange(false);
              onDone?.(members.map((o) => o.id));
              toast({
                title: `1 label created for ${String(members.length)} orders`,
                description:
                  'Tracking goes to each order on its channel. One packing slip lists every order.',
                tone: 'success',
              });
            }}
          >
            Create 1 label for {members.length} orders
          </Button>
        </>
      }
    >
      {!q.data ? (
        <div aria-busy className="h-32" />
      ) : (
        <div className="flex flex-col gap-4">
          <ul aria-label="Orders in this parcel" className="rounded-ctl border border-border">
            {all.map((o) => {
              const on = !left.has(o.id);
              return (
                <li key={o.id} className="border-b border-divider px-3 py-2 text-13 last:border-0">
                  <div className="flex items-center gap-3">
                    <input
                      type="checkbox"
                      className="size-4"
                      checked={on}
                      aria-label={`Include ${o.ref} in this label`}
                      onChange={() => {
                        setLeft((s) => {
                          const n = new Set(s);
                          if (n.has(o.id)) n.delete(o.id);
                          else n.add(o.id);
                          return n;
                        });
                      }}
                    />
                    <span className={cn('ref flex-1 font-medium', !on && 'text-ink-muted')}>
                      {o.ref}
                    </span>
                    <span className="num text-ink-muted">
                      {formatDate(o.placedAt)} {formatTime(o.placedAt)}
                    </span>
                    <span className="num w-14 text-right text-ink-muted">
                      {o.itemCount} item{o.itemCount === 1 ? '' : 's'}
                    </span>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      aria-expanded={asking === o.id}
                      onClick={() => {
                        setAsking(asking === o.id ? null : o.id);
                      }}
                    >
                      Remove from group
                    </Button>
                  </div>
                  {asking === o.id && (
                    <div className="mt-2 flex flex-wrap items-center gap-2 pl-7 text-13">
                      <span className="text-ink-muted">
                        Take {o.ref} out of the group for good? It then ships on its own, for
                        example by another carrier.
                      </span>
                      <Button
                        size="sm"
                        variant="danger"
                        disabled={busy}
                        onClick={() => void remove(o.id)}
                      >
                        Remove
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          setAsking(null);
                        }}
                      >
                        Keep
                      </Button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
          {members.length < 2 && (
            <p className="flex items-center gap-1.5 text-13 text-ink-muted">
              <TriangleAlert className="size-4 shrink-0 text-warning" aria-hidden />
              Tick at least 2 orders. An order left out ships on its own from the list as usual.
            </p>
          )}
          <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-13">
            <dt className="text-ink-muted">Weight</dt>
            <dd className="num text-right">
              {(grams / 1000).toFixed(2)} kg
              <span className="block text-xs text-ink-muted">
                Ticked orders’ weights plus one packaging allowance ({formatInt(PACKAGING_GRAMS)} g)
              </span>
            </dd>
            <dt className="text-ink-muted">Ship by</dt>
            <dd className="num text-right">
              {earliest ? `${formatDate(earliest.shipBy)} ${formatTime(earliest.shipBy)}` : '-'}
              <span className="block text-xs text-ink-muted">The earliest ticked order’s</span>
            </dd>
          </dl>
          <Field
            label="Service"
            hint={`${neededName ? `${neededName.carrier} ${neededName.service}` : 'This service'} is the highest any ticked order needs. You can change it.`}
          >
            <Select
              options={SERVICES.map((s) => ({ value: s.id, label: `${s.carrier} ${s.service}` }))}
              value={chosen}
              onChange={setService}
            />
          </Field>
        </div>
      )}
    </Dialog>
  );
}

/** "Not the same buyer": dismisses the group for good, with a reason for the audit log. */
export function NotSameBuyerDialog({
  group,
  onOpenChange,
}: {
  group: Pick<OrderRowGroup, 'id' | 'memberRefs'>;
  onOpenChange: (open: boolean) => void;
}) {
  const toast = useToast();
  const qc = useQueryClient();
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (reason.trim() === '') {
      setError('Say why these are different buyers');
      return;
    }
    setBusy(true);
    const r = await mockApi.dismissGroup(group.id, reason.trim());
    setBusy(false);
    if (!r.ok) {
      setError('The group could not be dismissed. Try again.');
      return;
    }
    onOpenChange(false);
    void qc.invalidateQueries();
    toast({
      title: 'Group dismissed',
      description: 'These orders will not be grouped again. The reason is in the audit log.',
      tone: 'success',
    });
  };
  return (
    <Dialog
      open
      onOpenChange={onOpenChange}
      title="Not the same buyer?"
      description={`${group.memberRefs.join(', ')} will be shown as separate orders and never grouped again.`}
      footer={
        <>
          <Button
            onClick={() => {
              onOpenChange(false);
            }}
          >
            Cancel
          </Button>
          <Button variant="primary" disabled={busy} onClick={() => void save()}>
            Dismiss group
          </Button>
        </>
      }
    >
      <Field
        label="Reason"
        required
        error={error}
        hint="Kept in the audit log. Do not enter customer details."
      >
        <textarea
          aria-label="Reason"
          value={reason}
          onChange={(e) => {
            setReason(e.target.value);
          }}
          rows={3}
          className="w-full rounded-ctl border border-border bg-card px-3 py-2 text-13 shadow-card outline-none focus:border-brand-600"
        />
      </Field>
    </Dialog>
  );
}
