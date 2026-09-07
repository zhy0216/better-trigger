/* =============================================================================
   Better Trigger — Tasks dashboard.
   ============================================================================= */
import React from 'react';
import { Icon, Sparkline } from '../components/primitives';
import { Page, Card, ErrorState, LoadingState } from '../components/Layout';
import { useTasks, useSchedules, useWorkers } from '../api/hooks';
import type { Route } from '../types';
import './tasks-dashboard.css';

function Stat({ label, value, icon, sub, tone, unavailable = false }: {
  label: string;
  value: React.ReactNode;
  icon: string;
  sub: string;
  tone?: string;
  unavailable?: boolean;
}) {
  return (
    <Card style={{ minWidth: 0 }}>
      <div className="bt-tasks-stat" aria-label={label} role="group">
        <div className="bt-tasks-stat-label"><span>{label}</span><Icon name={icon} size={16} /></div>
        <div className="bt-tasks-stat-value tnum" style={{ color: tone }}>{value}</div>
        <div className={`bt-tasks-stat-note${unavailable ? ' bt-tasks-stat-error' : ''}`} role={unavailable ? 'status' : undefined}>{sub}</div>
      </div>
    </Card>
  );
}

export function TasksDashboard({ setRoute, env = 'prod' }: { setRoute: (r: Route) => void; env?: string }) {
  const { data: tasks, error } = useTasks(env);
  const { data: schedules, error: schedulesError } = useSchedules(env);
  const { data: workers, error: workersError } = useWorkers(env);
  if (!tasks) return <Page>{error ? <ErrorState message={error} /> : <LoadingState />}</Page>;
  const totalRuns = tasks.reduce((a, t) => a + t.runs24h, 0);
  const tasksWithRuns = tasks.filter((t) => t.runs24h > 0);
  const avgSuccess = tasksWithRuns.length ? (tasksWithRuns.reduce((a, t) => a + t.success, 0) / tasksWithRuns.length).toFixed(1) : null;
  const scheduledCount = schedules?.filter((s) => s.enabled).length;
  const workersOnline = workers?.filter((w) => w.status === 'online').length;

  return (
    <Page>
      <div className="bt-tasks-heading">
        <div>
          <div className="bt-tasks-eyebrow">Overview</div>
          <h1>Task activity</h1>
          <p>Your tasks, throughput, and worker health in one place.</p>
        </div>
        <span className="bt-tasks-period"><Icon name="clock" size={14} />Last 24 hours</span>
      </div>
      <div className="bt-tasks-stats">
        <Stat label="Runs · last 24h" value={totalRuns.toLocaleString()} icon="activity" sub="Across registered tasks" />
        <Stat label="Avg success rate" value={avgSuccess == null ? '—' : `${avgSuccess}%`} icon="check"
          tone={avgSuccess == null ? undefined : 'var(--green-text)'} sub={avgSuccess == null ? 'No runs in the last 24 hours' : 'Average across tasks with runs'} />
        <Stat label="Registered tasks" value={tasks.length} icon="bolt"
          sub={schedulesError ? 'schedules unavailable' : scheduledCount != null ? `${scheduledCount} scheduled` : 'Loading schedules…'}
          unavailable={!!schedulesError} />
        <Stat label="Workers online" value={workersError ? '—' : workersOnline ?? '—'} icon="cpu"
          tone={!workersError && workersOnline ? 'var(--green-text)' : undefined}
          sub={workersError ? 'unavailable' : workersOnline == null ? 'Loading workers…' : 'Currently connected'}
          unavailable={!!workersError} />
      </div>
      <div className="bt-tasks-section-heading">
        <h2>Registered tasks <span className="bt-tasks-count tnum">{tasks.length}</span></h2>
        {tasks.length > 0 && <span>Open a task card to browse runs</span>}
      </div>
      {tasks.length === 0 ? (
        <Card>
          <div className="bt-tasks-empty">
            <span className="bt-tasks-empty-icon"><Icon name="bolt" size={24} /></span>
            <h3>No tasks registered yet</h3>
            <p>Start a worker to register its tasks. Their activity will appear here.</p>
          </div>
        </Card>
      ) : (
        <div className="bt-tasks-grid">
          {tasks.map((t) => (
            <Card key={t.id} hover onClick={() => setRoute('runs')} style={{ minWidth: 0 }}>
              <div className="bt-tasks-task-card">
                <div className="bt-tasks-task-heading">
                  <span className="bt-tasks-task-icon"><Icon name="bolt" size={18} /></span>
                  <div className="bt-tasks-task-identity">
                    <h3 className="mono">{t.name}</h3>
                    <p className="mono">{t.file}</p>
                  </div>
                  <span className="bt-tasks-card-arrow" aria-hidden="true"><Icon name="arrowRight" size={16} /></span>
                </div>
                <dl className="bt-tasks-task-metrics">
                  <div><dt>24h runs</dt><dd className="tnum">{t.runs24h.toLocaleString()}</dd></div>
                  <div>
                    <dt>Success rate</dt>
                    <dd className="tnum" style={{ color: t.runs24h === 0 ? 'var(--fg-muted)' : t.success < 97 ? 'var(--orange-text)' : 'var(--green-text)' }}>
                      {t.runs24h === 0 ? <>—<span className="bt-tasks-no-runs">No runs</span></> : `${t.success}%`}
                    </dd>
                  </div>
                </dl>
                <div className="bt-tasks-task-footer">
                  <dl className="bt-tasks-latency">
                    <div><dt>p50</dt><dd className="mono tnum">{t.p50}</dd></div>
                    <div><dt>p95</dt><dd className="mono tnum">{t.p95}</dd></div>
                  </dl>
                  <span className="bt-tasks-trend" aria-hidden="true"><Sparkline data={t.trend} color={t.runs24h === 0 ? 'var(--fg-subtle)' : t.success < 97 ? 'var(--orange-primary)' : 'var(--accent)'} /></span>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}
    </Page>
  );
}
