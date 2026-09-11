/* =============================================================================
   Better Trigger — Tweaks panel shell + form-control helpers.

   A floating control panel. The host postMessage protocol
   (`__activate_edit_mode` / `__edit_mode_available` / …) it was built for was
   removed — it was documented as dead in apps/web/README.md and, unorigin-
   checked, would have let any framing page open/close the panel. The panel is
   now fully controlled: the caller owns `open` (App.tsx, toggled from a TopBar
   button; p2-19) and defaults it to closed.
   ============================================================================= */
import React from 'react';
import { Modal } from './Modal';
import './tweaks-panel.css';

// ── TweaksPanel ─────────────────────────────────────────────────────────────
export function TweaksPanel({
  title = 'Tweaks', children, open = false, onOpenChange,
}: {
  title?: string; children?: React.ReactNode;
  /** Controlled visibility (p2-19): the caller — App.tsx — owns the state. */
  open?: boolean;
  /** Notified when the panel asks to close (the ✕ button). */
  onOpenChange?: (open: boolean) => void;
}) {
  const dismiss = () => {
    onOpenChange?.(false);
  };

  if (!open) return null;
  return (
    <Modal open={open} onClose={dismiss} label={title} className="twk-panel">
      <div className="twk-hd">
        <b>{title}</b>
        <button className="twk-x" aria-label={`Close ${title.toLowerCase()}`}
          onClick={dismiss}>✕</button>
      </div>
      <div className="twk-body">{children}</div>
    </Modal>
  );
}

// ── Layout helpers ──────────────────────────────────────────────────────────
export function TweakSection({ label, children }: { label: string; children?: React.ReactNode }) {
  return (
    <>
      <div className="twk-sect">{label}</div>
      {children}
    </>
  );
}

function TweakRow({ label, value, children }: { label: string; value?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <div className="twk-row">
      <div className="twk-lbl">
        <span>{label}</span>
        {value != null && <span className="twk-val">{value}</span>}
      </div>
      {children}
    </div>
  );
}

// ── Controls ────────────────────────────────────────────────────────────────
export function TweakRadio<T extends string | number>({ label, value, options, onChange }: {
  label: string; value: T; options: readonly T[]; onChange: (v: T) => void;
}) {
  const trackRef = React.useRef<HTMLDivElement | null>(null);
  const [dragging, setDragging] = React.useState(false);
  const valueRef = React.useRef(value);
  valueRef.current = value;
  // Detach for an in-flight scrub, so unmounting mid-drag can't leak the
  // window pointer listeners (p2-19).
  const dragCleanupRef = React.useRef<(() => void) | null>(null);
  React.useEffect(() => () => dragCleanupRef.current?.(), []);

  const opts = options.map((o) => ({ value: o, label: String(o) }));
  const idx = Math.max(0, opts.findIndex((o) => o.value === value));
  const n = opts.length;

  const segAt = (clientX: number) => {
    const r = trackRef.current!.getBoundingClientRect();
    const inner = r.width - 4;
    const i = Math.floor(((clientX - r.left - 2) / inner) * n);
    return opts[Math.max(0, Math.min(n - 1, i))].value;
  };

  const onPointerDown = (e: React.PointerEvent) => {
    setDragging(true);
    const v0 = segAt(e.clientX);
    if (v0 !== valueRef.current) onChange(v0);
    const move = (ev: PointerEvent) => {
      if (!trackRef.current) return;
      const v = segAt(ev.clientX);
      if (v !== valueRef.current) onChange(v);
    };
    const up = () => {
      setDragging(false);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      dragCleanupRef.current = null;
    };
    dragCleanupRef.current = up;
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return (
    <TweakRow label={label}>
      <div ref={trackRef} role="radiogroup" onPointerDown={onPointerDown}
        className={dragging ? 'twk-seg dragging' : 'twk-seg'}>
        <div className="twk-seg-thumb"
          style={{ left: `calc(2px + ${idx} * (100% - 4px) / ${n})`, width: `calc((100% - 4px) / ${n})` }} />
        {opts.map((o) => (
          <button key={o.value} type="button" role="radio" aria-checked={o.value === value}
            onClick={() => { if (o.value !== valueRef.current) onChange(o.value); }}>
            {o.label}
          </button>
        ))}
      </div>
    </TweakRow>
  );
}

function __twkIsLight(hex: string) {
  const h = String(hex).replace('#', '');
  const x = h.length === 3 ? h.replace(/./g, (c) => c + c) : h.padEnd(6, '0');
  const n = parseInt(x.slice(0, 6), 16);
  if (Number.isNaN(n)) return true;
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return r * 299 + g * 587 + b * 114 > 148000;
}

const __TwkCheck = ({ light }: { light: boolean }) => (
  <svg viewBox="0 0 14 14" aria-hidden="true">
    <path d="M3 7.2 5.8 10 11 4.2" fill="none" strokeWidth="2.2"
      strokeLinecap="round" strokeLinejoin="round"
      stroke={light ? 'rgba(0,0,0,.78)' : '#fff'} />
  </svg>
);

export function TweakColor({ label, value, options, onChange }: {
  label: string; value: string; options: string[]; onChange: (v: string) => void;
}) {
  return (
    <TweakRow label={label}>
      <div className="twk-chips" role="radiogroup">
        {options.map((o) => {
          const on = o === value;
          return (
            <button key={o} type="button" className="twk-chip" role="radio"
              aria-checked={on} data-on={on ? '1' : '0'}
              aria-label={o} title={o}
              style={{ background: o }}
              onClick={() => onChange(o)}>
              {on && <__TwkCheck light={__twkIsLight(o)} />}
            </button>
          );
        })}
      </div>
    </TweakRow>
  );
}
