import Head from 'next/head';
import { useRouter } from 'next/router';
import { useState, useEffect } from 'react';
import { useAuth } from '../lib/AuthContext';

export default function LoginPage() {
  const router = useRouter();
  const { user, authorized, loading, error, signIn } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const redirectTo = router.query.from || '/v2';
  const sessionExpired = router.query.expired === '1';

  useEffect(() => {
    if (authorized && user) {
      router.replace(redirectTo);
    }
  }, [authorized, user, router, redirectTo]);

  async function handleSubmit(e) {
    e.preventDefault();
    if (!email.trim() || !password) return;
    setSubmitting(true);
    await signIn(email.trim(), password);
    setSubmitting(false);
  }

  if (loading && !submitting) {
    return (
      <div className="aura-theme antialiased min-h-screen flex items-center justify-center relative overflow-hidden">
        <div className="noise-overlay"></div>
        <div className="glass-panel rounded-2xl border border-slate-800 p-12 flex flex-col items-center gap-4">
          <div className="w-10 h-10 border-2 border-brand-500 border-t-transparent rounded-full animate-spin"></div>
          <span className="text-slate-400 text-sm">Checking authentication...</span>
        </div>
      </div>
    );
  }

  if (authorized) return null;

  return (
    <>
      <Head>
        <title>Sign In — BINUSFace</title>
        <link rel="stylesheet" href="https://unpkg.com/@phosphor-icons/web@2.0.3/src/regular/style.css" />
      </Head>

      <div className="aura-theme antialiased min-h-screen flex items-center justify-center relative overflow-hidden">
        <div className="noise-overlay"></div>

        {/* Background effects */}
        <div className="absolute inset-0 overflow-hidden pointer-events-none">
          <div className="absolute top-1/4 left-1/4 w-96 h-96 bg-brand-500/5 rounded-full blur-[100px]"></div>
          <div className="absolute bottom-1/4 right-1/4 w-80 h-80 bg-indigo-500/5 rounded-full blur-[100px]"></div>
        </div>

        <div className="relative z-10 w-full max-w-md mx-4">
          {/* Logo + branding */}
          <div className="text-center mb-8">
            <div className="inline-flex items-center justify-center w-20 h-20 rounded-2xl bg-white/10 backdrop-blur border border-slate-700/50 mb-6 shadow-lg shadow-black/20">
              <img src="/binus-logo.jpg" alt="BINUS" className="w-14 h-14 rounded-lg object-contain bg-white p-0.5" />
            </div>
            <h1 className="text-3xl font-bold tracking-tight text-white">BINUSFace</h1>
            <p className="text-slate-400 mt-2">Attendance Monitoring System</p>
          </div>

          {/* Sign-in card */}
          <div className="glass-panel rounded-2xl border border-slate-800 overflow-hidden shadow-2xl shadow-black/30">
            <div className="p-8">
              <div className="text-center mb-6">
                <h2 className="text-lg font-semibold text-white">Dashboard Access</h2>
                <p className="text-sm text-slate-400 mt-1">Sign in with your credentials</p>
              </div>

              {sessionExpired && !error && (
                <div className="mb-6 p-4 rounded-xl bg-amber-500/10 border border-amber-500/20 text-amber-400 text-sm flex items-start gap-3">
                  <i className="ph ph-clock-countdown text-xl flex-shrink-0 mt-0.5"></i>
                  <span>Your session has expired. Please sign in again.</span>
                </div>
              )}

              {error && (
                <div className="mb-6 p-4 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400 text-sm flex items-start gap-3">
                  <i className="ph ph-warning-circle text-xl flex-shrink-0 mt-0.5"></i>
                  <span>{error}</span>
                </div>
              )}

              <form onSubmit={handleSubmit} className="space-y-4">
                <div>
                  <label className="text-xs font-medium text-slate-400 block mb-1.5">Email Address</label>
                  <div className="relative">
                    <i className="ph ph-envelope absolute left-4 top-1/2 -translate-y-1/2 text-slate-500"></i>
                    <input
                      type="email"
                      value={email}
                      onChange={e => setEmail(e.target.value)}
                      placeholder="you@binus.edu"
                      required
                      autoComplete="email"
                      className="w-full bg-slate-950/50 border border-slate-700 rounded-xl py-3 pl-11 pr-4 text-sm text-white placeholder-slate-600 focus:outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-500 transition-colors"
                    />
                  </div>
                </div>

                <div>
                  <label className="text-xs font-medium text-slate-400 block mb-1.5">Password</label>
                  <div className="relative">
                    <i className="ph ph-lock absolute left-4 top-1/2 -translate-y-1/2 text-slate-500"></i>
                    <input
                      type={showPassword ? 'text' : 'password'}
                      value={password}
                      onChange={e => setPassword(e.target.value)}
                      placeholder="••••••••••"
                      required
                      autoComplete="current-password"
                      className="w-full bg-slate-950/50 border border-slate-700 rounded-xl py-3 pl-11 pr-12 text-sm text-white placeholder-slate-600 focus:outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-500 transition-colors"
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

                <button
                  type="submit"
                  disabled={submitting || loading}
                  className="w-full flex items-center justify-center gap-2 px-6 py-3.5 bg-brand-500 hover:bg-brand-400 text-slate-950 rounded-xl text-sm font-bold transition-all shadow-lg shadow-brand-500/20 active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed mt-6"
                >
                  {submitting ? (
                    <>
                      <div className="w-4 h-4 border-2 border-slate-950 border-t-transparent rounded-full animate-spin"></div>
                      Signing in...
                    </>
                  ) : (
                    <>
                      <i className="ph ph-sign-in text-lg"></i>
                      Sign In
                    </>
                  )}
                </button>
              </form>

              <div className="mt-6 pt-6 border-t border-slate-800">
                <div className="flex items-start gap-3 text-xs text-slate-500">
                  <i className="ph ph-shield-check text-brand-500 text-base flex-shrink-0 mt-0.5"></i>
                  <p>Only pre-authorized accounts can access this dashboard. Contact your system administrator to request access.</p>
                </div>
              </div>
            </div>
          </div>

          {/* Footer */}
          <p className="text-center text-xs text-slate-600 mt-6">
            BINUS School Simprug &mdash; Facial Attendance System
          </p>
        </div>
      </div>
    </>
  );
}
