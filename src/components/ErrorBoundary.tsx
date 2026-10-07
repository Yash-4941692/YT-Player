import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Home, Info, RefreshCw } from 'lucide-react';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Catches render errors anywhere below it so a single broken component shows a calm
 * reload screen instead of a blank white page. Purely additive: it renders `children`
 * untouched while nothing is wrong, and keeps every saved lesson in localStorage/browser
 * storage — reloading the page is always safe.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Keeps the technical detail available in the browser console for debugging.
    console.error('Focusframe hit an unexpected error:', error, info.componentStack);
  }

  private reload = () => {
    window.location.reload();
  };

  private dismiss = () => {
    this.setState({ error: null });
  };

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="error-screen" role="alert">
        <div className="error-screen-card glass-card">
          <span className="error-screen-mark">!</span>
          <p className="eyebrow">SOMETHING WENT WRONG</p>
          <h1>This page hit a problem</h1>
          <p className="error-screen-copy">
            Nothing you saved is lost — your lessons, progress, timestamps and PDFs are still stored.
            Reloading the page usually fixes it.
          </p>
          <div className="error-screen-actions">
            <button className="button-primary" onClick={this.reload}><RefreshCw size={15} /> Reload the page</button>
            <button className="button-quiet" onClick={this.dismiss}><Home size={15} /> Try to continue</button>
          </div>
          <details className="error-screen-details">
            <summary><Info size={13} /> Technical details</summary>
            <pre>{error.message || String(error)}</pre>
          </details>
          <p className="error-screen-hint">
            Still stuck? Reload once more, then open the PDF library or a lesson again. If it keeps
            happening, send these technical details to whoever looks after the site.
          </p>
        </div>
      </div>
    );
  }
}
