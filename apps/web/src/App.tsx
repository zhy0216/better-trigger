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
import type { Route, VizStyle } from './types';

const TWEAK_DEFAULTS = {
  theme: 'dark',
  accent: '#6E6EFF',
  density: 'comfortable',
  vizStyle: 'waterfall',
};

export default function App() {
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);
  const [route, setRoute] = React.useState<Route>('run'); // run = hero trace detail
  const [env, setEnv] = React.useState('prod');
  const [collapsed, setCollapsed] = React.useState(false);

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
  if (route === 'run') screen = <RunView vizStyle={t.vizStyle as VizStyle} onBack={() => setRoute('runs')} />;
  else if (route === 'runs') screen = <RunsList env={env} onOpenRun={() => setRoute('run')} />;
  else if (route === 'tasks') screen = <TasksDashboard setRoute={goTo} onOpenRun={() => setRoute('run')} />;
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
          theme={t.theme} setTheme={(v) => setTweak('theme', v)}
          onSearch={() => {}}>
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
