/**
 * Hand movements and a listing's buffer (T-0317, INV-2, INV-3). Each movement dialog makes one
 * client_ref when it opens, so a retry after a lost answer books nothing twice.
 */
import { useState } from 'react';
import {
  stockApi,
  type AdjustReason,
  type ApiReply,
  type Movement,
  type StockListing,
} from '../../auth/api.ts';
import { Button } from '../../kit/Button.tsx';
import { Dialog } from '../../kit/Dialog.tsx';
import { Field, Input } from '../../kit/Field.tsx';
import { Select } from '../../kit/Select.tsx';
import { formatInt } from '../../lib/format.ts';
import { InlineError } from '../catalogue/parts.tsx';
import { refusalText } from '../catalogue/rules.ts';
import { REASON_LABEL, adjustBody, stockInBody, wholeUnits } from './rules.ts';

/** Sends a write and sorts the answer into done, a field error or a refusal line. */
function useWrite<T>() {
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const run = async (call: () => Promise<ApiReply<T>>, fallback: string, onOk: (b: T) => void) => {
    setBusy(true);
    setRefusal(null);
    try {
      const r = await call();
      if (r.ok) onOk(r.body as T);
      else setRefusal(refusalText(r, fallback));
    } catch {
      setRefusal('The server did not answer. Try again: it will not be booked twice.');
    } finally {
      setBusy(false);
    }
  };
  return { busy, refusal, run };
}

export function StockInDialog({
  skuId,
  sku,
  onClose,
  onDone,
}: {
  skuId: string;
  sku: string;
  onClose: () => void;
  onDone: (m: Movement) => void;
}) {
  const [clientRef] = useState(() => crypto.randomUUID());
  const [f, setF] = useState({ quantity: '', supplier: '', notes: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const w = useWrite<Movement>();
  const save = () => {
    const r = stockInBody(f, clientRef);
    if (!r.ok) {
      setErrors(r.errors);
      return;
    }
    setErrors({});
    void w.run(
      () => stockApi.stockIn(skuId, r.body),
      'The stock-in could not be booked. Try again.',
      onDone,
    );
  };
  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title={`Stock in: ${sku}`}
      description="On hand goes up and every listing of this SKU is updated where its quantity changes."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={w.busy} onClick={save}>
            Book stock in
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="Units received" required error={errors.quantity}>
          <Input
            value={f.quantity}
            onChange={(v) => {
              setF({ ...f, quantity: v });
            }}
            inputMode="numeric"
            className="num w-32"
          />
        </Field>
        <Field label="Supplier">
          <Input
            value={f.supplier}
            onChange={(v) => {
              setF({ ...f, supplier: v });
            }}
            maxLength={200}
          />
        </Field>
        <Field
          label="Notes"
          hint="For example the delivery note number. Do not enter customer details."
        >
          <Input
            value={f.notes}
            onChange={(v) => {
              setF({ ...f, notes: v });
            }}
            maxLength={500}
          />
        </Field>
        {w.refusal && <InlineError>{w.refusal}</InlineError>}
      </div>
    </Dialog>
  );
}

const REASONS = (Object.keys(REASON_LABEL) as AdjustReason[]).map((r) => ({
  value: r,
  label: REASON_LABEL[r],
}));

export function AdjustDialog({
  skuId,
  sku,
  onHand,
  onClose,
  onDone,
}: {
  skuId: string;
  sku: string;
  onHand: number;
  onClose: () => void;
  onDone: (m: Movement) => void;
}) {
  const [clientRef] = useState(() => crypto.randomUUID());
  const [f, setF] = useState<{ delta: string; reason: AdjustReason | null; text: string }>({
    delta: '',
    reason: null,
    text: '',
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const w = useWrite<Movement>();
  const save = () => {
    const r = adjustBody(f, onHand, clientRef);
    if (!r.ok) {
      setErrors(r.errors);
      return;
    }
    setErrors({});
    void w.run(
      () => stockApi.adjust(skuId, r.body),
      'The adjustment could not be saved. Try again.',
      onDone,
    );
  };
  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title={`Adjust stock: ${sku}`}
      description={`On hand now: ${formatInt(onHand)}. Every adjustment needs a reason and goes in the change log.`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={w.busy} onClick={save}>
            Save adjustment
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field
          label="Change"
          required
          hint="Use a minus sign to take stock off, for example -2"
          error={errors.delta}
        >
          <Input
            value={f.delta}
            onChange={(v) => {
              setF({ ...f, delta: v });
            }}
            inputMode="numeric"
            placeholder="-2"
            className="num w-32"
          />
        </Field>
        <Field label="Reason" required error={errors.reason}>
          <Select
            options={REASONS}
            value={f.reason}
            onChange={(v) => {
              setF({ ...f, reason: v as AdjustReason | null });
            }}
            placeholder="Choose a reason"
          />
        </Field>
        <Field
          label="What happened"
          required={f.reason === 'other'}
          hint="Do not enter customer details."
          error={errors.text}
        >
          <Input
            value={f.text}
            onChange={(v) => {
              setF({ ...f, text: v });
            }}
            maxLength={500}
          />
        </Field>
        {w.refusal && <InlineError>{w.refusal}</InlineError>}
      </div>
    </Dialog>
  );
}

/** INV-2: a listing's own buffer, or back to its account's. */
export function ListingBufferDialog({
  listing,
  name,
  onClose,
  onDone,
}: {
  listing: StockListing;
  name: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [own, setOwn] = useState(listing.buffer_override);
  const [value, setValue] = useState(String(listing.buffer));
  const [error, setError] = useState<string | null>(null);
  const w = useWrite<StockListing>();
  const save = () => {
    const n = own ? wholeUnits(value) : null;
    if (own && n === null) {
      setError('Enter a whole number, 0 or more');
      return;
    }
    setError(null);
    void w.run(
      () => stockApi.setListingBuffer(listing.id, n),
      'The buffer could not be saved. Try again.',
      () => {
        onDone();
      },
    );
  };
  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      size="sm"
      title="Listing buffer"
      description={
        <>
          <span className="ref">{listing.external_sku}</span> on {name}. The listing shows available
          minus this, never below 0.
        </>
      }
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={w.busy} onClick={save}>
            Save buffer
          </Button>
        </>
      }
    >
      <fieldset className="flex flex-col gap-3">
        <legend className="sr-only">Which buffer</legend>
        <label className="flex items-center gap-2 text-13">
          <input
            type="radio"
            name="buffer-kind"
            checked={!own}
            onChange={() => {
              setOwn(false);
            }}
            className="size-4 accent-brand-600"
          />
          Use the account&rsquo;s buffer
        </label>
        <label className="flex items-center gap-2 text-13">
          <input
            type="radio"
            name="buffer-kind"
            checked={own}
            onChange={() => {
              setOwn(true);
            }}
            className="size-4 accent-brand-600"
          />
          Its own buffer
        </label>
        {own && (
          <Field label="Units kept back" error={error ?? undefined}>
            <Input value={value} onChange={setValue} inputMode="numeric" className="num w-24" />
          </Field>
        )}
        {w.refusal && <InlineError>{w.refusal}</InlineError>}
      </fieldset>
    </Dialog>
  );
}
