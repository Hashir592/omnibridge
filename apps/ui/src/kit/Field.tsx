import { Field as BaseField } from '@base-ui/react/field';
import type { InputHTMLAttributes, ReactNode, Ref } from 'react';
import { cn } from '../lib/cn.ts';

/** Shared look of every text-like control: 36 px, 8 px radius, petrol border on focus. */
export const controlClass =
  'h-9 w-full rounded-ctl border border-border bg-card px-3 text-13 text-ink shadow-card outline-none placeholder:text-ink-muted focus:border-brand-600 disabled:bg-rail disabled:text-ink-muted data-[invalid]:border-danger';

/**
 * A labelled form field: label, control, hint and error, wired together for screen readers.
 * Put an <Input>, <Select>, <Combobox> or <DatePicker> inside.
 */
export function Field({
  label,
  hint,
  error,
  required,
  className,
  children,
}: {
  label: string;
  hint?: ReactNode;
  /** When set, the field is marked invalid and the message shows under it. */
  error?: string | undefined;
  required?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <BaseField.Root invalid={!!error} className={cn('flex flex-col gap-1.5', className)}>
      <BaseField.Label className="text-13 font-medium text-ink">
        {label}
        {required && <span className="text-ink-muted"> (required)</span>}
      </BaseField.Label>
      {children}
      {hint && !error && (
        <BaseField.Description className="text-xs text-ink-muted">{hint}</BaseField.Description>
      )}
      <BaseField.Error match={!!error} className="text-xs font-medium text-danger">
        {error}
      </BaseField.Error>
    </BaseField.Root>
  );
}

export function Input({
  className,
  ref,
  onChange,
  ...rest
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'onChange'> & {
  onChange?: (value: string) => void;
  ref?: Ref<HTMLInputElement>;
}) {
  return (
    <BaseField.Control
      ref={ref}
      className={cn(controlClass, className)}
      onValueChange={(v) => onChange?.(v)}
      {...rest}
    />
  );
}
