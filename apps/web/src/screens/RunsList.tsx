/* =============================================================================
   Better Trigger — Runs list.
   ============================================================================= */
import React from 'react';
import { Icon, Badge, StatusDot, StatusBadge, Input } from '../components/primitives';
import { Page, Card, ErrorState, LoadingState } from '../components/Layout';
import { useRuns } from '../api/hooks';
import type { Run } from '../types';
import './runs-list.css';

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
  const hasFilters = filter !== 'all' || q !== '';
  const clearFilters = () => {
    setFilter('all');
    setQ('');
  };

  return (
    <Page>
      <section className="bt-runs" aria-labelledby="bt-runs-title">
      <header className="bt-runs-heading">
        <div>
          <h1 id="bt-runs-title">Run history</h1>
          <p>Follow your tasks from trigger to completion.</p>
        </div>
        <button type="button" onClick={() => setLive((v) => !v)} aria-pressed={live}
          className="bt-runs-live" title={live ? 'Pause automatic updates' : 'Resume automatic updates'}>
          {live ? <span className="bt-live-dot" /> : <Icon name="pause" size={13} />}
          {live ? 'Live tailing' : 'Paused'}
        </button>
      </header>

      <div className="bt-runs-toolbar">
        <div role="group" aria-label="Status filter" className="bt-runs-filters">
          {FILTERS.map((f) => (
            <button key={f.id} type="button" onClick={() => setFilter(f.id)} aria-pressed={filter === f.id}
              className="bt-runs-filter">
              {f.id !== 'all' && <StatusDot status={f.id === 'waiting' ? 'frozen' : f.id} size={6} />}{f.label}
            </button>
          ))}
        </div>
        <label className="bt-runs-search">
          <span className="bt-runs-sr-only">Filter by task ID</span>
          <Input icon="search" placeholder="Filter by task id…" value={q} onChange={setQ} mono />
        </label>
      </div>

      <div className="bt-runs-summary">
        <p aria-live="polite" aria-atomic="true">
          {source !== null && <strong>{runs.length} {runs.length === 1 ? 'run' : 'runs'} loaded</strong>}
          <span>{live ? 'Following new runs' : 'Updates paused'}</span>
        </p>
        {hasFilters && (source === null || runs.length > 0) && (
          <button type="button" className="bt-runs-clear" onClick={clearFilters}>Clear filters</button>
        )}
      </div>
      {source === null ? (
        <Card>{error ? <ErrorState message={error} /> : !live ? (
          <div className="bt-runs-empty">
            <Icon name="pause" size={22} />
            <h2>Updates are paused.</h2>
            <p>Resume live updates to load runs for these filters.</p>
            <button type="button" className="bt-runs-action" onClick={() => setLive(true)}>Resume live updates</button>
          </div>
        ) : <LoadingState />}</Card>
      ) : (
      <Card>
        {runs.length > 0 && <div className="bt-runs-columns" aria-hidden="true">
          <span>Status</span><span>Run</span><span>Task</span><span>Trigger</span><span>Version</span><span>Duration</span><span>Started</span>
        </div>}
        <div className="bt-runs-rows">
        {runs.map((r) => (
          <button key={r.id} type="button" onClick={() => onOpenRun(r)} className="bt-runs-row">
            <span className="bt-runs-status"><StatusBadge status={r.status} size="sm" /></span>
            <span className="bt-runs-id mono" title={r.id}><span className="bt-runs-field-label">Run </span><span className="bt-runs-value">{r.id}</span></span>
            <span className="bt-runs-task">
              <Icon name="bolt" size={13} />
              <span className="bt-runs-value" title={r.task}>{r.task}</span>
              {r.env !== 'prod' && <Badge tone="orange">{r.env}</Badge>}
            </span>
            <span className="bt-runs-trigger"><span className="bt-runs-field-label">Trigger </span><span className="bt-runs-value" title={r.trigger}>{r.trigger}</span></span>
            <span className="bt-runs-version mono"><span className="bt-runs-field-label">Version </span><span className="bt-runs-value" title={r.version}>{r.version}</span></span>
            <span className={`bt-runs-duration mono tnum${r.status === 'running' ? ' bt-runs-duration-running' : ''}`}>
              <span className="bt-runs-field-label">Duration </span>
              {r.duration || (r.status === 'running' ? 'running…' : '—')}
            </span>
            <span className="bt-runs-started"><span className="bt-runs-field-label">Started </span>{r.started}</span>
          </button>
        ))}
        </div>
        {runs.length === 0 && (
          <div className="bt-runs-empty">
            <span className="bt-runs-empty-icon"><Icon name={hasFilters ? 'search' : 'bolt'} size={22} /></span>
            <h2>{hasFilters ? 'No runs match these filters.' : 'No runs yet.'}</h2>
            <p>{hasFilters ? 'Try another status or task ID to find the run you need.' : 'Runs will appear here when a task is triggered in this environment.'}</p>
            {hasFilters && <button type="button" className="bt-runs-action" onClick={clearFilters}>Clear filters</button>}
          </div>
        )}
        {hasMore && (
          <div className="bt-runs-pagination">
            <button type="button" onClick={() => void loadMore()} disabled={loadingMore || !live}
              className="bt-runs-action" aria-busy={loadingMore}>
              {loadingMore ? 'Loading…' : loadMoreError ? 'Retry loading more' : 'Load more'}
            </button>
            {!live && <p className="bt-runs-pagination-hint">Resume live updates to load more runs.</p>}
            {loadMoreError && (
              <div role="alert" className="bt-runs-pagination-error">
                Could not load more runs. Your loaded runs are still available.
              </div>
            )}
          </div>
        )}
      </Card>
      )}
      </section>
    </Page>
  );
}
