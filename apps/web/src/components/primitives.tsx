/* =============================================================================
   Better Trigger — UI primitives. Theme-aware (--fg, --surface, --border,
   --accent …) so they work in light AND dark. Lucide-style 2px-stroke icons.
   Interactive states (:hover / :focus) live in theme.css, not imperative
   style writes on mouse events — see the .bt-* helper classes there.
   ============================================================================= */
import React from 'react';
import type { RunStatus } from '../types';
import { STATUS_META } from './status-meta';

const ICONS: Record<string, React.ReactNode> = {
  // nav
  activity:   <path d="M22 12h-4l-3 9L9 3l-3 9H2" />,
  task:       <g><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M8 9h5M8 13h8M8 17h6" /></g>,
  clock:      <g><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></g>,
  bell:       <g><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.7 21a2 2 0 0 1-3.4 0" /></g>,
  rocket:     <g><path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z" /><path d="M12 15l-3-3a22 22 0 0 1 8-10 22 22 0 0 1 2 10 22 22 0 0 1-10 8z" /><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0" /><path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5" /></g>,
  sparkle:    <path d="M12 3l1.9 5.8L20 11l-6.1 2.2L12 19l-1.9-5.8L4 11l6.1-2.2z" />,
  // controls
  play:       <path d="M6 4l14 8-14 8z" />,
  pause:      <g><rect x="6" y="4" width="4" height="16" rx="1" /><rect x="14" y="4" width="4" height="16" rx="1" /></g>,
  restart:    <g><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5" /></g>,
  retry:      <g><path d="M21 12a9 9 0 1 1-3-6.7L21 8" /><path d="M21 3v5h-5" /></g>,
  search:     <g><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" /></g>,
  filter:     <path d="M3 5h18l-7 8v6l-4 2v-8z" />,
  plus:       <path d="M12 5v14M5 12h14" />,
  close:      <path d="M18 6 6 18M6 6l12 12" />,
  check:      <path d="M20 6 9 17l-5-5" />,
  chevronDown: <path d="M6 9l6 6 6-6" />,
  chevronUp: <path d="M18 15l-6-6-6 6" />,
  chevronRight: <path d="M9 18l6-6-6-6" />,
  chevronLeft: <path d="M15 18l-6-6 6-6" />,
  arrowRight: <path d="M5 12h14M12 5l7 7-7 7" />,
  arrowLeft:  <path d="M19 12H5M12 19l-7-7 7-7" />,
  // domain
  layers:     <g><path d="M12 2 2 7l10 5 10-5z" /><path d="M2 17l10 5 10-5M2 12l10 5 10-5" /></g>,
  git:        <g><circle cx="6" cy="6" r="2.5" /><circle cx="6" cy="18" r="2.5" /><circle cx="18" cy="9" r="2.5" /><path d="M6 8.5v7M18 11.5a6 6 0 0 1-6 6H8.5" /></g>,
  terminal:   <g><path d="M4 17l6-5-6-5" /><path d="M12 19h8" /></g>,
  copy:       <g><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h10" /></g>,
  external:   <g><path d="M14 4h6v6" /><path d="M20 4l-9 9" /><path d="M18 13v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h6" /></g>,
  bolt:       <path d="M13 2 4 14h7l-1 8 9-12h-7z" />,
  globe:      <g><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a14 14 0 0 1 0 18 14 14 0 0 1 0-18z" /></g>,
  calendar:   <g><rect x="3" y="4" width="18" height="17" rx="2" /><path d="M3 9h18M8 2v4M16 2v4" /></g>,
  cpu:        <g><rect x="6" y="6" width="12" height="12" rx="2" /><path d="M9 2v2M15 2v2M9 20v2M15 20v2M2 9h2M2 15h2M20 9h2M20 15h2" /></g>,
  db:         <g><ellipse cx="12" cy="5" rx="8" ry="3" /><path d="M4 5v14c0 1.66 3.58 3 8 3s8-1.34 8-3V5" /><path d="M4 12c0 1.66 3.58 3 8 3s8-1.34 8-3" /></g>,
  fn:         <g><path d="M9 3H7a2 2 0 0 0-2 2v3.5L3 10l2 1.5V15a2 2 0 0 0 2 2h2M15 3h2a2 2 0 0 1 2 2v3.5L21 10l-2 1.5V15a2 2 0 0 1-2 2h-2" /></g>,
  dot:        <circle cx="12" cy="12" r="4" />,
  menu:       <path d="M3 6h18M3 12h18M3 18h18" />,
  settings:   <g><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9c0 .55.45 1 1 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></g>,
  book:       <g><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" /><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" /></g>,
  moon:       <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />,
  sun:        <g><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></g>,
};

export interface IconProps {
  name: string;
  size?: number;
  className?: string;
  style?: React.CSSProperties;
  strokeWidth?: number;
}

export const Icon = ({ name, size = 16, className = '', style = {}, strokeWidth = 2 }: IconProps) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill="none"
    stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round"
    className={className} style={{ flexShrink: 0, ...style }}>
    {ICONS[name] || null}
  </svg>
);

type ButtonVariant = 'primary' | 'outline' | 'ghost' | 'subtle' | 'danger';
type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps {
  variant?: ButtonVariant;
  size?: ButtonSize;
  children?: React.ReactNode;
  icon?: string;
  iconRight?: string;
  onClick?: () => void;
  disabled?: boolean;
  active?: boolean;
  style?: React.CSSProperties;
  title?: string;
  type?: 'button' | 'submit' | 'reset';
}

export const Button = ({
  variant = 'primary', size = 'md', children, icon, iconRight, onClick, disabled, active, style, title, type = 'button',
}: ButtonProps) => {
  const sizes: Record<ButtonSize, React.CSSProperties> = {
    sm: { height: 28, padding: '0 10px', fontSize: 12, borderRadius: 6 },
    md: { height: 34, padding: '0 12px', fontSize: 13, borderRadius: 8 },
    lg: { height: 40, padding: '0 16px', fontSize: 14, borderRadius: 8 },
  };
  const variants: Record<ButtonVariant, { background: string; color: string; borderColor: string }> = {
    primary: { background: 'var(--accent)', color: 'var(--accent-fg)', borderColor: 'transparent' },
    outline: { background: 'var(--surface)', color: 'var(--fg)', borderColor: 'var(--border-strong)' },
    ghost:   { background: active ? 'var(--fill)' : 'transparent', color: 'var(--fg)', borderColor: 'transparent' },
    subtle:  { background: 'var(--fill)', color: 'var(--fg)', borderColor: 'transparent' },
    danger:  { background: 'var(--surface)', color: 'var(--red-text)', borderColor: 'var(--red-border)' },
  };
  // Hover background lives in theme.css (.bt-btn:hover) keyed off this variable
  // so the inline background never has to be mutated on mouse events.
  const hoverBackground: Record<ButtonVariant, string> = {
    primary: 'var(--accent-hover)',
    danger:  'var(--red-fill)',
    outline: 'var(--hover)',
    ghost:   'var(--hover)',
    subtle:  'var(--hover)',
  };
  const v = variants[variant];
  return (
    <button type={type} onClick={onClick} disabled={disabled} title={title}
      className="bt-btn" data-variant={variant}
      style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
        fontFamily: 'var(--font-sans)', fontWeight: 500, border: `1px solid ${v.borderColor}`,
        cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.45 : 1,
        transition: 'background var(--dur-fast), border-color var(--dur-fast), opacity var(--dur-fast)',
        whiteSpace: 'nowrap', ...sizes[size],
        background: 'var(--btn-bg)', color: 'var(--btn-fg)',
        ['--btn-bg' as string]: v.background,
        ['--btn-fg' as string]: v.color,
        ['--btn-hover-bg' as string]: hoverBackground[variant],
        ...style,
      }}>
      {icon && <Icon name={icon} size={size === 'sm' ? 13 : 14} />}
      {children}
      {iconRight && <Icon name={iconRight} size={size === 'sm' ? 13 : 14} />}
    </button>
  );
};

export interface IconButtonProps {
  name: string;
  active?: boolean;
  /** Toggle-button state, announced to assistive tech via aria-pressed. */
  pressed?: boolean;
  onClick?: () => void;
  size?: number;
  title?: string;
  box?: number;
}

export const IconButton = ({ name, active, pressed, onClick, size = 16, title, box = 30 }: IconButtonProps) => (
  <button type="button" onClick={onClick} title={title}
    data-active={active}
    aria-pressed={pressed}
    className="bt-icon-btn"
    style={{
      width: box, height: box, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      borderRadius: 8, border: 'none', cursor: 'pointer', flexShrink: 0,
      transition: 'background var(--dur-fast), color var(--dur-fast)',
    }}>
    <Icon name={name} size={size} />
  </button>
);

export const StatusDot = ({ status, size = 8, live }: { status: string; size?: number; live?: boolean }) => {
  const m = STATUS_META[status] || STATUS_META.queued;
  if ((status === 'running' || live) && status !== 'queued') {
    return <span className="bt-live-dot" style={{ width: size, height: size, background: m.color }} />;
  }
  return (
    <span style={{
      width: size, height: size, borderRadius: 9999, background: m.color, display: 'inline-block', flexShrink: 0,
      opacity: status === 'queued' ? 0.55 : 1,
    }} />
  );
};

export const StatusBadge = ({ status, size = 'md' }: { status: string; size?: 'sm' | 'md' }) => {
  const m = STATUS_META[status] || STATUS_META.queued;
  const pad = size === 'sm' ? '2px 7px 2px 6px' : '3px 9px 3px 7px';
  const fs = size === 'sm' ? 11 : 12;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 6, padding: pad, borderRadius: 9999,
      fontSize: fs, fontWeight: 500, lineHeight: 1, whiteSpace: 'nowrap',
      background: `color-mix(in srgb, ${m.color} 13%, transparent)`,
      color: m.color,
      border: `1px solid color-mix(in srgb, ${m.color} 26%, transparent)`,
    }}>
      <StatusDot status={status} size={6} />
      {m.label}
    </span>
  );
};

type BadgeTone = 'gray' | 'blue' | 'green' | 'orange' | 'red';

export const Badge = ({ tone = 'gray', children, style }: { tone?: BadgeTone; children?: React.ReactNode; style?: React.CSSProperties }) => {
  const map: Record<BadgeTone, { c: string }> = {
    gray:   { c: 'var(--fg-muted)' },
    blue:   { c: 'var(--accent)' },
    green:  { c: 'var(--green-primary)' },
    orange: { c: 'var(--orange-primary)' },
    red:    { c: 'var(--red-primary)' },
  };
  const c = (map[tone] || map.gray).c;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, fontWeight: 500,
      padding: '2px 8px', borderRadius: 9999, lineHeight: 1.4, whiteSpace: 'nowrap',
      background: `color-mix(in srgb, ${c} 11%, transparent)`, color: c,
      border: `1px solid color-mix(in srgb, ${c} 22%, transparent)`, ...style,
    }}>{children}</span>
  );
};

/**
 * A real <button role="switch">: focusable, toggled by click, Enter and Space
 * (p2-19 — it used to be an unlabelled div, mouse-only). The visual style is
 * the div's former box; button UA defaults are reset inline.
 */
export const Switch = ({ checked, onChange, size = 18 }: { checked: boolean; onChange?: (v: boolean) => void; size?: number }) => {
  const w = size === 18 ? 32 : 38;
  const knob = size - 4;
  return (
    <button type="button" role="switch" aria-checked={checked}
      onClick={() => onChange?.(!checked)}
      style={{
        appearance: 'none', padding: 0, border: 'none',
        position: 'relative', width: w, height: size, cursor: 'pointer', flexShrink: 0,
        background: checked ? 'var(--accent)' : 'var(--border-strong)', borderRadius: 9999,
        transition: 'background var(--dur-fast)',
      }}>
      <span aria-hidden="true" style={{
        position: 'absolute', top: 2, left: 2, width: knob, height: knob, background: '#fff',
        borderRadius: '50%', transform: checked ? `translateX(${w - size}px)` : 'translateX(0)',
        transition: 'transform var(--dur-fast) var(--ease-standard)', boxShadow: 'var(--shadow-sm)',
      }} />
    </button>
  );
};

export interface InputProps {
  value?: string;
  onChange?: (v: string) => void;
  placeholder?: string;
  icon?: string;
  style?: React.CSSProperties;
  mono?: boolean;
  type?: 'text' | 'password';
  /** Select the whole value when the field gains focus (rejected-key retries). */
  selectOnFocus?: boolean;
}

export const Input = ({ value, onChange, placeholder, icon, style, mono, type = 'text', selectOnFocus }: InputProps) => (
  <div style={{ position: 'relative', display: 'flex', alignItems: 'center', width: '100%', ...style }}>
    {icon && <Icon name={icon} size={14} style={{ position: 'absolute', left: 10, color: 'var(--fg-subtle)', pointerEvents: 'none' }} />}
    <input type={type} value={value ?? ''} onChange={(e) => onChange?.(e.target.value)} placeholder={placeholder}
      className="bt-input"
      style={{
        fontFamily: mono ? 'var(--font-mono)' : 'var(--font-sans)', fontSize: 13, height: 32,
        padding: icon ? '0 10px 0 30px' : '0 10px', width: '100%', boxSizing: 'border-box',
        background: 'var(--surface)', color: 'var(--fg)',
        transition: 'box-shadow var(--dur-fast), border-color var(--dur-fast)',
      }}
      onFocus={(e) => { if (selectOnFocus) e.target.select(); }} />
  </div>
);

// tiny inline sparkline
export const Sparkline = ({ data, w = 72, h = 22, color = 'var(--accent)' }: { data: number[]; w?: number; h?: number; color?: string }) => {
  // A single point divides by (length - 1) → NaN; an empty one min/max over [] →
  // Infinity. Either way the path is garbage — draw nothing instead.
  if (data.length < 2) return null;
  const max = Math.max(...data, 1);
  const min = Math.min(...data);
  const rng = max - min || 1;
  const pts = data.map((d, i) => [(i / (data.length - 1)) * w, h - 2 - ((d - min) / rng) * (h - 4)]);
  const path = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
  const area = path + ` L ${w} ${h} L 0 ${h} Z`;
  return (
    <svg width={w} height={h} style={{ display: 'block', overflow: 'visible' }}>
      <path d={area} fill={color} opacity="0.10" />
      <path d={path} fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
};

export type { RunStatus };
