/* =============================================================================
   Better Trigger — Schedules.
   ============================================================================= */
import React from 'react';
import { Icon, Button, Badge, Switch } from '../components/primitives';
import { Page, Card, SectionHead } from '../components/Layout';
import { useSchedules, api } from '../api/hooks';
import type { Schedule } from '../types';

export function Schedules() {
  const { data, live } = useSchedules();
  // local override layer: optimistic toggles applied on top of polled data,
  // so the switch stays responsive between 2s refreshes.
  const [overrides, setOverrides] = React.useState<Record<string, boolean>>({});
  const items: Schedule[] = data.map((s) => (s.id in overrides ? { ...s, enabled: overrides[s.id] } : s));
  const toggle = (id: string) => {
    const cur = items.find((i) => i.id === id);
    if (!cur) return;
    const next = !cur.enabled;
    setOverrides((o) => ({ ...o, [id]: next }));
    if (live) {
      api.setScheduleEnabled(id, next).catch(() => {
        // revert optimistic change on failure
        setOverrides((o) => ({ ...o, [id]: cur.enabled }));
      });
    }
  };
  return (
    <Page>
      <SectionHead title="Schedules" sub="Cron-style triggers attached to your tasks." action={<Button icon="plus">New schedule</Button>} />
      <Card>
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
