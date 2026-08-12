/* =============================================================================
   Better Trigger — TweaksPanel host-protocol removal (O3/p1-19).

   The panel used to talk to a hosting frame over postMessage
   (`__edit_mode_available` on mount, `__edit_mode_dismissed` on close) and
   open/close on an unorigin-checked `window` message listener. That protocol
   was removed: mount must not post, the legacy activate/deactivate messages
   must be ignored, and nothing may ever be posted to window.parent.

   In jsdom `window.parent === window`, so a spy on `window.parent.postMessage`
   also covers any stray `window.postMessage(...)` call.
   ============================================================================= */
// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TweaksPanel } from '../src/components/TweaksPanel';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('TweaksPanel host-protocol removal', () => {
  it('mounts without posting to window.parent', () => {
    const post = vi.spyOn(window.parent, 'postMessage');
    render(<TweaksPanel title="Tweaks"><div>content</div></TweaksPanel>);
    expect(post).not.toHaveBeenCalled();
  });

  it('ignores the legacy activate/deactivate messages and never posts back', () => {
    const post = vi.spyOn(window.parent, 'postMessage');
    const { queryByText } = render(<TweaksPanel title="Tweaks"><div>content</div></TweaksPanel>);

    expect(queryByText('Tweaks')).toBeNull(); // hidden by default

    // The dead protocol's open/close messages must be a no-op: no listener,
    // no postMessage to the (former) host.
    window.dispatchEvent(new MessageEvent('message', { data: { type: '__activate_edit_mode' } }));
    expect(queryByText('Tweaks')).toBeNull(); // still hidden — nothing opened it
    window.dispatchEvent(new MessageEvent('message', { data: { type: '__deactivate_edit_mode' } }));
    expect(post).not.toHaveBeenCalled();
  });
});
