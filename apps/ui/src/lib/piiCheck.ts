/**
 * TOOL-3: a simple check, before a reminder or note is saved, for text that looks like customer
 * details. It only warns; the user may still save. Returns what was found, in plain words.
 */
const CHECKS: Array<[string, RegExp]> = [
  ['an email address', /[^\s@]+@[^\s@]+\.[^\s@]+/],
  ['a phone number', /(?:\+44\s?|\b0)\d(?:[\s-]?\d){8,9}\b/],
  ['a postcode', /\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/i],
];

export function findPersonalDetails(text: string): string[] {
  return CHECKS.filter(([, re]) => re.test(text)).map(([label]) => label);
}
