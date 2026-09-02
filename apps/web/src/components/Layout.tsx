/* =============================================================================
   Better Trigger — shared layout pieces: Page, Card, Metric, SectionHead,
   LoadingState, ErrorState.
   ============================================================================= */
import React from 'react';
import { Icon } from './primitives';
import { API_BASE_URL } from '../api/client';

export function Page({ children, pad = true, scroll = true }: { children?: React.ReactNode; pad?: boolean; scroll?: boolean }) {
  return (
    <div style={{ flex: 1, minHeight: 0, overflowY: scroll ? 'auto' : 'hidden', background: 'var(--app-bg)' }}>
      <div style={{ maxWidth: 1180, margin: '0 auto', padding: pad ? '20px 24px 40px' : 0 }}>{children}</div>
    </div>
  );
}

/**
 * When given an `onClick` the card is an interactive control: it gets
 * role="button" + tabIndex + Enter/Space activation (p2-19 — it used to be
 * mouse-only). A real <button> is not used because cards carry block layout
 * content and, on the schedules screen, nested real buttons.
 */
export function Card({
  children, style, onClick, hover,
}: {
  children?: React.ReactNode;
  style?: React.CSSProperties;
  onClick?: () => void;
  hover?: boolean;
}) {
  const [h, setH] = React.useState(false);
  const interactive = onClick !== undefined;
  return (
    <div onClick={onClick}
      role={interactive ? 'button' : undefined}
      tabIndex={interactive ? 0 : undefined}
      onKeyDown={interactive ? (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick?.();
        }
      } : undefined}
      onMouseEnter={() => hover && setH(true)} onMouseLeave={() => setH(false)}
      style={{
        background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12,
        boxShadow: h ? 'var(--shadow-md)' : 'var(--shadow-panel)', cursor: onClick ? 'pointer' : 'default',
        transition: 'box-shadow var(--dur-base), border-color var(--dur-base), transform var(--dur-base)',
        borderColor: h && hover ? 'var(--border-strong)' : 'var(--border)',
        transform: h && hover ? 'translateY(-1px)' : 'none', ...style,
      }}>
      {children}
    </div>
  );
}

export function Metric({ label, value, tone }: { label: string; value: React.ReactNode; tone?: string }) {
  return (
    <div>
      <div style={{ fontSize: 10.5, color: 'var(--fg-faint)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 2, whiteSpace: 'nowrap' }}>{label}</div>
      <div className="mono tnum" style={{ fontSize: 13.5, fontWeight: 600, color: tone || 'var(--fg)', whiteSpace: 'nowrap' }}>{value}</div>
    </div>
  );
}

/** Centered "waiting for the first response" placeholder. */
export function LoadingState({ label = 'Connecting to server…' }: { label?: string }) {
  return (
    <div style={{ display: 'grid', placeItems: 'center', padding: '80px 0', color: 'var(--fg-subtle)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, fontSize: 13 }}>
        <span className="bt-live-dot" /> {label}
      </div>
    </div>
  );
}

/**
 * Centered "server unreachable" panel. Polling keeps retrying behind it, so
 * the screen recovers on its own once the API is back.
 */
export function ErrorState({ message }: { message?: string | null }) {
  return (
    <div style={{ display: 'grid', placeItems: 'center', padding: '64px 0' }}>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, maxWidth: 440, textAlign: 'center' }}>
        <div style={{
          width: 38, height: 38, borderRadius: 10, display: 'grid', placeItems: 'center',
          background: 'color-mix(in srgb, var(--red-primary) 10%, transparent)',
          border: '1px solid color-mix(in srgb, var(--red-primary) 25%, transparent)',
        }}>
          <Icon name="close" size={17} style={{ color: 'var(--red-primary)' }} />
        </div>
        <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--fg)' }}>Can’t reach the server</div>
        {message && <div className="mono" style={{ fontSize: 12, color: 'var(--fg-muted)', wordBreak: 'break-word' }}>{message}</div>}
        <div style={{ fontSize: 12.5, color: 'var(--fg-subtle)', lineHeight: 1.6 }}>
          Expected the API at <code className="mono" style={{ color: 'var(--fg-muted)' }}>{API_BASE_URL}</code>.
          Start the server (or set <code className="mono" style={{ color: 'var(--fg-muted)' }}>VITE_BT_API_URL</code>) — retrying automatically.
        </div>
      </div>
    </div>
  );
}

export function SectionHead({ title, sub, action }: { title: string; sub?: string; action?: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', marginBottom: 16, gap: 16 }}>
      <div>
        <h4 style={{ margin: 0, fontSize: 15, fontWeight: 600, letterSpacing: '-0.01em' }}>{title}</h4>
        {sub && <p style={{ margin: '3px 0 0', fontSize: 12.5, color: 'var(--fg-subtle)' }}>{sub}</p>}
      </div>
      {action}
    </div>
  );
}
