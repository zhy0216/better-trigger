/* =============================================================================
   Better Trigger — Onboarding / get started.
   ============================================================================= */
import React from 'react';
import { Icon, Button, Badge, IconButton } from '../components/primitives';
import { Page, Card } from '../components/Layout';

type Token = [string] | [string, string];

const CODE_TASK: Token[] = [
  ['kw', 'import'], ['t', ' { task } '], ['kw', 'from'], ['s', ' "@better-trigger/sdk"'], ['t', ';'], ['nl'],
  ['nl'],
  ['kw', 'export const'], ['fn', ' processOrder'], ['t', ' = task({'], ['nl'],
  ['t', '  id: '], ['s', '"process-order"'], ['t', ','], ['nl'],
  ['c', '  // up to 1hr, auto-retried, fully traced'], ['nl'],
  ['kw', '  run'], ['t', ': '], ['kw', 'async'], ['t', ' (payload) => {'], ['nl'],
  ['kw', '    const'], ['t', ' order = '], ['kw', 'await'], ['fn', ' charge'], ['t', '(payload);'], ['nl'],
  ['kw', '    await'], ['fn', ' sendReceipt'], ['t', '(order);'], ['nl'],
  ['kw', '    return'], ['t', ' { ok: '], ['kw', 'true'], ['t', ' };'], ['nl'],
  ['t', '  },'], ['nl'],
  ['t', '});'],
];
const TOK: Record<string, string> = { kw: 'var(--st-frozen)', s: 'var(--green-primary)', fn: 'var(--accent)', c: 'var(--fg-faint)', t: 'var(--fg)' };

function CodeBlock({ tokens, title }: { tokens: Token[]; title: string }) {
  return (
    <div style={{ borderRadius: 10, overflow: 'hidden', border: '1px solid var(--border)', background: 'var(--code-bg)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', borderBottom: '1px solid var(--divider)', background: 'var(--surface-2)' }}>
        <Icon name="fn" size={13} style={{ color: 'var(--fg-subtle)' }} />
        <span className="mono" style={{ fontSize: 11.5, color: 'var(--fg-muted)' }}>{title}</span>
        <div style={{ flex: 1 }} />
        <IconButton name="copy" size={13} box={24} title="Copy" />
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
    { n: 1, title: 'Install the CLI', body: 'Add the SDK and log in. One command per project.' },
    { n: 2, title: 'Write a task', body: 'A task is a regular async function. No queues to wire up.' },
    { n: 3, title: 'Trigger it', body: 'Run locally, then deploy. Every run is traced automatically.' },
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
                <CodeBlock title="terminal" tokens={[['fn', 'npm i'], ['t', ' -g @better-trigger/cli'], ['nl'], ['fn', 'bt login'], ['nl'], ['fn', 'bt init'], ['t', ' acme-store']]} />
                <p style={{ margin: 0, fontSize: 12.5, color: 'var(--fg-subtle)' }}>Creates a <code className="mono">trigger/</code> folder and links this workspace.</p>
              </div>
            )}
            {step === 2 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <CodeBlock title="trigger/orders.ts" tokens={CODE_TASK} />
                <p style={{ margin: 0, fontSize: 12.5, color: 'var(--fg-subtle)' }}>Any export wrapped in <code className="mono">task()</code> becomes triggerable and traceable.</p>
              </div>
            )}
            {step === 3 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <CodeBlock title="terminal" tokens={[['fn', 'bt dev'], ['c', '   # run + watch locally'], ['nl'], ['fn', 'bt deploy'], ['c', ' # ship an immutable version']]} />
                <Card style={{ padding: 14, display: 'flex', alignItems: 'center', gap: 12 }}>
                  <span className="bt-live-dot" />
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 13, fontWeight: 600 }}>A run just started</div>
                    <div style={{ fontSize: 12, color: 'var(--fg-subtle)' }}>Watch it stream live in the run view.</div>
                  </div>
                  <Button icon="activity" onClick={() => setRoute('run')}>Open run</Button>
                </Card>
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
