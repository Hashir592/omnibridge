import { LoaderCircle } from 'lucide-react';
import type { ButtonHTMLAttributes, ReactNode, Ref } from 'react';
import { cn } from '../lib/cn.ts';

export type ButtonVariant = 'primary' | 'secondary' | 'dark' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

const VARIANT: Record<ButtonVariant, string> = {
  // Petrol is for the one main action on a screen (Create label, Save).
  primary: 'bg-brand-700 text-white shadow-card hover:bg-brand-800',
  secondary: 'border border-border bg-card text-ink shadow-card hover:bg-hover',
  dark: 'bg-side text-white shadow-card hover:bg-side-hover',
  ghost: 'text-ink-muted hover:bg-hover hover:text-ink',
  // Destructive actions: red text and border, never a solid red block.
  danger: 'border border-danger/40 bg-card text-danger shadow-card hover:bg-danger-bg',
};

const SIZE: Record<ButtonSize, string> = {
  sm: 'h-8 px-3 text-13 gap-1.5',
  md: 'h-9 px-3.5 text-13 gap-1.5',
  lg: 'h-11 px-4 text-sm gap-2',
};

/** The button look, for a link that must look like a button (e.g. "Go to sign in"). */
export function buttonClass(variant: ButtonVariant = 'secondary', size: ButtonSize = 'md'): string {
  return cn(
    'inline-flex shrink-0 items-center justify-center rounded-ctl font-medium whitespace-nowrap disabled:pointer-events-none disabled:opacity-50',
    VARIANT[variant],
    SIZE[size],
  );
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** A lucide icon element, shown before the label. */
  icon?: ReactNode;
  /** While its action runs: disabled, a spinner in place of the icon, and aria-busy. */
  busy?: boolean;
  ref?: Ref<HTMLButtonElement>;
}

export function Button({
  variant = 'secondary',
  size = 'md',
  icon,
  busy = false,
  className,
  children,
  type = 'button',
  disabled,
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={cn(buttonClass(variant, size), busy && 'disabled:opacity-70', className)}
      disabled={disabled === true || busy}
      aria-busy={busy || undefined}
      {...rest}
    >
      {busy ? (
        <span aria-hidden className="flex [&>svg]:size-4">
          <LoaderCircle className="motion-safe:animate-spin" />
        </span>
      ) : (
        icon && (
          <span aria-hidden className="flex [&>svg]:size-4">
            {icon}
          </span>
        )
      )}
      {children}
    </button>
  );
}

/** A square button with only an icon; the label is required for screen readers. */
export function IconButton({
  label,
  icon,
  className,
  ...rest
}: Omit<ButtonProps, 'children' | 'variant' | 'size'> & { label: string; icon: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={cn(
        'grid size-9 shrink-0 place-items-center rounded-ctl text-ink-muted hover:bg-hover hover:text-ink disabled:pointer-events-none disabled:opacity-50 [&>svg]:size-4',
        className,
      )}
      {...rest}
    >
      {icon}
    </button>
  );
}
