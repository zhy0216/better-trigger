/* =============================================================================
   Better Trigger — Run observability (the hero).
   A single coherent waterfall: time-aligned span tree + live playback +
   inspector + streaming logs. vizStyle: "waterfall" | "tree".
   ============================================================================= */
import React from 'react';
import { Icon, IconButton, Badge, StatusBadge, StatusDot, STATUS_META } from '../../components/primitives';
import { TRACE, SPAN_LOGS } from '../../data/mock';
import { useRun } from '../../api/hooks';
import { relativeFuture } from '../../api/adapter';
import type { Span, Trace, LogLine, VizStyle } from '../../types';

const KIND_ICON: Record<string, string> = { task: 'bolt', http: 'globe', query: 'db', fn: 'fn' };
const KIND_LABEL: Record<string, string> = { task: 'subtask', http: 'http', query: 'query', fn: 'fn' };

function finalStatus(s: Span): string { return s.status === 'running' ? 'success' : s.status; }
function spanStateAt(s: Span, t: number): string {
  if (t < s.start) return 'pending';
  if (t < s.start + s.dur) return 'running';
  return finalStatus(s);
}
function fmtMs(ms: number): string {
  if (ms < 1000) return Math.round(ms) + 'ms';
  return (ms / 1000).toFixed(ms < 10000 ? 2 : 1) + 's';
}

interface PlaybackState {
  t: number;
  setT: React.Dispatch<React.SetStateAction<number>>;
  playing: boolean;
  toggle: () => void;
  restart: () => void;
  speed: number;
  setSpeed: (s: number) => void;
}

// ---- playback hook (persisted) ----
function usePlayback(totalMs: number, persistKey: string): PlaybackState {
  const init = (): { t?: number; playing?: boolean; speed?: number } => {
    try { return JSON.parse(localStorage.getItem(persistKey) || '{}'); } catch { return {}; }
  };
  const saved = init();
  const [t, setT] = React.useState(typeof saved.t === 'number' ? saved.t : 0);
  const [playing, setPlaying] = React.useState(saved.playing !== false);
  const [speed, setSpeed] = React.useState(saved.speed || 1);
  const raf = React.useRef(0);
  const last = React.useRef(0);
  React.useEffect(() => {
    if (!playing) return;
    last.current = performance.now();
    const tick = (now: number) => {
      const dt = now - last.current;
      last.current = now;
      setT((prev) => {
        const next = prev + dt * speed;
        if (next >= totalMs) { setPlaying(false); return totalMs; }
        return next;
      });
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  }, [playing, speed, totalMs]);
  React.useEffect(() => {
    const id = setTimeout(() => { try { localStorage.setItem(persistKey, JSON.stringify({ t, playing, speed })); } catch { /* ignore */ } }, 120);
    return () => clearTimeout(id);
  }, [t, playing, speed, persistKey]);
  const restart = () => { setT(0); setPlaying(true); };
  const toggle = () => { if (t >= totalMs) { setT(0); setPlaying(true); } else setPlaying((p) => !p); };
  return { t, setT, playing, toggle, restart, speed, setSpeed };
}

// ---- the trace header ----
function RunHeader({ trace, t, pb, runStatus, live }: { trace: Trace; t: number; pb: PlaybackState; runStatus: string; live?: boolean }) {
  const pct = Math.min(100, (t / trace.totalMs) * 100);
  const Meta = ({ icon, label, value, mono }: { icon: string; label: string; value: React.ReactNode; mono?: boolean }) => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 }}>
      <Icon name={icon} size={14} style={{ color: 'var(--fg-subtle)' }} />
      <span style={{ fontSize: 12, color: 'var(--fg-subtle)' }}>{label}</span>
      <span className={mono ? 'mono' : ''} style={{ fontSize: 12.5, color: 'var(--fg)', fontWeight: 500, whiteSpace: 'nowrap' }}>{value}</span>
    </div>
  );
  return (
    <div style={{ padding: '16px 20px 0', borderBottom: '1px solid var(--border)', background: 'var(--panel-bg)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <StatusBadge status={runStatus} />
        <h3 style={{ margin: 0, fontSize: 18, fontWeight: 600, letterSpacing: '-0.01em' }}>{trace.task}</h3>
        <span className="mono" style={{ fontSize: 12, color: 'var(--fg-subtle)', padding: '2px 8px', borderRadius: 6, background: 'var(--fill)' }}>{trace.runId}</span>
        <div style={{ flex: 1 }} />
        {!live && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <PlaybackControls pb={pb} t={t} total={trace.totalMs} />
          </div>
        )}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 18, flexWrap: 'wrap', padding: '13px 0 14px' }}>
        <Meta icon="bolt" label="trigger" value={trace.trigger} mono />
        <Meta icon="layers" label="env" value={trace.env} />
        <Meta icon="git" label="version" value={trace.version} mono />
        <Meta icon="clock" label="queued" value={trace.queuedFor} />
        <Meta icon="activity" label="elapsed" value={fmtMs(t)} />
      </div>
      <div style={{ height: 3, background: 'var(--fill)', borderRadius: 9999, overflow: 'hidden', marginBottom: -1.5 }}>
        <div style={{
          width: pct + '%', height: '100%', borderRadius: 9999,
          background: (STATUS_META[runStatus] || STATUS_META.success).color,
          transition: 'width 80ms linear',
        }} />
      </div>
    </div>
  );
}

function PlaybackControls({ pb, t, total }: { pb: PlaybackState; t: number; total: number }) {
  const done = t >= total;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: 4, borderRadius: 9999, background: 'var(--fill)' }}>
      <IconButton name="restart" size={15} box={28} onClick={pb.restart} title="Replay" />
      <button onClick={pb.toggle} title={done ? 'Replay' : pb.playing ? 'Pause' : 'Play'}
        style={{
          width: 30, height: 30, borderRadius: 9999, border: 'none', cursor: 'pointer', background: 'var(--accent)', color: 'var(--accent-fg)',
          display: 'grid', placeItems: 'center',
        }}>
        <Icon name={done ? 'restart' : pb.playing ? 'pause' : 'play'} size={14} />
      </button>
      <div style={{ display: 'flex', gap: 2, padding: '0 4px 0 2px' }}>
        {[1, 2, 4].map((s) => (
          <button key={s} onClick={() => pb.setSpeed(s)}
            style={{
              fontFamily: 'var(--font-mono)', fontSize: 10.5, fontWeight: 600, padding: '3px 5px', borderRadius: 5, border: 'none', cursor: 'pointer',
              background: pb.speed === s ? 'var(--surface)' : 'transparent', color: pb.speed === s ? 'var(--fg)' : 'var(--fg-subtle)',
              boxShadow: pb.speed === s ? 'var(--shadow-sm)' : 'none',
            }}>{s}×</button>
        ))}
      </div>
    </div>
  );
}

// ---- time ruler ----
function Ruler({ totalMs, labelW }: { totalMs: number; labelW: number }) {
  const ticks: number[] = [];
  for (let ms = 0; ms <= totalMs; ms += 1000) ticks.push(ms);
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
        {ticks.map((ms) => (
          <div key={ms} style={{
            position: 'absolute', left: (ms / totalMs) * 100 + '%', top: 0, bottom: 0,
            borderLeft: '1px solid var(--grid-line)', paddingLeft: 5,
          }}>
            <span className="mono" style={{ fontSize: 10, color: 'var(--fg-faint)', lineHeight: '26px' }}>{ms / 1000}s</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---- a single span row ----
function SpanRow({ s, t, totalMs, labelW, selected, onSelect, vizStyle, staticState }: {
  s: Span; t: number; totalMs: number; labelW: number; selected: boolean; onSelect: (id: string) => void; vizStyle: VizStyle; staticState?: boolean;
}) {
  // live mode renders the span's literal status; mock derives it from playback time.
  const state = staticState ? s.status : spanStateAt(s, t);
  if (state === 'pending') return (
    <div style={{ height: 'var(--span-h)', display: 'flex', opacity: 0.32, alignItems: 'center' }}>
      <div style={{ width: labelW, flexShrink: 0, paddingLeft: 14 + s.level * 18, display: 'flex', alignItems: 'center', gap: 7 }}>
        <span style={{ width: 7, height: 7, borderRadius: 9999, border: '1.5px dashed var(--fg-faint)' }} />
        <span style={{ fontSize: 12.5, color: 'var(--fg-faint)' }}>{s.label}</span>
      </div>
    </div>
  );
  const m = STATUS_META[state];
  const visDur = state === 'running' ? Math.max(t - s.start, 20) : s.dur;
  const left = (s.start / totalMs) * 100;
  const width = (visDur / totalMs) * 100;
  const running = state === 'running';
  const stripe = `repeating-linear-gradient(45deg, ${m.color}, ${m.color} 7px, color-mix(in srgb, ${m.color} 72%, transparent) 7px, color-mix(in srgb, ${m.color} 72%, transparent) 14px)`;

  return (
    <div onClick={() => onSelect(s.id)}
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
        <span style={{
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
            height: Math.min(15, parseInt(getComputedStyle(document.documentElement).getPropertyValue('--span-h')) - 8) || 14,
            minWidth: 3, borderRadius: 4, overflow: 'hidden',
            background: running ? 'transparent' : m.color,
            backgroundImage: running ? stripe : 'none', backgroundSize: '19.8px 100%',
            animation: running ? 'bt-stripe 0.7s linear infinite' : 'none',
            boxShadow: selected ? '0 0 0 1.5px var(--accent)' : 'none', display: 'flex', alignItems: 'center',
          }}>
            {!running && (
              <span className="mono tnum" style={{
                fontSize: 10, color: '#fff', marginLeft: 6, fontWeight: 600, opacity: width > 7 ? 0.95 : 0,
                textShadow: '0 1px 1px rgba(0,0,0,0.25)',
              }}>{fmtMs(s.dur)}</span>
            )}
          </div>
        )}
        {/* duration label outside short bars */}
        {vizStyle !== 'tree' && !running && width <= 7 && (
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
function Inspector({ span, t, trace, wake, staticState }: { span: Span | undefined; t: number; trace: Trace; wake?: WakeInfo; staticState?: boolean }) {
  if (!span) return null;
  const state = staticState ? span.status : spanStateAt(span, t);
  const Row = ({ k, v, mono }: { k: string; v: React.ReactNode; mono?: boolean }) => (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '6px 0', borderBottom: '1px solid var(--divider)' }}>
      <span style={{ fontSize: 12, color: 'var(--fg-subtle)', whiteSpace: 'nowrap' }}>{k}</span>
      <span className={mono ? 'mono' : ''} style={{ fontSize: 12.5, color: 'var(--fg)', fontWeight: 500, textAlign: 'right', whiteSpace: 'nowrap' }}>{v}</span>
    </div>
  );
  const payload = span.level === 0 ? trace.payload : null;
  return (
    <div style={{ width: 320, flexShrink: 0, borderLeft: '1px solid var(--border)', background: 'var(--panel-bg)', overflowY: 'auto' }}>
      <div style={{ padding: '16px 16px 14px', borderBottom: '1px solid var(--divider)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          <Icon name={KIND_ICON[span.kind] || 'dot'} size={15} style={{ color: span.kind === 'task' ? 'var(--accent)' : 'var(--fg-muted)' }} />
          <Badge tone={span.kind === 'task' ? 'blue' : 'gray'}>{KIND_LABEL[span.kind]}</Badge>
          <div style={{ flex: 1 }} />
          <StatusBadge status={state} size="sm" />
        </div>
        <div className="mono" style={{ fontSize: 14, fontWeight: 600, color: 'var(--fg)', wordBreak: 'break-word' }}>{span.label}</div>
      </div>
      <div style={{ padding: '10px 16px 14px' }}>
        <div style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--fg-faint)', marginBottom: 4 }}>Timing</div>
        <Row k="started at" v={fmtMs(span.start)} mono />
        <Row k="duration" v={state === 'running' ? fmtMs(Math.max(t - span.start, 0)) + ' …' : fmtMs(span.dur)} mono />
        <Row k="self time" v={fmtMs(Math.round(span.dur * 0.4))} mono />
        <Row k="attempt" v={state === 'failed' ? '3 of 3' : '1 of 1'} mono />
      </div>
      {payload && (
        <div style={{ padding: '0 16px 16px' }}>
          <div style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--fg-faint)', marginBottom: 6 }}>Payload</div>
          <pre className="mono" style={{
            margin: 0, fontSize: 11.5, lineHeight: 1.6, background: 'var(--code-bg)', border: '1px solid var(--divider)',
            borderRadius: 8, padding: 12, overflowX: 'auto', color: 'var(--fg-muted)',
          }}>{JSON.stringify(payload, null, 2)}</pre>
        </div>
      )}
      {span.level === 0 && wake && wake.waits.length > 0 && (
        <div style={{ padding: '0 16px 16px' }}>
          <div style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--fg-faint)', marginBottom: 6 }}>Waiting on</div>
          <div style={{
            background: 'color-mix(in srgb, var(--st-frozen) 8%, transparent)', border: '1px solid color-mix(in srgb, var(--st-frozen) 22%, transparent)',
            borderRadius: 8, padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 8,
          }}>
            {wake.waits.map((w, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                <Icon name={w.childRunId ? 'bolt' : 'clock'} size={13} style={{ color: 'var(--st-frozen)', flexShrink: 0 }} />
                <span style={{ fontSize: 12, color: 'var(--fg-muted)', flexShrink: 0 }}>
                  {w.childRunId ? 'child run' : w.kind === 'until' ? 'resume at' : 'resume in'}
                </span>
                <span className="mono" style={{ fontSize: 12, color: 'var(--fg)', fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {w.childRunId
                    ? w.childRunId
                    : w.resumeAt
                      ? relativeFuture(w.resumeAt)
                      : 'pending'}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
      {span.kind !== 'task' && (
        <div style={{ padding: '0 16px 16px' }}>
          <div style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--fg-faint)', marginBottom: 6 }}>Attributes</div>
          <pre className="mono" style={{
            margin: 0, fontSize: 11.5, lineHeight: 1.6, background: 'var(--code-bg)', border: '1px solid var(--divider)',
            borderRadius: 8, padding: 12, overflowX: 'auto', color: 'var(--fg-muted)',
          }}>{JSON.stringify(
            span.kind === 'http' ? { method: 'POST', status: state === 'warning' ? 207 : 200, retries: state === 'warning' ? 1 : 0 }
              : span.kind === 'query' ? { rows: 3, cached: false, db: 'primary' }
                : { ok: true }, null, 2)}</pre>
        </div>
      )}
    </div>
  );
}

// ---- streaming log ----
const LOG_TONE: Record<string, string> = {
  info: 'var(--fg-muted)', debug: 'var(--fg-subtle)', query: 'var(--accent)', http: 'var(--st-frozen)', warn: 'var(--orange-primary)', error: 'var(--red-primary)',
};

interface LogEntry { spanId: string; lvl: string; msg: string; ms: number; label: string }

function LogStream({ trace, logs, t, selectedId, scoped, setScoped }: {
  trace: Trace; logs: Record<string, LogLine[]>; t: number; selectedId: string; scoped: boolean; setScoped: React.Dispatch<React.SetStateAction<boolean>>;
}) {
  const lines = React.useMemo<LogEntry[]>(() => {
    const out: LogEntry[] = [];
    trace.spans.forEach((s) => {
      (logs[s.id] || []).forEach(([lvl, msg, at]) => {
        const ms = parseInt(at);
        out.push({ spanId: s.id, lvl, msg, ms, label: s.label });
      });
    });
    return out.sort((a, b) => a.ms - b.ms);
  }, [trace, logs]);
  const visible = lines.filter((l) => l.ms <= t && (!scoped || !selectedId || l.spanId === selectedId));
  const ref = React.useRef<HTMLDivElement | null>(null);
  React.useEffect(() => { if (ref.current) ref.current.scrollTop = ref.current.scrollHeight; }, [visible.length]);
  return (
    <div style={{ height: 184, flexShrink: 0, borderTop: '1px solid var(--border)', background: 'var(--panel-bg)', display: 'flex', flexDirection: 'column' }}>
      <div style={{ height: 34, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 10, padding: '0 14px', borderBottom: '1px solid var(--divider)' }}>
        <Icon name="terminal" size={14} style={{ color: 'var(--fg-subtle)' }} />
        <span style={{ fontSize: 12.5, fontWeight: 600 }}>Logs</span>
        <span style={{ fontSize: 11, color: 'var(--fg-subtle)' }} className="tnum">{visible.length} lines</span>
        <div style={{ flex: 1 }} />
        <button onClick={() => setScoped((v) => !v)}
          style={{
            display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, padding: '3px 8px', borderRadius: 6, border: '1px solid var(--border)',
            background: scoped ? 'var(--accent-fill)' : 'transparent', color: scoped ? 'var(--accent)' : 'var(--fg-muted)', cursor: 'pointer',
          }}>
          <Icon name="filter" size={12} /> {scoped ? 'Scoped to span' : 'All spans'}
        </button>
      </div>
      <div ref={ref} style={{ flex: 1, overflowY: 'auto', padding: '8px 14px', fontFamily: 'var(--font-mono)', fontSize: 11.5, lineHeight: 1.85 }}>
        {visible.length === 0 && <div style={{ color: 'var(--fg-faint)', fontFamily: 'var(--font-sans)' }}>Waiting for logs…</div>}
        {visible.map((l, i) => (
          <div key={i} style={{ display: 'flex', gap: 10 }}>
            <span className="tnum" style={{ color: 'var(--fg-faint)', flexShrink: 0, width: 52, textAlign: 'right' }}>{fmtMs(l.ms)}</span>
            <span style={{ color: LOG_TONE[l.lvl], textTransform: 'uppercase', fontSize: 10, fontWeight: 600, flexShrink: 0, width: 42, paddingTop: 1 }}>{l.lvl}</span>
            <span style={{ color: 'var(--fg)', flex: 1 }}>{l.msg}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---- full run view ----
interface WakeInfo {
  waits: Array<{ kind: string; resumeAt: string | null; childRunId: string | null }>;
}

export function RunView({ vizStyle = 'waterfall', runId = null, onBack }: { vizStyle?: VizStyle; runId?: string | null; onBack?: () => void }) {
  const { data: detail, live } = useRun(runId);
  // live run detail present → render real data static (no playback reset on poll);
  // otherwise fall back to the animated mock TRACE (contract §7).
  const liveMode = live && !!runId && !!detail;
  const trace = liveMode ? detail!.trace : TRACE;
  const logs: Record<string, LogLine[]> = liveMode ? detail!.spanLogs : SPAN_LOGS;

  const pb = usePlayback(trace.totalMs, liveMode ? 'bt_playback_live' : 'bt_playback');
  const [selectedId, setSelectedId] = React.useState('s4');
  const [scoped, setScoped] = React.useState(false);
  const labelW = vizStyle === 'tree' ? 320 : 300;

  // live: reveal the whole timeline (no animation), status comes from the server.
  const t = liveMode ? trace.totalMs : pb.t;
  const selected = trace.spans.find((s) => s.id === selectedId) ?? trace.spans[0];
  const wake: WakeInfo | undefined = liveMode ? { waits: detail!.pendingWaits } : undefined;
  const runStatus = liveMode
    ? detail!.status
    : pb.t < trace.totalMs
      ? 'running'
      : trace.spans.some((s) => s.status === 'failed')
        ? 'failed'
        : trace.spans.some((s) => s.status === 'warning')
          ? 'warning'
          : 'success';

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
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
      <RunHeader trace={trace} t={t} pb={pb} runStatus={runStatus} live={liveMode} />
      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, position: 'relative', background: 'var(--surface)' }}>
          <div style={{ flex: 1, overflowY: 'auto', position: 'relative' }}>
            <Ruler totalMs={trace.totalMs} labelW={labelW} />
            <div style={{ position: 'relative', padding: '6px 0 16px' }}>
              {/* now-line */}
              {!liveMode && runStatus === 'running' && vizStyle !== 'tree' && (
                <div style={{
                  position: 'absolute', top: 0, bottom: 16,
                  left: `calc(${labelW}px + (100% - ${labelW}px) * ${t / trace.totalMs})`,
                  width: 1.5, background: 'var(--accent)', opacity: 0.7, zIndex: 2, pointerEvents: 'none',
                }}>
                  <div style={{ position: 'absolute', top: -1, left: -3, width: 7, height: 7, borderRadius: 9999, background: 'var(--accent)' }} />
                </div>
              )}
              {trace.spans.map((s) => (
                <SpanRow key={s.id} s={s} t={t} totalMs={trace.totalMs} labelW={labelW}
                  selected={selected?.id === s.id} onSelect={setSelectedId} vizStyle={vizStyle} staticState={liveMode} />
              ))}
            </div>
          </div>
          <LogStream trace={trace} logs={logs} t={t} selectedId={selected?.id ?? ''} scoped={scoped} setScoped={setScoped} />
        </div>
        <Inspector span={selected} t={t} trace={trace} wake={wake} staticState={liveMode} />
      </div>
    </div>
  );
}
