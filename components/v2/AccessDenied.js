/**
 * components/v2/AccessDenied.js — Friendly "you don't have access" surface.
 *
 * Replaces silent `return null` branches in pages/components when a user
 * lacks the required permission. Shows:
 *   - a clear, human message naming the action that was blocked
 *   - the raw permission key (`feature.action`) ONLY for owner/admin so
 *     they can hand it to support without users seeing implementation
 *     detail
 *   - "Go back" and optional "Contact admin" CTAs
 *
 * Side-effect: fire-and-forget POST to /api/audit/permission-denied so the
 * security team has visibility into denial patterns.
 *
 * Usage (inline page guard):
 *   if (!can('reports', 'view')) {
 *     return <AccessDenied feature="reports" action="view" what="view reports" />;
 *   }
 */
import { useEffect, useMemo, useRef } from 'react';
import { useRouter } from 'next/router';
import { useAuth } from '../../lib/AuthContext';

const FRIENDLY = {
  view: 'view',
  edit: 'edit',
  create: 'create',
  delete: 'delete',
  export: 'export',
  approve: 'approve',
  reject: 'reject',
  suspend: 'suspend',
  enroll: 'enroll',
  download: 'download',
  manage: 'manage',
};

function friendlyAction(action) {
  if (!action) return 'do that';
  if (FRIENDLY[action]) return FRIENDLY[action];
  return action.replace(/_/g, ' ');
}

function friendlyFeature(feature) {
  if (!feature) return 'this area';
  return feature.replace(/_/g, ' ');
}

export default function AccessDenied({
  feature,
  action,
  what,
  variant = 'panel', // 'panel' | 'page'
  onBack,
}) {
  const router = useRouter();
  const { role } = useAuth();
  const loggedRef = useRef(false);

  const isPrivileged = role === 'owner' || role === 'admin';
  const description = useMemo(() => {
    if (what) return what;
    return `${friendlyAction(action)} ${friendlyFeature(feature)}`;
  }, [feature, action, what]);

  // Fire-and-forget audit log (best effort — never blocks the UI).
  useEffect(() => {
    if (loggedRef.current) return;
    loggedRef.current = true;
    try {
      fetch('/api/audit/permission-denied', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          feature: feature || null,
          action: action || null,
          path: typeof window !== 'undefined' ? window.location.pathname : null,
          at: new Date().toISOString(),
        }),
        keepalive: true,
      }).catch(() => {});
    } catch {}
  }, [feature, action]);

  const goBack = () => {
    if (typeof onBack === 'function') return onBack();
    if (typeof window !== 'undefined' && window.history.length > 1) {
      router.back();
    } else {
      router.push('/v2');
    }
  };

  const card = (
    <div className="max-w-md w-full bg-white/90 dark:bg-slate-900/80 border border-slate-200 dark:border-slate-800 rounded-2xl p-8 shadow-xl">
      <div className="flex items-center gap-3 mb-4">
        <div className="w-10 h-10 rounded-xl bg-amber-500/15 border border-amber-500/30 flex items-center justify-center">
          <i className="ph ph-lock-key text-2xl text-amber-500 dark:text-amber-400" aria-hidden="true"></i>
        </div>
        <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
          You don&apos;t have access
        </h2>
      </div>
      <p className="text-sm text-slate-700 dark:text-slate-300 mb-2">
        Your account isn&apos;t permitted to <span className="font-medium">{description}</span>.
      </p>
      <p className="text-xs text-slate-500 dark:text-slate-400 mb-4">
        If you need access, please contact a system administrator.
      </p>
      {isPrivileged && feature && action && (
        <p className="text-[11px] font-mono text-slate-500 dark:text-slate-400 bg-slate-100 dark:bg-slate-950/60 border border-slate-200 dark:border-slate-800 rounded-lg px-3 py-2 mb-4">
          Permission key: <span className="text-slate-700 dark:text-slate-300">{feature}.{action}</span>
        </p>
      )}
      <div className="flex gap-2">
        <button
          onClick={goBack}
          className="flex-1 px-4 py-2.5 rounded-lg border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800/60 text-slate-900 dark:text-slate-100 text-sm font-medium transition-colors"
        >
          Go back
        </button>
        <a
          href="mailto:it-support@binus.edu"
          className="flex-1 px-4 py-2.5 rounded-lg bg-brand-500 hover:bg-brand-400 text-slate-950 text-sm font-semibold transition-colors text-center"
        >
          Contact admin
        </a>
      </div>
    </div>
  );

  if (variant === 'page') {
    return (
      <div className="min-h-[60vh] flex items-center justify-center p-6">
        {card}
      </div>
    );
  }
  return (
    <div className="py-12 flex items-center justify-center">
      {card}
    </div>
  );
}
