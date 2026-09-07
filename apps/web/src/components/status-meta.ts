/* =============================================================================
   Better Trigger — run-status metadata (color / label / tone).
   Kept out of primitives.tsx so that file only exports components (React Fast
   Refresh warns when a module mixes components and plain values).
   ============================================================================= */

export interface StatusMeta {
  color: string;
  textColor: string;
  label: string;
  tone: string;
}

export const STATUS_META: Record<string, StatusMeta> = {
  running:  { color: 'var(--st-running)',  textColor: 'var(--blue-text)', label: 'Running',   tone: 'blue' },
  queued:   { color: 'var(--st-queued)',   textColor: 'var(--fg-muted)', label: 'Queued',    tone: 'gray' },
  success:  { color: 'var(--st-success)',  textColor: 'var(--green-text)', label: 'Completed', tone: 'green' },
  warning:  { color: 'var(--st-warning)',  textColor: 'var(--orange-text)', label: 'Warning',   tone: 'orange' },
  failed:   { color: 'var(--st-failed)',   textColor: 'var(--red-text)', label: 'Failed',    tone: 'red' },
  frozen:   { color: 'var(--st-frozen)',   textColor: 'var(--st-frozen-text)', label: 'Frozen',    tone: 'blue' },
  canceled: { color: 'var(--st-canceled)', textColor: 'var(--fg-muted)', label: 'Canceled',  tone: 'gray' },
};
