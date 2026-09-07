/* =============================================================================
   Better Trigger — Run observability (the hero).
   A single coherent waterfall: time-aligned span tree + inspector + logs,
   rendered from live run detail. vizStyle: "waterfall" | "tree".
   ============================================================================= */
import React from 'react';
import { Icon, Badge, Button, StatusBadge, StatusDot } from '../../components/primitives';
import { STATUS_META } from '../../components/status-meta';
import { ErrorState, LoadingState } from '../../components/Layout';
import { useRun, api, recordConnectionError } from '../../api/hooks';
import { ApiError } from '../../api/client';
import { relativeFuture, type AdaptedRunDetail } from '../../api/adapter';
import { createRetryIntentKey } from './retryIntentKey';
import { rulerTicks } from './ruler';
import { isAtBottom } from './scroll';
import type { Span, Trace, LogLine, VizStyle } from '../../types';
import './run-view.css';

const KIND_ICON: Record<string, string> = { task: 'bolt', http: 'globe', query: 'db', fn: 'fn' };
const KIND_LABEL: Record<string, string> = { task: 'subtask', http: 'http', query: 'query', fn: 'fn' };

function fmtMs(ms: number): string {
  if (ms < 1000) return Math.round(ms) + 'ms';
  return (ms / 1000).toFixed(ms < 10000 ? 2 : 1) + 's';
}

// ---- the trace header ----
function RunHeader({ trace, runStatus, env, onRetried }: { trace: Trace; runStatus: string; env: string; onRetried?: (newRunId: string) => void }) {
  const Meta = ({ icon, label, value, mono }: { icon: string; label: string; value: React.ReactNode; mono?: boolean }) => (
    <div className="run-meta" style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 }}>
      <Icon name={icon} size={14} style={{ color: 'var(--fg-subtle)' }} />
      <span style={{ fontSize: 12, color: 'var(--fg-subtle)' }}>{label}</span>
      <span className={mono ? 'mono' : ''} style={{ fontSize: 12.5, color: 'var(--fg)', fontWeight: 500, overflowWrap: 'anywhere' }}>{value}</span>
    </div>
  );
  // UI status vocabulary: waiting maps to 'frozen', so cancel covers the
  // server's queued/running/waiting; retry covers the terminal dead ends.
  const canRetry = runStatus === 'failed' || runStatus === 'canceled';
  const canCancel = runStatus === 'queued' || runStatus === 'running' || runStatus === 'frozen';
  // Disabled/"pending" overlay for the gap between click and the next polled
  // frame; on failure it rolls back (buttons re-enable) and surfaces the error.
  const [pending, setPending] = React.useState<'retry' | 'cancel' | null>(null);
  const [actionError, setActionError] = React.useState<string | null>(null);
  // p2-38 repair: one Idempotency-Key per retry INTENT, not per click event.
  // current() mints on the first click of an intent and returns the SAME key
  // for every re-send of that intent (the second click of a double-click
  // racing the pending disabled state, a re-send while the request is still
  // in flight), so the server's replay path hands back the one run this
  // intent already created. clear() in the request's finally ends the intent
  // on settle (success OR failure, whether or not a response made it back) —
  // the NEXT click is a new intent with a fresh key. Two dashboard tabs each
  // hold their own holder by design: cross-client dedup needs server-side
  // coordination and is outside this protocol (docs/backend-contract.md §3.7).
  const retryIntentKey = React.useMemo(() => createRetryIntentKey(), []);
  const runAction = async (kind: 'retry' | 'cancel') => {
    setActionError(null);
    setPending(kind);
    try {
      if (kind === 'retry') {
        // retryRun mints a NEW run (id changes) — navigate to it, or the
        // poll would keep watching the old failed run forever and repeat
        // clicks would silently spawn N runs.
        const operationKey = retryIntentKey.current();
        const { runId: newRunId } = await api.retryRun(trace.runId, env, { operationKey });
        onRetried?.(newRunId);
      } else {
        // Cancel keeps the same run: the 2s useRun poll picks up 'canceled'.
        await api.cancelRun(trace.runId, env);
      }
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'request failed');
      // C3: only a 401 means the credential is bad; a 404/409/network failure is
      // a transient run-state or transport problem and must not flip the whole
      // dashboard to "offline". Feed just the auth rejection into the shared
      // connection registry so the key prompt takes over.
      if (e instanceof ApiError && e.status === 401) recordConnectionError(e);
    } finally {
      setPending(null);
      if (kind === 'retry') retryIntentKey.clear();
    }
  };
  return (
    <div className="run-header">
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <StatusBadge status={runStatus} />
        <h3 style={{ margin: 0, fontSize: 18, fontWeight: 600, letterSpacing: '-0.01em', overflowWrap: 'anywhere', minWidth: 0 }}>{trace.task}</h3>
        <span className="mono run-id">{trace.runId}</span>
        <div style={{ flex: 1 }} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {canRetry && (
            <Button size="sm" variant="outline" icon="retry" disabled={pending !== null}
              onClick={() => void runAction('retry')}>
              {pending === 'retry' ? 'Retrying…' : 'Retry'}
            </Button>
          )}
          {canCancel && (
            <Button size="sm" variant="danger" icon="close" disabled={pending !== null}
              onClick={() => void runAction('cancel')}>
              {pending === 'cancel' ? 'Canceling…' : 'Cancel'}
            </Button>
          )}
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 18, flexWrap: 'wrap', padding: '13px 0 14px' }}>
        <Meta icon="bolt" label="trigger" value={trace.trigger} mono />
        <Meta icon="layers" label="env" value={trace.env} />
        <Meta icon="git" label="version" value={trace.version} mono />
        <Meta icon="clock" label="queued" value={trace.queuedFor} />
        <Meta icon="activity" label="elapsed" value={fmtMs(trace.totalMs)} />
      </div>
      {actionError && (
        <div role="alert" style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 10px', marginBottom: 12, borderRadius: 8, fontSize: 12.5, color: 'var(--red-text)', background: 'color-mix(in srgb, var(--red-primary) 7%, transparent)', border: '1px solid color-mix(in srgb, var(--red-primary) 25%, transparent)' }}>
          <Icon name="close" size={13} />
          <span>{actionError}</span>
        </div>
      )}
      <div style={{ height: 3, background: 'var(--fill)', borderRadius: 9999, overflow: 'hidden', marginBottom: -1.5 }}>
        <div style={{
          width: '100%', height: '100%', borderRadius: 9999,
          background: (STATUS_META[runStatus] || STATUS_META.success).color,
        }} />
      </div>
    </div>
  );
}

// ---- time ruler ----
function Ruler({ totalMs, labelW }: { totalMs: number; labelW: string }) {
  const ticks = rulerTicks(totalMs);
  return (
    <div style={{
      display: 'flex', height: 26, alignItems: 'stretch', position: 'sticky', top: 0, zIndex: 3,
      background: 'var(--panel-bg)', borderBottom: '1px solid var(--divider)',
    }}>
      <div style={{
        width: labelW, flexShrink: 0, display: 'flex', alignItems: 'center', paddingLeft: 14,
        fontSize: 10.5, fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--fg-faint)',
      }}>Span</div>
      <div style={{ flex: 1, position: 'relative' }}>
        {ticks.map(({ ms, label }) => (
          <div key={ms} style={{
            position: 'absolute', left: (ms / totalMs) * 100 + '%', top: 0, bottom: 0,
            borderLeft: '1px solid var(--grid-line)', paddingLeft: 5,
          }}>
            <span className="mono" style={{ fontSize: 10, color: 'var(--fg-faint)', lineHeight: '26px' }}>{label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---- a single span row ----
function SpanRow({ s, t, totalMs, labelW, selected, onSelect, vizStyle }: {
  s: Span; t: number; totalMs: number; labelW: string; selected: boolean; onSelect: (id: string) => void; vizStyle: VizStyle;
}) {
  const state = s.status;
  const m = STATUS_META[state];
  const visDur = state === 'running' ? Math.max(t - s.start, 20) : s.dur;
  const left = (s.start / totalMs) * 100;
  const width = (visDur / totalMs) * 100;
  const running = state === 'running';
  const stripe = `repeating-linear-gradient(45deg, ${m.color}, ${m.color} 7px, color-mix(in srgb, ${m.color} 72%, transparent) 7px, color-mix(in srgb, ${m.color} 72%, transparent) 14px)`;

  return (
    <div className="run-span-row" onClick={() => onSelect(s.id)}
      role="button" tabIndex={0} aria-pressed={selected}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect(s.id);
        }
      }}
      style={{
        height: 'var(--span-h)', display: 'flex', alignItems: 'center', cursor: 'pointer', position: 'relative',
        background: selected ? 'var(--accent-fill)' : 'transparent',
        borderRadius: 6, transition: 'background var(--dur-fast)',
      }}
      onMouseEnter={(e) => { if (!selected) e.currentTarget.style.background = 'var(--hover)'; }}
      onMouseLeave={(e) => { if (!selected) e.currentTarget.style.background = 'transparent'; }}>
      {/* label cell */}
      <div style={{ width: labelW, flexShrink: 0, paddingLeft: 14 + s.level * 18, paddingRight: 8, display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 }}>
        {s.level > 0 && <span style={{ position: 'absolute', left: 14 + (s.level - 1) * 18 + 3, top: 0, bottom: 0, width: 1, background: 'var(--divider)' }} />}
        <Icon name={KIND_ICON[s.kind] || 'dot'} size={13} style={{ color: s.kind === 'task' ? 'var(--accent)' : 'var(--fg-subtle)' }} />
        <span title={s.label} style={{
          fontSize: 12.5, fontWeight: s.kind === 'task' ? 600 : 500, color: 'var(--fg)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          fontFamily: s.kind === 'http' || s.kind === 'query' ? 'var(--font-mono)' : 'var(--font-sans)',
        }}>{s.label}</span>
      </div>
      {/* timeline cell */}
      <div style={{ flex: 1, position: 'relative', height: '100%' }}>
        {vizStyle === 'tree' ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, height: '100%', paddingLeft: 4 }}>
            <span style={{ flex: '0 0 80px', maxWidth: 120, height: 5, borderRadius: 9999, background: 'var(--fill)', overflow: 'hidden' }}>
              <span style={{ display: 'block', height: '100%', width: Math.max(6, (s.dur / totalMs) * 100) + '%', background: m.color, opacity: running ? 0.7 : 1 }} />
            </span>
            <span className="mono tnum" style={{ fontSize: 11, color: 'var(--fg-muted)' }}>{fmtMs(visDur)}</span>
            <StatusDot status={state} size={6} />
          </div>
        ) : (
          <div style={{
            position: 'absolute', left: left + '%', width: width + '%', top: '50%', transform: 'translateY(-50%)',
            height: 'min(15px, calc(var(--span-h) - 8px))',
            minWidth: 3, borderRadius: 4, overflow: 'hidden',
            backgroundColor: running ? 'transparent' : m.color,
            backgroundImage: running ? stripe : 'none', backgroundSize: '19.8px 100%',
            animation: running ? 'bt-stripe 0.7s linear infinite' : 'none',
            boxShadow: selected ? '0 0 0 1.5px var(--accent)' : 'none', display: 'flex', alignItems: 'center',
          }} />
        )}
        {/* Keep duration text on the surface, where its contrast is independent
            of the span's status color. */}
        {vizStyle !== 'tree' && !running && (
          <span className="mono tnum" style={{
            position: 'absolute', left: `calc(${left}% + ${width}%)`, top: '50%', transform: 'translateY(-50%)',
            marginLeft: 6, fontSize: 10, color: 'var(--fg-subtle)', whiteSpace: 'nowrap',
          }}>{fmtMs(s.dur)}</span>
        )}
      </div>
    </div>
  );
}

// ---- inspector for selected span ----
function CopyButton({ value, label }: { value: string; label: string }) {
  const [status, setStatus] = React.useState<'idle' | 'copying' | 'copied' | 'failed'>('idle');
  const request = React.useRef(0);
  React.useEffect(() => {
    request.current += 1;
    setStatus('idle');
    return () => { request.current += 1; };
  }, [value]);
  const copy = async () => {
    const currentRequest = ++request.current;
    setStatus('copying');
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(value);
      if (request.current === currentRequest) setStatus('copied');
    } catch {
      if (request.current === currentRequest) setStatus('failed');
    }
  };
  return (
    <span className="run-copy-control">
      <button type="button" className="run-small-button" aria-label={`Copy ${label}`}
        disabled={status === 'copying'} onClick={() => void copy()}>
        {status === 'copying' ? 'Copying…' : 'Copy'}
      </button>
      <span className={status === 'failed' ? 'run-copy-error' : 'run-copy-feedback'} role="status">
        {status === 'copied' ? 'Copied' : status === 'failed' ? 'Copy failed' : ''}
      </span>
    </span>
  );
}

function ContentSection({ label, value, error = false }: { label: string; value: string; error?: boolean }) {
  return (
    <section className={`run-content-section${error ? ' run-content-error' : ''}`} aria-label={label}>
      <div className="run-section-heading">
        <h4>{label}</h4>
        <CopyButton value={value} label={label} />
      </div>
      {error && <p className="run-error-summary">{value.split('\n')[0]}</p>}
      <details open={!error && value.length < 400}>
        <summary>{error ? 'Error details' : `${label} contents`}</summary>
        <pre className="mono">{value}</pre>
      </details>
    </section>
  );
}

function Inspector({ span, t, trace, wake }: { span: Span | undefined; t: number; trace: Trace; wake?: WakeInfo }) {
  if (!span) return <div className="run-inspector-empty">No span details available yet.</div>;
  const state = span.status;
  const payload = span.level === 0 ? trace.payload : null;
  return (
    <div className="run-inspector-content">
      <div className="run-inspector-heading">
        <div className="run-inspector-badges">
          <Icon name={KIND_ICON[span.kind] || 'dot'} size={15} style={{ color: span.kind === 'task' ? 'var(--accent)' : 'var(--fg-muted)' }} />
          <Badge tone={span.kind === 'task' ? 'blue' : 'gray'}>{KIND_LABEL[span.kind]}</Badge>
          <StatusBadge status={state} size="sm" />
        </div>
        <h3 className="mono">{span.label}</h3>
      </div>
      <section className="run-content-section" aria-label="Timing">
        <h4>Timing</h4>
        <dl className="run-timing">
          <div><dt>Started at</dt><dd className="mono">{fmtMs(span.start)}</dd></div>
          <div><dt>Duration</dt><dd className="mono">{state === 'running' ? fmtMs(Math.max(t - span.start, 0)) + ' …' : fmtMs(span.dur)}</dd></div>
          {span.attempt && <div><dt>Attempt</dt><dd className="mono">{span.attempt}</dd></div>}
        </dl>
      </section>
      {span.error && <ContentSection label="Error" error value={span.error.message + (span.error.stack ? '\n\n' + span.error.stack : '')} />}
      {span.level === 0 && wake && wake.waits.length > 0 && (
        <section className="run-content-section" aria-label="Waiting on">
          <h4>Waiting on</h4>
          <div className="run-waits">
            {wake.waits.map((w, i) => (
              <div key={i} className="run-wait">
                <div className="run-wait-label">
                  <Icon name={w.childRunId ? 'bolt' : 'clock'} size={13} />
                  <span>{w.childRunId ? 'Child run' : w.kind === 'until' ? 'Resume at' : 'Resume in'}</span>
                </div>
                <span className="mono run-wait-value">{w.childRunId ?? (w.resumeAt ? relativeFuture(w.resumeAt) : 'pending')}</span>
                {w.childRunId && <CopyButton value={w.childRunId} label="child run ID" />}
              </div>
            ))}
          </div>
        </section>
      )}
      {payload != null && <ContentSection label="Payload" value={JSON.stringify(payload, null, 2)} />}
      {span.output != null && <ContentSection label="Output" value={JSON.stringify(span.output, null, 2)} />}
    </div>
  );
}

// ---- streaming log ----
const LOG_TONE: Record<string, string> = {
  info: 'var(--fg-muted)', debug: 'var(--fg-subtle)', query: 'var(--accent-text)', http: 'var(--st-frozen-text)', warn: 'var(--orange-text)', error: 'var(--red-text)',
};

interface LogEntry { id: number; spanId: string; lvl: string; msg: string; ms: number; label: string }

// Rendered standalone only by tests; the app mounts it via RunDetail.
export function LogStream({ trace, logs, t, selectedId, scoped, setScoped, onLoadOlderLogs, loadingOlderLogs, hasOlderLogs, loadOlderLogsError }: {
  trace: Trace; logs: Record<string, LogLine[]>; t: number; selectedId: string; scoped: boolean; setScoped: React.Dispatch<React.SetStateAction<boolean>>;
  /** PF3 logs paging: fetch the next older page and append it to the stream. */
  onLoadOlderLogs: () => Promise<boolean>; loadingOlderLogs: boolean; hasOlderLogs: boolean;
  loadOlderLogsError: string | null;
}) {
  const lines = React.useMemo<LogEntry[]>(() => {
    const out: LogEntry[] = [];
    trace.spans.forEach((s) => {
      (logs[s.id] || []).forEach(([lvl, msg, at, id]) => {
        const ms = parseInt(at);
        out.push({ id, spanId: s.id, lvl, msg, ms, label: s.label });
      });
    });
    return out.sort((a, b) => a.ms - b.ms);
  }, [trace, logs]);
  const visible = React.useMemo(
    () => lines.filter((l) => l.ms <= t && (!scoped || !selectedId || l.spanId === selectedId)),
    [lines, t, scoped, selectedId],
  );
  const ref = React.useRef<HTMLDivElement | null>(null);
  const stickToBottom = React.useRef(true);
  const scope = scoped ? `span:${selectedId}` : 'all';
  const [following, setFollowing] = React.useState(true);
  const previous = React.useRef<{
    firstId: number | undefined; height: number; top: number; scope: string;
    anchor: { id: string; offset: number } | null;
  } | null>(null);
  const wasHidden = React.useRef(false);
  const rememberPosition = () => {
    const el = ref.current;
    if (el) previous.current = {
      firstId: visible[0]?.id, height: el.scrollHeight, top: el.scrollTop, scope, anchor: logAnchor(el),
    };
  };
  const onScroll = () => {
    const el = ref.current;
    if (!el) return;
    const tracePanel = el.closest('.run-trace-panel');
    if (tracePanel && getComputedStyle(tracePanel).display === 'none') return;
    stickToBottom.current = isAtBottom(el.scrollTop, el.clientHeight, el.scrollHeight);
    setFollowing(stickToBottom.current);
    rememberPosition();
  };
  React.useLayoutEffect(() => {
    // Every newly selected stream starts at its own tail, including a return
    // to a scope the reader paused earlier.
    stickToBottom.current = true;
    setFollowing(true);
  }, [scope]);
  React.useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const tracePanel = el.closest('.run-trace-panel');
    if (tracePanel && getComputedStyle(tracePanel).display === 'none') {
      // A poll may arrive while the compact UI shows Details. Preserve the
      // last visible geometry until Trace is displayed again.
      wasHidden.current = true;
      return;
    }
    const before = previous.current;
    const prepended = before && before.firstId !== visible[0]?.id && visible.some((l) => l.id === before.firstId);
    if (stickToBottom.current) {
      el.scrollTop = el.scrollHeight;
    } else if ((prepended || wasHidden.current) && before) {
      const row = before.anchor && el.querySelector<HTMLElement>(`[data-log-id="${before.anchor.id}"]`);
      if (row && before.anchor) {
        el.scrollTop += row.getBoundingClientRect().top - el.getBoundingClientRect().top - before.anchor.offset;
      } else {
        el.scrollTop = before.top + (prepended ? el.scrollHeight - before.height : 0);
      }
    }
    wasHidden.current = false;
    previous.current = { firstId: visible[0]?.id, height: el.scrollHeight, top: el.scrollTop, scope, anchor: logAnchor(el) };
  });
  const jumpToLatest = () => {
    stickToBottom.current = true;
    setFollowing(true);
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
    rememberPosition();
  };
  const loadOlder = () => {
    // Paging is an explicit request to read history, even when clicked at the
    // tail. Capture an existing row before the response inserts older ones.
    rememberPosition();
    stickToBottom.current = false;
    setFollowing(false);
    void onLoadOlderLogs();
  };
  const selectedLabel = trace.spans.find((span) => span.id === selectedId)?.label;
  const isActive = ['queued', 'running', 'frozen'].includes(trace.spans[0]?.status ?? '');
  const emptyMessage = scoped && selectedId
    ? 'No logs for this span.'
    : isActive ? 'Waiting for logs…' : 'No logs were recorded for this run.';
  return (
    <section className="run-log-stream" aria-label="Run logs">
      <div className="run-log-toolbar">
        <div className="run-log-title">
          <Icon name="terminal" size={14} />
          <h4>Logs</h4>
          <span className="tnum">{visible.length} lines</span>
          <span className={`run-follow-status${following ? ' is-following' : ''}`} role="status">{following ? 'Following' : 'Paused'}</span>
        </div>
        <div className="run-log-actions">
          {!following && <button type="button" className="run-small-button" onClick={jumpToLatest}>Jump to latest</button>}
          {hasOlderLogs && (
            <button type="button" className="run-small-button" onClick={loadOlder} disabled={loadingOlderLogs}>
              <Icon name="chevronUp" size={12} /> {loadingOlderLogs ? 'Loading…' : 'Load older logs'}
            </button>
          )}
          <button type="button" className="run-small-button run-scope-button" onClick={() => setScoped((v) => !v)}
            aria-pressed={scoped} title={scoped ? `Logs for ${selectedLabel ?? 'selected span'}` : 'Show only the selected span'}>
            <Icon name="filter" size={12} /> <span>{scoped ? `Span: ${selectedLabel ?? 'selected span'}` : 'All spans'}</span>
          </button>
        </div>
        {loadOlderLogsError && <div className="run-log-load-error" role="alert">Could not load older logs. Use “Load older logs” to retry.</div>}
      </div>
      <div ref={ref} onScroll={onScroll} className="run-log-scroller" role="region" aria-label="Log entries" tabIndex={0}>
        {visible.length === 0 && <div className="run-log-empty">{emptyMessage}</div>}
        {visible.map((l) => (
          <div key={l.id} className="run-log-line" data-log-id={l.id}>
            <span className="run-log-time tnum">{fmtMs(l.ms)}</span>
            <span className="run-log-level" style={{ color: LOG_TONE[l.lvl] }}>{l.lvl}</span>
            <span className="run-log-message">{l.msg}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

function logAnchor(el: HTMLElement): { id: string; offset: number } | null {
  const viewport = el.getBoundingClientRect();
  for (const row of el.querySelectorAll<HTMLElement>('[data-log-id]')) {
    const bounds = row.getBoundingClientRect();
    if (bounds.bottom > viewport.top && bounds.top < viewport.bottom) {
      return { id: row.dataset.logId!, offset: bounds.top - viewport.top };
    }
  }
  return null;
}

// ---- full run view ----
interface WakeInfo {
  waits: Array<{ kind: string; resumeAt: string | null; childRunId: string | null }>;
}

export function RunView({ vizStyle = 'waterfall', runId = null, env = 'prod', onBack, onRetried }: { vizStyle?: VizStyle; runId?: string | null; env?: string; onBack?: () => void; onRetried?: (newRunId: string) => void }) {
  const { data: detail, error, loadOlderLogs, loadingOlderLogs, hasOlderLogs, loadOlderLogsError } = useRun(runId, env);

  let body: React.ReactNode;
  if (!runId) {
    body = (
      <div style={{ display: 'grid', placeItems: 'center', flex: 1 }}>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, color: 'var(--fg-subtle)' }}>
          <Icon name="activity" size={22} style={{ color: 'var(--fg-faint)' }} />
          <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--fg)' }}>No run selected</div>
          <div style={{ fontSize: 12.5 }}>Pick a run from the Runs list to inspect its trace.</div>
        </div>
      </div>
    );
  } else if (!detail) {
    body = <div style={{ flex: 1, overflowY: 'auto' }}>{error ? <ErrorState message={error} /> : <LoadingState />}</div>;
  } else {
    body = (
      <RunDetail key={runId} detail={detail} vizStyle={vizStyle} env={env} onRetried={onRetried}
        onLoadOlderLogs={loadOlderLogs} loadingOlderLogs={loadingOlderLogs} hasOlderLogs={hasOlderLogs} loadOlderLogsError={loadOlderLogsError} />
    );
  }

  return (
    <div className="run-view">
      {onBack && (
        <div style={{ padding: '10px 20px 0', background: 'var(--panel-bg)' }}>
          <button onClick={onBack} style={{
            display: 'flex', alignItems: 'center', gap: 5, border: 'none', background: 'transparent', color: 'var(--fg-muted)',
            cursor: 'pointer', fontSize: 12.5, fontFamily: 'var(--font-sans)', padding: 0,
          }}>
            <Icon name="chevronLeft" size={14} /> All runs
          </button>
        </div>
      )}
      {body}
    </div>
  );
}

function RunDetail({ detail, vizStyle, env, onLoadOlderLogs, loadingOlderLogs, hasOlderLogs, loadOlderLogsError, onRetried }: {
  detail: AdaptedRunDetail; vizStyle: VizStyle; env: string;
  onLoadOlderLogs: () => Promise<boolean>; loadingOlderLogs: boolean; hasOlderLogs: boolean; loadOlderLogsError: string | null;
  onRetried?: (newRunId: string) => void;
}) {
  const trace = detail.trace;
  const logs: Record<string, LogLine[]> = detail.spanLogs;
  const [selectedId, setSelectedId] = React.useState(trace.spans[0]?.id ?? '');
  const [scoped, setScoped] = React.useState(false);
  const [panel, setPanel] = React.useState<'trace' | 'details'>('trace');
  const panelId = React.useId();
  const labelW = 'var(--run-label-width)';
  const activateTab = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 'trace' : event.key === 'End' ? 'details' : panel === 'trace' ? 'details' : 'trace';
    setPanel(next);
    document.getElementById(`${panelId}-${next}-tab`)?.focus();
  };

  // the whole timeline is revealed at once; status comes from the server.
  const t = trace.totalMs;
  const selected = trace.spans.find((s) => s.id === selectedId) ?? trace.spans[0];
  const wake: WakeInfo = { waits: detail.pendingWaits };

  return (
    <>
      <RunHeader trace={trace} runStatus={detail.status} env={env} onRetried={onRetried} />
      <div className="run-panel-tabs" role="tablist" aria-label="Run panels">
        {(['trace', 'details'] as const).map((name) => (
          <button key={name} id={`${panelId}-${name}-tab`} type="button" role="tab"
            aria-selected={panel === name} aria-controls={`${panelId}-${name}`}
            tabIndex={panel === name ? 0 : -1} onClick={() => setPanel(name)} onKeyDown={activateTab}>
            <Icon name={name === 'trace' ? 'activity' : 'layers'} size={14} />
            {name === 'trace' ? 'Trace & logs' : 'Span details'}
          </button>
        ))}
      </div>
      <div className="run-workspace" data-panel={panel} data-viz={vizStyle}>
        <section id={`${panelId}-trace`} className="run-trace-panel" role="tabpanel" aria-labelledby={`${panelId}-trace-tab`}>
          <div className="run-trace-heading"><h4>Execution trace</h4><span className="tnum">{trace.spans.length} spans</span></div>
          <div className="run-timeline-scroller" tabIndex={0} aria-label="Span timeline">
            <div className="run-timeline">
              <Ruler totalMs={trace.totalMs} labelW={labelW} />
              <div style={{ position: 'relative', padding: '6px 0 16px' }}>
                {trace.spans.map((s) => (
                  <SpanRow key={s.id} s={s} t={t} totalMs={trace.totalMs} labelW={labelW}
                    selected={selected?.id === s.id} onSelect={setSelectedId} vizStyle={vizStyle} />
                ))}
              </div>
            </div>
          </div>
          <LogStream trace={trace} logs={logs} t={t} selectedId={selected?.id ?? ''} scoped={scoped} setScoped={setScoped}
            onLoadOlderLogs={onLoadOlderLogs} loadingOlderLogs={loadingOlderLogs} hasOlderLogs={hasOlderLogs} loadOlderLogsError={loadOlderLogsError} />
        </section>
        <section id={`${panelId}-details`} className="run-inspector" role="tabpanel" aria-labelledby={`${panelId}-details-tab`} tabIndex={0}>
          <Inspector key={selected?.id} span={selected} t={t} trace={trace} wake={wake} />
        </section>
      </div>
    </>
  );
}
