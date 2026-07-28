/* =============================================================================
   Better Trigger — app root: routing, theme/density/accent application, tweaks.
   ============================================================================= */
import React from 'react';
import { useTweaks } from './hooks/useTweaks';
import { Sidebar, TopBar } from './components/Shell';
import { Button } from './components/primitives';
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
import { useConnection } from './api/hooks';
import type { Route, VizStyle } from './types';

const TWEAK_DEFAULTS = {
  theme: 'dark',
  accent: '#6E6EFF',
  density: 'comfortable',
  vizStyle: 'waterfall',
};

export default function App() {
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);
  const [route, setRoute] = React.useState<Route>('runs');
  const [env, setEnv] = React.useState('prod');
  const [collapsed, setCollapsed] = React.useState(false);
  const [runId, setRunId] = React.useState<string | null>(null); // selected run for RunView
  const connection = useConnection();

  const openRun = (id?: string) => { setRunId(id ?? null); setRoute('run'); };

  // apply theme + density + accent to <html>
  React.useEffect(() => {
    const el = document.documentElement;
    el.setAttribute('data-theme', t.theme);
    el.setAttribute('data-density', t.density === 'compact' ? 'compact' : 'comfortable');
    el.style.setProperty('--accent', t.accent);
  }, [t.theme, t.density, t.accent]);

  const goTo = (r: string) => setRoute(r as Route);
  const activeNav = route === 'run' ? 'runs' : route;
  const titles: Record<string, string> = {
    run: 'Run', runs: 'Runs', tasks: 'Tasks', schedules: 'Schedules',
    alerts: 'Alerts', deployments: 'Deployments', onboarding: 'Get started',
  };

  let screen: React.ReactNode;
  if (route === 'run') screen = <RunView vizStyle={t.vizStyle as VizStyle} runId={runId} onBack={() => setRoute('runs')} />;
  else if (route === 'runs') screen = <RunsList env={env} onOpenRun={(r) => openRun(r.id)} />;
  else if (route === 'tasks') screen = <TasksDashboard setRoute={goTo} onOpenRun={openRun} />;
  else if (route === 'schedules') screen = <Schedules />;
  else if (route === 'alerts') screen = <Alerts />;
  else if (route === 'deployments') screen = <Deployments />;
  else if (route === 'onboarding') screen = <Onboarding setRoute={goTo} />;

  return (
    <div style={{ display: 'flex', height: '100vh', overflow: 'hidden' }} data-screen-label={titles[route]}>
      <Sidebar route={activeNav} setRoute={(r) => setRoute((r === 'runs' ? 'runs' : r) as Route)} collapsed={collapsed} />
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        <TopBar title={titles[route]} env={env} setEnv={setEnv}
          onToggleSidebar={() => setCollapsed((c) => !c)}
          theme={t.theme} setTheme={(v) => setTweak('theme', v)}>
          <ConnectionDot connection={connection} />
          {route === 'tasks' && <Button variant="outline" size="sm" icon="plus" onClick={() => setRoute('onboarding')}>New task</Button>}
        </TopBar>
        {screen}
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
