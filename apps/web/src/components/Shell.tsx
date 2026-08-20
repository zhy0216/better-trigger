/* =============================================================================
   Better Trigger — app shell: brand mark, sidebar nav, top bar.
   ============================================================================= */
import React from 'react';
import { Icon, IconButton } from './primitives';
import { NAV, type NavEntry } from './navigation';
import type { Route } from '../types';

export const Logo = ({ size = 26 }: { size?: number }) => (
  <div style={{
    width: size, height: size, borderRadius: 7, background: 'var(--accent)',
    display: 'grid', placeItems: 'center', flexShrink: 0,
    boxShadow: '0 1px 2px rgba(0,0,0,0.2), inset 0 1px 0 rgba(255,255,255,0.25)',
  }}>
    <svg viewBox="0 0 24 24" width={size * 0.6} height={size * 0.6} fill="none">
      <path d="M13 2 5 13h6l-1 9 9-12h-6z" fill="#fff" stroke="#fff" strokeWidth="1.4" strokeLinejoin="round" />
    </svg>
  </div>
);

const ENVS = [
  { id: 'prod', label: 'Production', dot: 'var(--green-primary)' },
  { id: 'staging', label: 'Staging', dot: 'var(--orange-primary)' },
  { id: 'dev', label: 'Development', dot: 'var(--accent)' },
];

export function Sidebar({ route, setRoute, collapsed }: { route: Route; setRoute: (r: Route) => void; collapsed: boolean }) {
  const w = collapsed ? 60 : 224;
  const navItem = (item: NavEntry) => {
    const on = route === item.id;
    return (
      <button key={item.id} onClick={() => setRoute(item.id)}
        title={collapsed ? item.label : undefined}
        data-active={on}
        className="bt-nav-item"
        style={{
          display: 'flex', alignItems: 'center', gap: 10, width: '100%',
          height: 36, padding: collapsed ? 0 : '0 10px', justifyContent: collapsed ? 'center' : 'flex-start',
          borderRadius: 8, border: 'none', cursor: 'pointer', position: 'relative',
          fontFamily: 'var(--font-sans)', fontSize: 13,
        }}>
        <Icon name={item.icon} size={17} strokeWidth={on ? 2.2 : 2} />
        {!collapsed && <span style={{ flex: 1, textAlign: 'left' }}>{item.label}</span>}
      </button>
    );
  };
  return (
    <aside style={{
      width: w, flexShrink: 0, height: '100%', background: 'var(--panel-bg)',
      borderRight: '1px solid var(--border)', display: 'flex', flexDirection: 'column',
      transition: 'width var(--dur-base) var(--ease-standard)',
    }}>
      {/* brand */}
      <div style={{ height: 56, display: 'flex', alignItems: 'center', gap: 10, padding: '0 14px', borderBottom: '1px solid var(--divider)' }}>
        <Logo />
        {!collapsed && (
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 13.5, fontWeight: 600, letterSpacing: '-0.01em', lineHeight: 1.15, whiteSpace: 'nowrap' }}>Better Trigger</div>
            <div style={{ fontSize: 11, color: 'var(--fg-subtle)', lineHeight: 1.2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>Self-hosted</div>
          </div>
        )}
      </div>

      {/* nav */}
      <nav style={{ flex: 1, padding: collapsed ? '10px 8px' : '10px 12px', display: 'flex', flexDirection: 'column', gap: 2, overflowY: 'auto' }}>
        {NAV.map(navItem)}
        <div style={{ height: 1, background: 'var(--divider)', margin: collapsed ? '10px 4px' : '10px 6px' }} />
        {navItem({ id: 'onboarding', label: 'Get started', icon: 'sparkle' })}
      </nav>
    </aside>
  );
}

export function EnvSwitcher({ env, setEnv }: { env: string; setEnv: (e: string) => void }) {
  const [open, setOpen] = React.useState(false);
  const cur = ENVS.find((e) => e.id === env) || ENVS[0];
  return (
    <div style={{ position: 'relative' }}>
      <button onClick={() => setOpen((o) => !o)}
        style={{
          display: 'flex', alignItems: 'center', gap: 8, height: 32, padding: '0 10px', borderRadius: 8,
          border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--fg)', cursor: 'pointer',
          fontFamily: 'var(--font-sans)', fontSize: 13, fontWeight: 500,
        }}>
        <span style={{ width: 7, height: 7, borderRadius: 9999, background: cur.dot }} />
        {cur.label}
        <Icon name="chevronDown" size={14} style={{ color: 'var(--fg-subtle)' }} />
      </button>
      {open && (
        <>
          <div onClick={() => setOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 40 }} />
          <div style={{
            position: 'absolute', top: 38, left: 0, minWidth: 180, background: 'var(--panel-bg)',
            border: '1px solid var(--border)', borderRadius: 10, boxShadow: 'var(--shadow-pop)', padding: 5, zIndex: 50,
            animation: 'bt-fade-up 140ms var(--ease-standard)',
          }}>
            {ENVS.map((e) => (
              <button key={e.id} onClick={() => { setEnv(e.id); setOpen(false); }}
                data-selected={env === e.id}
                className="bt-menu-item"
                style={{
                  display: 'flex', alignItems: 'center', gap: 8, width: '100%', height: 32, padding: '0 9px', borderRadius: 7,
                  border: 'none', color: 'var(--fg)', cursor: 'pointer',
                  fontFamily: 'var(--font-sans)', fontSize: 13, textAlign: 'left',
                }}>
                <span style={{ width: 7, height: 7, borderRadius: 9999, background: e.dot }} />
                <span style={{ flex: 1 }}>{e.label}</span>
                {env === e.id && <Icon name="check" size={14} style={{ color: 'var(--accent)' }} />}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

export function TopBar({
  title, env, setEnv, onToggleSidebar, theme, setTheme, children,
}: {
  title: string;
  env: string;
  setEnv: (e: string) => void;
  onToggleSidebar: () => void;
  theme: string;
  setTheme: (t: string) => void;
  children?: React.ReactNode;
}) {
  return (
    <header style={{
      height: 56, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 12, padding: '0 18px',
      borderBottom: '1px solid var(--border)', background: 'var(--panel-bg)',
    }}>
      <IconButton name="menu" onClick={onToggleSidebar} title="Toggle sidebar" />
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, minWidth: 0 }}>
        <span style={{ fontSize: 16, fontWeight: 600, letterSpacing: '-0.01em', whiteSpace: 'nowrap' }}>{title}</span>
      </div>
      <div style={{ flex: 1 }} />
      {children}
      <EnvSwitcher env={env} setEnv={setEnv} />
      <IconButton name={theme === 'dark' ? 'sun' : 'moon'} onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} title="Toggle theme" />
    </header>
  );
}

export type { Route };
