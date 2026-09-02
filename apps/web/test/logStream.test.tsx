/* =============================================================================
   Better Trigger — LogStream auto-scroll stickiness (P1-17 C3).

   A running run appends log lines every 2s poll. The stream must keep
   following the tail only while the reader is at the bottom; once they scroll
   up to read history, a poll landing must not yank them back down. jsdom has
   no layout, so the scroll geometry is faked on the container element — the
   predicate (isAtBottom) is additionally pinned as a pure unit.
   ============================================================================= */
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { LogStream, isAtBottom } from '../src/features/run/RunView';
import type { LogLine, Span, Trace } from '../src/types';

const span: Span = { id: 's0', label: 'task', kind: 'task', level: 0, start: 0, dur: 100, status: 'running' };
const trace: Trace = {
  runId: 'r1', task: 't', version: 'v', env: 'prod', trigger: 'api',
  queuedFor: '0ms', payload: {}, totalMs: 1000, spans: [span],
};

const line = (ms: number): LogLine => ['info', `line ${ms}`, String(ms)];
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
    const { container, rerender } = render(stream(3));
    const el = container.querySelector<HTMLElement>('div[style*="overflow-y"]');
    expect(el).toBeTruthy();
    fakeScroller(el!, geom);

    // Fresh mount: the reader is at the bottom → new lines are followed.
    rerender(stream(4));
    expect(geom.scrollTop).toBe(1000);

    // The reader scrolls up to read history…
    geom.scrollTop = 100;
    fireEvent.scroll(el!);

    // …the next poll appends a line: their position must survive.
    rerender(stream(5));
    expect(geom.scrollTop).toBe(100);

    // Scrolling back to the bottom re-arms the auto-follow.
    geom.scrollTop = 800;
    fireEvent.scroll(el!);
    rerender(stream(6));
    expect(geom.scrollTop).toBe(1000);
  });
});
