/* =============================================================================
   Better Trigger — Deployments. No server API yet (/api/v1/deployments);
   renders a coming-soon empty state until it exists.
   ============================================================================= */
import { Icon } from '../components/primitives';
import { Page, Card, SectionHead } from '../components/Layout';

export function Deployments() {
  return (
    <Page>
      <SectionHead title="Deployments" sub="Every push builds a versioned, immutable deploy." />
      <Card style={{ padding: '64px 24px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, textAlign: 'center' }}>
        <div style={{
          width: 44, height: 44, borderRadius: 11, display: 'grid', placeItems: 'center',
          background: 'var(--accent-fill)', color: 'var(--accent)',
        }}>
          <Icon name="rocket" size={20} />
        </div>
        <div style={{ fontSize: 14, fontWeight: 600 }}>Deployments are coming soon</div>
        <div style={{ fontSize: 12.5, color: 'var(--fg-subtle)', maxWidth: 380 }}>
          Track versioned deploys per environment, with build status and one-click rollback.
        </div>
      </Card>
    </Page>
  );
}
