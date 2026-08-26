/* =============================================================================
   Better Trigger — app root: routing, theme/density/accent application, tweaks.
   ============================================================================= */
import React from 'react';
import { useTweaks } from './hooks/useTweaks';
import { Sidebar, TopBar } from './components/Shell';
import { Button, Input } from './components/primitives';
import {
  TweaksPanel,
  TweakSection,
  TweakRadio,
  TweakColor,
} from './components/TweaksPanel';
import { RunView } from './features/run/RunView';
import { RunsList } from './screens/RunsList';
import { TasksDashboard } from './screens/TasksDashboard';
import { Schedules } from './screens/Schedules';
import { Alerts } from './screens/Alerts';
import { Deployments } from './screens/Deployments';
import { Onboarding } from './screens/Onboarding';
import { resetConnection, useConnection } from './api/hooks';
import { getApiKeySource, setApiKey } from './api/client';
import type { Route, VizStyle } from './types';

const TWEAK_DEFAULTS = {
  theme: 'dark',
  accent: '#6E6EFF',
  density: 'comfortable',
  vizStyle: 'waterfall',
};

/* URL routing — the daemon's SPA fallback (apps/worker/src/static.ts) serves
   index.html for deep links, so paths mirror the sidebar + run detail. There is
   no 'workers' route (worker stats live on the tasks dashboard) and no path for
   'alerts'/'deployments', so those fall back to the runs list when unknown. */
const STATIC_ROUTES: Array<[string, Route]> = [
  ['/tasks', 'tasks'],
  ['/schedules', 'schedules'],
  ['/alerts', 'alerts'],
  ['/deployments', 'deployments'],
  ['/onboarding', 'onboarding'],
];

function parsePath(path: string): { route: Route; runId: string | null } {
  const runMatch = /^\/runs\/([^/]+)$/.exec(path);
  if (runMatch) return { route: 'run', runId: runMatch[1] };
  if (path === '/' || path === '/runs') return { route: 'runs', runId: null };
  const hit = STATIC_ROUTES.find(([p]) => path === p);
  return hit ? { route: hit[1], runId: null } : { route: 'runs', runId: null };
}

function pathFor(route: Route, runId?: string | null): string {
  if (route === 'run') return `/runs/${runId ?? ''}`;
  if (route === 'runs') return '/runs';
  return STATIC_ROUTES.find(([, r]) => r === route)?.[0] ?? '/runs';
}

export default function App() {
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);
  const initial = React.useMemo(() => parsePath(window.location.pathname), []);
  const [route, setRoute] = React.useState<Route>(initial.route);
  const [env, setEnv] = React.useState('prod');
  const [collapsed, setCollapsed] = React.useState(false);
  const [runId, setRunId] = React.useState<string | null>(initial.runId); // selected run for RunView
  const connection = useConnection();
  const [apiKeySource, setApiKeySource] = React.useState(getApiKeySource);
  // Key-prompt state lives in App so it survives the prompt's unmount: the
  // token is kept for the user to edit on a rejection, and keyRejected
  // distinguishes a REJECTED key from a first visit.
  const [pendingKey, setPendingKey] = React.useState('');
  const [keyRejected, setKeyRejected] = React.useState(false);
  const submittedRef = React.useRef(false);

  // A second 'unauthorized' after a submit means the daemon rejected the key:
  // surface that as a distinct variant instead of a blank first-visit prompt.
  React.useEffect(() => {
    if (connection === 'unauthorized' && submittedRef.current) {
      setKeyRejected(true);
    }
  }, [connection]);

  const navigate = (nextRoute: Route, nextRunId: string | null = null) => {
    history.pushState(null, '', pathFor(nextRoute, nextRunId));
    setRunId(nextRoute === 'run' ? nextRunId : null);
    setRoute(nextRoute);
  };
  const openRun = (id?: string) => navigate('run', id ?? null);

  // Seed state from the mount URL (replaceState: the first load is the current
  // history entry, not a new one) and keep route/runId in sync with back/forward.
  React.useEffect(() => {
    const seeded = parsePath(window.location.pathname);
    history.replaceState(null, '', pathFor(seeded.route, seeded.runId));
    const onPop = () => {
      const next = parsePath(window.location.pathname);
      setRunId(next.runId);
      setRoute(next.route);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  // apply theme + density + accent to <html>
  React.useEffect(() => {
    const el = document.documentElement;
    el.setAttribute('data-theme', t.theme);
    el.setAttribute('data-density', t.density === 'compact' ? 'compact' : 'comfortable');
    el.style.setProperty('--accent', t.accent);
  }, [t.theme, t.density, t.accent]);

  const goTo = (r: Route) => navigate(r);
  const activeNav = route === 'run' ? 'runs' : route;
  const titles: Record<Route, string> = {
    run: 'Run', runs: 'Runs', tasks: 'Tasks', schedules: 'Schedules',
    alerts: 'Alerts', deployments: 'Deployments', onboarding: 'Get started',
  };

  let screen: React.ReactNode;
  if (route === 'run') screen = <RunView vizStyle={t.vizStyle as VizStyle} runId={runId} env={env} onBack={() => navigate('runs')} onRetried={(newRunId) => openRun(newRunId)} />;
  else if (route === 'runs') screen = <RunsList env={env} onOpenRun={(r) => openRun(r.id)} />;
  else if (route === 'tasks') screen = <TasksDashboard setRoute={goTo} onOpenRun={openRun} env={env} />;
  else if (route === 'schedules') screen = <Schedules env={env} />;
  else if (route === 'alerts') screen = <Alerts />;
  else if (route === 'deployments') screen = <Deployments />;
  else if (route === 'onboarding') screen = <Onboarding setRoute={goTo} />;

  return (
    <div style={{ display: 'flex', height: '100vh', overflow: 'hidden' }} data-screen-label={titles[route]}>
      <Sidebar route={activeNav} setRoute={navigate} collapsed={collapsed} />
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        <TopBar title={titles[route]} env={env} setEnv={setEnv}
          onToggleSidebar={() => setCollapsed((c) => !c)}
          theme={t.theme} setTheme={(v) => setTweak('theme', v)}>
          <ConnectionDot connection={connection} />
          {apiKeySource === 'vite-env' && (
            <span title="VITE_BT_API_KEY is embedded in this bundle; use only for local development" style={{ color: 'var(--orange-text)', fontSize: 11.5, whiteSpace: 'nowrap' }}>
              Local API key
            </span>
          )}
          {route === 'tasks' && <Button variant="outline" size="sm" icon="plus" onClick={() => navigate('onboarding')}>New task</Button>}
        </TopBar>
        {connection === 'unauthorized' ? (
          <ApiKeyPrompt
            source={apiKeySource}
            token={pendingKey}
            keyRejected={keyRejected}
            onChangeToken={setPendingKey}
            onSubmit={(token) => {
              setApiKey(token);
              setApiKeySource(getApiKeySource());
              setPendingKey(token);
              setKeyRejected(false);
              submittedRef.current = true;
              resetConnection();
            }}
            onClear={() => {
              setApiKey(null);
              setApiKeySource(getApiKeySource());
              setPendingKey('');
              setKeyRejected(false);
              submittedRef.current = false;
              resetConnection();
            }}
          />
        ) : screen}
      </div>

      <TweaksPanel>
        <TweakSection label="Theme" />
        <TweakRadio label="Mode" value={t.theme} options={['light', 'dark']} onChange={(v) => setTweak('theme', v)} />
        <TweakColor label="Accent" value={t.accent}
          options={['#6E6EFF', '#2A6FDB', '#18C580', '#7A5AE0', '#FF9A0C']}
          onChange={(v) => setTweak('accent', v as string)} />
        <TweakSection label="Layout" />
        <TweakRadio label="Density" value={t.density} options={['comfortable', 'compact']} onChange={(v) => setTweak('density', v)} />
        <TweakSection label="Run view" />
        <TweakRadio label="Trace style" value={t.vizStyle} options={['waterfall', 'tree']} onChange={(v) => setTweak('vizStyle', v)} />
      </TweaksPanel>
    </div>
  );
}

/* Tiny connection indicator, sits among the TopBar trailing items. */
const CONNECTION_META = {
  connecting: { label: 'Connecting…', title: 'Waiting for the first server response', color: 'var(--fg-faint)' },
  live: { label: 'Live', title: 'Connected to server', color: 'var(--green-primary)' },
  down: { label: 'Offline', title: 'Server unreachable — retrying', color: 'var(--red-primary)' },
  unauthorized: { label: 'API key required', title: 'The daemon rejected the API key', color: 'var(--orange-primary)' },
} as const;

function ConnectionDot({ connection }: { connection: keyof typeof CONNECTION_META }) {
  const m = CONNECTION_META[connection];
  return (
    <div title={m.title}
      style={{
        display: 'flex', alignItems: 'center', gap: 6, height: 32, padding: '0 9px', borderRadius: 8,
        border: '1px solid var(--border)', background: 'var(--surface)',
        fontSize: 11.5, fontWeight: 500, color: 'var(--fg-subtle)', cursor: 'default',
      }}>
      <span style={{
        width: 7, height: 7, borderRadius: 9999, display: 'inline-block', flexShrink: 0,
        background: m.color,
      }} />
      {m.label}
    </div>
  );
}

export function ApiKeyPrompt({
  source,
  token,
  keyRejected,
  onChangeToken,
  onSubmit,
  onClear,
}: {
  source: 'vite-env' | 'memory' | 'none';
  token: string;
  keyRejected: boolean;
  onChangeToken: (token: string) => void;
  onSubmit: (token: string) => void;
  onClear: () => void;
}) {
  return (
    <main style={{ flex: 1, minHeight: 0, overflowY: 'auto', background: 'var(--app-bg)' }}>
      <div style={{ maxWidth: 560, margin: '0 auto', padding: '80px 24px' }}>
        <div style={{
          padding: 24, borderRadius: 12, border: '1px solid var(--orange-border)',
          background: 'color-mix(in srgb, var(--orange-primary) 6%, var(--surface))',
          boxShadow: 'var(--shadow-panel)',
        }}>
          <div style={{ color: 'var(--orange-primary)', fontSize: 12, fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase' }}>
            Authentication required
          </div>
          <h2 style={{ margin: '8px 0 8px', fontSize: 22, fontWeight: 600, letterSpacing: '-0.02em' }}>Enter your API key</h2>
          {keyRejected ? (
            <p role="alert" style={{
              margin: '0 0 16px', padding: '10px 12px', borderRadius: 8,
              background: 'color-mix(in srgb, var(--red-primary) 10%, var(--surface))',
              border: '1px solid var(--red-border)', color: 'var(--red-text)',
              fontSize: 13, lineHeight: 1.6,
            }}>
              That key was rejected — the daemon said it is invalid. Try a different token.
            </p>
          ) : (
            <p style={{ margin: '0 0 20px', color: 'var(--fg-muted)', fontSize: 13.5, lineHeight: 1.6 }}>
              Paste the token the daemon expects (check its <code className="mono">BETTER_TRIGGER_API_KEY</code>).
              Tokens are kept in memory for this page only and you will be asked again after a refresh.
            </p>
          )}
          <form onSubmit={(event) => { event.preventDefault(); onSubmit(token); }} style={{ display: 'flex', gap: 8 }}>
            <Input value={token} onChange={onChangeToken} placeholder="Bearer token" mono type="password" selectOnFocus={keyRejected} style={{ flex: 1 }} />
            <Button type="submit" disabled={!token.trim()}>Connect</Button>
          </form>
          {source !== 'none' && (
            <button type="button" onClick={onClear} style={{ marginTop: 12, padding: 0, border: 0, background: 'transparent', color: 'var(--fg-subtle)', fontFamily: 'var(--font-sans)', fontSize: 12, cursor: 'pointer' }}>
              Clear the current key and use a different token
            </button>
          )}
          {source === 'vite-env' && (
            <p style={{ margin: '16px 0 0', paddingTop: 12, borderTop: '1px solid var(--divider)', color: 'var(--orange-text)', fontSize: 12, lineHeight: 1.5 }}>
              This key is provided by <code className="mono">VITE_BT_API_KEY</code> and embedded in this bundle — local development only;
              don't compile a long-lived bearer secret into a public build.
            </p>
          )}
        </div>
      </div>
    </main>
  );
}
