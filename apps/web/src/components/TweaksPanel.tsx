/* =============================================================================
   Better Trigger — Tweaks panel shell + form-control helpers.

   A floating, draggable control panel. The host postMessage protocol
   (`__activate_edit_mode` / `__edit_mode_available` / …) it was built for was
   removed — it was documented as dead in apps/web/README.md and, unorigin-
   checked, would have let any framing page open/close the panel. The panel is
   now fully controlled: the caller owns `open` (App.tsx, toggled from a TopBar
   button; p2-19) and defaults it to closed. Pointer drags register window-
   level move/up listeners; every site also stashes its detach in a ref so an
   unmount mid-drag cannot leak one (p2-19).
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
  const dragRef = React.useRef<HTMLDialogElement | null>(null);
  const offsetRef = React.useRef({ x: 16, y: 16 });
  // Detaches the header drag's window listeners; set while a drag is live so
  // the unmount effect below can clean up an in-flight drag (p2-19).
  const dragCleanupRef = React.useRef<(() => void) | null>(null);
  const PAD = 16;

  const clampToViewport = React.useCallback(() => {
    const panel = dragRef.current;
    if (!panel) return;
    const w = panel.offsetWidth;
    const h = panel.offsetHeight;
    const maxRight = Math.max(PAD, window.innerWidth - w - PAD);
    const maxBottom = Math.max(PAD, window.innerHeight - h - PAD);
    offsetRef.current = {
      x: Math.min(maxRight, Math.max(PAD, offsetRef.current.x)),
      y: Math.min(maxBottom, Math.max(PAD, offsetRef.current.y)),
    };
    panel.style.right = offsetRef.current.x + 'px';
    panel.style.bottom = offsetRef.current.y + 'px';
  }, []);

  React.useEffect(() => {
    if (!open) return;
    clampToViewport();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', clampToViewport);
      return () => window.removeEventListener('resize', clampToViewport);
    }
    const ro = new ResizeObserver(clampToViewport);
    ro.observe(document.documentElement);
    if (dragRef.current) ro.observe(dragRef.current);
    return () => ro.disconnect();
  }, [open, clampToViewport]);

  // Unmounting mid-drag used to leak the window mousemove/mouseup pair until
  // the next (detached) mouseup; detach it here instead (p2-19).
  React.useEffect(() => () => dragCleanupRef.current?.(), [open]);

  const dismiss = () => {
    onOpenChange?.(false);
  };

  const onDragStart = (e: React.MouseEvent) => {
    dragCleanupRef.current?.();
    const panel = dragRef.current;
    if (!panel) return;
    const r = panel.getBoundingClientRect();
    const sx = e.clientX;
    const sy = e.clientY;
    const startRight = window.innerWidth - r.right;
    const startBottom = window.innerHeight - r.bottom;
    const move = (ev: MouseEvent) => {
      offsetRef.current = {
        x: startRight - (ev.clientX - sx),
        y: startBottom - (ev.clientY - sy),
      };
      clampToViewport();
    };
    const detach = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', detach);
      dragCleanupRef.current = null;
    };
    dragCleanupRef.current = detach;
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', detach);
  };

  if (!open) return null;
  return (
      <Modal panelRef={dragRef} open={open} onClose={dismiss} label={title} className="twk-panel"
        style={{ right: offsetRef.current.x, bottom: offsetRef.current.y }}>
        <div className="twk-hd" onMouseDown={onDragStart}>
          <b>{title}</b>
          <button className="twk-x" aria-label={`Close ${title.toLowerCase()}`}
            onMouseDown={(e) => e.stopPropagation()}
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

export function TweakRow({ label, value, children, inline = false }: { label: string; value?: React.ReactNode; children?: React.ReactNode; inline?: boolean }) {
  return (
    <div className={inline ? 'twk-row twk-row-h' : 'twk-row'}>
      <div className="twk-lbl">
        <span>{label}</span>
        {value != null && <span className="twk-val">{value}</span>}
      </div>
      {children}
    </div>
  );
}

// ── Controls ────────────────────────────────────────────────────────────────
export function TweakSlider({ label, value, min = 0, max = 100, step = 1, unit = '', onChange }: {
  label: string; value: number; min?: number; max?: number; step?: number; unit?: string; onChange: (v: number) => void;
}) {
  return (
    <TweakRow label={label} value={`${value}${unit}`}>
      <input type="range" className="twk-slider" min={min} max={max} step={step}
        value={value} onChange={(e) => onChange(Number(e.target.value))} />
    </TweakRow>
  );
}

export function TweakToggle({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="twk-row twk-row-h">
      <div className="twk-lbl"><span>{label}</span></div>
      <button type="button" className="twk-toggle" data-on={value ? '1' : '0'}
        role="switch" aria-checked={!!value}
        onClick={() => onChange(!value)}><i /></button>
    </div>
  );
}

type Option = string | number | { value: string | number; label: string };

export function TweakRadio({ label, value, options, onChange }: {
  label: string; value: string | number; options: Option[]; onChange: (v: string | number) => void;
}) {
  const trackRef = React.useRef<HTMLDivElement | null>(null);
  const [dragging, setDragging] = React.useState(false);
  const valueRef = React.useRef(value);
  valueRef.current = value;
  // Detach for an in-flight scrub, so unmounting mid-drag can't leak the
  // window pointer listeners (p2-19).
  const dragCleanupRef = React.useRef<(() => void) | null>(null);
  React.useEffect(() => () => dragCleanupRef.current?.(), []);

  const labelLen = (o: Option) => String(typeof o === 'object' ? o.label : o).length;
  const maxLen = options.reduce<number>((m, o) => Math.max(m, labelLen(o)), 0);
  const fitsAsSegments = maxLen <= (({ 2: 16, 3: 10 } as Record<number, number>)[options.length] ?? 0);
  if (!fitsAsSegments) {
    const resolve = (s: string) => {
      const m = options.find((o) => String(typeof o === 'object' ? o.value : o) === s);
      return m === undefined ? s : typeof m === 'object' ? m.value : m;
    };
    return <TweakSelect label={label} value={value} options={options} onChange={(s) => onChange(resolve(String(s)))} />;
  }
  const opts = options.map((o) => (typeof o === 'object' ? o : { value: o, label: String(o) }));
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

export function TweakSelect({ label, value, options, onChange }: {
  label: string; value: string | number; options: Option[]; onChange: (v: string) => void;
}) {
  return (
    <TweakRow label={label}>
      <select className="twk-field" value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => {
          const v = typeof o === 'object' ? o.value : o;
          const l = typeof o === 'object' ? o.label : o;
          return <option key={v} value={v}>{l}</option>;
        })}
      </select>
    </TweakRow>
  );
}

export function TweakText({ label, value, placeholder, onChange }: {
  label: string; value: string; placeholder?: string; onChange: (v: string) => void;
}) {
  return (
    <TweakRow label={label}>
      <input className="twk-field" type="text" value={value} placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)} />
    </TweakRow>
  );
}

export function TweakNumber({ label, value, min, max, step = 1, unit = '', onChange }: {
  label: string; value: number; min?: number; max?: number; step?: number; unit?: string; onChange: (v: number) => void;
}) {
  const clamp = (n: number) => {
    if (min != null && n < min) return min;
    if (max != null && n > max) return max;
    return n;
  };
  const startRef = React.useRef({ x: 0, val: 0 });
  // Detach for an in-flight scrub, so unmounting mid-drag can't leak the
  // window pointer listeners (p2-19).
  const scrubCleanupRef = React.useRef<(() => void) | null>(null);
  React.useEffect(() => () => scrubCleanupRef.current?.(), []);
  const onScrubStart = (e: React.PointerEvent) => {
    e.preventDefault();
    startRef.current = { x: e.clientX, val: value };
    const decimals = (String(step).split('.')[1] || '').length;
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - startRef.current.x;
      const raw = startRef.current.val + dx * step;
      const snapped = Math.round(raw / step) * step;
      onChange(clamp(Number(snapped.toFixed(decimals))));
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      scrubCleanupRef.current = null;
    };
    scrubCleanupRef.current = up;
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  return (
    <div className="twk-num">
      <span className="twk-num-lbl" onPointerDown={onScrubStart}>{label}</span>
      <input type="number" value={value} min={min} max={max} step={step}
        onChange={(e) => onChange(clamp(Number(e.target.value)))} />
      {unit && <span className="twk-num-unit">{unit}</span>}
    </div>
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

type ColorOption = string | string[];

export function TweakColor({ label, value, options, onChange }: {
  label: string; value: ColorOption; options?: ColorOption[]; onChange: (v: ColorOption) => void;
}) {
  if (!options || !options.length) {
    return (
      <div className="twk-row twk-row-h">
        <div className="twk-lbl"><span>{label}</span></div>
        <input type="color" className="twk-swatch" value={value as string}
          onChange={(e) => onChange(e.target.value)} />
      </div>
    );
  }
  const key = (o: ColorOption) => String(JSON.stringify(o)).toLowerCase();
  const cur = key(value);
  return (
    <TweakRow label={label}>
      <div className="twk-chips" role="radiogroup">
        {options.map((o, i) => {
          const colors = Array.isArray(o) ? o : [o];
          const [hero, ...rest] = colors;
          const sup = rest.slice(0, 4);
          const on = key(o) === cur;
          return (
            <button key={i} type="button" className="twk-chip" role="radio"
              aria-checked={on} data-on={on ? '1' : '0'}
              aria-label={colors.join(', ')} title={colors.join(' · ')}
              style={{ background: hero }}
              onClick={() => onChange(o)}>
              {sup.length > 0 && (
                <span>
                  {sup.map((c, j) => <i key={j} style={{ background: c }} />)}
                </span>
              )}
              {on && <__TwkCheck light={__twkIsLight(hero)} />}
            </button>
          );
        })}
      </div>
    </TweakRow>
  );
}

export function TweakButton({ label, onClick, secondary = false }: { label: string; onClick: () => void; secondary?: boolean }) {
  return (
    <button type="button" className={secondary ? 'twk-btn secondary' : 'twk-btn'} onClick={onClick}>{label}</button>
  );
}
