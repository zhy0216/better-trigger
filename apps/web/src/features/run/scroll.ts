/* =============================================================================
   Better Trigger — log-stream scroll math (pure, unit-testable).

   Kept out of RunView.tsx so that file exports only components: React Fast
   Refresh warns when a module mixes component and non-component exports — the
   same reason navigation.ts / status-meta.ts exist.
   ============================================================================= */

// C3 (p1-17): auto-follow only while the reader is stuck to the bottom. The
// ε absorbs sub-pixel rounding and the row-height jitter of a line landing
// mid-render, so "still bottomed" doesn't need to be pixel-exact.
export const AT_BOTTOM_EPSILON_PX = 4;

/** Pure stickiness predicate — exported so the keep-position rule is unit
 *  testable without a layout engine (jsdom reports 0 for scroll geometry). */
export function isAtBottom(scrollTop: number, clientHeight: number, scrollHeight: number): boolean {
  return scrollHeight - scrollTop - clientHeight <= AT_BOTTOM_EPSILON_PX;
}
