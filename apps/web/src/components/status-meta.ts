/* =============================================================================
   Better Trigger — run-status metadata (color / label).
   Kept out of primitives.tsx so that file only exports components (React Fast
   Refresh warns when a module mixes components and plain values).
   ============================================================================= */

export interface StatusMeta {
  color: string;
  textColor: string;
  label: string;
}

export const STATUS_META: Record<string, StatusMeta> = {
  running:  { color: 'var(--st-running)',  textColor: 'var(--blue-text)', label: 'Running' },
  queued:   { color: 'var(--st-queued)',   textColor: 'var(--fg-muted)', label: 'Queued' },
  success:  { color: 'var(--st-success)',  textColor: 'var(--green-text)', label: 'Completed' },
  warning:  { color: 'var(--st-warning)',  textColor: 'var(--orange-text)', label: 'Warning' },
  failed:   { color: 'var(--st-failed)',   textColor: 'var(--red-text)', label: 'Failed' },
  frozen:   { color: 'var(--st-frozen)',   textColor: 'var(--st-frozen-text)', label: 'Frozen' },
  canceled: { color: 'var(--st-canceled)', textColor: 'var(--fg-muted)', label: 'Canceled' },
};
