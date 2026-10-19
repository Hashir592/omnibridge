// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { DateCell, MoneyCell, NumberCell } from './cells.tsx';

afterEach(cleanup);

describe('table cells', () => {
  it('[NFR-9] money cells show pounds from integer pence with a thousands comma', () => {
    render(<MoneyCell pence={123456} />);
    expect(screen.getByText('£1,234.56')).toBeTruthy();
  });

  it('[NFR-9] negative money shows a minus sign and the danger colour', () => {
    render(<MoneyCell pence={-500} />);
    const el = screen.getByText('−£5.00');
    expect(el.className).toContain('text-danger');
    expect(el.className).toContain('num');
  });

  it('[NFR-9] number cells group thousands and use tabular figures', () => {
    render(<NumberCell value={10234} />);
    expect(screen.getByText('10,234').className).toContain('num');
  });

  it('[NFR-9] date cells show DD/MM/YYYY and the London time in summer (BST)', () => {
    render(<DateCell iso="2026-07-01T12:05:00Z" />);
    expect(screen.getByText('01/07/2026')).toBeTruthy();
    expect(screen.getByText('13:05')).toBeTruthy();
  });

  it('[NFR-9] date cells show the London time in winter (GMT) and the London day', () => {
    render(<DateCell iso="2026-12-31T23:30:00Z" />);
    expect(screen.getByText('31/12/2026')).toBeTruthy();
    expect(screen.getByText('23:30')).toBeTruthy();
    cleanup();
    // 23:30 UTC on 30 June is 00:30 on 1 July in London.
    render(<DateCell iso="2026-06-30T23:30:00Z" />);
    expect(screen.getByText('01/07/2026')).toBeTruthy();
    expect(screen.getByText('00:30')).toBeTruthy();
  });
});
