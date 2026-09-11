/* =============================================================================
   useTweaks — single source of truth for tweak values.

   Originally wired to an external host that persisted the values by rewriting an
   EDITMODE block on disk over postMessage. The host protocol was removed (it
   was documented as dead in apps/web/README.md); values now live in React state
   for the session only — setTweak merges into that state and nothing else.
   ============================================================================= */
import React from 'react';

export type SetTweak<T> = <K extends keyof T>(key: K, value: T[K]) => void;

export function useTweaks<T extends Record<string, unknown>>(defaults: T): [T, SetTweak<T>] {
  const [values, setValues] = React.useState<T>(defaults);

  const setTweak = React.useCallback<SetTweak<T>>((key, value) => {
    setValues((prev) => ({ ...prev, [key]: value }));
  }, []);

  return [values, setTweak];
}
