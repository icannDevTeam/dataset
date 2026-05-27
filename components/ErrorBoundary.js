/**
 * components/ErrorBoundary.js — Catches uncaught React render errors and
 * shows a friendly fallback instead of a blank white page.
 *
 * Mounted at the app root in pages/_app.js.
 */
import React from 'react';

export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // eslint-disable-next-line no-console
    console.error('[ErrorBoundary]', error, info?.componentStack);
  }

  handleReload = () => {
    this.setState({ error: null });
    if (typeof window !== 'undefined') window.location.reload();
  };

  handleHome = () => {
    if (typeof window !== 'undefined') window.location.href = '/v2';
  };

  render() {
    if (!this.state.error) return this.props.children;

    const msg = this.state.error?.message || 'An unexpected error occurred.';
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-950 dark:bg-slate-950 text-slate-100 p-6">
        <div className="max-w-lg w-full bg-slate-900/80 dark:bg-slate-900/80 border border-slate-800 rounded-2xl p-8 shadow-2xl">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-10 h-10 rounded-xl bg-red-500/15 border border-red-500/30 flex items-center justify-center">
              <i className="ph ph-warning-octagon text-2xl text-red-400" aria-hidden="true"></i>
            </div>
            <h1 className="text-lg font-semibold">Something went wrong</h1>
          </div>
          <p className="text-sm text-slate-300 mb-2">
            The page crashed while rendering. You can try reloading or return to the dashboard.
          </p>
          <pre className="text-[11px] leading-snug bg-slate-950/70 border border-slate-800 rounded-lg p-3 max-h-40 overflow-auto text-slate-400 whitespace-pre-wrap break-words">
            {msg}
          </pre>
          <div className="mt-6 flex gap-2">
            <button
              onClick={this.handleReload}
              className="flex-1 px-4 py-2.5 rounded-lg bg-brand-500 hover:bg-brand-400 text-slate-950 text-sm font-semibold transition-colors"
            >
              Reload page
            </button>
            <button
              onClick={this.handleHome}
              className="flex-1 px-4 py-2.5 rounded-lg border border-slate-700 hover:border-slate-600 hover:bg-slate-800/60 text-slate-100 text-sm font-medium transition-colors"
            >
              Go to dashboard
            </button>
          </div>
        </div>
      </div>
    );
  }
}
