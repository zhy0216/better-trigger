/* =============================================================================
   Better Trigger — top-level error boundary.

   A single malformed payload (e.g. a run detail that crashes adaptRunDetail)
   used to blank the whole screen: an uncaught render error unmounts the tree.
   This catches it and shows the existing ErrorState plus a reload affordance,
   so one bad response degrades to a recoverable panel instead of a white page.
   ============================================================================= */
import React from 'react';
import { Button } from './primitives';
import { ErrorState } from './Layout';

interface State {
  error: Error | null;
}

export class ErrorBoundary extends React.Component<{ children: React.ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  render(): React.ReactNode {
    if (this.state.error) {
      return (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', padding: 24 }}>
          <ErrorState message={this.state.error.message} />
          <Button variant="outline" icon="restart" onClick={() => window.location.reload()}>
            Reload
          </Button>
        </div>
      );
    }
    return this.props.children;
  }
}
