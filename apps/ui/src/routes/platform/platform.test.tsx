// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IncidentLine } from '../../components/IncidentLine.tsx';
import { allowedMoves, capShare, daysUntil, incidentProblem, isSection } from './rules.ts';
import { SecretValueForm } from './secrets.tsx';

afterEach(cleanup);

describe('workspace status moves', () => {
  it('[PLAT-2] archive is final and reactivate works from suspended only', () => {
    expect(allowedMoves('active')).toEqual(['suspend', 'archive']);
    expect(allowedMoves('suspended')).toEqual(['reactivate', 'archive']);
    expect(allowedMoves('archived')).toEqual([]);
  });
});

describe('incident banner text', () => {
  it('[PLAT-2] needs 1 to 200 characters after trimming and no email address', () => {
    expect(incidentProblem('   ')).toBeDefined();
    expect(incidentProblem('x'.repeat(201))).toBeDefined();
    expect(incidentProblem('Write to ops@example.test')).toBeDefined();
    expect(incidentProblem(` ${'x'.repeat(200)} `)).toBeUndefined();
    expect(incidentProblem('eBay orders are late.')).toBeUndefined();
  });

  it('[PLAT-2] shows as a plain line: icon and text, no tinted box', () => {
    render(
      <IncidentLine
        incident={{
          message: 'Orders are late.',
          severity: 'critical',
          set_at: '2026-11-20T09:00:00Z',
        }}
      />,
    );
    const line = screen.getByRole('alert');
    expect(line.textContent).toContain('Incident: Orders are late.');
    expect(line.className).not.toMatch(/bg-(danger|warning|brand)/);
  });

  it('[PLAT-2] shows nothing without an incident', () => {
    const { container } = render(<IncidentLine incident={null} />);
    expect(container.textContent).toBe('');
  });
});

describe('console helpers', () => {
  it('[PLAT-2] usage share is null without a cap', () => {
    expect(capShare(4_000, 5_000)).toBe(80);
    expect(capShare(10, null)).toBeNull();
    expect(capShare(10, 0)).toBeNull();
  });

  it('[PLAT-2] days until expiry round down and go negative once passed', () => {
    const now = Date.parse('2026-11-20T10:00:00Z');
    expect(daysUntil('2026-11-30T09:00:00Z', now)).toBe(9);
    expect(daysUntil('2026-11-19T10:00:00Z', now)).toBe(-1);
  });

  it('[PLAT-1] only known sections are read from the address', () => {
    expect(isSection('secrets')).toBe(true);
    expect(isSection('orders')).toBe(false);
    expect(isSection(undefined)).toBe(false);
  });
});

describe('app secret form', () => {
  const field = () => screen.getByLabelText<HTMLInputElement>('Value');

  it('[PLAT-4] starts empty and masked, and is never saved by the browser', () => {
    render(<SecretValueForm slot="current" onSave={vi.fn()} onCancel={vi.fn()} />);
    expect(field().value).toBe('');
    expect(field().type).toBe('password');
    expect(field().autocomplete).toBe('new-password');
  });

  it('[PLAT-4] clears the value after a save', async () => {
    const onSave = vi.fn().mockResolvedValue(true);
    render(<SecretValueForm slot="next" onSave={onSave} onCancel={vi.fn()} />);
    fireEvent.change(field(), { target: { value: 'synthetic-value' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save value' }));
      await Promise.resolve();
    });
    expect(onSave).toHaveBeenCalledWith('synthetic-value');
    expect(field().value).toBe('');
  });

  it('[PLAT-4] keeps the value and says so when the save failed', async () => {
    const onSave = vi.fn().mockResolvedValue(false);
    render(<SecretValueForm slot="current" onSave={onSave} onCancel={vi.fn()} />);
    fireEvent.change(field(), { target: { value: 'synthetic-value' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save value' }));
      await Promise.resolve();
    });
    expect(field().value).toBe('synthetic-value');
    expect(screen.getByText('The value could not be saved. Try again.')).toBeTruthy();
  });

  it('[PLAT-4] refuses an empty value without calling the server', () => {
    const onSave = vi.fn();
    render(<SecretValueForm slot="current" onSave={onSave} onCancel={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Save value' }));
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByText('Paste the value to save.')).toBeTruthy();
  });
});
