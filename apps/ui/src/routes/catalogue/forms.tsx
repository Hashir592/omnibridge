/**
 * Catalogue forms (T-0316): new SKU or bundle, edit details, VAT-type change, COGS from a date and
 * a new VAT rate. Each sends the contract body and shows the server's field errors and refusals.
 */
import { useQuery } from '@tanstack/react-query';
import { useId, useState, type ReactNode } from 'react';
import { useAppState } from '../../app/session.tsx';
import {
  catalogueApi,
  type ApiReply,
  type MasterSku,
  type MasterSkuUpdate,
  type VatType,
} from '../../auth/api.ts';
import { Button } from '../../kit/Button.tsx';
import { DatePicker } from '../../kit/DatePicker.tsx';
import { Dialog, Sheet } from '../../kit/Dialog.tsx';
import { Field, Input } from '../../kit/Field.tsx';
import { Select } from '../../kit/Select.tsx';
import { cn } from '../../lib/cn.ts';
import { todayLondon } from '../../lib/dates.ts';
import { InlineError, SkuPicker } from './parts.tsx';
import {
  VAT_NAME,
  VAT_TYPES,
  fieldErrors,
  rateNumber,
  newSkuBody,
  parsePounds,
  parseRate,
  penceToPounds,
  refusalText,
  type NewSkuForm,
} from './rules.ts';

const vatOptions = VAT_TYPES.map((t) => ({ value: t, label: VAT_NAME[t] }));

/** Runs a write and sorts its answer into field errors, a refusal line, or success. */
function useSubmit<T>() {
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [refusal, setRefusal] = useState<string | null>(null);
  const submit = async (
    call: () => Promise<ApiReply<T>>,
    fallback: string,
    onOk: (body: T) => void,
  ) => {
    setBusy(true);
    setRefusal(null);
    try {
      const r = await call();
      if (r.ok) {
        setErrors({});
        onOk(r.body as T);
        return;
      }
      const fields = fieldErrors(r);
      setErrors(fields);
      if (Object.keys(fields).length === 0) setRefusal(refusalText(r, fallback));
    } catch {
      setRefusal('The server did not answer. Try again.');
    } finally {
      setBusy(false);
    }
  };
  const reset = () => {
    setErrors({});
    setRefusal(null);
  };
  return { busy, errors, setErrors, refusal, submit, reset };
}

/** CAT-1 manufacturer: pick one used before or type a new one (a native list, keyboard-friendly). */
function ManufacturerInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { session, persona } = useAppState();
  const listId = useId();
  const names = useQuery({
    queryKey: ['manufacturers', persona],
    queryFn: catalogueApi.manufacturers,
    enabled: !!session,
    staleTime: 60_000,
  });
  return (
    <>
      <Input value={value} onChange={onChange} list={listId} autoComplete="off" maxLength={100} />
      <datalist id={listId}>
        {(names.data ?? []).map((n) => (
          <option key={n} value={n} />
        ))}
      </datalist>
    </>
  );
}

function Grid({ children, cols = 2 }: { children: ReactNode; cols?: 2 | 3 }) {
  return (
    <div className={cn('grid gap-3', cols === 3 ? 'grid-cols-3' : 'grid-cols-2')}>{children}</div>
  );
}

const EMPTY: NewSkuForm = {
  kind: 'single',
  sku: '',
  title: '',
  shortDescription: '',
  weightG: '',
  manufacturer: '',
  barcode: '',
  vatType: null,
  cogs: '',
  cogsFrom: null,
  componentId: null,
  packSize: '2',
};

/** CAT-1 and CAT-3: a plain SKU or a bundle of one component SKU. */
export function NewSkuSheet({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (s: MasterSku) => void;
}) {
  const [f, setF] = useState<NewSkuForm>({ ...EMPTY, cogsFrom: todayLondon() });
  const s = useSubmit<MasterSku>();
  const set = (patch: Partial<NewSkuForm>) => {
    setF((prev) => ({ ...prev, ...patch }));
  };
  const close = () => {
    setF({ ...EMPTY, cogsFrom: todayLondon() });
    s.reset();
    onOpenChange(false);
  };
  const save = () => {
    const r = newSkuBody(f);
    if (!r.ok) {
      s.setErrors(r.errors);
      return;
    }
    void s.submit(
      () => catalogueApi.createSku(r.body),
      'The SKU could not be created. Try again.',
      (sku) => {
        close();
        onCreated(sku);
      },
    );
  };
  const bundle = f.kind === 'bundle';
  const kindName = useId();

  return (
    <Sheet
      open={open}
      onOpenChange={(o) => {
        if (!o) close();
      }}
      title="New SKU"
      description="A Master SKU is the product you stock. Channel listings map to it by SKU code."
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button variant="primary" disabled={s.busy} onClick={save}>
            {bundle ? 'Create bundle' : 'Create SKU'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <fieldset>
          <legend className="text-13 font-medium">Type</legend>
          <div className="mt-1.5 flex gap-4">
            {(
              [
                ['single', 'Single product'],
                ['bundle', 'Bundle of one SKU'],
              ] as const
            ).map(([kind, label]) => (
              <label key={kind} className="flex h-9 items-center gap-2 text-13">
                <input
                  type="radio"
                  name={kindName}
                  checked={f.kind === kind}
                  onChange={() => {
                    set({ kind });
                    s.reset();
                  }}
                  className="size-4 accent-brand-600"
                />
                {label}
              </label>
            ))}
          </div>
        </fieldset>

        <Field
          label="SKU code"
          required
          error={s.errors.sku}
          hint="Matched exactly against your channel SKUs. It cannot change later."
        >
          <Input
            value={f.sku}
            onChange={(v) => {
              set({ sku: v });
            }}
            maxLength={64}
            className="ref"
          />
        </Field>
        <Field label="Title" required error={s.errors.title}>
          <Input
            value={f.title}
            onChange={(v) => {
              set({ title: v });
            }}
            maxLength={200}
          />
        </Field>
        <Field
          label="Short description"
          required
          error={s.errors.short_description}
          hint="Printed as the item description on labels and customs forms. Up to 100 characters."
        >
          <Input
            value={f.shortDescription}
            onChange={(v) => {
              set({ shortDescription: v });
            }}
            maxLength={100}
          />
        </Field>

        {bundle ? (
          <>
            <Field
              label="Holds this SKU"
              required
              error={s.errors['bundle.component_id']}
              hint="A bundle holds units of one plain SKU. Its stock, VAT type and COGS follow that SKU."
            >
              <SkuPicker
                value={f.componentId}
                onChange={(id) => {
                  set({ componentId: id });
                }}
                plainOnly
              />
            </Field>
            <Field
              label="Units in the pack"
              required
              error={s.errors['bundle.pack_size']}
              hint="2 or more."
            >
              <Input
                value={f.packSize}
                onChange={(v) => {
                  set({ packSize: v });
                }}
                inputMode="numeric"
                className="num w-28"
              />
            </Field>
          </>
        ) : (
          <>
            <Field
              label="VAT type"
              required
              error={s.errors.vat_type}
              hint="Zero-rated and No VAT are different: zero-rated sales still go on the VAT return."
            >
              <Select
                options={vatOptions}
                value={f.vatType}
                onChange={(v) => {
                  set({ vatType: v as VatType | null });
                }}
                placeholder="Choose a VAT type"
              />
            </Field>
            <Grid>
              <Field
                label="COGS per unit"
                error={s.errors.cogs_pence}
                hint="Pounds, ex VAT. Optional."
              >
                <Input
                  value={f.cogs}
                  onChange={(v) => {
                    set({ cogs: v });
                  }}
                  inputMode="decimal"
                  placeholder="0.00"
                  className="num"
                />
              </Field>
              <Field label="COGS from" error={s.errors.cogs_effective_from}>
                <DatePicker
                  value={f.cogsFrom}
                  onChange={(v) => {
                    set({ cogsFrom: v });
                  }}
                />
              </Field>
            </Grid>
          </>
        )}

        <Grid>
          <Field label="Weight (g)" required error={s.errors.weight_g}>
            <Input
              value={f.weightG}
              onChange={(v) => {
                set({ weightG: v });
              }}
              inputMode="numeric"
              className="num"
            />
          </Field>
          <Field label="Barcode" error={s.errors.barcode}>
            <Input
              value={f.barcode}
              onChange={(v) => {
                set({ barcode: v });
              }}
              maxLength={64}
              className="ref"
            />
          </Field>
        </Grid>
        <Field
          label="Manufacturer"
          error={s.errors.manufacturer}
          hint="Pick one you used before or type a new one."
        >
          <ManufacturerInput
            value={f.manufacturer}
            onChange={(v) => {
              set({ manufacturer: v });
            }}
          />
        </Field>
        {s.refusal && <InlineError>{s.refusal}</InlineError>}
      </div>
    </Sheet>
  );
}

interface EditForm {
  title: string;
  shortDescription: string;
  barcode: string;
  manufacturer: string;
  weightG: string;
  length: string;
  width: string;
  height: string;
  imageUrl: string;
  purchaseVat: string;
  lead: string;
  safety: string;
  cover: string;
  active: boolean;
}

function editForm(s: MasterSku): EditForm {
  return {
    title: s.title,
    shortDescription: s.short_description,
    barcode: s.barcode ?? '',
    manufacturer: s.manufacturer ?? '',
    weightG: String(s.weight_g),
    length: s.dimensions ? String(s.dimensions.length_mm) : '',
    width: s.dimensions ? String(s.dimensions.width_mm) : '',
    height: s.dimensions ? String(s.dimensions.height_mm) : '',
    imageUrl: s.image_url ?? '',
    purchaseVat: s.purchase_vat_rate_bp === null ? '' : rateNumber(s.purchase_vat_rate_bp),
    lead: String(s.reorder.lead_time_days),
    safety: String(s.reorder.safety_days),
    cover: String(s.reorder.target_cover_days),
    active: s.active,
  };
}

const int = (t: string, max: number) =>
  /^\s*\d+\s*$/.test(t) && Number(t) <= max ? Number(t) : null;

/** The edit body; the SKU code and a bundle's make-up are never sent (read-only). */
export function editBody(
  f: EditForm,
): { ok: true; body: MasterSkuUpdate } | { ok: false; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  if (!f.title.trim()) errors.title = 'Enter a title';
  if (!f.shortDescription.trim()) errors.short_description = 'Enter a short description';
  const weight = int(f.weightG, 1_000_000);
  if (weight === null) errors.weight_g = 'Enter the weight in whole grams';
  const dims = [f.length, f.width, f.height];
  const anyDim = dims.some((d) => d.trim());
  const dimNums = dims.map((d) => int(d, 10_000));
  if (anyDim && dimNums.some((n) => n === null || n < 1))
    errors.dimensions = 'Enter all three sizes in whole millimetres, or none';
  let purchase: number | null = null;
  if (f.purchaseVat.trim()) {
    purchase = parseRate(f.purchaseVat);
    if (purchase === null)
      errors.purchase_vat_rate_bp = 'Enter a rate from 0 to 100, for example 20';
  }
  const lead = int(f.lead, 365);
  const safety = int(f.safety, 365);
  const cover = int(f.cover, 730);
  if (lead === null || safety === null || cover === null)
    errors.reorder = 'Enter whole days: lead and safety up to 365, cover up to 730';
  if (f.imageUrl.trim() && !/^https?:\/\/\S+$/.test(f.imageUrl.trim()))
    errors.image_url = 'Enter a full web address starting with https://';
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    body: {
      title: f.title.trim(),
      short_description: f.shortDescription.trim(),
      barcode: f.barcode.trim() || null,
      manufacturer: f.manufacturer.trim() || null,
      weight_g: weight ?? 0,
      dimensions: anyDim
        ? { length_mm: dimNums[0] ?? 1, width_mm: dimNums[1] ?? 1, height_mm: dimNums[2] ?? 1 }
        : null,
      image_url: f.imageUrl.trim() || null,
      purchase_vat_rate_bp: purchase,
      reorder: {
        lead_time_days: lead ?? 0,
        safety_days: safety ?? 0,
        target_cover_days: cover ?? 0,
      },
      active: f.active,
    },
  };
}

export function EditSkuSheet({
  sku,
  open,
  onOpenChange,
  onSaved,
}: {
  sku: MasterSku;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: (s: MasterSku) => void;
}) {
  const [f, setF] = useState<EditForm>(() => editForm(sku));
  const s = useSubmit<MasterSku>();
  const set = (patch: Partial<EditForm>) => {
    setF((prev) => ({ ...prev, ...patch }));
  };
  const close = () => {
    setF(editForm(sku));
    s.reset();
    onOpenChange(false);
  };
  const save = () => {
    const r = editBody(f);
    if (!r.ok) {
      s.setErrors(r.errors);
      return;
    }
    void s.submit(
      () => catalogueApi.updateSku(sku.id, r.body),
      'The changes could not be saved. Try again.',
      (saved) => {
        s.reset();
        onOpenChange(false);
        onSaved(saved);
      },
    );
  };
  const activeId = useId();

  return (
    <Sheet
      open={open}
      onOpenChange={(o) => {
        if (!o) close();
      }}
      title={`Edit ${sku.sku}`}
      description="The SKU code cannot change. To change a bundle's make-up, create a new bundle SKU."
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button variant="primary" disabled={s.busy} onClick={save}>
            Save changes
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="Title" required error={s.errors.title}>
          <Input
            value={f.title}
            onChange={(v) => {
              set({ title: v });
            }}
            maxLength={200}
          />
        </Field>
        <Field
          label="Short description"
          required
          error={s.errors.short_description}
          hint="Printed on labels and customs forms."
        >
          <Input
            value={f.shortDescription}
            onChange={(v) => {
              set({ shortDescription: v });
            }}
            maxLength={100}
          />
        </Field>
        <Grid>
          <Field label="Barcode" error={s.errors.barcode}>
            <Input
              value={f.barcode}
              onChange={(v) => {
                set({ barcode: v });
              }}
              maxLength={64}
              className="ref"
            />
          </Field>
          <Field label="Weight (g)" required error={s.errors.weight_g}>
            <Input
              value={f.weightG}
              onChange={(v) => {
                set({ weightG: v });
              }}
              inputMode="numeric"
              className="num"
            />
          </Field>
        </Grid>
        <Field label="Manufacturer" error={s.errors.manufacturer}>
          <ManufacturerInput
            value={f.manufacturer}
            onChange={(v) => {
              set({ manufacturer: v });
            }}
          />
        </Field>
        <fieldset className="flex flex-col gap-1.5">
          <legend className="text-13 font-medium">Dimensions (mm)</legend>
          <Grid cols={3}>
            <Input
              aria-label="Length in mm"
              placeholder="Length"
              value={f.length}
              onChange={(v) => {
                set({ length: v });
              }}
              inputMode="numeric"
              className="num"
            />
            <Input
              aria-label="Width in mm"
              placeholder="Width"
              value={f.width}
              onChange={(v) => {
                set({ width: v });
              }}
              inputMode="numeric"
              className="num"
            />
            <Input
              aria-label="Height in mm"
              placeholder="Height"
              value={f.height}
              onChange={(v) => {
                set({ height: v });
              }}
              inputMode="numeric"
              className="num"
            />
          </Grid>
          {s.errors.dimensions && <InlineError>{s.errors.dimensions}</InlineError>}
        </fieldset>
        <Field label="Image address" error={s.errors.image_url}>
          <Input
            value={f.imageUrl}
            onChange={(v) => {
              set({ imageUrl: v });
            }}
            placeholder="https://"
          />
        </Field>
        <Field
          label="Purchase VAT rate (%)"
          error={s.errors.purchase_vat_rate_bp}
          hint="Only when you pay a different VAT rate on purchases than the SKU's VAT type. Leave empty otherwise."
        >
          <Input
            value={f.purchaseVat}
            onChange={(v) => {
              set({ purchaseVat: v });
            }}
            inputMode="decimal"
            className="num w-28"
          />
        </Field>
        <fieldset className="flex flex-col gap-1.5">
          <legend className="text-13 font-medium">Reorder settings (days)</legend>
          <Grid cols={3}>
            <Field label="Lead time">
              <Input
                value={f.lead}
                onChange={(v) => {
                  set({ lead: v });
                }}
                inputMode="numeric"
                className="num"
              />
            </Field>
            <Field label="Safety stock">
              <Input
                value={f.safety}
                onChange={(v) => {
                  set({ safety: v });
                }}
                inputMode="numeric"
                className="num"
              />
            </Field>
            <Field label="Target cover">
              <Input
                value={f.cover}
                onChange={(v) => {
                  set({ cover: v });
                }}
                inputMode="numeric"
                className="num"
              />
            </Field>
          </Grid>
          {s.errors.reorder && <InlineError>{s.errors.reorder}</InlineError>}
        </fieldset>
        <label htmlFor={activeId} className="flex h-9 items-center gap-2 text-13">
          <input
            id={activeId}
            type="checkbox"
            checked={f.active}
            onChange={(e) => {
              set({ active: e.target.checked });
            }}
            className="size-4 accent-brand-600"
          />
          Active
          <span className="text-ink-muted">
            (inactive SKUs stay on past orders but not in pickers)
          </span>
        </label>
        {s.refusal && <InlineError>{s.refusal}</InlineError>}
      </div>
    </Sheet>
  );
}

/** ADR-078: a new VAT type from a day on; past order lines keep their snapshot. */
export function VatChangeDialog({
  sku,
  open,
  onOpenChange,
  onSaved,
}: {
  sku: MasterSku;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: (s: MasterSku) => void;
}) {
  const [type, setType] = useState<VatType | null>(null);
  const [from, setFrom] = useState<string | null>(todayLondon());
  const s = useSubmit<MasterSku>();
  const close = () => {
    setType(null);
    setFrom(todayLondon());
    s.reset();
    onOpenChange(false);
  };
  const save = () => {
    if (!type || !from) {
      s.setErrors({
        ...(type ? {} : { vat_type: 'Choose a VAT type' }),
        ...(from ? {} : { effective_from: 'Choose the first day' }),
      });
      return;
    }
    void s.submit(
      () => catalogueApi.updateSku(sku.id, { vat: { vat_type: type, effective_from: from } }),
      'The VAT type could not be changed. Try again.',
      (saved) => {
        close();
        onSaved(saved);
      },
    );
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) close();
      }}
      title="Change VAT type"
      description="Orders placed before the date keep the VAT type they were sold under."
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button variant="primary" disabled={s.busy} onClick={save}>
            Change VAT type
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="New VAT type" required error={s.errors.vat_type ?? s.errors['vat.vat_type']}>
          <Select
            options={vatOptions}
            value={type}
            onChange={(v) => {
              setType(v as VatType | null);
            }}
            placeholder="Choose a VAT type"
          />
        </Field>
        <Field
          label="From"
          required
          error={s.errors.effective_from ?? s.errors['vat.effective_from']}
        >
          <DatePicker value={from} onChange={setFrom} />
        </Field>
        {s.refusal && <InlineError>{s.refusal}</InlineError>}
      </div>
    </Dialog>
  );
}

/** CAT-4: a COGS from a day on; the same day again replaces it. */
export function CogsDialog({
  sku,
  open,
  onOpenChange,
  onSaved,
}: {
  sku: MasterSku;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const latest = sku.cogs_history[0];
  const [amount, setAmount] = useState('');
  const [from, setFrom] = useState<string | null>(todayLondon());
  const s = useSubmit<unknown>();
  const close = () => {
    setAmount('');
    setFrom(todayLondon());
    s.reset();
    onOpenChange(false);
  };
  const save = () => {
    const pence = parsePounds(amount);
    if (pence === null || !from) {
      s.setErrors({
        ...(pence === null ? { cogs_pence: 'Enter the cost in pounds, for example 12.34' } : {}),
        ...(from ? {} : { effective_from: 'Choose the first day' }),
      });
      return;
    }
    void s.submit(
      () => catalogueApi.setCogs(sku.id, { cogs_pence: pence, effective_from: from }),
      'The COGS could not be saved. Try again.',
      () => {
        close();
        onSaved();
      },
    );
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) close();
      }}
      title={`Set COGS for ${sku.sku}`}
      description="Cost per unit, ex VAT. A cost on a day that already has one replaces it. Orders keep the COGS of the day they were placed."
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button variant="primary" disabled={s.busy} onClick={save}>
            Save COGS
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field
          label="COGS per unit (£)"
          required
          error={s.errors.cogs_pence}
          {...(latest ? { hint: `Latest: £${penceToPounds(latest.cogs_pence)}` } : {})}
        >
          <Input
            value={amount}
            onChange={setAmount}
            inputMode="decimal"
            placeholder="0.00"
            className="num w-36"
          />
        </Field>
        <Field label="From" required error={s.errors.effective_from}>
          <DatePicker value={from} onChange={setFrom} />
        </Field>
        {s.refusal && <InlineError>{s.refusal}</InlineError>}
      </div>
    </Dialog>
  );
}

/** CAT-2: a new rate for one VAT type from a day (admins only; a future change needs no code). */
export function AddVatRateDialog({
  open,
  onOpenChange,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const [type, setType] = useState<VatType | null>(null);
  const [rate, setRate] = useState('');
  const [from, setFrom] = useState<string | null>(null);
  const s = useSubmit<unknown>();
  const close = () => {
    setType(null);
    setRate('');
    setFrom(null);
    s.reset();
    onOpenChange(false);
  };
  const fixedZero = type === 'zero' || type === 'no_vat';
  const save = () => {
    const bp = fixedZero ? 0 : parseRate(rate);
    if (!type || bp === null || !from) {
      s.setErrors({
        ...(type ? {} : { vat_type: 'Choose a VAT type' }),
        ...(bp === null ? { rate_bp: 'Enter a rate from 0 to 100, for example 20' } : {}),
        ...(from ? {} : { effective_from: 'Choose the first day' }),
      });
      return;
    }
    void s.submit(
      () => catalogueApi.createVatRate({ vat_type: type, rate_bp: bp, effective_from: from }),
      'The rate could not be added. Try again.',
      () => {
        close();
        onSaved();
      },
    );
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) close();
      }}
      title="Add a VAT rate"
      description="Use this when HMRC changes a rate. Orders placed before the date keep the old rate."
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button variant="primary" disabled={s.busy} onClick={save}>
            Add rate
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="VAT type" required error={s.errors.vat_type}>
          <Select
            options={vatOptions}
            value={type}
            onChange={(v) => {
              setType(v as VatType | null);
            }}
            placeholder="Choose a VAT type"
          />
        </Field>
        <Field
          label="Rate (%)"
          required
          error={s.errors.rate_bp}
          {...(fixedZero ? { hint: 'Zero-rated and No VAT are always 0%.' } : {})}
        >
          <Input
            value={fixedZero ? '0' : rate}
            onChange={setRate}
            disabled={fixedZero}
            inputMode="decimal"
            className="num w-28"
          />
        </Field>
        <Field label="From" required error={s.errors.effective_from}>
          <DatePicker value={from} onChange={setFrom} />
        </Field>
        {s.refusal && <InlineError>{s.refusal}</InlineError>}
      </div>
    </Dialog>
  );
}
