import { useState, type InputHTMLAttributes } from 'react';

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'onBlur'> & {
  value: number;
  /** How the committed value is shown, e.g. grams as "0.49". */
  format: (v: number) => string;
  /** Text to value; null while the text is not a valid value yet (e.g. "1." or ""). */
  parse: (text: string) => number | null;
  onCommit: (v: number) => void;
};

/**
 * Number input that keeps what the user is typing. A valid value is committed on every change,
 * but the text is only re-formatted on blur, so "1.", "" or "1.2" can be typed on the way to "1.25".
 */
export function NumberField({ value, format, parse, onCommit, ...rest }: Props) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <input
      {...rest}
      value={draft ?? format(value)}
      onChange={(e) => {
        setDraft(e.target.value);
        const v = parse(e.target.value);
        if (v !== null) onCommit(v);
      }}
      onBlur={() => {
        setDraft(null);
      }}
    />
  );
}

/** "0.49" kg text to grams; null when not a positive number with at most 3 decimals. */
export function parseKg(text: string): number | null {
  if (!/^\d+(\.\d{0,3})?$/.test(text.trim())) return null;
  const g = Math.round(Number(text) * 1000);
  return g > 0 ? g : null;
}

/** Parcel count 1 to 9; null otherwise. */
export function parseParcels(text: string): number | null {
  return /^[1-9]$/.test(text.trim()) ? Number(text) : null;
}
