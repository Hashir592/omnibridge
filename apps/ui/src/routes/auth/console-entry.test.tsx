// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConsoleEntry } from './console-entry.tsx';

afterEach(cleanup);

const row = () => screen.queryByRole('button', { name: /Platform console/ });

describe('platform console row in the workspace picker', () => {
  it('[PLAT-1] is not shown to someone who is not a platform admin', () => {
    render(
      <ul>
        <ConsoleEntry show={false} enter={vi.fn()} onEntered={vi.fn()} />
      </ul>,
    );
    expect(row()).toBeNull();
  });

  it('[PLAT-1] enters the console for a platform admin', async () => {
    const enter = vi.fn().mockResolvedValue({ ok: true, status: 204 });
    const onEntered = vi.fn();
    render(
      <ul>
        <ConsoleEntry show enter={enter} onEntered={onEntered} />
      </ul>,
    );
    fireEvent.click(screen.getByRole('button', { name: /Platform console/ }));
    await waitFor(() => {
      expect(onEntered).toHaveBeenCalledOnce();
    });
    expect(enter).toHaveBeenCalledOnce();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('[PLAT-1] shows a plain inline error on 403 and stays on the picker', async () => {
    const onEntered = vi.fn();
    render(
      <ul>
        <ConsoleEntry
          show
          enter={vi.fn().mockResolvedValue({ ok: false, status: 403 })}
          onEntered={onEntered}
        />
      </ul>,
    );
    fireEvent.click(screen.getByRole('button', { name: /Platform console/ }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('The console is not open to this account here');
    expect(alert.className).not.toMatch(/bg-|border/);
    expect(onEntered).not.toHaveBeenCalled();
  });

  it('[PLAT-1] says to try again on any other failure', async () => {
    render(
      <ul>
        <ConsoleEntry
          show
          enter={vi.fn().mockRejectedValue(new Error('net'))}
          onEntered={vi.fn()}
        />
      </ul>,
    );
    fireEvent.click(screen.getByRole('button', { name: /Platform console/ }));
    expect((await screen.findByRole('alert')).textContent).toContain('Try again');
  });
});
