/* =============================================================================
   Better Trigger — Onboarding / get started.
   The three steps mirror the real flow (see examples/basic): install the SDK
   (`better-trigger`), declare a task(), then startWorker + trigger over HTTP.
   ============================================================================= */
import React from 'react';
import { Icon, Button, Badge, IconButton } from '../components/primitives';
import { Page } from '../components/Layout';

type Token = [string] | [string, string];

const CODE_INSTALL: Token[] = [
  ['fn', 'npm i'], ['t', ' better-trigger'], ['nl'],
  ['c', '# server: better-trigger-server + Postgres'], ['nl'],
  ['fn', 'export'], ['t', ' BETTER_TRIGGER_API_URL=http://localhost:4848'],
];

const CODE_TASK: Token[] = [
  ['kw', 'import'], ['t', ' { task } '], ['kw', 'from'], ['s', ' "better-trigger"'], ['t', ';'], ['nl'],
  ['nl'],
  ['kw', 'export const'], ['fn', ' processOrder'], ['t', ' = task({'], ['nl'],
  ['t', '  id: '], ['s', '"process-order"'], ['t', ','], ['nl'],
  ['kw', '  run'], ['t', ': '], ['kw', 'async'], ['t', ' (payload, ctx) => {'], ['nl'],
  ['c', '    // durable step — replayed from cache on retry'], ['nl'],
  ['kw', '    const'], ['t', ' charge = '], ['kw', 'await'], ['t', ' ctx.'], ['fn', 'step'], ['t', '('], ['s', '"charge"'], ['t', ', () =>'], ['nl'],
  ['fn', '      chargeCard'], ['t', '(payload));'], ['nl'],
  ['kw', '    await'], ['t', ' ctx.wait.'], ['fn', 'for'], ['t', '('], ['s', '"5s"'], ['t', ');'], ['nl'],
  ['kw', '    return'], ['t', ' { ok: '], ['kw', 'true'], ['t', ', chargeId: charge.id };'], ['nl'],
  ['t', '  },'], ['nl'],
  ['t', '});'],
];

const CODE_WORKER: Token[] = [
  ['kw', 'import'], ['t', ' { startWorker } '], ['kw', 'from'], ['s', ' "better-trigger"'], ['t', ';'], ['nl'],
  ['kw', 'import'], ['t', ' { processOrder } '], ['kw', 'from'], ['s', ' "./tasks"'], ['t', ';'], ['nl'],
  ['nl'],
  ['kw', 'await'], ['fn', ' startWorker'], ['t', '({ tasks: [processOrder] });'],
];

const CODE_TRIGGER: Token[] = [
  ['fn', 'bun'], ['t', ' src/worker.ts'], ['nl'],
  ['fn', 'curl'], ['t', ' -s localhost:4848/api/v1/trigger \\'], ['nl'],
  ['t', "  -H 'content-type: application/json' \\"], ['nl'],
  ['t', "  -d '"], ['s', '{"taskId":"process-order","payload":{}}'], ['t', "'"],
];

const TOK: Record<string, string> = { kw: 'var(--st-frozen)', s: 'var(--green-primary)', fn: 'var(--accent)', c: 'var(--fg-faint)', t: 'var(--fg)' };

function CodeBlock({ tokens, title }: { tokens: Token[]; title: string }) {
  const [copied, setCopied] = React.useState(false);
  const copy = () => {
    const text = tokens.map((tk) => (tk[0] === 'nl' ? '\n' : tk[1])).join('');
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    });
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

export function Onboarding({ setRoute }: { setRoute: (r: string) => void }) {
  const [step, setStep] = React.useState(1);
  const steps = [
    { n: 1, title: 'Install the SDK', body: 'One package. It talks to your self-hosted server.' },
    { n: 2, title: 'Write a task', body: 'A plain async function with durable, replayable steps.' },
    { n: 3, title: 'Run a worker & trigger', body: 'The worker registers tasks and long-polls for runs.' },
  ];
  return (
    <Page>
      <div style={{ maxWidth: 760, margin: '0 auto', paddingTop: 8 }}>
        <Badge tone="blue" style={{ marginBottom: 14 }}><Icon name="sparkle" size={12} />Get started</Badge>
        <h2 style={{ margin: '0 0 8px', fontSize: 30, fontWeight: 600, letterSpacing: '-0.02em' }}>Your first task in three steps</h2>
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
                <p style={{ margin: 0, fontSize: 12.5, color: 'var(--fg-subtle)' }}>The server needs a Postgres database — migrations run automatically on startup.</p>
              </div>
            )}
            {step === 2 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <CodeBlock title="src/tasks.ts" tokens={CODE_TASK} />
                <p style={{ margin: 0, fontSize: 12.5, color: 'var(--fg-subtle)' }}>Each <code className="mono">ctx.step</code> is memoized — on retry, completed steps replay from cache instead of re-executing.</p>
              </div>
            )}
            {step === 3 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <CodeBlock title="src/worker.ts" tokens={CODE_WORKER} />
                <CodeBlock title="terminal" tokens={CODE_TRIGGER} />
                <p style={{ margin: 0, fontSize: 12.5, color: 'var(--fg-subtle)' }}>Every run is traced automatically — open Runs to watch it stream live.</p>
              </div>
            )}
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 18 }}>
              <Button variant="ghost" disabled={step === 1} onClick={() => setStep((s) => s - 1)} icon="chevronLeft">Back</Button>
              {step < 3
                ? <Button onClick={() => setStep((s) => s + 1)} iconRight="chevronRight">Next</Button>
                : <Button onClick={() => setRoute('runs')} iconRight="arrowRight">Go to runs</Button>}
            </div>
          </div>
        </div>
      </div>
    </Page>
  );
}
