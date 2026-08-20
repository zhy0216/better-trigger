/* =============================================================================
   Better Trigger — sidebar navigation model.
   Kept out of Shell.tsx so that file only exports components (React Fast
   Refresh warns when a module mixes components and plain values).
   ============================================================================= */
import type { Route } from '../types';

export interface NavEntry {
  id: Route;
  label: string;
  icon: string;
}

export const NAV: NavEntry[] = [
  { id: 'runs',        label: 'Runs',        icon: 'activity' },
  { id: 'tasks',       label: 'Tasks',       icon: 'task' },
  { id: 'schedules',   label: 'Schedules',   icon: 'clock' },
  { id: 'alerts',      label: 'Alerts',      icon: 'bell' },
  { id: 'deployments', label: 'Deployments', icon: 'rocket' },
];
