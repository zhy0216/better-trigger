/* =============================================================================
   Better Trigger — Onboarding / get started.
   The four steps mirror the real daemon flow (see README.md and examples/basic):
   install the SDK, declare a task(), start the worker daemon, then trigger over HTTP.
   ============================================================================= */
import React from 'react';
import { Icon, Button, Badge, IconButton } from '../components/primitives';
import { Page } from '../components/Layout';
import type { Route } from '../types';

type Token = [string] | [string, string];

const CODE_INSTALL: Token[] = [
  ['fn', 'npm install'], ['t', ' better-trigger'],
];

const CODE_TASK: Token[] = [
  ['kw', 'import'], ['t', ' { task } '], ['kw', 'from'], ['s', ' "better-trigger"'], ['t', ';'], ['nl'],
  ['nl'],
  ['kw', 'export const'], ['fn', ' hello'], ['t', ' = '], ['fn', 'task'], ['t', '({'], ['nl'],
  ['t', '  id: '], ['s', '"hello-world"'], ['t', ','], ['nl'],
  ['t', '  run: '], ['kw', 'async'], ['t', ' (payload: { name: string }) => `hello, ${payload.name}`,'], ['nl'],
  ['t', '});'],
];

const CODE_DAEMON: Token[] = [
  ['fn', 'DATABASE_URL=postgres://localhost:5432/better_trigger'], ['t', ' \\'], ['nl'],
  ['t', '  bunx --bun @better-trigger/worker --tasks ./tasks.ts'],
];

const CODE_TRIGGER: Token[] = [
  ['kw', 'import'], ['t', ' { betterTrigger } '], ['kw', 'from'], ['s', ' "better-trigger"'], ['t', ';'], ['nl'],
  ['kw', 'import'], ['t', ' { hello } '], ['kw', 'from'], ['s', ' "./tasks"'], ['t', ';'], ['nl'],
  ['nl'],
  ['fn', 'betterTrigger'], ['t', '({ url: '], ['s', '"http://localhost:4848"'], ['t', ' }).'], ['fn', 'setDefault'], ['t', '();'], ['nl'],
  ['kw', 'const'], ['t', ' handle = '], ['kw', 'await'], ['t', ' hello.'], ['fn', 'trigger'], ['t', '({ name: '], ['s', '"ada"'], ['t', ' });'], ['nl'],
  ['kw', 'console.log'], ['t', '('], ['kw', 'await'], ['t', ' handle.'], ['fn', 'result'], ['t', '());'],
];

const TOK: Record<string, string> = { kw: 'var(--st-frozen)', s: 'var(--green-primary)', fn: 'var(--accent)', c: 'var(--fg-faint)', t: 'var(--fg)' };

/** Last-resort copy for non-secure contexts where navigator.clipboard is absent
 *  (http on a LAN host, older browsers). Best-effort: a failure just means no
 *  feedback, never an unhandled rejection. */
function legacyCopy(text: string, done: () => void): void {
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = typeof document.execCommand === 'function' && document.execCommand('copy');
    ta.remove();
    if (ok) done();
  } catch {
    /* clipboard unavailable — swallow it, the copy is simply a no-op */
  }
}

function CodeBlock({ tokens, title }: { tokens: Token[]; title: string }) {
  const [copied, setCopied] = React.useState(false);
  const copy = () => {
    const text = tokens.map((tk) => (tk[0] === 'nl' ? '\n' : tk[1])).join('');
    const done = () => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    };
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(() => legacyCopy(text, done));
    } else {
      legacyCopy(text, done);
    }
  };
  return (
    <div style={{ borderRadius: 10, overflow: 'hidden', border: '1px solid var(--border)', background: 'var(--code-bg)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', borderBottom: '1px solid var(--divider)', background: 'var(--surface-2)' }}>
        <Icon name="fn" size={13} style={{ color: 'var(--fg-subtle)' }} />
        <span className="mono" style={{ fontSize: 11.5, color: 'var(--fg-muted)' }}>{title}</span>
        <div style={{ flex: 1 }} />
        <IconButton name={copied ? 'check' : 'copy'} size={13} box={24} title="Copy" onClick={copy} />
      </div>
      <pre className="mono" style={{ margin: 0, padding: '14px 16px', fontSize: 12.5, lineHeight: 1.75, overflowX: 'auto' }}>
        {tokens.map((tk, i) => (tk[0] === 'nl' ? '\n' : <span key={i} style={{ color: TOK[tk[0]] }}>{tk[1]}</span>))}
      </pre>
    </div>
  );
}

export function Onboarding({ setRoute }: { setRoute: (r: Route) => void }) {
  const [step, setStep] = React.useState(1);
  const steps = [
    { n: 1, title: 'Install the SDK', body: 'Add the package to the application that triggers tasks.' },
    { n: 2, title: 'Define a task', body: 'Export task() from a module the daemon can load.' },
    { n: 3, title: 'Start the daemon', body: 'The worker owns Postgres and serves the HTTP API.' },
    { n: 4, title: 'Trigger from your app', body: 'Use the SDK client and inspect the handle result.' },
  ];
  return (
    <Page>
      <div style={{ maxWidth: 760, margin: '0 auto', paddingTop: 8 }}>
        <Badge tone="blue" style={{ marginBottom: 14 }}><Icon name="sparkle" size={12} />Get started</Badge>
        <h2 style={{ margin: '0 0 8px', fontSize: 30, fontWeight: 600, letterSpacing: '-0.02em' }}>Your first task in four steps</h2>
        <p style={{ margin: '0 0 28px', fontSize: 15, color: 'var(--fg-muted)', lineHeight: 1.55, maxWidth: 560 }}>
          Write long-running background jobs as plain functions. Better Trigger handles queues, retries, and observability — you keep full control of the code.
        </p>

        <div style={{ display: 'flex', gap: 18 }}>
          {/* step rail */}
          <div style={{ flexShrink: 0, width: 240, display: 'flex', flexDirection: 'column', gap: 6 }}>
            {steps.map((s) => {
              const on = step === s.n;
              const done = step > s.n;
              return (
                <button key={s.n} onClick={() => setStep(s.n)}
                  style={{
                    display: 'flex', gap: 12, padding: '12px 13px', borderRadius: 10, border: '1px solid ' + (on ? 'var(--accent-border)' : 'var(--border)'),
                    background: on ? 'var(--accent-fill)' : 'var(--surface)', cursor: 'pointer', textAlign: 'left', transition: 'all var(--dur-fast)',
                  }}>
                  <div style={{
                    width: 24, height: 24, borderRadius: 9999, flexShrink: 0, display: 'grid', placeItems: 'center', fontSize: 12, fontWeight: 600,
                    background: done ? 'var(--green-primary)' : on ? 'var(--accent)' : 'var(--fill)', color: done || on ? '#fff' : 'var(--fg-muted)',
                  }}>
                    {done ? <Icon name="check" size={13} /> : s.n}
                  </div>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--fg)' }}>{s.title}</div>
                    <div style={{ fontSize: 11.5, color: 'var(--fg-subtle)', marginTop: 2, lineHeight: 1.4 }}>{s.body}</div>
                  </div>
                </button>
              );
            })}
          </div>

          {/* step panel */}
          <div style={{ flex: 1, minWidth: 0 }}>
            {step === 1 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <CodeBlock title="terminal" tokens={CODE_INSTALL} />
                <p style={{ margin: 0, fontSize: 12.5, color: 'var(--fg-subtle)' }}>Install the SDK in the app that triggers work. The worker daemon is the only process that needs Postgres access.</p>
              </div>
            )}
            {step === 2 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <CodeBlock title="tasks.ts" tokens={CODE_TASK} />
                <p style={{ margin: 0, fontSize: 12.5, color: 'var(--fg-subtle)' }}>The daemon imports this module and registers each exported task before it starts accepting runs.</p>
              </div>
            )}
            {step === 3 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <CodeBlock title="terminal" tokens={CODE_DAEMON} />
                <p style={{ margin: 0, fontSize: 12.5, color: 'var(--fg-subtle)' }}>The daemon applies migrations, executes runs, and serves the API on <code className="mono">localhost:4848</code>.</p>
              </div>
            )}
            {step === 4 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <CodeBlock title="src/app.ts" tokens={CODE_TRIGGER} />
                <p style={{ margin: 0, fontSize: 12.5, color: 'var(--fg-subtle)' }}>The app talks to the daemon over HTTP. Use <code className="mono">handle.result()</code> to wait for the completed output, then open Runs to inspect the trace.</p>
              </div>
            )}
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 18 }}>
              <Button variant="ghost" disabled={step === 1} onClick={() => setStep((s) => s - 1)} icon="chevronLeft">Back</Button>
              {step < 4
                ? <Button onClick={() => setStep((s) => s + 1)} iconRight="chevronRight">Next</Button>
                : <Button onClick={() => setRoute('runs')} iconRight="arrowRight">Go to runs</Button>}
            </div>
          </div>
        </div>
      </div>
    </Page>
  );
}
