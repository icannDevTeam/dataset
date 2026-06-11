/**
 * /reset-password?token=... — public, landed from the emailed reset link.
 *
 * Posts to /api/auth/reset-password which verifies the single-use token,
 * rotates the Firebase Auth password, and revokes all existing sessions.
 * Error states: link_invalid | link_expired | link_used | policy violations.
 */
import Head from 'next/head';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useState } from 'react';

// Mirrors lib/password-policy.js — server remains authoritative.
const RULES = [
  { key: 'len',   label: 'At least 10 characters',  test: (p) => p.length >= 10 },
  { key: 'lower', label: 'One lowercase letter',    test: (p) => /[a-z]/.test(p) },
  { key: 'upper', label: 'One uppercase letter',    test: (p) => /[A-Z]/.test(p) },
  { key: 'digit', label: 'One digit',               test: (p) => /[0-9]/.test(p) },
];

const ERROR_MESSAGES = {
  link_invalid: 'This reset link is invalid. Please request a new one.',
  link_expired: 'This reset link has expired. Reset links are valid for 30 minutes.',
  link_used: 'This reset link has already been used. Please request a new one.',
  rate_limited: 'Too many attempts. Please wait a few minutes and try again.',
  internal: 'Something went wrong. Please request a new reset link.',
};

export default function ResetPasswordPage() {
  const router = useRouter();
  const token = typeof router.query.token === 'string' ? router.query.token : '';

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState(null);
  const [linkDead, setLinkDead] = useState(false);

  const ruleResults = RULES.map((r) => ({ ...r, ok: r.test(password) }));
  const allRulesOk = ruleResults.every((r) => r.ok);
  const confirmOk = confirm.length > 0 && confirm === password;

  async function handleSubmit(e) {
    e.preventDefault();
    if (!allRulesOk || !confirmOk || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const r = await fetch('/api/auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, newPassword: password }),
      });
      const j = await r.json().catch(() => ({}));
      if (r.ok) {
        setDone(true);
        return;
      }
      const code = j.error || 'internal';
      if (code === 'link_invalid' || code === 'link_expired' || code === 'link_used') {
        setLinkDead(true);
      }
      setError(ERROR_MESSAGES[code] || j.message || code);
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  const missingToken = router.isReady && !token;

  return (
    <>
      <Head>
        <title>Set New Password - BINUS Attendance</title>
        <link rel="stylesheet" href="https://unpkg.com/@phosphor-icons/web@2.0.3/src/regular/style.css" />
      </Head>

      <div className="aura-theme antialiased min-h-screen flex items-center justify-center relative overflow-hidden">
        <div className="noise-overlay"></div>
        <div className="absolute inset-0 overflow-hidden pointer-events-none">
          <div className="absolute top-1/4 left-1/4 w-96 h-96 bg-brand-500/5 rounded-full blur-[100px]"></div>
          <div className="absolute bottom-1/4 right-1/4 w-80 h-80 bg-indigo-500/5 rounded-full blur-[100px]"></div>
        </div>

        <div className="relative z-10 w-full max-w-md mx-4">
          <div className="text-center mb-8">
            <div className="inline-flex items-center justify-center w-20 h-20 rounded-2xl mb-6 bg-white/10 backdrop-blur border border-slate-700/50 shadow-lg shadow-black/20">
              <img src="/binus-logo.jpg" alt="BINUS" className="w-14 h-14 rounded-lg object-contain bg-white p-0.5" />
            </div>
            <h1 className="text-3xl font-bold tracking-tight text-white">Set New Password</h1>
            <p className="text-slate-400 mt-2">Choose a strong password for your account</p>
          </div>

          <div className="rounded-2xl overflow-hidden glass-panel border border-slate-800 shadow-2xl shadow-black/30">
            <div className="p-8">
              {done ? (
                <div className="text-center">
                  <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-emerald-500/10 border border-emerald-500/20 mb-5">
                    <i className="ph ph-check-circle text-3xl text-emerald-400"></i>
                  </div>
                  <h2 className="text-lg font-semibold text-white">Password updated</h2>
                  <p className="text-sm text-slate-400 mt-2 leading-relaxed">
                    Your password has been changed and all previous sessions have been signed out.
                    A confirmation email is on its way.
                  </p>
                  <Link
                    href="/login"
                    className="mt-6 inline-flex items-center justify-center gap-2 px-6 py-3 rounded-xl text-sm font-bold bg-brand-500 hover:bg-brand-400 text-slate-950 transition-all active:scale-[0.98] shadow-lg shadow-brand-500/20"
                  >
                    <i className="ph ph-sign-in text-lg"></i>
                    Sign In
                  </Link>
                </div>
              ) : missingToken || linkDead ? (
                <div className="text-center">
                  <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-red-500/10 border border-red-500/20 mb-5">
                    <i className="ph ph-link-break text-3xl text-red-400"></i>
                  </div>
                  <h2 className="text-lg font-semibold text-white">Link not valid</h2>
                  <p className="text-sm text-slate-400 mt-2 leading-relaxed">
                    {error || 'This reset link is missing or no longer valid. Reset links expire after 30 minutes and can only be used once.'}
                  </p>
                  <Link
                    href="/forgot-password"
                    className="mt-6 inline-flex items-center justify-center gap-2 px-6 py-3 rounded-xl text-sm font-bold bg-brand-500 hover:bg-brand-400 text-slate-950 transition-all active:scale-[0.98] shadow-lg shadow-brand-500/20"
                  >
                    <i className="ph ph-paper-plane-tilt text-lg"></i>
                    Request a New Link
                  </Link>
                </div>
              ) : (
                <>
                  {error && (
                    <div className="mb-6 p-4 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400 text-sm flex items-start gap-3">
                      <i className="ph ph-warning-circle text-xl flex-shrink-0 mt-0.5"></i>
                      <span>{error}</span>
                    </div>
                  )}

                  <form onSubmit={handleSubmit} className="space-y-4">
                    <div>
                      <label className="text-xs font-medium text-slate-400 block mb-1.5">New Password</label>
                      <div className="relative">
                        <i className="ph ph-lock absolute left-4 top-1/2 -translate-y-1/2 text-slate-500"></i>
                        <input
                          type={showPassword ? 'text' : 'password'}
                          value={password}
                          onChange={(e) => setPassword(e.target.value)}
                          placeholder="••••••••••"
                          required
                          autoComplete="new-password"
                          autoFocus
                          className="w-full bg-slate-950/50 border rounded-xl py-3 pl-11 pr-12 text-sm text-white placeholder-slate-600 focus:outline-none transition-colors border-slate-700 focus:border-brand-500 focus:ring-1 focus:ring-brand-500"
                        />
                        <button
                          type="button"
                          onClick={() => setShowPassword(!showPassword)}
                          className="absolute right-4 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300 transition-colors"
                        >
                          <i className={`ph ${showPassword ? 'ph-eye-slash' : 'ph-eye'} text-lg`}></i>
                        </button>
                      </div>
                    </div>

                    {/* Live policy checklist */}
                    <ul className="space-y-1.5 px-1">
                      {ruleResults.map((r) => (
                        <li key={r.key} className={`flex items-center gap-2 text-xs transition-colors ${r.ok ? 'text-emerald-400' : 'text-slate-500'}`}>
                          <i className={`ph ${r.ok ? 'ph-check-circle' : 'ph-circle'} text-sm`}></i>
                          {r.label}
                        </li>
                      ))}
                    </ul>

                    <div>
                      <label className="text-xs font-medium text-slate-400 block mb-1.5">Confirm Password</label>
                      <div className="relative">
                        <i className="ph ph-lock-key absolute left-4 top-1/2 -translate-y-1/2 text-slate-500"></i>
                        <input
                          type={showPassword ? 'text' : 'password'}
                          value={confirm}
                          onChange={(e) => setConfirm(e.target.value)}
                          placeholder="••••••••••"
                          required
                          autoComplete="new-password"
                          className={`w-full bg-slate-950/50 border rounded-xl py-3 pl-11 pr-4 text-sm text-white placeholder-slate-600 focus:outline-none transition-colors focus:ring-1 ${
                            confirm.length > 0 && !confirmOk
                              ? 'border-red-500/60 focus:border-red-500 focus:ring-red-500'
                              : 'border-slate-700 focus:border-brand-500 focus:ring-brand-500'
                          }`}
                        />
                      </div>
                      {confirm.length > 0 && !confirmOk && (
                        <p className="text-xs text-red-400 mt-1.5">Passwords do not match.</p>
                      )}
                    </div>

                    <button
                      type="submit"
                      disabled={submitting || !allRulesOk || !confirmOk}
                      className="w-full flex items-center justify-center gap-2 px-6 py-3.5 rounded-xl text-sm font-bold transition-all active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed mt-6 bg-brand-500 hover:bg-brand-400 text-slate-950 shadow-lg shadow-brand-500/20"
                    >
                      {submitting ? (
                        <>
                          <div className="w-4 h-4 border-2 border-slate-950 border-t-transparent rounded-full animate-spin"></div>
                          Updating...
                        </>
                      ) : (
                        <>
                          <i className="ph ph-key text-lg"></i>
                          Set New Password
                        </>
                      )}
                    </button>
                  </form>

                  <div className="mt-6 pt-6 border-t border-slate-800 text-center">
                    <Link href="/login" className="text-xs font-medium text-brand-500 hover:text-brand-400 transition-colors inline-flex items-center gap-1.5">
                      <i className="ph ph-arrow-left"></i>
                      Back to Sign In
                    </Link>
                  </div>
                </>
              )}
            </div>
          </div>

          <p className="text-center text-xs text-slate-600 mt-6">
            BINUS School Simprug - Facial Attendance System
          </p>
        </div>
      </div>
    </>
  );
}
