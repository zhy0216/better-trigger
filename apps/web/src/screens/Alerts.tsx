/* =============================================================================
   Better Trigger — Alerts.
   ============================================================================= */
import { Icon, Button, IconButton, Badge, StatusDot } from '../components/primitives';
import { Page, Card, SectionHead } from '../components/Layout';
import { ALERTS } from '../data/mock';

export function Alerts() {
  const items = ALERTS;
  const stMap: Record<string, { tone: string; label: string }> = {
    firing: { tone: 'red', label: 'Firing' },
    armed: { tone: 'gray', label: 'Armed' },
    resolved: { tone: 'green', label: 'Resolved' },
  };
  return (
    <Page>
      <SectionHead title="Alerts" sub="Get notified when runs fail, slow down, or deployments break." action={<Button icon="plus">New alert</Button>} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {items.map((a) => {
          const firing = a.status === 'firing';
          return (
            <Card key={a.id} style={{
              padding: '14px 16px', display: 'flex', alignItems: 'center', gap: 14,
              borderColor: firing ? 'var(--red-border)' : 'var(--border)',
              background: firing ? 'color-mix(in srgb, var(--red-primary) 5%, var(--surface))' : 'var(--surface)',
            }}>
              <div style={{
                width: 36, height: 36, borderRadius: 9, flexShrink: 0, display: 'grid', placeItems: 'center',
                background: firing ? 'color-mix(in srgb, var(--red-primary) 14%, transparent)' : 'var(--fill)',
                color: firing ? 'var(--red-primary)' : 'var(--fg-subtle)',
              }}>
                <Icon name="bell" size={18} />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13.5, fontWeight: 600, marginBottom: 2 }}>{a.title}</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, fontSize: 12, color: 'var(--fg-subtle)', whiteSpace: 'nowrap' }}>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}><Icon name="filter" size={12} />{a.scope}</span>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}><Icon name="arrowRight" size={12} />{a.channel}</span>
                </div>
              </div>
              {firing && <span className="tnum" style={{ fontSize: 12, color: 'var(--red-text)' }}>{a.when}</span>}
              <Badge tone={stMap[a.status].tone} style={firing ? { animation: 'bt-pulse 1.6s ease-in-out infinite' } : {}}>
                <StatusDot status={firing ? 'failed' : a.status === 'resolved' ? 'success' : 'queued'} size={6} />{stMap[a.status].label}
              </Badge>
              <IconButton name="settings" size={15} title="Edit alert" />
            </Card>
          );
        })}
      </div>
    </Page>
  );
}
