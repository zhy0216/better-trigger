/* =============================================================================
   Better Trigger — Schedules.
   ============================================================================= */
import React from 'react';
import { Icon, Badge, Switch } from '../components/primitives';
import { Page, Card, SectionHead, ErrorState, LoadingState } from '../components/Layout';
import { useSchedules, api, recordConnectionError } from '../api/hooks';
import { ApiError } from '../api/client';
import type { Schedule } from '../types';

export function Schedules({ env = 'prod' }: { env?: string }) {
  const { data, error } = useSchedules(env);
  // local override layer: optimistic toggles applied on top of polled data,
  // so the switch stays responsive between 2s refreshes.
  const [overrides, setOverrides] = React.useState<Record<string, boolean>>({});
  // C2 · mirrors RunView's actionError: a failed toggle must say so instead of
  // silently rolling back. Cleared on the next attempt.
  const [toggleError, setToggleError] = React.useState<string | null>(null);
  const items: Schedule[] = (data ?? []).map((s) => (s.id in overrides ? { ...s, enabled: overrides[s.id] } : s));
  const toggle = (id: string) => {
    const cur = items.find((i) => i.id === id);
    if (!cur) return;
    const next = !cur.enabled;
    setToggleError(null);
    setOverrides((o) => ({ ...o, [id]: next }));
    api.setScheduleEnabled(id, next, env).catch((e: unknown) => {
      // revert optimistic change on failure and surface the reason (C2)
      setOverrides((o) => ({ ...o, [id]: cur.enabled }));
      setToggleError(e instanceof Error ? e.message : 'request failed');
      // A rejected key must reach the shared connection registry so the key
      // prompt takes over, exactly like RunHeader's control actions.
      if (e instanceof ApiError && e.status === 401) recordConnectionError(e);
    });
  };
  if (!data) {
    return (
      <Page>
        <SectionHead title="Schedules" sub="Cron-style triggers attached to your tasks." />
        {error ? <ErrorState message={error} /> : <LoadingState />}
      </Page>
    );
  }
  return (
    <Page>
      <SectionHead title="Schedules" sub="Cron-style triggers attached to your tasks." />
      {toggleError && (
        <div role="alert" style={{ display: 'flex', alignItems: 'center', gap: 6, margin: '0 0 12px', padding: '8px 10px', borderRadius: 8, fontSize: 12.5, color: 'var(--red-text)', background: 'color-mix(in srgb, var(--red-primary) 7%, transparent)', border: '1px solid color-mix(in srgb, var(--red-primary) 25%, transparent)' }}>
          <Icon name="close" size={13} />
          <span>Failed to update schedule — {toggleError}</span>
        </div>
      )}
      <Card>
        {items.length === 0 && (
          <div style={{ padding: '48px 0', textAlign: 'center', color: 'var(--fg-subtle)', fontSize: 13 }}>
            No schedules yet — declare <code className="mono">cron</code> on a task and start its worker.
          </div>
        )}
        {items.map((s, i) => (
          <div key={s.id} style={{
            display: 'flex', alignItems: 'center', gap: 16, padding: '0 16px', height: 60, opacity: s.enabled ? 1 : 0.55,
            borderBottom: i < items.length - 1 ? '1px solid var(--divider)' : 'none',
          }}>
            <div style={{ width: 34, height: 34, borderRadius: 9, background: 'var(--accent-fill)', display: 'grid', placeItems: 'center', flexShrink: 0 }}>
              <Icon name="clock" size={17} style={{ color: 'var(--accent)' }} />
            </div>
            <div style={{ width: 130, flexShrink: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 }}>
                <Icon name="bolt" size={12} style={{ color: 'var(--accent)' }} />{s.task}
              </div>
              <div style={{ fontSize: 11.5, color: 'var(--fg-subtle)' }}>{s.human}</div>
            </div>
            <code style={{ fontFamily: 'var(--font-mono)', fontSize: 12, padding: '3px 8px', borderRadius: 6, background: 'var(--code-bg)', color: 'var(--fg-muted)', whiteSpace: 'nowrap', flexShrink: 0 }}>{s.cron}</code>
            <div style={{ fontSize: 12, color: 'var(--fg-subtle)', display: 'flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap' }}>
              <Icon name="globe" size={12} />{s.tz}
            </div>
            <div style={{ flex: 1 }} />
            <div style={{ textAlign: 'right', width: 110 }}>
              <div style={{ fontSize: 10.5, color: 'var(--fg-faint)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Next run</div>
              <div className="mono tnum" style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--fg)' }}>{s.next}</div>
            </div>
            <div style={{ width: 70 }}><Badge tone={s.last === 'warn' ? 'orange' : 'green'}>last {s.last}</Badge></div>
            <Switch checked={s.enabled} onChange={() => toggle(s.id)} />
          </div>
        ))}
      </Card>
    </Page>
  );
}
