/* =============================================================================
   Better Trigger — Schedules.
   ============================================================================= */
import React from 'react';
import { Icon, Badge } from '../components/primitives';
import { Page, Card, SectionHead, ErrorState, LoadingState } from '../components/Layout';
import { useSchedules, api, recordConnectionError } from '../api/hooks';
import { ApiError } from '../api/client';
import type { Schedule } from '../types';
import './schedules.css';

export function Schedules({ env = 'prod' }: { env?: string }) {
  // Pending writes and optimistic values belong to one environment only.
  return <ScheduleList key={env} env={env} />;
}

function ScheduleList({ env }: { env: string }) {
  const { data, error } = useSchedules(env);
  const [overrides, setOverrides] = React.useState<Record<string, boolean>>({});
  const [toggleError, setToggleError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState<Set<string>>(() => new Set());
  const serverRef = React.useRef<Record<string, boolean>>({});
  const seqRef = React.useRef(0);
  // A synchronous guard also catches repeated clicks before React renders.
  // Sequence ownership discards writes whose row disappeared or unmounted.
  const requestsRef = React.useRef(new Map<string, number>());
  const items: Schedule[] = (data ?? []).map((s) => (s.id in overrides ? { ...s, enabled: overrides[s.id] } : s));

  React.useEffect(() => {
    const requests = requestsRef.current;
    return () => requests.clear();
  }, []);

  React.useEffect(() => {
    if (!data) return;
    const present = new Set(data.map((s) => s.id));
    for (const s of data) serverRef.current[s.id] = s.enabled;
    for (const id of requestsRef.current.keys()) {
      if (!present.has(id)) requestsRef.current.delete(id);
    }
    setPending((p) => [...p].every((id) => present.has(id)) ? p : new Set([...p].filter((id) => present.has(id))));
    setOverrides((o) => {
      let changed = false;
      const next: Record<string, boolean> = {};
      for (const [id, val] of Object.entries(o)) {
        const row = data.find((s) => s.id === id);
        if (!row || row.enabled === val) { changed = true; continue; }
        next[id] = val;
      }
      return changed ? next : o;
    });
  }, [data]);

  const toggle = (id: string) => {
    const cur = items.find((i) => i.id === id);
    if (!cur || requestsRef.current.has(id)) return;
    const next = !cur.enabled;
    const seq = ++seqRef.current;
    requestsRef.current.set(id, seq);
    const isCurrent = () => requestsRef.current.get(id) === seq;
    setPending((p) => new Set(p).add(id));
    setToggleError(null);
    setOverrides((o) => ({ ...o, [id]: next }));
    api.setScheduleEnabled(id, next, env)
      .then(() => {
        if (isCurrent()) serverRef.current[id] = next;
      })
      .catch((e: unknown) => {
        if (!isCurrent()) return;
        setOverrides((o) => ({ ...o, [id]: serverRef.current[id] ?? cur.enabled }));
        setToggleError(`${cur.task}: ${e instanceof Error ? e.message : 'request failed'}`);
        if (e instanceof ApiError && e.status === 401) recordConnectionError(e);
      })
      .finally(() => {
        if (!isCurrent()) return;
        requestsRef.current.delete(id);
        setPending((p) => { const nextPending = new Set(p); nextPending.delete(id); return nextPending; });
      });
  };

  if (!data) {
    return (
      <Page>
        <SectionHead title="Schedules" sub="Keep recurring work running on time." />
        {error ? <ErrorState message={error} /> : <LoadingState />}
      </Page>
    );
  }
  const activeCount = items.filter((s) => s.enabled).length;

  return (
    <Page>
      <SectionHead title="Schedules" sub="Keep recurring work running on time." />
      {toggleError && (
        <div role="alert" className="bt-schedules-error">
          <Icon name="close" size={15} />
          <span>Failed to update schedule — {toggleError}</span>
        </div>
      )}
      {items.length > 0 && (
        <div className="bt-schedules-summary">
          <span><strong className="tnum">{items.length}</strong> {items.length === 1 ? 'schedule' : 'schedules'}</span>
          <span className="bt-schedules-summary-active"><span aria-hidden="true" />{activeCount} active</span>
          <span>{items.length - activeCount} paused</span>
        </div>
      )}
      <Card>
        {items.length === 0 ? (
          <div className="bt-schedules-empty">
            <span className="bt-schedules-empty-icon"><Icon name="clock" size={24} /></span>
            <h3>No schedules yet</h3>
            <p>Declare <code className="mono">cron</code> on a task and start its worker to register a recurring schedule.</p>
          </div>
        ) : items.map((s) => (
          <div key={s.id} className="bt-schedules-row" role="group" aria-label={`${s.task} schedule`}>
            <div className="bt-schedules-identity">
              <span className="bt-schedules-icon"><Icon name="clock" size={18} /></span>
              <div className="bt-schedules-task">
                <h3 className="mono">{s.task}</h3>
                <p>{s.human}</p>
              </div>
            </div>
            <div className="bt-schedules-expression">
              <code className="mono">{s.cron}</code>
              <span className="bt-schedules-timezone"><Icon name="globe" size={12} />{s.tz}</span>
            </div>
            <div className="bt-schedules-next">
              <span className="bt-schedules-field-label">Next run</span>
              <span className="mono tnum">{s.next}</span>
            </div>
            <div className="bt-schedules-last">
              <span className="bt-schedules-field-label">Last run</span>
              <Badge tone={s.last === 'warn' ? 'orange' : s.last === 'ok' ? 'green' : 'gray'}>{s.last === '—' ? 'No runs yet' : s.last}</Badge>
            </div>
            <div className="bt-schedules-control">
              <span className={`bt-schedules-state${s.enabled ? ' bt-schedules-state-active' : ''}`} aria-live="polite">
                {pending.has(s.id) ? 'Saving…' : s.enabled ? 'Active' : 'Paused'}
              </span>
              <button type="button" role="switch" aria-checked={s.enabled} aria-label={`Toggle ${s.task} schedule`}
                className="bt-schedules-switch" disabled={pending.has(s.id)} aria-busy={pending.has(s.id)}
                onClick={() => toggle(s.id)}>
                <span className="bt-schedules-switch-track" aria-hidden="true"><span /></span>
              </button>
            </div>
          </div>
        ))}
      </Card>
    </Page>
  );
}
