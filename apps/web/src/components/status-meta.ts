/* =============================================================================
   Better Trigger — run-status metadata (color / label / tone).
   Kept out of primitives.tsx so that file only exports components (React Fast
   Refresh warns when a module mixes components and plain values).
   ============================================================================= */

export interface StatusMeta {
  color: string;
  label: string;
  tone: string;
}

export const STATUS_META: Record<string, StatusMeta> = {
  running:  { color: 'var(--st-running)',  label: 'Running',   tone: 'blue' },
  queued:   { color: 'var(--st-queued)',   label: 'Queued',    tone: 'gray' },
  success:  { color: 'var(--st-success)',  label: 'Completed', tone: 'green' },
  warning:  { color: 'var(--st-warning)',  label: 'Warning',   tone: 'orange' },
  failed:   { color: 'var(--st-failed)',   label: 'Failed',    tone: 'red' },
  frozen:   { color: 'var(--st-frozen)',   label: 'Frozen',    tone: 'blue' },
  canceled: { color: 'var(--st-canceled)', label: 'Canceled',  tone: 'gray' },
};
