import React from 'react';
import { BRAND } from '../theme.js';

export class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch(error, info) {
    console.error('[ErrorBoundary]', error, info);
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div role="alert" style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, background: BRAND.paper, color: BRAND.ink }}>
        <div style={{ maxWidth: 420, background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 12, padding: 32, textAlign: 'center' }}>
          <h1 style={{ fontSize: 20, fontWeight: 700, margin: '0 0 8px' }}>Something went wrong</h1>
          <p style={{ fontSize: 14, color: BRAND.muted, margin: '0 0 16px', lineHeight: 1.5 }}>
            Your saved data is safe. Reload to continue.
          </p>
          <pre style={{ fontSize: 11, color: '#991B1B', background: '#FEE2E2', padding: 10, borderRadius: 6, textAlign: 'left', overflow: 'auto', margin: '0 0 16px' }}>
            {String(this.state.error && this.state.error.message || this.state.error)}
          </pre>
          <button onClick={() => window.location.reload()} className="btn">Reload</button>
        </div>
      </div>
    );
  }
}
