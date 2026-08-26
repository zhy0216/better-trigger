/* =============================================================================
   Better Trigger — Runs list.
   ============================================================================= */
import React from 'react';
import { Icon, Badge, StatusDot, StatusBadge, Input } from '../components/primitives';
import { Page, Card, ErrorState, LoadingState } from '../components/Layout';
import { useRuns } from '../api/hooks';
import type { Run } from '../types';

// filter id → server status (contract §5: queued|running|waiting|completed|failed|canceled)
const FILTER_TO_SERVER: Record<string, string | undefined> = {
  all: undefined,
  running: 'running',
  success: 'completed',
  failed: 'failed',
  queued: 'queued',
  waiting: 'waiting',
  canceled: 'canceled',
};

const FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'running', label: 'Running' },
  { id: 'success', label: 'Completed' },
  { id: 'failed', label: 'Failed' },
  { id: 'queued', label: 'Queued' },
  { id: 'waiting', label: 'Waiting' },
  { id: 'canceled', label: 'Canceled' },
];

export function RunsList({ onOpenRun, env }: { onOpenRun: (run: Run) => void; env: string }) {
  const [filter, setFilter] = React.useState('all');
  const [q, setQ] = React.useState('');
  const [live, setLive] = React.useState(true);
  // env + status + taskId filtering all happen server-side (a task not on the
  // first loaded page would otherwise show a false "no matches" empty state).
  // `live` gates polling — Paused stops requests and holds current data,
  // resuming refreshes immediately.
  // PF3: loadMore consumes the server's nextCursor (older pages append).
  const { data: source, error, loadMore, loadingMore, hasMore, loadMoreError } = useRuns(
    env,
    { status: FILTER_TO_SERVER[filter], taskId: q || undefined },
    live,
  );
  const runs = source ?? [];

  const colT = '112px 150px minmax(0,1fr) 96px 130px 96px 92px';
  const Th = ({ children, style }: { children?: React.ReactNode; style?: React.CSSProperties }) => (
    <div style={{ fontSize: 10.5, fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--fg-faint)', ...style }}>{children}</div>
  );

  return (
    <Page>
      {/* toolbar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', gap: 2, padding: 3, background: 'var(--fill)', borderRadius: 9999 }}>
          {FILTERS.map((f) => (
            <button key={f.id} onClick={() => setFilter(f.id)}
              style={{
                display: 'flex', alignItems: 'center', gap: 6, height: 28, padding: '0 12px', borderRadius: 9999, border: 'none', cursor: 'pointer',
                fontFamily: 'var(--font-sans)', fontSize: 12.5, fontWeight: 500,
                background: filter === f.id ? 'var(--surface)' : 'transparent', color: filter === f.id ? 'var(--fg)' : 'var(--fg-muted)',
                boxShadow: filter === f.id ? 'var(--shadow-sm)' : 'none',
              }}>
              {f.id !== 'all' && <StatusDot status={f.id === 'waiting' ? 'frozen' : f.id} size={6} />}{f.label}
            </button>
          ))}
        </div>
        <div style={{ width: 220 }}><Input icon="search" placeholder="Filter by task id…" value={q} onChange={setQ} mono /></div>
        <div style={{ flex: 1 }} />
        <button onClick={() => setLive((v) => !v)}
          style={{
            display: 'flex', alignItems: 'center', gap: 7, height: 32, padding: '0 11px', borderRadius: 8, border: '1px solid var(--border)',
            background: live ? 'var(--accent-fill)' : 'var(--surface)', color: live ? 'var(--accent)' : 'var(--fg-muted)', cursor: 'pointer', fontSize: 12.5, fontWeight: 500,
          }}>
          {live ? <span className="bt-live-dot" /> : <Icon name="pause" size={13} />} {live ? 'Live tailing' : 'Paused'}
        </button>
      </div>

      {source === null ? (
        <Card>{error ? <ErrorState message={error} /> : <LoadingState />}</Card>
      ) : (
      <Card>
        <div style={{ display: 'grid', gridTemplateColumns: colT, gap: 12, padding: '11px 16px', borderBottom: '1px solid var(--divider)' }}>
          <Th>Status</Th><Th>Run</Th><Th>Task</Th><Th>Trigger</Th><Th>Version</Th><Th style={{ textAlign: 'right' }}>Duration</Th><Th style={{ textAlign: 'right' }}>Started</Th>
        </div>
        {runs.map((r, i) => (
          <div key={r.id} onClick={() => onOpenRun(r)}
            style={{
              display: 'grid', gridTemplateColumns: colT, gap: 12, padding: '0 16px', height: 'var(--row-h)', alignItems: 'center', cursor: 'pointer',
              borderBottom: i < runs.length - 1 ? '1px solid var(--divider)' : 'none', transition: 'background var(--dur-fast)',
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--hover)')}
            onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}>
            <div><StatusBadge status={r.status} size="sm" /></div>
            <div className="mono" style={{ fontSize: 12, color: 'var(--fg-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.id}</div>
            <div style={{ fontSize: 13, fontWeight: 500, display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 }}>
              <Icon name="bolt" size={13} style={{ color: 'var(--accent)' }} />
              <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.task}</span>
              {r.env !== 'prod' && <Badge tone="orange" style={{ flexShrink: 0 }}>{r.env}</Badge>}
            </div>
            <div style={{ fontSize: 12, color: 'var(--fg-muted)' }}>{r.trigger}</div>
            <div className="mono" style={{ fontSize: 11.5, color: 'var(--fg-subtle)' }}>{r.version}</div>
            <div className="mono tnum" style={{ fontSize: 12.5, textAlign: 'right', color: r.status === 'running' ? 'var(--accent)' : 'var(--fg)' }}>
              {r.duration || (r.status === 'running' ? 'running…' : '—')}
            </div>
            <div style={{ fontSize: 12, color: 'var(--fg-subtle)', textAlign: 'right', whiteSpace: 'nowrap' }}>{r.started}</div>
          </div>
        ))}
        {runs.length === 0 && (
          <div style={{ padding: '48px 0', textAlign: 'center', color: 'var(--fg-subtle)', fontSize: 13 }}>No runs match these filters.</div>
        )}
        {hasMore && (
          <div style={{ padding: '10px 16px', borderTop: '1px solid var(--divider)' }}>
            <button onClick={() => void loadMore()} disabled={loadingMore}
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center', width: '100%', height: 32, borderRadius: 8,
                border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--fg-muted)', cursor: 'pointer',
                fontFamily: 'var(--font-sans)', fontSize: 12.5, fontWeight: 500,
              }}>
              {loadingMore ? 'Loading…' : 'Load more'}
            </button>
            {loadMoreError && (
              <div role="alert" style={{ marginTop: 8, fontSize: 12, color: 'var(--red-text)', textAlign: 'center' }}>
                Load failed — retry
              </div>
            )}
          </div>
        )}
      </Card>
      )}
    </Page>
  );
}
