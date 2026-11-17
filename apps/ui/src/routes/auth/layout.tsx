import {
  Boxes,
  CircleAlert,
  CircleCheck,
  Info,
  ReceiptText,
  ShieldCheck,
  Truck,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '../../lib/cn.ts';

const FACTS = [
  { icon: Boxes, text: 'Orders and stock from Amazon, eBay in one place' },
  { icon: Truck, text: 'Evri and DPD labels straight from the shipping desk' },
  { icon: ReceiptText, text: 'Profit and a VAT ledger for every company you run' },
  { icon: ShieldCheck, text: 'Two-step sign in on every account; data protected' },
];

function Logo() {
  return (
    <img src="/brand/logo.webp" alt="OmniBridge" width={109} height={32} className="h-8 w-auto" />
  );
}

const footerLink = 'hover:text-ink hover:underline';

/**
 * The frame every auth screen sits in (T-0303). Split screen, the usual pattern for B2B sign in:
 * a graphite panel (the sidebar colour) on the left with plain facts about the product; logo,
 * form and footer on the right (Hashir, 20/10/2026). The form comes first in the DOM, so keyboard
 * and screen-reader order still starts at the form. No illustration, gradient or motion (DIRECTION §6). Below 1024 px the
 * panel goes and the form keeps its logo and footer, so the page never looks unfinished.
 */
export function AuthFrame({
  title,
  intro,
  width = 'narrow',
  children,
  below,
}: {
  title: string;
  intro?: ReactNode;
  width?: 'narrow' | 'wide';
  children: ReactNode;
  /** Small print under the form, e.g. the invite-only note. */
  below?: ReactNode;
}) {
  return (
    <div className="flex min-h-dvh bg-card">
      <div className="flex min-w-0 flex-1 flex-col px-6 py-6 sm:px-10 lg:px-14">
        <header>
          <Logo />
        </header>
        <main className="flex flex-1 items-center justify-center py-10">
          <div className={cn('w-full', width === 'wide' ? 'max-w-[520px]' : 'max-w-[400px]')}>
            <h1 className="text-2xl font-semibold tracking-[-0.015em]">{title}</h1>
            {intro && <div className="mt-2 text-sm text-ink-muted">{intro}</div>}
            <div className="mt-8">{children}</div>
            {below && <div className="mt-8 text-13 text-ink-muted">{below}</div>}
          </div>
        </main>
        <footer className="flex flex-wrap items-center gap-x-5 gap-y-1 text-xs text-ink-muted">
          <span>© {new Date().getFullYear()} OmniBridge</span>
          <a href="https://omnibridge.co.uk/privacy" className={footerLink}>
            Privacy
          </a>
          <a href="https://omnibridge.co.uk/terms" className={footerLink}>
            Terms
          </a>
          <a href="https://omnibridge.co.uk/contact" className={footerLink}>
            Contact
          </a>
        </footer>
      </div>
      <aside
        aria-label="About OmniBridge"
        className="hidden w-[44%] max-w-[640px] shrink-0 flex-col lg:order-first justify-center bg-side p-14 text-white lg:flex"
      >
        <div className="max-w-[440px]">
          <p className="text-[28px] leading-9 font-semibold tracking-[-0.02em]">
            The back office for UK sellers on Amazon, eBay
          </p>
          <ul className="mt-10 flex flex-col gap-5">
            {FACTS.map(({ icon: Icon, text }) => (
              <li key={text} className="flex items-start gap-3.5 text-sm text-side-text">
                <span className="grid size-8 shrink-0 place-items-center rounded-ctl bg-white/8">
                  <Icon className="size-4 text-white" aria-hidden strokeWidth={1.75} />
                </span>
                <span className="pt-1.5">{text}</span>
              </li>
            ))}
          </ul>
        </div>
      </aside>
    </div>
  );
}

type Tone = 'danger' | 'warning' | 'success' | 'info';

const TONE: Record<Tone, { text: string; icon: ReactNode }> = {
  danger: { text: 'text-danger', icon: <CircleAlert className="size-4" aria-hidden /> },
  warning: { text: 'text-warning', icon: <CircleAlert className="size-4" aria-hidden /> },
  success: { text: 'text-success', icon: <CircleCheck className="size-4" aria-hidden /> },
  info: { text: 'text-ink-muted', icon: <Info className="size-4" aria-hidden /> },
};

/**
 * An inline form message: icon and coloured text, no box or tint (Hashir, 20/10/2026: a tinted
 * banner reads as slop; plain inline text is the usual pattern). Errors are announced (role=alert).
 */
export function Notice({
  tone,
  title,
  children,
  className,
}: {
  tone: Tone;
  title: string;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div
      role={tone === 'danger' || tone === 'warning' ? 'alert' : 'status'}
      className={cn('flex gap-2 text-13', className)}
    >
      <span className={cn('mt-px shrink-0', TONE[tone].text)}>{TONE[tone].icon}</span>
      <div className="min-w-0">
        <p className={cn('font-medium', TONE[tone].text)}>{title}</p>
        {children && <div className="mt-0.5 text-ink-muted">{children}</div>}
      </div>
    </div>
  );
}

/** Text link in auth screens: petrol, underlined on hover, keyboard focus ring from the base. */
export const authLink = 'font-medium text-brand-600 hover:underline';
