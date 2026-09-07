/* =============================================================================
   Better Trigger — LogStream auto-scroll stickiness (P1-17 C3).

   A running run appends log lines every 2s poll. The stream must keep
   following the tail only while the reader is at the bottom; once they scroll
   up to read history, a poll landing must not yank them back down. jsdom has
   no layout, so the scroll geometry is faked on the container element — the
   predicate (isAtBottom) is additionally pinned as a pure unit.
   ============================================================================= */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LogStream } from '../src/features/run/RunView';
import { isAtBottom } from '../src/features/run/scroll';
import type { LogLine, Span, Trace } from '../src/types';

const span: Span = { id: 's0', label: 'task', kind: 'task', level: 0, start: 0, dur: 100, status: 'running' };
const trace: Trace = {
  runId: 'r1', task: 't', version: 'v', env: 'prod', trigger: 'api',
  queuedFor: '0ms', payload: {}, totalMs: 1000, spans: [span],
};

const line = (ms: number): LogLine => ['info', `line ${ms}`, String(ms), ms];
const logsOf = (count: number): Record<string, LogLine[]> => ({
  s0: Array.from({ length: count }, (_, i) => line(i)),
});

const stream = (count: number) => (
  <LogStream trace={trace} logs={logsOf(count)} t={1000} selectedId="" scoped={false}
    setScoped={() => {}} onLoadOlderLogs={async () => false} loadingOlderLogs={false}
    hasOlderLogs={false} loadOlderLogsError={null} />
);

/** Fake the scroll geometry (jsdom reports 0 for every box). */
function fakeScroller(el: HTMLElement, geom: { scrollTop: number; clientHeight: number; scrollHeight: number }): void {
  Object.defineProperty(el, 'scrollTop', { configurable: true, get: () => geom.scrollTop, set: (v: number) => { geom.scrollTop = v; } });
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => geom.clientHeight });
  Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => geom.scrollHeight });
}

afterEach(cleanup);

describe('isAtBottom (the keep-position predicate)', () => {
  it('is bottomed within the epsilon, and free above it', () => {
    expect(isAtBottom(800, 200, 1000)).toBe(true); // exactly at bottom
    expect(isAtBottom(796, 200, 1000)).toBe(true); // 4px of slack
    expect(isAtBottom(795, 200, 1000)).toBe(false); // beyond it
    expect(isAtBottom(100, 200, 1000)).toBe(false); // scrolled up reading
    expect(isAtBottom(0, 200, 100)).toBe(true); // content shorter than the box
  });
});

describe('LogStream auto-scroll (P1-17 C3)', () => {
  it('follows the tail while pinned, holds position after the reader scrolls up, and resumes at the bottom', () => {
    const geom = { scrollTop: 0, clientHeight: 200, scrollHeight: 1000 };
    const { rerender } = render(stream(3));
    const el = screen.getByRole('region', { name: 'Log entries' });
    expect(el).toBeTruthy();
    fakeScroller(el!, geom);

    // Fresh mount: the reader is at the bottom → new lines are followed.
    rerender(stream(4));
    expect(geom.scrollTop).toBe(1000);

    // The reader scrolls up to read history…
    geom.scrollTop = 100;
    fireEvent.scroll(el!);
    expect(screen.getByText('Paused')).toBeTruthy();

    // …the next poll appends a line: their position must survive.
    rerender(stream(5));
    expect(geom.scrollTop).toBe(100);

    // Scrolling back to the bottom re-arms the auto-follow.
    geom.scrollTop = 800;
    fireEvent.scroll(el!);
    rerender(stream(6));
    expect(geom.scrollTop).toBe(1000);
    expect(screen.getByText('Following')).toBeTruthy();
  });

  it('jumps to the latest entry and follows later polls after explicitly resuming', () => {
    const geom = { scrollTop: 100, clientHeight: 200, scrollHeight: 1000 };
    const { rerender } = render(stream(3));
    const el = screen.getByRole('region', { name: 'Log entries' });
    fakeScroller(el, geom);
    fireEvent.scroll(el);
    fireEvent.click(screen.getByRole('button', { name: 'Jump to latest' }));
    expect(geom.scrollTop).toBe(1000);
    expect(screen.getByText('Following')).toBeTruthy();
    geom.scrollHeight = 1200;
    rerender(stream(4));
    expect(geom.scrollTop).toBe(1200);
    expect(screen.queryByRole('button', { name: 'Jump to latest' })).toBeNull();
  });
});

describe('LogStream stable row keys (T4)', () => {
  const view = (logs: Record<string, LogLine[]>) => (
    <LogStream trace={trace} logs={logs} t={100_000} selectedId="" scoped={false}
      setScoped={() => {}} onLoadOlderLogs={async () => false} loadingOlderLogs={false}
      hasOlderLogs={false} loadOlderLogsError={null} />
  );

  it('reuses existing rows when "load older" prepends an earlier page', () => {
    // Head page (ids 3,4); the older page prepends ids 1,2 ahead of them.
    const head: Record<string, LogLine[]> = { s0: [['info', 'keepA', '300ms', 3], ['info', 'keepB', '400ms', 4]] };
    const grew: Record<string, LogLine[]> = {
      s0: [['info', 'old1', '100ms', 1], ['info', 'old2', '200ms', 2], ['info', 'keepA', '300ms', 3], ['info', 'keepB', '400ms', 4]],
    };
    const { rerender } = render(view(head));
    const before = screen.getByText('keepA');
    rerender(view(grew));
    // Keyed by the log-record id, the already-visible row keeps its DOM node
    // (with index keys the prepend shifted every row and rebuilt them).
    expect(screen.getByText('keepA')).toBe(before);
    expect(screen.getByText('old1')).toBeTruthy();
  });

  it('preserves the visible row offset when an older page is inserted above the reader', () => {
    const head: Record<string, LogLine[]> = { s0: [line(3), line(4)] };
    const grew: Record<string, LogLine[]> = { s0: [line(1), line(2), line(3), line(4)] };
    const geom = { scrollTop: 100, clientHeight: 200, scrollHeight: 1000 };
    const { rerender } = render(view(head));
    const el = screen.getByRole('region', { name: 'Log entries' });
    fakeScroller(el, geom);
    const rect = (top: number, height: number) => ({ top, bottom: top + height, height, left: 0, right: 100, width: 100, x: 0, y: top, toJSON: () => ({}) });
    el.getBoundingClientRect = () => rect(100, 200);
    let rowTop = 120;
    const row = screen.getByText('line 3').closest<HTMLElement>('[data-log-id]')!;
    row.getBoundingClientRect = () => rect(rowTop, 20);
    fireEvent.scroll(el);
    expect(screen.getByText('Paused')).toBeTruthy();

    rowTop = 320;
    geom.scrollHeight = 1200;
    rerender(view(grew));

    expect(geom.scrollTop).toBe(300);
    expect(screen.getByText('line 3').closest('[data-log-id]')).toBe(row);
    expect(screen.getByText('Paused')).toBeTruthy();
  });

  it('keeps the reading position when polling adds history while the Trace panel is hidden', () => {
    const head = { s0: [line(3), line(4)] };
    const grew = { s0: [line(1), line(2), line(3), line(4)] };
    const panel = (logs: Record<string, LogLine[]>, hidden: boolean) => (
      <div className="run-trace-panel" style={{ display: hidden ? 'none' : 'flex' }}>{view(logs)}</div>
    );
    const { rerender } = render(panel(head, false));
    const el = screen.getByRole('region', { name: 'Log entries' });
    const geom = { scrollTop: 100, clientHeight: 200, scrollHeight: 1000 };
    fakeScroller(el, geom);
    fireEvent.scroll(el);
    geom.scrollHeight = 0;
    geom.scrollTop = 0;
    rerender(panel(grew, true));
    fireEvent.scroll(el);
    geom.scrollHeight = 1200;
    rerender(panel(grew, false));
    expect(geom.scrollTop).toBe(300);
    expect(screen.getByText('Paused')).toBeTruthy();
  });
});

describe('LogStream scope and empty states', () => {
  it('keeps paging and retry feedback available for an empty span scope', () => {
    const loadOlder = vi.fn(async () => false);
    const setScoped = vi.fn();
    render(<LogStream trace={trace} logs={{}} t={1000} selectedId="s0" scoped
      setScoped={setScoped} onLoadOlderLogs={loadOlder} loadingOlderLogs={false}
      hasOlderLogs loadOlderLogsError="network error" />);
    expect(screen.getByText('No logs for this span.')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('Could not load older logs');
    const scope = screen.getByRole('button', { name: 'Span: task' });
    expect(scope.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(scope);
    expect(setScoped).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Load older logs' }));
    expect(loadOlder).toHaveBeenCalledOnce();
    expect(screen.getByText('Paused')).toBeTruthy();
  });

  it('distinguishes an active stream from a finished run without logs', () => {
    const { rerender } = render(stream(0));
    expect(screen.getByText('Waiting for logs…')).toBeTruthy();
    rerender(<LogStream trace={{ ...trace, spans: [{ ...span, status: 'success' }] }} logs={{}}
      t={1000} selectedId="" scoped={false} setScoped={() => {}} onLoadOlderLogs={async () => false}
      loadingOlderLogs={false} hasOlderLogs={false} loadOlderLogsError={null} />);
    expect(screen.getByText('No logs were recorded for this run.')).toBeTruthy();
  });

  it('resumes at the tail of a new span scope without keeping the old paused state', () => {
    const child = { ...span, id: 's1', label: 'child' };
    const scopedTrace = { ...trace, spans: [span, child] };
    const viewScope = (selectedId: string) => <LogStream trace={scopedTrace}
      logs={{ s0: [line(1)], s1: [line(2)] }} t={1000} selectedId={selectedId} scoped
      setScoped={() => {}} onLoadOlderLogs={async () => false} loadingOlderLogs={false}
      hasOlderLogs={false} loadOlderLogsError={null} />;
    const { rerender } = render(viewScope('s0'));
    const el = screen.getByRole('region', { name: 'Log entries' });
    const geom = { scrollTop: 100, clientHeight: 200, scrollHeight: 1000 };
    fakeScroller(el, geom);
    fireEvent.scroll(el);
    expect(screen.getByText('Paused')).toBeTruthy();
    rerender(viewScope('s1'));
    expect(screen.getByRole('button', { name: 'Span: child' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.queryByText('line 1')).toBeNull();
    expect(screen.getByText('line 2')).toBeTruthy();
    expect(screen.getByText('Following')).toBeTruthy();
    expect(geom.scrollTop).toBe(1000);
    rerender(viewScope('s0'));
    expect(screen.getByText('Following')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Span: task' }).getAttribute('aria-pressed')).toBe('true');
  });
});
