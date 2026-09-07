import React from 'react';

export function useMediaQuery(query: string): boolean {
  const media = React.useMemo(() => window.matchMedia?.(query), [query]);
  const subscribe = React.useCallback((notify: () => void) => {
    media?.addEventListener('change', notify);
    return () => media?.removeEventListener('change', notify);
  }, [media]);
  return React.useSyncExternalStore(subscribe, () => media?.matches ?? false, () => false);
}
