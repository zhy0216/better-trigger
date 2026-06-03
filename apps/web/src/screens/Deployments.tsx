/* =============================================================================
   Better Trigger — Deployments.
   ============================================================================= */
import { Icon, Button, IconButton, Badge } from '../components/primitives';
import { Page, Card, SectionHead } from '../components/Layout';
import { DEPLOYMENTS } from '../data/mock';

export function Deployments() {
  const items = DEPLOYMENTS;
  const stMap: Record<string, { tone: string; label: string }> = {
    current:  { tone: 'green', label: 'Current' },
    previous: { tone: 'gray',  label: 'Previous' },
    archived: { tone: 'gray',  label: 'Archived' },
    failed:   { tone: 'red',   label: 'Build failed' },
  };
  return (
    <Page>
      <SectionHead title="Deployments" sub="Every push builds a versioned, immutable deploy." action={<Button icon="rocket">Deploy</Button>} />
      <Card>
        {items.map((d, i) => (
          <div key={d.id} style={{
            display: 'flex', alignItems: 'center', gap: 14, padding: '0 16px', height: 62,
            borderBottom: i < items.length - 1 ? '1px solid var(--divider)' : 'none', opacity: d.status === 'archived' ? 0.6 : 1,
          }}>
            <div style={{
              width: 36, height: 36, borderRadius: 9, flexShrink: 0, display: 'grid', placeItems: 'center',
              background: d.status === 'failed' ? 'color-mix(in srgb, var(--red-primary) 12%, transparent)' : 'var(--accent-fill)',
              color: d.status === 'failed' ? 'var(--red-primary)' : 'var(--accent)',
            }}>
              <Icon name="rocket" size={17} />
            </div>
            <div style={{ width: 150, flexShrink: 0 }}>
              <div className="mono" style={{ fontSize: 13, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 7 }}>
                {d.id}
                {d.env !== 'prod' && <Badge tone="orange">{d.env}</Badge>}
              </div>
              <div style={{ fontSize: 11.5, color: 'var(--fg-subtle)' }}>{d.tasks} tasks · {d.when}</div>
            </div>
            <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 9 }}>
              <Icon name="git" size={13} style={{ color: 'var(--fg-subtle)', flexShrink: 0 }} />
              <code style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5, color: 'var(--fg-subtle)' }}>{d.git}</code>
              <span style={{ fontSize: 12.5, color: 'var(--fg-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{d.msg}</span>
            </div>
            <Badge tone={stMap[d.status].tone}>{stMap[d.status].label}</Badge>
            <IconButton name="external" size={15} title="View deploy" />
          </div>
        ))}
      </Card>
    </Page>
  );
}
