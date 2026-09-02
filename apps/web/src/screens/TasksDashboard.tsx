/* =============================================================================
   Better Trigger — Tasks dashboard.
   ============================================================================= */
import React from 'react';
import { Icon, Sparkline } from '../components/primitives';
import { Page, Card, Metric, ErrorState, LoadingState } from '../components/Layout';
import { useTasks, useSchedules, useWorkers } from '../api/hooks';
import type { Route } from '../types';

export function TasksDashboard({ setRoute, env = 'prod' }: { setRoute: (r: Route) => void; env?: string }) {
  const { data: tasks, error } = useTasks(env);
  const { data: schedules, error: schedulesError } = useSchedules(env);
  const { data: workers, error: workersError } = useWorkers(env);
  if (!tasks) return <Page>{error ? <ErrorState message={error} /> : <LoadingState />}</Page>;
  const totalRuns = tasks.reduce((a, t) => a + t.runs24h, 0);
  const avgSuccess = tasks.length ? (tasks.reduce((a, t) => a + t.success, 0) / tasks.length).toFixed(1) : '0.0';
  const scheduledCount = schedules?.filter((s) => s.enabled).length;
  const workersOnline = workers?.filter((w) => w.status === 'online').length;

  const Stat = ({ label, value, sub, tone, subTone }: { label: string; value: React.ReactNode; sub?: string; tone?: string; subTone?: string }) => (
    <Card style={{ padding: '14px 16px', flex: 1, minWidth: 0 }}>
      <div style={{ fontSize: 11.5, color: 'var(--fg-subtle)', marginBottom: 6 }}>{label}</div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 7 }}>
        <span className="tnum" style={{ fontSize: 26, fontWeight: 600, letterSpacing: '-0.02em', color: tone || 'var(--fg)' }}>{value}</span>
        {sub && <span role="status" style={{ fontSize: 12, color: subTone || 'var(--fg-subtle)' }}>{sub}</span>}
      </div>
    </Card>
  );

  return (
    <Page>
      <div style={{ display: 'flex', gap: 12, marginBottom: 18 }}>
        <Stat label="Runs · last 24h" value={totalRuns.toLocaleString()} />
        <Stat label="Avg success rate" value={avgSuccess + '%'} tone="var(--green-primary)" />
        <Stat
          label="Active tasks"
          value={tasks.length}
          sub={schedulesError ? 'schedules unavailable' : scheduledCount != null ? scheduledCount + ' scheduled' : undefined}
          subTone={schedulesError ? 'var(--red-text)' : undefined}
        />
        <Stat
          label="Workers online"
          value={workersOnline ?? '—'}
          tone={workersOnline ? 'var(--green-primary)' : undefined}
          sub={workersError ? 'unavailable' : undefined}
          subTone={workersError ? 'var(--red-text)' : undefined}
        />
      </div>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <h4 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>Tasks</h4>
      </div>

      {tasks.length === 0 && (
        <Card style={{ padding: '48px 0', textAlign: 'center', color: 'var(--fg-subtle)', fontSize: 13 }}>
          No tasks registered yet — start a worker to register its tasks.
        </Card>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 12 }}>
        {tasks.map((t) => (
          <Card key={t.id} hover onClick={() => setRoute('runs')} style={{ padding: 16 }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3 }}>
                  <Icon name="bolt" size={15} style={{ color: 'var(--accent)', flexShrink: 0 }} />
                  <span className="mono" style={{ fontSize: 13.5, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.name}</span>
                </div>
                <div className="mono" style={{ fontSize: 11, color: 'var(--fg-subtle)' }}>{t.file}</div>
              </div>
              <Sparkline data={t.trend} color={t.success < 97 ? 'var(--orange-primary)' : 'var(--accent)'} />
            </div>
            <div style={{ display: 'flex', gap: 20, marginTop: 14, paddingTop: 13, borderTop: '1px solid var(--divider)' }}>
              <Metric label="24h runs" value={t.runs24h.toLocaleString()} />
              <Metric label="p50" value={t.p50} />
              <Metric label="p95" value={t.p95} />
              <Metric label="success" value={t.success + '%'} tone={t.success < 97 ? 'var(--orange-text)' : 'var(--green-text)'} />
            </div>
          </Card>
        ))}
      </div>
    </Page>
  );
}
