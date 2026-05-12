import Head from 'next/head';
import { useRouter } from 'next/router';
import { useState, useEffect } from 'react';
import { useAuth } from '../../lib/AuthContext';

/**
 * /v2/change-password — first-login forced password change.
 *
 * Renders standalone (no V2Layout chrome) so a user with
 * mustChangePassword=true can't navigate around the dashboard.
 * V2Layout's gate redirects here automatically; this page also
 * doubles as a voluntary password rotation screen.
 */
export default function ChangePasswordPage() {
  const router = useRouter();
  const { user, authorized, loading, signOut } = useAuth();
  const [pw1, setPw1] = useState('');
  const [pw2, setPw2] = useState('');
  const [show, setShow] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    if (!loading && !authorized) {
      router.replace('/login');
    }
  }, [loading, authorized, router]);

  function validate(pw) {
    if (pw.length < 10) return 'Password must be at least 10 characters.';
    if (!/[a-z]/.test(pw)) return 'Must include a lowercase letter.';
    if (!/[A-Z]/.test(pw)) return 'Must include an uppercase letter.';
    if (!/[0-9]/.test(pw)) return 'Must include a digit.';
    return null;
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    const v = validate(pw1);
    if (v) { setError(v); return; }
    if (pw1 !== pw2) { setError('Passwords do not match.'); return; }
    setSubmitting(true);
    try {
      const idToken = await user.getIdToken();
      const r = await fetch('/api/auth/change-password', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${idToken}`,
        },
        body: JSON.stringify({ newPassword: pw1 }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        setError(data.error || 'Failed to update password.');
        setSubmitting(false);
        return;
      }
      setSuccess(true);
      // Sign out so the user has to re-auth with the new password — this
      // also clears any stale session cookies / mustChangePassword cache.
      setTimeout(async () => {
        try { await signOut('password_changed'); } catch {}
        window.location.href = '/login';
      }, 1500);
    } catch (e) {
      setError(e.message || 'Network error');
      setSubmitting(false);
    }
  }

  if (loading || !authorized) {
    return (
      <div className="aura-theme antialiased min-h-screen flex items-center justify-center">
        <div className="w-10 h-10 border-2 border-brand-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <>
      <Head>
        <title>Change Password — BINUS Attendance</title>
        <link rel="stylesheet" href="https://unpkg.com/@phosphor-icons/web@2.0.3/src/regular/style.css" />
      </Head>
      <div className="aura-theme antialiased min-h-screen flex items-center justify-center px-4 py-8">
        <div className="w-full max-w-md">
          <div className="text-center mb-6">
            <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl mb-4 bg-white/10 backdrop-blur border border-slate-700/50">
              <i className="ph ph-key text-3xl text-amber-300"></i>
            </div>
            <h1 className="text-2xl font-bold text-white">Set a new password</h1>
            <p className="text-slate-400 mt-2 text-sm">
              You must change your temporary password before continuing.
            </p>
          </div>

          <div className="glass-panel rounded-2xl border border-slate-800 p-6">
            {success ? (
              <div className="text-center py-6">
                <div className="inline-flex items-center justify-center w-14 h-14 rounded-full bg-emerald-500/20 border border-emerald-500/40 mb-4">
                  <i className="ph ph-check text-2xl text-emerald-400"></i>
                </div>
                <p className="text-white font-medium">Password updated</p>
                <p className="text-slate-400 text-sm mt-1">Signing you out…</p>
              </div>
            ) : (
              <form onSubmit={handleSubmit} className="space-y-4">
                <div>
                  <label className="block text-xs font-medium text-slate-400 uppercase tracking-wider mb-2">
                    New password
                  </label>
                  <input
                    type={show ? 'text' : 'password'}
                    value={pw1}
                    onChange={(e) => setPw1(e.target.value)}
                    className="w-full px-4 py-3 bg-slate-900/50 border border-slate-700 rounded-lg text-white placeholder-slate-500 focus:outline-none focus:border-brand-500"
                    placeholder="At least 10 characters"
                    autoFocus
                    required
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-400 uppercase tracking-wider mb-2">
                    Confirm new password
                  </label>
                  <input
                    type={show ? 'text' : 'password'}
                    value={pw2}
                    onChange={(e) => setPw2(e.target.value)}
                    className="w-full px-4 py-3 bg-slate-900/50 border border-slate-700 rounded-lg text-white placeholder-slate-500 focus:outline-none focus:border-brand-500"
                    placeholder="Type it again"
                    required
                  />
                </div>
                <label className="flex items-center gap-2 text-sm text-slate-400 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={show}
                    onChange={(e) => setShow(e.target.checked)}
                    className="rounded border-slate-700 bg-slate-900"
                  />
                  Show password
                </label>

                <ul className="text-xs text-slate-500 space-y-1 pl-4">
                  <li>• Minimum 10 characters</li>
                  <li>• At least one uppercase, one lowercase, one digit</li>
                  <li>• Avoid reusing your temporary password</li>
                </ul>

                {error && (
                  <div className="px-3 py-2 rounded-lg bg-rose-500/10 border border-rose-500/30 text-rose-300 text-sm">
                    {error}
                  </div>
                )}

                <button
                  type="submit"
                  disabled={submitting}
                  className="w-full py-3 rounded-lg bg-brand-600 hover:bg-brand-500 disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold transition-colors"
                >
                  {submitting ? 'Updating…' : 'Update password'}
                </button>

                <button
                  type="button"
                  onClick={async () => { try { await signOut('cancelled'); } catch {} window.location.href = '/login'; }}
                  className="w-full text-xs text-slate-500 hover:text-slate-300 transition-colors"
                >
                  Sign out instead
                </button>
              </form>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
