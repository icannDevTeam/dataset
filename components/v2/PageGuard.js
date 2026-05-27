/**
 * components/v2/PageGuard.js — Inline RBAC guard that preserves the sidebar.
 *
 * Use this when you want the V2Layout chrome (sidebar / topbar) to remain
 * visible even when the user lacks permission for the page body. The
 * `<AccessDenied>` panel renders inside the layout so the user can still
 * navigate elsewhere.
 *
 * Usage:
 *   <V2Layout>
 *     <PageGuard feature="reports" action="view" what="view reports">
 *       <ActualPageContent />
 *     </PageGuard>
 *   </V2Layout>
 *
 * Or for pages already inside V2Layout via getLayout:
 *   return (
 *     <PageGuard feature="pickup_admin" action="view">
 *       {body}
 *     </PageGuard>
 *   );
 */
import { useAuth } from '../../lib/AuthContext';
import AccessDenied from './AccessDenied';

export default function PageGuard({ feature, action = 'view', what, children, fallback }) {
  const { loading, authorized, can } = useAuth();

  if (loading) {
    return (
      <div className="min-h-[40vh] flex items-center justify-center text-slate-400 text-sm">
        <span className="inline-flex items-center gap-2">
          <span className="w-3 h-3 rounded-full bg-brand-500/60 animate-pulse"></span>
          Checking access…
        </span>
      </div>
    );
  }

  if (!authorized) {
    return fallback ?? <AccessDenied feature={feature} action={action} what={what} variant="panel" />;
  }

  if (feature && !can(feature, action)) {
    return fallback ?? <AccessDenied feature={feature} action={action} what={what} variant="panel" />;
  }

  return children;
}
