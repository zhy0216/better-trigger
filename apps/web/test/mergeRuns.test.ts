/* =============================================================================
   Better Trigger — runs-list page merging (PF3, todos/02-performance.md).

   The head/tail merge is the part of the pagination that can break ordering,
   so it is a pure module (no React) with its own tests. The two scenarios
   that matter:

     - the tail is always APPENDED strictly older content — a page must never
       slip newer runs behind older ones (the pre-fix bug: a poll reset the
       cursor, the next page contained runs newer than the tail, and the list
       read "...2,1,51");
     - the live head may advance while the tail exists — dedupe keeps the
       head's copy and the display order stays head → tail.
   ============================================================================= */
import { describe, expect, it } from 'vitest';
import { appendTailPage, mergeRunPages } from '../src/api/mergeRuns';
import type { Run } from '../src/types';

const run = (id: number, label = `r${id}`): Run => ({
  id: String(id),
  task: 't',
  status: 'completed',
  version: 'v',
  env: 'prod',
  trigger: 'api',
  duration: null,
  attempts: 1,
  started: '—',
  ts: id,
});

describe('appendTailPage', () => {
  it('appends an older page after the tail, keeping order', () => {
    // head is 5..1; the user loaded page 2 (runs 10..6) then page 3 (15..11).
    const tail = [10, 9, 8, 7, 6].map(run);
    const page = [15, 14, 13, 12, 11].map(run);
    expect(appendTailPage(tail, page).map((r) => r.id)).toEqual([
      '10', '9', '8', '7', '6', '15', '14', '13', '12', '11',
    ]);
  });

  it('drops a run that already exists in the tail (keyset moved between polls)', () => {
    const tail = [6, 5].map(run);
    const page = [6, 4].map(run); // run 6 repeated
    expect(appendTailPage(tail, page).map((r) => r.id)).toEqual(['6', '5', '4']);
  });
});

describe('mergeRunPages', () => {
  it('puts the live head first, appended pages after, deduped (head wins)', () => {
    const head = [3, 2, 1].map(run);
    const tail = [1, 0].map(run); // run 1 repeated across the boundary
    expect(mergeRunPages(head, tail).map((r) => r.id)).toEqual(['3', '2', '1', '0']);
  });

  it('keeps global newest-first order when the head advanced past the tail', () => {
    // The head moved from 5..1 to 6..2 (a new run 6 arrived). The tail (1..0)
    // is strictly older than the head's oldest (2) — nothing to reorder.
    const head = [6, 5, 4, 3, 2].map(run);
    const tail = [1, 0].map(run);
    const merged = mergeRunPages(head, tail).map((r) => r.id);
    expect(merged).toEqual(['6', '5', '4', '3', '2', '1', '0']);
    for (let i = 1; i < merged.length; i++) {
      expect(Number(merged[i - 1])).toBeGreaterThan(Number(merged[i]));
    }
  });

  it('empty tail passes the head through unchanged', () => {
    const head = [2, 1].map(run);
    expect(mergeRunPages(head, []).map((r) => r.id)).toEqual(['2', '1']);
  });
});
