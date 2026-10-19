// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Calendar, DatePicker } from './DatePicker.tsx';

afterEach(cleanup);

const input = () => screen.getByPlaceholderText<HTMLInputElement>('DD/MM/YYYY');

describe('DatePicker', () => {
  it('[NFR-9] shows the stored date as DD/MM/YYYY', () => {
    render(<DatePicker value="2026-10-19" onChange={vi.fn()} />);
    expect(input().value).toBe('19/10/2026');
  });

  it('[NFR-9] accepts a typed short UK date when the field loses focus', () => {
    const onChange = vi.fn();
    render(<DatePicker value={null} onChange={onChange} />);
    fireEvent.change(input(), { target: { value: '3/11/26' } });
    fireEvent.blur(input());
    expect(onChange).toHaveBeenCalledWith('2026-11-03');
  });

  it('[NFR-9] flags a date that does not exist and keeps the old value', () => {
    const onChange = vi.fn();
    render(<DatePicker value="2026-10-19" onChange={onChange} />);
    fireEvent.change(input(), { target: { value: '31/02/2026' } });
    fireEvent.blur(input());
    expect(onChange).not.toHaveBeenCalled();
    expect(input().getAttribute('aria-invalid')).toBe('true');
  });

  it('[NFR-9] rejects a date outside the allowed range', () => {
    const onChange = vi.fn();
    render(<DatePicker value={null} onChange={onChange} min="2026-10-19" />);
    fireEvent.change(input(), { target: { value: '18/10/2026' } });
    fireEvent.blur(input());
    expect(onChange).not.toHaveBeenCalled();
  });

  it('[NFR-9] clears to null when emptied', () => {
    const onChange = vi.fn();
    render(<DatePicker value="2026-10-19" onChange={onChange} />);
    fireEvent.change(input(), { target: { value: '' } });
    fireEvent.blur(input());
    expect(onChange).toHaveBeenCalledWith(null);
  });
});

describe('Calendar', () => {
  it('[NFR-8] moves by day and week with the arrow keys and picks with Enter', () => {
    const onPick = vi.fn();
    render(<Calendar value="2026-10-19" onPick={onPick} />);
    const grid = screen.getByRole('grid', { name: 'October 2026' });
    expect(
      screen.getByRole('button', { name: 'Monday 19 October 2026' }).getAttribute('aria-pressed'),
    ).toBe('true');
    fireEvent.keyDown(grid, { key: 'ArrowRight' });
    fireEvent.keyDown(grid, { key: 'ArrowDown' });
    const focused = screen.getByRole('button', { name: 'Tuesday 27 October 2026' });
    expect(focused.tabIndex).toBe(0);
    fireEvent.click(focused);
    expect(onPick).toHaveBeenCalledWith('2026-10-27');
  });

  it('[NFR-8] Page Down moves to the next month and the heading follows', () => {
    render(<Calendar value="2026-01-31" onPick={vi.fn()} />);
    fireEvent.keyDown(screen.getByRole('grid'), { key: 'PageDown' });
    expect(screen.getByRole('grid', { name: 'February 2026' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Saturday 28 February 2026' }).tabIndex).toBe(0);
  });

  it('[NFR-8] arrow keys never move onto a disabled day, so focus stays in the grid', () => {
    render(<Calendar value="2026-10-19" min="2026-10-19" onPick={vi.fn()} />);
    fireEvent.keyDown(screen.getByRole('grid'), { key: 'ArrowLeft' });
    fireEvent.keyDown(screen.getByRole('grid'), { key: 'ArrowUp' });
    expect(screen.getByRole('button', { name: 'Monday 19 October 2026' }).tabIndex).toBe(0);
  });

  it('[NFR-8] disables days outside the allowed range', () => {
    render(<Calendar value="2026-10-19" min="2026-10-10" onPick={vi.fn()} />);
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Friday 9 October 2026' }).disabled,
    ).toBe(true);
  });
});
