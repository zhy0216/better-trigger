/* =============================================================================
   Better Trigger — top-level error boundary (T5).

   Before the boundary, a render throw (a malformed run detail crashing
   adaptRunDetail) unmounted the whole tree → a blank screen. The boundary now
   traps it and shows the existing ErrorState plus a Reload affordance.
   ============================================================================= */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ErrorBoundary } from '../src/components/ErrorBoundary';

afterEach(cleanup);

const Bomb = () => {
  throw new Error('kaboom');
};

describe('ErrorBoundary', () => {
  it('renders an error panel with a reload control instead of blanking', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <ErrorBoundary>
        <Bomb />
      </ErrorBoundary>,
    );
    expect(screen.getByText('kaboom')).toBeTruthy();
    expect(screen.getByRole('button', { name: /reload/i })).toBeTruthy();
    spy.mockRestore();
  });

  it('renders children untouched when nothing throws', () => {
    render(
      <ErrorBoundary>
        <span>fine</span>
      </ErrorBoundary>,
    );
    expect(screen.getByText('fine')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /reload/i })).toBeNull();
  });
});
