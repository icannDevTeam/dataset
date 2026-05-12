/**
 * components/v2/ReauthGate.jsx — Step-up password prompt.
 *
 * Usage:
 *   const { requireReauth, reauthModal } = useReauthGate();
 *   ...
 *   const onExport = async () => {
 *     const token = await requireReauth({ action: 'Export attendance CSV' });
 *     if (!token) return;             // user cancelled
 *     await fetch('/api/...', { headers: { 'X-Reauth-Token': token }});
 *   };
 *   ...
 *   return (<>{reauthModal}<button onClick={onExport}>…</button></>);
 *
 * The hook caches the verified token in module-scope memory for ~4 min so
 * a parent who clicks Export → Print → CSV in quick succession is only
 * prompted once. Every successful re-auth is also audit-logged server-side
 * via /api/audit/log-export when used through the standard helper.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { getReauthToken as getCachedToken, setReauthToken } from '../../lib/reauth-cache';
import { getReauthToken as fetchReauthToken } from '../../lib/reauth-client';

export function useReauthGate() {
  const [open, setOpen] = useState(false);
  const [action, setAction] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const resolverRef = useRef(null); // pending Promise resolver
  const inputRef = useRef(null);

  // Resolve the pending Promise + close.
  const finish = useCallback((token) => {
    setOpen(false);
    setBusy(false);
    setError(null);
    setPassword('');
    const r = resolverRef.current;
    resolverRef.current = null;
    if (r) r(token);
  }, []);

  // Public API — returns Promise<token|null>. null = user cancelled.
  const requireReauth = useCallback(({ action: label = 'Continue', forceFresh = false } = {}) => {
    // Honor cache unless caller forces fresh.
    if (!forceFresh) {
      const cached = getCachedToken();
      if (cached) return Promise.resolve(cached);
    }
    return new Promise((resolve) => {
      resolverRef.current = resolve;
      setAction(label || 'Continue');
      setPassword('');
      setError(null);
      setOpen(true);
      // Focus on next tick when input is mounted.
      setTimeout(() => { try { inputRef.current?.focus(); } catch {} }, 50);
    });
  }, []);

  const submit = useCallback(async (e) => {
    if (e) e.preventDefault();
    if (busy) return;
    if (!password) { setError('Password is required.'); return; }
    setBusy(true); setError(null);
    try {
      const token = await fetchReauthToken(password);
      setReauthToken(token);
      finish(token);
    } catch (err) {
      setError(err?.message || 'Re-authentication failed.');
      setBusy(false);
    }
  }, [busy, password, finish]);

  const cancel = useCallback(() => {
    if (busy) return; // don't allow cancel mid-verify
    finish(null);
  }, [busy, finish]);

  // Esc to cancel.
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === 'Escape') cancel(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, cancel]);

  const reauthModal = open ? (
    <div className="fixed inset-0 z-[60] bg-slate-950/85 backdrop-blur-sm flex items-center justify-center p-4">
      <form
        onSubmit={submit}
        className="bg-slate-900 border border-slate-800 rounded-2xl shadow-2xl w-full max-w-md overflow-hidden"
      >
        <div className="px-6 py-4 border-b border-slate-800 flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-amber-500/15 border border-amber-500/30 flex items-center justify-center">
            <i className="ph ph-shield-check text-amber-300 text-xl"></i>
          </div>
          <div>
            <div className="text-white font-semibold">Confirm your password</div>
            <div className="text-xs text-slate-400">Required for: {action}</div>
          </div>
        </div>
        <div className="px-6 py-5 space-y-3">
          <p className="text-sm text-slate-300 leading-relaxed">
            For audit purposes, downloads and exports require a password
            re-confirmation. Your re-confirmation is logged with your account.
          </p>
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wider text-slate-500 mb-1">
              Password
            </label>
            <input
              ref={inputRef}
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              disabled={busy}
              className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-600 focus:border-emerald-500 focus:outline-none"
              placeholder="Enter your account password"
            />
          </div>
          {error && (
            <div className="text-xs px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/30 text-red-300">
              {error}
            </div>
          )}
        </div>
        <div className="px-6 py-3 border-t border-slate-800 flex items-center justify-end gap-2 bg-slate-900/60">
          <button
            type="button"
            onClick={cancel}
            disabled={busy}
            className="px-4 py-2 text-sm text-slate-400 hover:text-white rounded-lg disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy || !password}
            className="px-4 py-2 bg-emerald-500 hover:bg-emerald-400 text-slate-950 rounded-lg text-sm font-semibold disabled:opacity-50"
          >
            {busy ? 'Verifying…' : 'Confirm & continue'}
          </button>
        </div>
      </form>
    </div>
  ) : null;

  return { requireReauth, reauthModal };
}
