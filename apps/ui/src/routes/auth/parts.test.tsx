// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { PasswordRules, passwordLocallyValid, personalParts } from './parts.tsx';

afterEach(cleanup);

describe('password rules', () => {
  it('[USR-3] needs at least 12 characters', () => {
    expect(passwordLocallyValid('elevenchars', [])).toBe(false);
    expect(passwordLocallyValid('twelve chars', [])).toBe(true);
  });

  it('[USR-3] refuses the name or the email local part, in any case', () => {
    const personal = personalParts('Jo Brennan', 'jo.b@example.test');
    expect(passwordLocallyValid('my BRENNAN password', personal)).toBe(false);
    expect(passwordLocallyValid('calm river lantern', personal)).toBe(true);
    // Parts under 3 characters ("Jo") are ignored, or nearly every password would fail.
    expect(passwordLocallyValid('jog along the river', personal)).toBe(true);
  });

  it('[USR-3] [NFR-8] shows every rule, with the server-only ones marked as checked on save', () => {
    render(<PasswordRules password="short" personal={[]} />);
    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(4);
    expect(items[0]?.textContent).toContain('(not yet)');
    expect(items[2]?.textContent).toContain('checked when you save');
    expect(items[3]?.textContent).toContain('checked when you save');
  });
});
