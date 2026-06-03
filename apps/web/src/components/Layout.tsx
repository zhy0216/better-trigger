/* =============================================================================
   Better Trigger — shared layout pieces: Page, Card, Metric, SectionHead.
   ============================================================================= */
import React from 'react';

export function Page({ children, pad = true, scroll = true }: { children?: React.ReactNode; pad?: boolean; scroll?: boolean }) {
  return (
    <div style={{ flex: 1, minHeight: 0, overflowY: scroll ? 'auto' : 'hidden', background: 'var(--app-bg)' }}>
      <div style={{ maxWidth: 1180, margin: '0 auto', padding: pad ? '20px 24px 40px' : 0 }}>{children}</div>
    </div>
  );
}

export function Card({
  children, style, onClick, hover,
}: {
  children?: React.ReactNode;
  style?: React.CSSProperties;
  onClick?: () => void;
  hover?: boolean;
}) {
  const [h, setH] = React.useState(false);
  return (
    <div onClick={onClick}
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
