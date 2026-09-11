/* =============================================================================
   Better Trigger — runs-list page merging (pure functions).
   The runs list = a live polled head (newest page, refreshed every 2s) plus
   pages the user loaded via "Load more" (older pages). These two combinators
   keep that merge ordered and duplicate-free; extracted so the pagination
   logic is testable without React (PF3, todos/02-performance.md).
   ============================================================================= */
import type { Run } from '../types';

/** Live head first, then the appended older pages, deduped (head wins). */
export function mergeRunPages(head: Run[], tail: Run[]): Run[] {
  const seen = new Set<string>();
  const out: Run[] = [];
  for (const r of head) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    out.push(r);
  }
  for (const r of tail) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    out.push(r);
  }
  return out;
}
