import { Download, Plus, Printer, Trash2 } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { AlertStrip, Badge, Count, SignalLabel, StatusLabel } from '../kit/Badge.tsx';
import { Button, IconButton } from '../kit/Button.tsx';
import { Combobox } from '../kit/Combobox.tsx';
import { DatePicker } from '../kit/DatePicker.tsx';
import { ConfirmDialog, Dialog, Sheet } from '../kit/Dialog.tsx';
import { Field, Input } from '../kit/Field.tsx';
import { Select } from '../kit/Select.tsx';
import { Skeleton } from '../kit/Skeleton.tsx';
import { Tabs } from '../kit/Tabs.tsx';
import { useToast } from '../kit/Toast.tsx';
import { formatUkDate } from '../lib/dates.ts';

/* Gallery sections for the controls (T-0302). Synthetic data only. */

const CARRIERS = [
  { value: 'rm48', label: 'Royal Mail Tracked 48' },
  { value: 'rm24', label: 'Royal Mail Tracked 24' },
  { value: 'evri', label: 'Evri Standard' },
  { value: 'dpd', label: 'DPD Next Day' },
];

const SKUS = Array.from({ length: 60 }, (_, i) => ({
  value: `SKU-${String(10000 + i)}`,
  label: `SKU-${String(10000 + i)} · ${['Oak', 'Steel', 'Linen', 'Copper'][i % 4] ?? ''} ${['shelf', 'mug', 'lamp'][i % 3] ?? ''}`,
}));

export function ControlsGallery({ Section }: { Section: SectionComponent }) {
  return (
    <>
      <Section id="buttons" title="Buttons">
        <Panel>
          <Row label="Variants">
            <Button variant="primary" icon={<Printer />}>
              Create label
            </Button>
            <Button variant="secondary" icon={<Download />}>
              Export CSV
            </Button>
            <Button variant="dark">Apply</Button>
            <Button variant="ghost">Cancel</Button>
            <Button variant="danger" icon={<Trash2 />}>
              Delete note
            </Button>
          </Row>
          <Row label="Sizes">
            <Button variant="primary" size="sm">
              Small
            </Button>
            <Button variant="primary" size="md">
              Medium
            </Button>
            <Button variant="primary" size="lg">
              Large (shipping desk)
            </Button>
          </Row>
          <Row label="Disabled and icon only">
            <Button variant="primary" disabled>
              Create label
            </Button>
            <Button disabled>Export CSV</Button>
            <IconButton label="Add reminder" icon={<Plus />} />
            <IconButton label="Delete" icon={<Trash2 />} />
          </Row>
        </Panel>
      </Section>

      <Section id="forms" title="Form fields">
        <FormDemo />
      </Section>

      <Section id="badges" title="Status, badges and alerts">
        <Panel>
          <Row label="Status (icon + label, ADR-041)">
            <StatusLabel tone="success">Delivered</StatusLabel>
            <StatusLabel tone="warning">Tracking not confirmed</StatusLabel>
            <StatusLabel tone="danger">Label failed</StatusLabel>
            <StatusLabel tone="info">In transit</StatusLabel>
            <StatusLabel tone="neutral">Cancelled</StatusLabel>
          </Row>
          <Row label="Signal labels (PRD marks)">
            <SignalLabel signal="Provisional" />
            <SignalLabel signal="Estimate" />
            <SignalLabel signal="Allocated estimate" />
            <SignalLabel signal="Native" />
            <SignalLabel signal="Derived" />
          </Row>
          <Row label="Badge and count">
            <Badge>Admin</Badge>
            <Badge>Read only</Badge>
            <Count value={7} />
            <Count value={1240} />
          </Row>
          <div className="flex flex-col gap-2 pt-2">
            <AlertStrip tone="danger" title="3 orders are oversold.">
              Cancel or source stock for them before 14:00 today.
            </AlertStrip>
            <AlertStrip
              tone="warning"
              title="Amazon has not confirmed tracking for 5 orders."
              action={<Button size="sm">View orders</Button>}
            >
              Check the tracking numbers; Amazon may hold payment until it confirms.
            </AlertStrip>
            <AlertStrip tone="info" title="Figures for this month are provisional.">
              They settle once Amazon sends the monthly fee report.
            </AlertStrip>
          </div>
        </Panel>
      </Section>

      <Section id="tabs" title="Section tabs">
        <TabsDemo />
      </Section>

      <Section id="overlays" title="Dialog, sheet, confirm and toast">
        <OverlaysDemo />
      </Section>

      <Section id="skeleton" title="Skeleton (shown only after 300 ms)">
        <Panel>
          <div className="flex flex-col gap-3">
            <Skeleton className="h-4 w-48" />
            <Skeleton className="h-3 w-72" />
            <Skeleton className="h-3 w-60" />
          </div>
        </Panel>
      </Section>
    </>
  );
}

export type SectionComponent = (p: { id: string; title: string; children: ReactNode }) => ReactNode;

function Panel({ children }: { children: ReactNode }) {
  return (
    <div className="flex max-w-4xl flex-col gap-4 rounded-card border border-border bg-card p-4 shadow-card">
      {children}
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <div className="mb-2 text-xs text-ink-muted">{label}</div>
      <div className="flex flex-wrap items-center gap-3">{children}</div>
    </div>
  );
}

function FormDemo() {
  const [ref, setRef] = useState('');
  const [carrier, setCarrier] = useState<string | null>('rm48');
  const [sku, setSku] = useState<string | null>(null);
  const [date, setDate] = useState<string | null>('2026-10-19');
  const [weight, setWeight] = useState('abc');
  return (
    <Panel>
      <div className="grid gap-x-6 gap-y-5 sm:grid-cols-2">
        <Field label="Order ref" hint="Amazon, eBay or website order number">
          <Input value={ref} onChange={setRef} placeholder="e.g. 204-1234567-1234567" />
        </Field>
        <Field
          label="Weight (g)"
          error={/^\d+$/.test(weight) ? undefined : 'Enter whole grams, for example 450.'}
        >
          <Input value={weight} onChange={setWeight} inputMode="numeric" />
        </Field>
        <Field label="Carrier service" required>
          <Select options={CARRIERS} value={carrier} onChange={setCarrier} />
        </Field>
        <Field label="SKU" hint="Searchable list">
          <Combobox options={SKUS} value={sku} onChange={setSku} placeholder="Type a SKU or name" />
        </Field>
        <Field
          label="Ship by"
          hint={date ? `Stored as ${date}, shown as ${formatUkDate(date)}` : 'Empty'}
        >
          <DatePicker value={date} onChange={setDate} />
        </Field>
        <Field label="Disabled">
          <Input value="Read only for packers" disabled />
        </Field>
      </div>
    </Panel>
  );
}

function TabsDemo() {
  const [tab, setTab] = useState<'summary' | 'history' | 'notes'>('summary');
  return (
    <Panel>
      <Tabs
        label="Order sections"
        value={tab}
        onChange={setTab}
        items={[
          {
            value: 'summary',
            label: 'Summary',
            content: <p className="text-13">Lines, money and the label.</p>,
          },
          {
            value: 'history',
            label: 'History',
            content: <p className="text-13">Every change, newest first.</p>,
          },
          {
            value: 'notes',
            label: 'Notes',
            content: <p className="text-13">Do not store customer details here.</p>,
          },
        ]}
      />
    </Panel>
  );
}

function OverlaysDemo() {
  const [dialog, setDialog] = useState(false);
  const [sheet, setSheet] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const toast = useToast();
  return (
    <Panel>
      <Row label="Open each one">
        <Button
          onClick={() => {
            setDialog(true);
          }}
        >
          Open dialog
        </Button>
        <Button
          onClick={() => {
            setSheet(true);
          }}
        >
          Open sheet
        </Button>
        <Button
          variant="danger"
          onClick={() => {
            setConfirm(true);
          }}
        >
          Delete 3 notes
        </Button>
        <Button
          onClick={() => {
            toast({
              title: 'Label created',
              description: 'Order 204-1504360 is ready to print.',
              tone: 'success',
            });
          }}
        >
          Success toast
        </Button>
        <Button
          onClick={() => {
            toast({
              title: 'Label failed',
              description: 'DPD rejected the postcode. Fix the address and try again.',
              tone: 'error',
            });
          }}
        >
          Error toast (stays)
        </Button>
      </Row>
      <Dialog
        open={dialog}
        onOpenChange={setDialog}
        title="Change carrier service"
        description="Applies to the 4 selected orders."
        footer={
          <>
            <Button
              variant="ghost"
              onClick={() => {
                setDialog(false);
              }}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                setDialog(false);
              }}
            >
              Change service
            </Button>
          </>
        }
      >
        <Field label="Carrier service">
          <Select options={CARRIERS} value="rm24" onChange={() => undefined} />
        </Field>
      </Dialog>
      <Sheet
        open={sheet}
        onOpenChange={setSheet}
        title="Add reminder"
        description="Shows on Home when it is due."
        footer={
          <>
            <Button
              variant="ghost"
              onClick={() => {
                setSheet(false);
              }}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                setSheet(false);
              }}
            >
              Save reminder
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <AlertStrip tone="info" title="Do not store customer details here.">
            Reminders are visible to everyone with the Reminders tab.
          </AlertStrip>
          <Field label="What to do">
            <Input placeholder="e.g. Reorder oak brackets" />
          </Field>
          <Field label="Due">
            <DatePicker value={null} onChange={() => undefined} />
          </Field>
        </div>
      </Sheet>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title="Delete 3 notes?"
        description="They are removed for everyone and cannot be recovered."
        confirmLabel="Delete 3 notes"
        destructive
        onConfirm={() => {
          toast({ title: '3 notes deleted', tone: 'success' });
        }}
      />
    </Panel>
  );
}
