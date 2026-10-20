import { useEffect, useState } from 'react';
import { cn } from '../lib/cn.ts';

/** True only after `pending` has lasted longer than `delay` ms (DIRECTION §5: no flash for fast loads). */
export function useDelayed(pending: boolean, delay = 300): boolean {
  const [late, setLate] = useState(false);
  useEffect(() => {
    if (!pending) {
      setLate(false);
      return;
    }
    const t = setTimeout(() => {
      setLate(true);
    }, delay);
    return () => {
      clearTimeout(t);
    };
  }, [pending, delay]);
  return late;
}

/** A grey placeholder bar. Size it with classes, e.g. "h-3 w-40". No shimmer animation. */
export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cn('rounded bg-surface', className)} />;
}
