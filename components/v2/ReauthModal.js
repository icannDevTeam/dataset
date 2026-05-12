/**
 * components/v2/ReauthModal.js — Step-up password prompt.
 *
 * Generic — works for any high-risk action. Caller passes:
 *   onConfirm(token)  — receives a fresh Firebase ID token
 *   onCancel()        — modal dismissed without confirming
 *   title, action     — copy
 */
import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../../lib/AuthContext';
import { getReauthToken } from '../../lib/reauth-client';

export default function ReauthModal({
  open,
  title = 'Confirm your password',
  action = 'continue',
  onConfirm,
  onCancel,
}) {
  const { user } = useAuth();
  const [pw, setPw] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const inputRef = useRef(null);

  useEffect(() => {
    if (open) {
      setPw('');
      setErr(null);
      setBusy(false);
      const t = setTimeout(() => inputRef.current?.focus(), 60);
      return () => clearTimeout(t);
    }
  }, [open]);

  if (!open) return null;

  const submit = async (e) => {
    e?.preventDefault?.();
    if (busy) return;
    setBusy(true); setErr(null);
    try {
      const token = await getReauthToken(pw);
      setBusy(false);
      onConfirm?.(token);
    } catch (ex) {
      setBusy(false);
      setErr(ex.message || 'Re-authentication failed.');
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4"
      onClick={(e) => { if (e.target === e.currentTarget && !busy) onCancel?.(); }}
    >
      <form
        onSubmit={submit}
        className="bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl w-full max-w-md overflow-hidden"
      >
        <div className="px-5 py-4 border-b border-slate-800 flex items-start gap-3">
          <div className="w-10 h-10 rounded-lg bg-amber-500/15 text-amber-300 flex items-center justify-center flex-shrink-0">
            <i className="ph ph-lock-key text-xl" />
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="text-base font-semibold text-white">{title}</h3>
            <p className="text-xs text-slate-400 mt-0.5">
              For your security, please re-enter your password to {action}. This
              event is recorded in the audit log.
            </p>
          </div>
        </div>

        <div className="px-5 py-4 space-y-3">
          <div>
            <label className="block text-[10px] uppercase tracking-wider text-slate-500 mb-1">Signed in as</label>
            <div className="text-sm text-slate-300 font-mono truncate">{user?.email || '—'}</div>
          </div>
          <div>
            <label className="block text-[10px] uppercase tracking-wider text-slate-500 mb-1" htmlFor="reauth-pw">
              Password
            </label>
            <input
              ref={inputRef}
              id="reauth-pw"
              type="password"
              autoComplete="current-password"
              value={pw}
              onChange={(e) => setPw(e.target.value)}
              disabled={busy}
              className="w-full text-sm bg-slate-950 border border-slate-700 focus:border-amber-500 focus:outline-none rounded-lg px-3 py-2 text-white"
              placeholder="••••••••"
            />
          </div>
          {err && (
            <div className="text-xs rounded px-2 py-1.5 bg-rose-500/10 text-rose-300 border border-rose-500/30 flex items-start gap-1.5">
              <i className="ph ph-warning-circle mt-0.5" /> <span>{err}</span>
            </div>
          )}
        </div>

        <div className="px-5 py-3 border-t border-slate-800 bg-slate-950/60 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="px-3 py-1.5 text-xs font-medium text-slate-300 hover:text-white border border-slate-700 hover:border-slate-500 hover:bg-slate-800 rounded-lg disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy || !pw}
            className="px-3 py-1.5 text-xs font-semibold rounded-lg text-white bg-amber-600 hover:bg-amber-500 flex items-center gap-1.5 disabled:opacity-50"
          >
            {busy
              ? (<><i className="ph ph-circle-notch animate-spin" /> Verifying…</>)
              : (<><i className="ph ph-lock-key" /> Confirm</>)}
          </button>
        </div>
      </form>
    </div>
  );
}
