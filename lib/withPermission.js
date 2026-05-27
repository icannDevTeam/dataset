/**
 * lib/withPermission.js — Page-level RBAC guard.
 *
 * Wraps a Next.js page so that, once the auth state has resolved, the user
 * either sees the page (when `can(feature, action)` returns true) or a
 * friendly `<AccessDenied>` panel. While auth is still loading we render a
 * lightweight skeleton instead of a blank screen.
 *
 * Why a HOC instead of inline checks?
 *   - Keeps page bodies focused on the happy path.
 *   - Guarantees every guarded page also logs the denial (via AccessDenied).
 *   - One place to evolve the "you don't have access" UX.
 *
 * Usage:
 *   import withPermission from '../../lib/withPermission';
 *   function ReportsPage() { ... }
 *   export default withPermission(ReportsPage, { feature: 'reports', action: 'view', what: 'view reports' });
 *
 * Notes:
 *   - This runs purely in the client; the API layer is still the source of
 *     truth for authorization. The guard is UX, not security.
 *   - For pages with a custom `getLayout`, that layout is preserved.
 */
import React from 'react';
import { useAuth } from './AuthContext';
import AccessDenied from '../components/v2/AccessDenied';

function GuardLoading() {
  return (
    <div className="min-h-[40vh] flex items-center justify-center text-slate-400 text-sm">
      <span className="inline-flex items-center gap-2">
        <span className="w-3 h-3 rounded-full bg-brand-500/60 animate-pulse"></span>
        Checking access…
      </span>
    </div>
  );
}

export default function withPermission(Component, opts = {}) {
  const {
    feature,
    action = 'view',
    what,
    variant = 'page',
    // If true, also require an authenticated session — pages where unauth
    // users could hit it directly (e.g., deep links from emails).
    requireAuth = true,
  } = opts;

  function Guarded(props) {
    const { loading, authorized, can } = useAuth();

    if (loading) return <GuardLoading />;

    if (requireAuth && !authorized) {
      // _app.js already redirects unauthenticated users to /login, but as a
      // belt-and-braces guard we render the friendly panel so the page body
      // never executes with a null user.
      return <AccessDenied feature={feature} action={action} what={what} variant={variant} />;
    }

    if (feature && !can(feature, action)) {
      return <AccessDenied feature={feature} action={action} what={what} variant={variant} />;
    }

    return <Component {...props} />;
  }

  // Preserve next.js page-level metadata (getLayout, etc.).
  if (Component.getLayout) Guarded.getLayout = Component.getLayout;
  Guarded.displayName = `withPermission(${Component.displayName || Component.name || 'Page'})`;
  return Guarded;
}
