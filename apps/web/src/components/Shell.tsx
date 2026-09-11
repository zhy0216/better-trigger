/* =============================================================================
   Better Trigger — app shell: brand mark, sidebar nav, top bar.
   ============================================================================= */
import React from 'react';
import { Icon, IconButton } from './primitives';
import { NAV, type NavEntry } from './navigation';
import { Modal } from './Modal';
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

export function Sidebar({ route, setRoute, collapsed, mobile = false, open = false, onClose = () => {} }: {
  route: Route;
  setRoute: (r: Route) => void;
  collapsed: boolean;
  mobile?: boolean;
  open?: boolean;
  onClose?: () => void;
}) {
  const compact = collapsed && !mobile;
  const navItem = (item: NavEntry) => {
    const on = route === item.id;
    return (
      <button key={item.id} onClick={() => setRoute(item.id)} type="button"
        title={compact ? item.label : undefined}
        aria-label={item.label}
        aria-current={on ? 'page' : undefined}
        data-active={on}
        className="bt-nav-item"
        >
        <Icon name={item.icon} size={17} strokeWidth={on ? 2.2 : 2} />
        {!compact && <span className="bt-nav-label">{item.label}</span>}
      </button>
    );
  };
  const content = (
    <>
      <div className="bt-brand">
        <Logo size={30} />
        {!compact && (
          <div className="bt-brand-copy">
            <strong>Better Trigger</strong>
            <span>Task orchestration</span>
          </div>
        )}
        {mobile && <IconButton name="close" title="Close navigation" onClick={onClose} />}
      </div>
      <nav aria-label="Workspace" className="bt-navigation">
        {!compact && <div className="bt-nav-section">Workspace</div>}
        {NAV.map(navItem)}
        <div className="bt-nav-divider" />
        {navItem({ id: 'onboarding', label: 'Get started', icon: 'sparkle' })}
      </nav>
      <div className="bt-sidebar-footer">
        <Icon name="bolt" size={15} />
        {!compact && <span>Self-hosted. Your infrastructure.</span>}
      </div>
    </>
  );
  if (mobile) return (
    <Modal open={open} onClose={onClose} label="Workspace navigation" id="workspace-navigation" className="bt-nav-drawer">
      <div className="bt-sidebar" data-collapsed="false">{content}</div>
    </Modal>
  );
  return <aside id="workspace-navigation" className="bt-sidebar" data-collapsed={compact}>{content}</aside>;
}

export function EnvSwitcher({ env, setEnv }: { env: string; setEnv: (e: string) => void }) {
  const [open, setOpen] = React.useState(false);
  const triggerRef = React.useRef<HTMLButtonElement | null>(null);
  // EnvSwitcher keyboard path (p2-19): Esc closes and restores focus to the
  // trigger; opening moves focus into the menu so Tab/Enter continue from
  // there instead of leaving the caret on a vanished popup.
  const optionRefs = React.useRef<Record<string, HTMLButtonElement | null>>({});
  const cur = ENVS.find((e) => e.id === env) || ENVS[0];

  const close = React.useCallback((refocus: boolean) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  }, []);

  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close(true);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, close]);

  React.useEffect(() => {
    if (!open) return;
    (optionRefs.current[env] ?? optionRefs.current[ENVS[0].id])?.focus();
  }, [open, env]);

  return (
    <div className="bt-env-switcher">
      <button ref={triggerRef} onClick={() => setOpen((o) => !o)}
        aria-haspopup="true" aria-expanded={open}
        className="bt-env-trigger" type="button">
        <span style={{ width: 7, height: 7, borderRadius: 9999, background: cur.dot }} />
        <span>{cur.label}</span>
        <Icon name="chevronDown" size={14} style={{ color: 'var(--fg-subtle)' }} />
      </button>
      {open && (
        <>
          <div onClick={() => setOpen(false)} aria-hidden="true" style={{ position: 'fixed', inset: 0, zIndex: 40 }} />
          <div role="group" aria-label="Environment" className="bt-env-menu">
            {ENVS.map((e) => (
              <button key={e.id} ref={(el) => { optionRefs.current[e.id] = el; }}
                onClick={() => { setEnv(e.id); close(true); }}
                data-selected={env === e.id}
                aria-pressed={env === e.id}
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
  title, env, setEnv, onToggleSidebar, theme, setTheme, tweaksOpen, onToggleTweaks, children, sidebarExpanded = true,
}: {
  title: string;
  env: string;
  setEnv: (e: string) => void;
  onToggleSidebar: () => void;
  theme: string;
  setTheme: (t: string) => void;
  /** Tweaks panel visibility + toggle (p2-19): the only built-in entry to the
   *  panel — without it the panel could never be opened. */
  tweaksOpen: boolean;
  onToggleTweaks: () => void;
  children?: React.ReactNode;
  sidebarExpanded?: boolean;
}) {
  return (
    <header className="bt-topbar">
      <div className="bt-topbar-heading">
        <IconButton name="menu" onClick={onToggleSidebar} title="Toggle sidebar"
          expanded={sidebarExpanded} controls="workspace-navigation" />
        <span className="bt-topbar-separator" aria-hidden="true" />
        <h1>{title}</h1>
      </div>
      <div className="bt-topbar-context">{children}</div>
      <div className="bt-topbar-controls">
        <EnvSwitcher env={env} setEnv={setEnv} />
        <IconButton name={theme === 'dark' ? 'sun' : 'moon'} onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} title="Toggle theme" />
        <IconButton name="settings" active={tweaksOpen} pressed={tweaksOpen}
          onClick={onToggleTweaks} title="Display settings" id="display-settings-trigger" />
      </div>
    </header>
  );
}
