/* =============================================================================
   useTweaks — single source of truth for tweak values.

   Originally wired to an external host that persisted the values by rewriting an
   EDITMODE block on disk over postMessage. The host protocol was removed (it
   was documented as dead in apps/web/README.md); values now live in React state
   for the session, and change listeners subscribe to the `tweakchange`
   CustomEvent instead.
   ============================================================================= */
import React from 'react';

export type SetTweak<T> = (keyOrEdits: keyof T | Partial<T>, val?: unknown) => void;

export function useTweaks<T extends Record<string, unknown>>(defaults: T): [T, SetTweak<T>] {
  const [values, setValues] = React.useState<T>(defaults);

  // Accepts either setTweak('key', value) or setTweak({ key: value, ... }).
  const setTweak = React.useCallback<SetTweak<T>>((keyOrEdits, val) => {
    const edits = (typeof keyOrEdits === 'object' && keyOrEdits !== null
      ? keyOrEdits
      : { [keyOrEdits as keyof T]: val }) as Partial<T>;
    setValues((prev) => ({ ...prev, ...edits }));
    window.dispatchEvent(new CustomEvent('tweakchange', { detail: edits }));
  }, []);

  return [values, setTweak];
}
