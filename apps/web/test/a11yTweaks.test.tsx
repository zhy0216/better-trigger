/* =============================================================================
   Better Trigger — p2-19 low-hanging fruit round 2.

   Covers what the CLI cannot verify by hand:
   - C2: the Tweaks panel is reachable — App owns `open`, the TopBar button
     toggles it, the panel's ✕ collapses it, and it stays closed by default.
   - C3: keyboard/a11y semantics — Switch is a real role=switch button, the
     runs rows are real buttons, the interactive Card takes role=button with
     Enter/Space, and EnvSwitcher exposes aria-expanded, moves focus into the
     menu on open and restores it on Escape close.
   - C4: drag/scrub window listeners are detached when the component unmounts
     mid-drag (no leak, no stale closure after unmount).
   ============================================================================= */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../src/App';
import { EnvSwitcher } from '../src/components/Shell';
import { Card } from '../src/components/Layout';
import { Switch } from '../src/components/primitives';
import { TweakNumber, TweakRadio, TweaksPanel } from '../src/components/TweaksPanel';
import { RunsList } from '../src/screens/RunsList';
import { setApiKey } from '../src/api/client';
import { resetConnection } from '../src/api/hooks';
import type { RunsResponse, RunSummary } from '../src/api/client';

const NOW = Date.parse('2026-08-11T12:00:00Z');

const run = (id: string): RunSummary => ({
  id,
  taskId: 't',
  status: 'completed',
  trigger: 'api',
  codeVersion: 'v',
  env: 'prod',
  attempt: 1,
  durationMs: 1000,
  createdAt: new Date(NOW - 60_000).toISOString(),
  startedAt: new Date(NOW - 60_000).toISOString(),
  finishedAt: new Date(NOW - 59_000).toISOString(),
});

const runsPage = (ids: string[]): RunsResponse => ({ runs: ids.map(run), nextCursor: null });

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  setApiKey(null);
  resetConnection();
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  window.history.replaceState(null, '', '/');
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.history.replaceState(null, '', '/');
});

const eventCount = (calls: unknown[][], type: string): number =>
  calls.filter((c) => c[0] === type).length;

describe('Switch keyboard access (C3)', () => {
  it('is a focusable role=switch button that reports and toggles state', () => {
    const onChange = vi.fn();
    render(<Switch checked={false} onChange={onChange} />);
    const el = screen.getByRole('switch');
    // A real <button> — focusable, and Enter/Space activate it natively.
    expect(el.tagName).toBe('BUTTON');
    expect(el.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(el);
    expect(onChange).toHaveBeenCalledWith(true);
  });
});

describe('EnvSwitcher keyboard access (C3)', () => {
  it('exposes aria-expanded, focuses the menu on open, and closes on Escape with focus restore', () => {
    const setEnv = vi.fn();
    render(<EnvSwitcher env="prod" setEnv={setEnv} />);
    const trigger = screen.getByRole('button', { name: /production/i });
    expect(trigger.getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    const menu = screen.getByRole('group', { name: 'Environment' });
    const options = within(menu).getAllByRole('button');
    // Focus management: opening moves focus onto the selected option.
    expect(document.activeElement).toBe(options[0]);

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('group', { name: 'Environment' })).toBeNull();
    // Escape restores focus to the trigger instead of dropping it on the body.
    expect(document.activeElement).toBe(trigger);
  });

  it('a focused option selects the env with a plain click', () => {
    const setEnv = vi.fn();
    render(<EnvSwitcher env="prod" setEnv={setEnv} />);
    fireEvent.click(screen.getByRole('button', { name: /production/i }));
    const menu = screen.getByRole('group', { name: 'Environment' });
    fireEvent.click(within(menu).getByText('Staging'));
    expect(setEnv).toHaveBeenCalledWith('staging');
    expect(screen.queryByRole('group', { name: 'Environment' })).toBeNull();
  });
});

describe('runs rows (C3)', () => {
  it('renders each run as a real button that opens the run', async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify(runsPage(['a1', 'b2'])), { status: 200 })),
    );
    const onOpenRun = vi.fn();
    render(<RunsList env="prod" onOpenRun={onOpenRun} />);

    await waitFor(() => expect(screen.getByText('a1')).toBeTruthy());
    const row = screen.getByRole('button', { name: /a1/ });
    expect(row.tagName).toBe('BUTTON');
    fireEvent.click(row);
    expect(onOpenRun).toHaveBeenCalledWith(expect.objectContaining({ id: 'a1' }));
  });
});

describe('interactive Card (C3)', () => {
  it('gets role=button + tabIndex + Enter/Space activation only when clickable', () => {
    const onClick = vi.fn();
    const { unmount } = render(
      <Card onClick={onClick}><span>task card</span></Card>,
    );
    const el = screen.getByRole('button');
    expect(el.tabIndex).toBe(0);
    fireEvent.keyDown(el, { key: 'Enter' });
    expect(onClick).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(el, { key: ' ' });
    expect(onClick).toHaveBeenCalledTimes(2);
    unmount();

    render(<Card><span>static card</span></Card>);
    expect(screen.queryByRole('button')).toBeNull();
  });
});

describe('TweaksPanel reachability (C2)', () => {
  it('is closed by default and toggles open/closed from the TopBar button', async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify(runsPage([])), { status: 200 })),
    );
    render(<App />);

    expect(screen.queryByText('Tweaks')).toBeNull(); // closed by default
    const toggle = screen.getByTitle('Toggle tweaks');
    expect(toggle.getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(toggle);
    expect(screen.getByText('Tweaks')).toBeTruthy();
    expect(toggle.getAttribute('aria-pressed')).toBe('true');

    // The panel's own ✕ collapses it.
    fireEvent.click(screen.getByLabelText('Close tweaks'));
    expect(screen.queryByText('Tweaks')).toBeNull();

    // And the TopBar button toggles again.
    fireEvent.click(toggle);
    expect(screen.getByText('Tweaks')).toBeTruthy();
    fireEvent.click(toggle);
    expect(screen.queryByText('Tweaks')).toBeNull();
  });

  it('renders only while `open` and notifies the controller on ✕', () => {
    const onOpenChange = vi.fn();
    const { rerender } = render(
      <TweaksPanel title="Tweaks" onOpenChange={onOpenChange}><div>content</div></TweaksPanel>,
    );
    expect(screen.queryByText('Tweaks')).toBeNull();
    rerender(
      <TweaksPanel open title="Tweaks" onOpenChange={onOpenChange}><div>content</div></TweaksPanel>,
    );
    fireEvent.click(screen.getByLabelText('Close tweaks'));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

describe('TweakRadio click (C3)', () => {
  it('segment buttons change the value on click, not only via pointer drag', () => {
    const onChange = vi.fn();
    render(<TweakRadio label="Mode" value="light" options={['light', 'dark']} onChange={onChange} />);
    fireEvent.click(screen.getByRole('radio', { name: 'dark' }));
    expect(onChange).toHaveBeenCalledWith('dark');
  });
});

describe('drag listener lifetime (C4)', () => {
  it('unmounting the panel mid-drag detaches its window listeners', () => {
    const add = vi.spyOn(window, 'addEventListener');
    const remove = vi.spyOn(window, 'removeEventListener');
    const { unmount } = render(
      <TweaksPanel open onOpenChange={() => {}}><div>content</div></TweaksPanel>,
    );
    fireEvent.mouseDown(screen.getByText('Tweaks'), { clientX: 10, clientY: 10 });
    expect(eventCount(add.mock.calls, 'mousemove')).toBeGreaterThanOrEqual(1);

    const removedBefore = eventCount(remove.mock.calls, 'mousemove');
    const upBefore = eventCount(remove.mock.calls, 'mouseup');
    unmount();
    expect(eventCount(remove.mock.calls, 'mousemove')).toBe(removedBefore + 1);
    expect(eventCount(remove.mock.calls, 'mouseup')).toBe(upBefore + 1);
  });

  it('unmounting a segment radio mid-scrub detaches its pointer listeners', () => {
    const add = vi.spyOn(window, 'addEventListener');
    const remove = vi.spyOn(window, 'removeEventListener');
    const { unmount } = render(
      <TweakRadio label="Mode" value="light" options={['light', 'dark']} onChange={() => {}} />,
    );
    fireEvent.pointerDown(screen.getByRole('radiogroup'), { clientX: 5, clientY: 5 });
    expect(eventCount(add.mock.calls, 'pointermove')).toBeGreaterThanOrEqual(1);

    const removedBefore = eventCount(remove.mock.calls, 'pointermove');
    unmount();
    expect(eventCount(remove.mock.calls, 'pointermove')).toBe(removedBefore + 1);
  });

  it('unmounting a number field mid-scrub detaches its pointer listeners', () => {
    const add = vi.spyOn(window, 'addEventListener');
    const remove = vi.spyOn(window, 'removeEventListener');
    const { unmount } = render(
      <TweakNumber label="Count" value={5} onChange={() => {}} />,
    );
    fireEvent.pointerDown(screen.getByText('Count'), { clientX: 5, clientY: 5 });
    expect(eventCount(add.mock.calls, 'pointermove')).toBeGreaterThanOrEqual(1);

    const removedBefore = eventCount(remove.mock.calls, 'pointermove');
    unmount();
    expect(eventCount(remove.mock.calls, 'pointermove')).toBe(removedBefore + 1);
  });
});
