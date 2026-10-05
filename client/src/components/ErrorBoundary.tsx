import { Component, ErrorInfo, ReactNode } from 'react';
import { IconAlert } from '../motion/Icons';

/* ============================================================================
   ErrorBoundary — one failing panel must never blank the trading desk.
   Chart libraries, canvas contexts and exotic browser APIs can all throw; the
   boundary keeps the rest of the dashboard alive and offers a retry.
   ========================================================================== */

interface Props {
  children: ReactNode;
  label?: string;
  compact?: boolean;
}

interface State {
  error: Error | null;
}

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // keep a breadcrumb for the browser console without breaking the UI
    console.error(`[VelocityX] ${this.props.label ?? 'panel'} failed:`, error, info?.componentStack);
  }

  private reset = () => this.setState({ error: null });

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <section className="panel" style={{ padding: 16 }}>
        <div className="panel-title" style={{ color: 'var(--amber)', marginBottom: 8 }}>
          <span className="ico" style={{ color: 'var(--amber)' }}>
            <IconAlert />
          </span>
          {this.props.label ?? 'Panel'} unavailable
        </div>
        <p className="hint" style={{ marginBottom: 10 }}>
          This module hit a runtime error, so it has been isolated. The engine, auto-trading and every other panel keep
          running normally.
        </p>
        <code
          className="hint"
          style={{
            display: 'block',
            padding: '8px 10px',
            borderRadius: 'var(--r-s)',
            background: 'rgba(0,0,0,.3)',
            border: '1px solid var(--stroke-1)',
            marginBottom: 12,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
        >
          {error.message || String(error)}
        </code>
        <button className="btn sm primary" onClick={this.reset}>
          Try again
        </button>
      </section>
    );
  }
}
