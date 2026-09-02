/* =============================================================================
   Better Trigger — Onboarding robustness (T7).

   Step 3 told users to run `bunx better-trigger-worker`, but a project that
   only installed the SDK has no such bin, so bunx reaches for a
   same-named registry package that does not exist — the correct invocation is
   `@better-trigger/worker`. And the copy button used a bare
   `navigator.clipboard.writeText(...).then(...)` with no rejection handling, so
   a non-secure context (undefined clipboard) or a permission denial produced an
   unhandled rejection / TypeError.
   ============================================================================= */
/// <reference types="node" />
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Onboarding } from '../src/screens/Onboarding';

const setClipboard = (value: unknown): void => {
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value });
};

afterEach(() => {
  cleanup();
  setClipboard(undefined);
  vi.restoreAllMocks();
});

describe('Onboarding daemon command', () => {
  it('runs the published @better-trigger/worker bin, not better-trigger-worker', () => {
    render(<Onboarding setRoute={() => {}} />);
    fireEvent.click(screen.getByText('Start the daemon'));

    expect(screen.getByText(/bunx --bun @better-trigger\/worker --tasks/)).toBeTruthy();
    expect(screen.queryByText(/better-trigger-worker/)).toBeNull();
  });
});

describe('Onboarding clipboard robustness', () => {
  it('does not raise an unhandled rejection when the clipboard write rejects', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    setClipboard({ writeText: () => Promise.reject(new Error('denied')) });

    render(<Onboarding setRoute={() => {}} />);
    await act(async () => {
      fireEvent.click(screen.getAllByTitle('Copy')[0]);
    });
    // Let the rejected promise + its catch handler run.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    process.off('unhandledRejection', onUnhandled);
    expect(unhandled).toHaveLength(0);
  });

  it('does not throw when navigator.clipboard is unavailable (non-secure context)', () => {
    setClipboard(undefined);
    render(<Onboarding setRoute={() => {}} />);
    expect(() => fireEvent.click(screen.getAllByTitle('Copy')[0])).not.toThrow();
  });

  it('reports success feedback when the clipboard write resolves', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    setClipboard({ writeText });
    render(<Onboarding setRoute={() => {}} />);

    await act(async () => {
      fireEvent.click(screen.getAllByTitle('Copy')[0]);
    });
    await waitFor(() => expect(writeText).toHaveBeenCalled());
  });
});
