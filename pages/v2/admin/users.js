/**
 * /v2/admin/users — Firebase Auth user directory + Owner/Admin password reset.
 *
 * Hard gates
 *   • Page render        : sensitive_user_access.view_user_directory
 *   • 3-dot menu visible : sensitive_user_access.reset_user_password
 *   • Submit reset       : server requires the same permission + a fresh
 *                          re-auth token (maxAgeSec 120) + a strong password.
 *
 * The page is intentionally read-mostly. No invite / role-change controls
 * live here — those stay in /v2/admin/rbac. This screen exists so an Owner
 * or designated Admin can locate a real auth user and reset their password
 * in one place.
 *
 * Reset workflow
 *   1. Open row menu → "Reset password…" → modal.
 *   2. Owner types + confirms a new password. Live strength meter shows
 *      which of the 5 server-side rules are still missing. Submit stays
 *      disabled until every rule is green AND the two fields match.
 *   3. On submit, requireReauth() prompts for the Owner's own password
 *      (via the shared ReauthGate). The resulting X-Reauth-Token is sent
 *      with the POST.
 *   4. Server validates again (defence in depth), updates Firebase Auth,
 *      revokes the target's sessions, flags `mustChangePassword: true`,
 *      and writes an audit log entry. The new password is NEVER logged.
 *   5. UI banner reminds the Owner that the user is NOT notified — they
 *      must communicate the new credential through a secure side channel.
 */
import Head from 'next/head';
import { useCallback, useEffect, useMemo, useState } from 'react';
import AdminLayout from '../../../components/v2/AdminLayout';
import { useAuth } from '../../../lib/AuthContext';
import { useReauthGate } from '../../../components/v2/ReauthGate';
import rbac from '../../../lib/rbac';

const { can } = rbac;

// ── Password policy (must mirror the server-side rules in
//    /pages/api/v2/admin/users/[uid]/reset-password.js). ─────────────
const PASSWORD_RULES = [
  { key: 'length', label: 'At least 12 characters',           test: (v) => v.length >= 12 },
  { key: 'upper',  label: 'At least one uppercase letter',    test: (v) => /[A-Z]/.test(v) },
  { key: 'lower',  label: 'At least one lowercase letter',    test: (v) => /[a-z]/.test(v) },
  { key: 'digit',  label: 'At least one digit',               test: (v) => /[0-9]/.test(v) },
  { key: 'symbol', label: 'At least one symbol (e.g. !@#$%)', test: (v) => /[^A-Za-z0-9\s]/.test(v) },
  { key: 'nows',   label: 'No whitespace characters',         test: (v) => v.length > 0 && !/\s/.test(v) },
];

const ROLE_TONE = {
  owner:  'bg-amber-500/10 text-amber-300 border-amber-500/30',
  admin:  'bg-indigo-500/10 text-indigo-300 border-indigo-500/30',
  guard:  'bg-sky-500/10 text-sky-300 border-sky-500/30',
  viewer: 'bg-slate-500/10 text-slate-300 border-slate-500/30',
};

function formatTimestamp(iso) {
  if (!iso) return 'Never';
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return 'Unknown';
    return d.toLocaleString();
  } catch {
    return 'Unknown';
  }
}

// Page is wrapped in AdminLayout; we early-return an access-denied panel
// before fetching anything if the caller lacks view_user_directory.
export default function AdminUsersPage() {
  const { user, permissions, role } = useAuth();
  const canView  = can(permissions, 'sensitive_user_access.view_user_directory');
  const canReset = can(permissions, 'sensitive_user_access.reset_user_password');

  if (!canView) {
    return (
      <AdminLayout title="Users" subtitle="Firebase Auth directory">
        <Head><title>Users · Admin</title></Head>
        <AccessDenied
          title="You don't have access to this page"
          message="The Users directory is part of Sensitive User Access. Only Owners — or admins explicitly granted view_user_directory — can open it."
          currentRole={role}
        />
      </AdminLayout>
    );
  }

  return (
    <AdminLayout title="Users" subtitle="Firebase Auth directory · Owner/Admin password reset (permission-gated)" fullBleed>
      <Head><title>Users · Admin</title></Head>
      <UsersDirectory canReset={canReset} currentUser={user} />
    </AdminLayout>
  );
}

// ── Directory ──────────────────────────────────────────────────────────────
function UsersDirectory({ canReset, currentUser }) {
  const [users, setUsers] = useState([]);
  const [pageStack, setPageStack] = useState([null]); // history of pageTokens
  const [nextPageToken, setNextPageToken] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [search, setSearch] = useState('');
  const [menuFor, setMenuFor] = useState(null); // uid
  const [resetTarget, setResetTarget] = useState(null);
  const [toast, setToast] = useState(null);

  const getAuthHeaders = useCallback(async () => {
    if (!currentUser) return {};
    const token = await currentUser.getIdToken();
    return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
  }, [currentUser]);

  const fetchPage = useCallback(async (pageToken) => {
    setLoading(true); setLoadError('');
    try {
      const headers = await getAuthHeaders();
      const qs = pageToken ? `?pageToken=${encodeURIComponent(pageToken)}` : '';
      const res = await fetch(`/api/v2/admin/users/list${qs}`, { headers });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setLoadError(data.error || `Request failed (${res.status}).`);
        setUsers([]);
        setNextPageToken(null);
        return;
      }
      setUsers(Array.isArray(data.users) ? data.users : []);
      setNextPageToken(data.nextPageToken || null);
    } catch (err) {
      setLoadError(err?.message || 'Network error.');
    } finally {
      setLoading(false);
    }
  }, [getAuthHeaders]);

  useEffect(() => {
    fetchPage(pageStack[pageStack.length - 1]);
  }, [fetchPage, pageStack]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return users;
    return users.filter((u) =>
      (u.email || '').toLowerCase().includes(q) ||
      (u.displayName || '').toLowerCase().includes(q) ||
      (u.uid || '').toLowerCase().includes(q)
    );
  }, [users, search]);

  // Close row menu on outside click.
  useEffect(() => {
    if (!menuFor) return;
    const onClick = () => setMenuFor(null);
    window.addEventListener('click', onClick);
    return () => window.removeEventListener('click', onClick);
  }, [menuFor]);

  function showToast(msg, tone = 'success') {
    setToast({ msg, tone });
    setTimeout(() => setToast(null), 3500);
  }

  return (
    <div className="h-full flex flex-col min-h-0">
      {/* Persistent owner-only banner */}
      <div className="px-4 lg:px-6 pt-4">
        <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 text-amber-100 px-4 py-3 text-sm flex items-start gap-3">
          <i className="ph ph-shield-warning text-amber-300 text-xl mt-0.5" />
          <div className="space-y-0.5">
            <div className="font-semibold text-amber-200">Sensitive User Access — granted by Owner only</div>
            <div className="text-xs text-amber-200/80 leading-relaxed">
              Resetting a password bypasses the user. <strong>They will not be notified.</strong>
              Communicate the new password through a secure side channel (in-person, encrypted IM)
              and require them to change it on first sign-in.
            </div>
          </div>
        </div>
      </div>

      {/* Toolbar */}
      <div className="px-4 lg:px-6 pt-4 flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[220px] max-w-md">
          <i className="ph ph-magnifying-glass absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 text-sm" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by name, email or UID"
            className="w-full pl-9 pr-3 py-2 text-sm bg-slate-900/60 border border-slate-700/60 rounded-lg text-white placeholder:text-slate-500 focus:outline-none focus:border-brand-500"
          />
        </div>
        <button
          onClick={() => fetchPage(pageStack[pageStack.length - 1])}
          className="inline-flex items-center gap-1.5 px-3 py-2 text-xs text-slate-300 hover:text-white border border-slate-700 rounded-lg hover:bg-slate-800 transition-colors"
        >
          <i className="ph ph-arrow-clockwise" /> Refresh
        </button>
        <div className="ml-auto text-xs text-slate-500">
          {loading ? 'Loading…' : `${filtered.length} of ${users.length} on this page`}
        </div>
      </div>

      {/* Table */}
      <div className="flex-1 overflow-auto px-4 lg:px-6 pt-3 pb-4 min-h-0">
        {loadError && (
          <div className="rounded-xl border border-red-500/40 bg-red-500/10 text-red-200 px-4 py-3 text-sm mb-3">
            {loadError}
          </div>
        )}
        <div className="rounded-xl border border-slate-800 bg-slate-950/40 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-900/60 text-[10px] uppercase tracking-widest text-slate-500">
              <tr>
                <th className="text-left font-semibold px-4 py-3">User</th>
                <th className="text-left font-semibold px-4 py-3 hidden md:table-cell">Role</th>
                <th className="text-left font-semibold px-4 py-3 hidden lg:table-cell">Last sign-in</th>
                <th className="text-right font-semibold px-4 py-3 w-12">{/* row menu */}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/80">
              {!loading && filtered.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-4 py-10 text-center text-slate-500 text-sm">
                    No users match the current filter.
                  </td>
                </tr>
              )}
              {filtered.map((u) => {
                const tone = ROLE_TONE[u.role] || ROLE_TONE.viewer;
                const isMe = !!currentUser?.email && u.email === currentUser.email.toLowerCase();
                const initials = (u.displayName || u.email || '?').trim().charAt(0).toUpperCase();
                return (
                  <tr key={u.uid} className="hover:bg-slate-900/40 transition-colors">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        <div className="w-9 h-9 rounded-full bg-brand-500/15 text-brand-300 border border-brand-500/30 flex items-center justify-center text-sm font-semibold flex-shrink-0">
                          {initials}
                        </div>
                        <div className="min-w-0">
                          <div className="text-sm font-medium text-white truncate flex items-center gap-2">
                            {u.displayName || <span className="text-slate-500 italic">No name</span>}
                            {isMe && (
                              <span className="text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-slate-800 text-slate-400 border border-slate-700">You</span>
                            )}
                            {u.disabled && (
                              <span className="text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-red-500/10 text-red-300 border border-red-500/30">Disabled</span>
                            )}
                          </div>
                          <div className="text-xs text-slate-500 truncate">{u.email || '—'}</div>
                          <div className="text-[10px] text-slate-600 font-mono truncate md:hidden">{u.uid}</div>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3 hidden md:table-cell">
                      <span className={`inline-block text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded border ${tone}`}>
                        {u.role}
                      </span>
                    </td>
                    <td className="px-4 py-3 hidden lg:table-cell text-xs text-slate-400">
                      {formatTimestamp(u.lastSignInTime)}
                    </td>
                    <td className="px-2 py-3 text-right relative">
                      {canReset && (
                        <button
                          onClick={(e) => { e.stopPropagation(); setMenuFor(menuFor === u.uid ? null : u.uid); }}
                          aria-label="Row actions"
                          className="inline-flex items-center justify-center w-8 h-8 rounded-lg text-slate-500 hover:text-white hover:bg-slate-800 transition-colors"
                        >
                          <i className="ph ph-dots-three-vertical text-lg" />
                        </button>
                      )}
                      {menuFor === u.uid && (
                        <div
                          onClick={(e) => e.stopPropagation()}
                          className="absolute right-2 top-full z-30 mt-1 w-56 rounded-lg bg-slate-900 border border-slate-700 shadow-2xl py-1"
                        >
                          <button
                            onClick={() => { setMenuFor(null); setResetTarget(u); }}
                            disabled={isMe}
                            className="w-full text-left px-3 py-2 text-sm text-slate-200 hover:bg-slate-800 disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-2"
                            title={isMe ? 'Use Change Password in your account settings' : ''}
                          >
                            <i className="ph ph-key text-amber-300" />
                            Reset password…
                          </button>
                          {isMe && (
                            <div className="px-3 py-1.5 text-[10px] text-slate-500 leading-snug border-t border-slate-800 mt-1">
                              You cannot reset your own password here. Use Change Password instead.
                            </div>
                          )}
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        <div className="mt-3 flex items-center justify-between text-xs text-slate-400">
          <div>
            Page {pageStack.length}
          </div>
          <div className="flex items-center gap-2">
            <button
              disabled={pageStack.length <= 1 || loading}
              onClick={() => setPageStack((s) => s.slice(0, -1))}
              className="px-3 py-1.5 rounded-lg border border-slate-700 text-slate-300 hover:bg-slate-800 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              ← Previous
            </button>
            <button
              disabled={!nextPageToken || loading}
              onClick={() => setPageStack((s) => [...s, nextPageToken])}
              className="px-3 py-1.5 rounded-lg border border-slate-700 text-slate-300 hover:bg-slate-800 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Next →
            </button>
          </div>
        </div>
      </div>

      {/* Reset modal */}
      {resetTarget && (
        <ResetPasswordModal
          target={resetTarget}
          currentUser={currentUser}
          getAuthHeaders={getAuthHeaders}
          onClose={() => setResetTarget(null)}
          onSuccess={(t) => {
            setResetTarget(null);
            showToast(`Password reset for ${t.email || t.uid}. User was not notified.`, 'success');
          }}
        />
      )}

      {/* Toast */}
      {toast && (
        <div className="fixed bottom-6 right-6 z-[80] max-w-sm">
          <div
            role="status"
            className={`rounded-xl border shadow-2xl px-4 py-3 text-sm ${
              toast.tone === 'error'
                ? 'bg-red-500/15 border-red-500/40 text-red-100'
                : 'bg-emerald-500/15 border-emerald-500/40 text-emerald-100'
            }`}
          >
            {toast.msg}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Access-denied panel ────────────────────────────────────────────────────
function AccessDenied({ title, message, currentRole }) {
  return (
    <div className="p-6 lg:p-10 max-w-2xl mx-auto">
      <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-8 text-center space-y-4">
        <div className="mx-auto w-14 h-14 rounded-2xl bg-amber-500/10 border border-amber-500/30 flex items-center justify-center">
          <i className="ph ph-lock-key text-amber-300 text-3xl" />
        </div>
        <h2 className="text-xl font-semibold text-white">{title}</h2>
        <p className="text-sm text-slate-400 leading-relaxed">{message}</p>
        {currentRole && (
          <div className="text-xs text-slate-500">
            Your current role: <span className="font-mono text-slate-300">{currentRole}</span>
          </div>
        )}
        <div className="text-xs text-slate-500 pt-2 border-t border-slate-800/60">
          If you believe you should have access, ask an Owner to grant
          <span className="font-mono text-slate-300"> sensitive_user_access.view_user_directory </span>
          under your user in the RBAC console.
        </div>
      </div>
    </div>
  );
}

// ── Reset modal ────────────────────────────────────────────────────────────
function ResetPasswordModal({ target, currentUser, getAuthHeaders, onClose, onSuccess }) {
  const { requireReauth, reauthModal } = useReauthGate();
  const [pw1, setPw1] = useState('');
  const [pw2, setPw2] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const ruleResults = useMemo(
    () => PASSWORD_RULES.map((r) => ({ ...r, passed: r.test(pw1) })),
    [pw1]
  );
  const allPassed = ruleResults.every((r) => r.passed);
  const matches = pw1.length > 0 && pw1 === pw2;
  const canSubmit = allPassed && matches && !busy;
  const isSelf = !!currentUser?.email && (target.email || '').toLowerCase() === currentUser.email.toLowerCase();

  const submit = async (reauthToken) => {
    setBusy(true); setErr('');
    try {
      const headers = await getAuthHeaders();
      const res = await fetch(`/api/v2/admin/users/${encodeURIComponent(target.uid)}/reset-password`, {
        method: 'POST',
        headers: {
          ...headers,
          ...(reauthToken ? { 'X-Reauth-Token': reauthToken } : {}),
        },
        body: JSON.stringify({ newPassword: pw1 }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        onSuccess(target);
        return;
      }
      // If the cached reauth token is stale, force a fresh prompt and retry once.
      if (res.status === 401 && /^reauth_/.test(data.error || '')) {
        const fresh = await requireReauth({ action: 'Reset another user’s password', forceFresh: true });
        if (!fresh) { setErr('Re-authentication cancelled.'); setBusy(false); return; }
        return submit(fresh);
      }
      if (res.status === 403 && data.error === 'cannot_self_reset') {
        setErr(data.message || 'You cannot reset your own password here.');
      } else if (res.status === 400 && data.error === 'weak_password') {
        setErr(`Password rejected by server (${data.reason || 'weak'}).`);
      } else if (res.status === 423) {
        setErr(data.message || 'Too many failed attempts. Try again later.');
      } else {
        setErr(data.message || data.error || `Request failed (${res.status}).`);
      }
    } catch (e) {
      setErr(e?.message || 'Network error.');
    } finally {
      setBusy(false);
    }
  };

  const onSubmit = async (e) => {
    e.preventDefault();
    if (!canSubmit) return;
    if (isSelf) { setErr('You cannot reset your own password here.'); return; }
    const token = await requireReauth({ action: `Reset password for ${target.email || target.uid}` });
    if (!token) { setErr('Re-authentication cancelled.'); return; }
    submit(token);
  };

  return (
    <>
      {reauthModal}
      <div className="fixed inset-0 z-[70] bg-slate-950/85 backdrop-blur-sm flex items-center justify-center p-4">
        <form
          onSubmit={onSubmit}
          className="bg-slate-900 border border-slate-800 rounded-2xl shadow-2xl w-full max-w-lg overflow-hidden"
        >
          {/* Header */}
          <div className="px-6 py-4 border-b border-slate-800 flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-amber-500/15 border border-amber-500/30 flex items-center justify-center flex-shrink-0">
              <i className="ph ph-key text-amber-300 text-xl" />
            </div>
            <div className="min-w-0">
              <div className="text-white font-semibold truncate">Reset password</div>
              <div className="text-xs text-slate-400 truncate">
                {target.displayName ? `${target.displayName} · ` : ''}{target.email || target.uid}
              </div>
            </div>
          </div>

          {/* Persistent warning banner */}
          <div className="px-6 pt-4">
            <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 text-amber-100 px-3 py-2 text-xs leading-relaxed">
              <strong className="text-amber-200">User will not be notified.</strong> Communicate the new
              password through a secure side channel (in-person, encrypted IM). The user’s active
              sessions will be revoked immediately and they will be forced to change the password
              on next sign-in.
            </div>
          </div>

          {/* Inputs */}
          <div className="px-6 py-4 space-y-4">
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider text-slate-500 mb-1">
                New password
              </label>
              <div className="relative">
                <input
                  type={show ? 'text' : 'password'}
                  value={pw1}
                  onChange={(e) => setPw1(e.target.value)}
                  autoComplete="new-password"
                  disabled={busy}
                  className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 pr-10 text-sm text-white placeholder-slate-600 focus:border-brand-500 focus:outline-none font-mono"
                  placeholder="Min 12 chars · upper · lower · digit · symbol"
                />
                <button
                  type="button"
                  onClick={() => setShow((s) => !s)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-200"
                  tabIndex={-1}
                  aria-label={show ? 'Hide password' : 'Show password'}
                >
                  <i className={`ph ${show ? 'ph-eye-slash' : 'ph-eye'} text-base`} />
                </button>
              </div>
            </div>
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider text-slate-500 mb-1">
                Confirm new password
              </label>
              <input
                type={show ? 'text' : 'password'}
                value={pw2}
                onChange={(e) => setPw2(e.target.value)}
                autoComplete="new-password"
                disabled={busy}
                className={`w-full bg-slate-800 border rounded-lg px-3 py-2 text-sm text-white placeholder-slate-600 focus:outline-none font-mono ${
                  pw2.length > 0 && !matches
                    ? 'border-red-500/60 focus:border-red-500'
                    : 'border-slate-700 focus:border-brand-500'
                }`}
                placeholder="Re-enter password"
              />
              {pw2.length > 0 && !matches && (
                <div className="mt-1 text-[11px] text-red-300">Passwords do not match.</div>
              )}
            </div>

            {/* Strength rules */}
            <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-3">
              <div className="text-[10px] font-semibold uppercase tracking-widest text-slate-500 mb-2">
                Password requirements
              </div>
              <ul className="space-y-1">
                {ruleResults.map((r) => (
                  <li
                    key={r.key}
                    className={`text-xs flex items-center gap-2 transition-colors ${
                      r.passed ? 'text-emerald-300' : 'text-slate-500'
                    }`}
                  >
                    <i className={`ph ${r.passed ? 'ph-check-circle' : 'ph-circle'} text-sm`} />
                    <span>{r.label}</span>
                  </li>
                ))}
                <li className={`text-xs flex items-center gap-2 ${matches ? 'text-emerald-300' : 'text-slate-500'}`}>
                  <i className={`ph ${matches ? 'ph-check-circle' : 'ph-circle'} text-sm`} />
                  <span>New password and confirmation match</span>
                </li>
              </ul>
            </div>

            {err && (
              <div className="text-xs px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/30 text-red-200">
                {err}
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="px-6 py-3 border-t border-slate-800 flex items-center justify-end gap-2 bg-slate-900/60">
            <button
              type="button"
              onClick={onClose}
              disabled={busy}
              className="px-4 py-2 text-sm text-slate-400 hover:text-white rounded-lg disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!canSubmit || isSelf}
              className="px-4 py-2 bg-amber-500 hover:bg-amber-400 text-slate-950 rounded-lg text-sm font-semibold disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center gap-2"
            >
              {busy ? (
                <>
                  <i className="ph ph-spinner-gap animate-spin" />
                  Resetting…
                </>
              ) : (
                <>
                  <i className="ph ph-key" />
                  Reset password
                </>
              )}
            </button>
          </div>
        </form>
      </div>
    </>
  );
}
