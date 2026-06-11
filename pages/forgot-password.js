/**
 * /forgot-password — public self-service password reset request.
 *
 * Posts to /api/auth/forgot-password which always answers generic OK
 * (no user enumeration). Shows a "check your inbox" state after submit.
 */
import Head from 'next/head';
import Link from 'next/link';
import { useState } from 'react';

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState(null);

  async function handleSubmit(e) {
    e.preventDefault();
    if (!email.trim() || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const raw = email.trim();
      const full = raw.includes('@') ? raw : `${raw.toLowerCase()}@binus.edu`;
      const r = await fetch('/api/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: full }),
      });
      if (r.status === 429) {
        const j = await r.json().catch(() => ({}));
        setError(`Too many requests. Please try again in ${Math.ceil((j.retryAfter || 900) / 60)} minutes.`);
        return;
      }
      // Generic OK regardless of account existence
      setSent(true);
    } catch {
      setError('Something went wrong. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <Head>
        <title>Forgot Password - BINUS Attendance</title>
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
            <h1 className="text-3xl font-bold tracking-tight text-white">Reset Password</h1>
            <p className="text-slate-400 mt-2">We&apos;ll email you a secure reset link</p>
          </div>

          <div className="rounded-2xl overflow-hidden glass-panel border border-slate-800 shadow-2xl shadow-black/30">
            <div className="p-8">
              {sent ? (
                <div className="text-center">
                  <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-emerald-500/10 border border-emerald-500/20 mb-5">
                    <i className="ph ph-envelope-open text-3xl text-emerald-400"></i>
                  </div>
                  <h2 className="text-lg font-semibold text-white">Check your inbox</h2>
                  <p className="text-sm text-slate-400 mt-2 leading-relaxed">
                    If an account exists for that email, a password reset link is on its way.
                    The link expires in <span className="text-slate-300 font-medium">30 minutes</span> and
                    can be used once.
                  </p>
                  <p className="text-xs text-slate-500 mt-4">
                    Didn&apos;t get it? Check your spam folder, or try again in a few minutes.
                  </p>
                  <Link
                    href="/login"
                    className="mt-6 inline-flex items-center justify-center gap-2 px-6 py-3 rounded-xl text-sm font-bold bg-brand-500 hover:bg-brand-400 text-slate-950 transition-all active:scale-[0.98] shadow-lg shadow-brand-500/20"
                  >
                    <i className="ph ph-arrow-left text-lg"></i>
                    Back to Sign In
                  </Link>
                </div>
              ) : (
                <>
                  <div className="text-center mb-6">
                    <h2 className="text-lg font-semibold text-white">Forgot your password?</h2>
                    <p className="text-sm text-slate-400 mt-1">
                      Enter your account email and we&apos;ll send a reset link
                    </p>
                  </div>

                  {error && (
                    <div className="mb-6 p-4 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400 text-sm flex items-start gap-3">
                      <i className="ph ph-warning-circle text-xl flex-shrink-0 mt-0.5"></i>
                      <span>{error}</span>
                    </div>
                  )}

                  <form onSubmit={handleSubmit} className="space-y-4">
                    <div>
                      <label className="text-xs font-medium text-slate-400 block mb-1.5">Email</label>
                      <div className="relative">
                        <i className="ph ph-envelope absolute left-4 top-1/2 -translate-y-1/2 text-slate-500"></i>
                        <input
                          type="text"
                          value={email}
                          onChange={(e) => setEmail(e.target.value)}
                          placeholder="you@binus.edu"
                          required
                          autoComplete="email"
                          autoFocus
                          className="w-full bg-slate-950/50 border rounded-xl py-3 pl-11 pr-4 text-sm text-white placeholder-slate-600 focus:outline-none transition-colors border-slate-700 focus:border-brand-500 focus:ring-1 focus:ring-brand-500"
                        />
                      </div>
                    </div>

                    <button
                      type="submit"
                      disabled={submitting}
                      className="w-full flex items-center justify-center gap-2 px-6 py-3.5 rounded-xl text-sm font-bold transition-all active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed mt-6 bg-brand-500 hover:bg-brand-400 text-slate-950 shadow-lg shadow-brand-500/20"
                    >
                      {submitting ? (
                        <>
                          <div className="w-4 h-4 border-2 border-slate-950 border-t-transparent rounded-full animate-spin"></div>
                          Sending...
                        </>
                      ) : (
                        <>
                          <i className="ph ph-paper-plane-tilt text-lg"></i>
                          Send Reset Link
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
