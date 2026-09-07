import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../src/App';
import { setApiKey } from '../src/api/client';
import { resetConnection } from '../src/api/hooks';

let mobile: boolean;
let listeners: Set<() => void>;

beforeEach(() => {
  mobile = true;
  listeners = new Set();
  vi.stubGlobal('matchMedia', vi.fn(() => ({
    get matches() { return mobile; },
    addEventListener: (_: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
  })));
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
    runs: [], nextCursor: null, tasks: [], schedules: [], workers: [],
  }))));
  window.history.replaceState(null, '', '/runs');
  setApiKey(null);
  resetConnection();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('responsive workspace navigation', () => {
  it('opens from its trigger and closes with focus restored on cancel or navigation', async () => {
    render(<App />);
    const trigger = screen.getByRole('button', { name: 'Toggle sidebar' });
    expect(screen.queryByRole('navigation')).toBeNull();
    expect(trigger.getAttribute('aria-expanded')).toBe('false');

    // fireEvent.click does not focus the button, matching Safari's pointer
    // behavior. The opener must establish a reliable return target itself.
    fireEvent.click(trigger);
    const dialog = screen.getByRole('dialog', { name: 'Workspace navigation' });
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(within(dialog).getByRole('button', { name: 'Runs' }).getAttribute('aria-current')).toBe('page');
    fireEvent(dialog, new Event('cancel', { cancelable: true }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger);

    fireEvent.click(trigger);
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Tasks' }));
    await waitFor(() => expect(window.location.pathname).toBe('/tasks'));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(screen.getAllByRole('main')).toHaveLength(1);
    expect(screen.getByRole('main', { name: 'Tasks' })).toBeTruthy();
  });

  it('dismisses the drawer on a breakpoint change and does not reopen it later', () => {
    render(<App />);
    const trigger = screen.getByRole('button', { name: 'Toggle sidebar' });
    fireEvent.click(trigger);
    expect(screen.getByRole('dialog')).toBeTruthy();
    act(() => { mobile = false; listeners.forEach((listener) => listener()); });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('navigation', { name: 'Workspace' })).toBeTruthy();
    act(() => { mobile = true; listeners.forEach((listener) => listener()); });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('navigation')).toBeNull();
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
  });

  it('wraps keyboard focus in both directions inside the navigation dialog', () => {
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Toggle sidebar' }));
    const dialog = screen.getByRole('dialog', { name: 'Workspace navigation' });
    const controls = within(dialog).getAllByRole('button');
    // jsdom has no layout; these displayed controls are also exercised in a
    // real browser to verify native-dialog focus and backdrop behavior.
    controls.forEach((control) => vi.spyOn(control, 'getClientRects').mockReturnValue([{}] as unknown as DOMRectList));
    const first = controls[0];
    const last = controls[controls.length - 1];
    last.focus();
    fireEvent.keyDown(last, { key: 'Tab' });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it('offers display settings as a named dialog and returns focus to its opener', () => {
    render(<App />);
    const trigger = screen.getByRole('button', { name: 'Display settings' });
    fireEvent.click(trigger);
    const dialog = screen.getByRole('dialog', { name: 'Display settings' });
    expect(dialog.contains(document.activeElement)).toBe(true);
    fireEvent(dialog, new Event('cancel', { cancelable: true }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(trigger.getAttribute('aria-pressed')).toBe('false');
  });
});
