/* =============================================================================
   Better Trigger — Alerts. No server API yet (/api/v1/alerts); renders a
   coming-soon empty state until it exists.
   ============================================================================= */
import { Icon } from '../components/primitives';
import { Page, Card, SectionHead } from '../components/Layout';

export function Alerts() {
  return (
    <Page>
      <SectionHead title="Alerts" sub="Get notified when runs fail, slow down, or deployments break." />
      <Card style={{ padding: '64px 24px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, textAlign: 'center' }}>
        <div style={{
          width: 44, height: 44, borderRadius: 11, display: 'grid', placeItems: 'center',
          background: 'var(--fill)', color: 'var(--fg-subtle)',
        }}>
          <Icon name="bell" size={20} />
        </div>
        <div style={{ fontSize: 14, fontWeight: 600 }}>Alerts are coming soon</div>
        <div style={{ fontSize: 12.5, color: 'var(--fg-subtle)', maxWidth: 380 }}>
          Define rules on failure rate, latency, or deploy status and route them to Slack, email, or PagerDuty.
        </div>
      </Card>
    </Page>
  );
}
