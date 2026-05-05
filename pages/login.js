import Head from 'next/head';
import { useRouter } from 'next/router';
import { useState, useEffect } from 'react';
import { useAuth } from '../lib/AuthContext';

export default function LoginPage() {
  const router = useRouter();
  const { user, authorized, loading, error, signIn } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const redirectTo = router.query.from || '/v2';
  const fromPath = String(router.query.from || '');
  const teacherMode = fromPath.startsWith('/pickup/teacher') || String(router.query.mode || '').toLowerCase() === 'teacher';
  const sessionExpired = router.query.expired === '1';

  useEffect(() => {
    if (authorized && user) {
      // Full page load instead of client-side nav to ensure clean state after auth
      window.location.href = redirectTo;
    }
  }, [authorized, user, redirectTo]);

  async function handleSubmit(e) {
    e.preventDefault();
    if (!username.trim() || !password) return;
    setSubmitting(true);
    // Auto-append @binus.edu if no @ present
    const email = username.trim().includes('@') ? username.trim() : `${username.trim().toLowerCase()}@binus.edu`;
    await signIn(email, password);
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
        <title>{teacherMode ? 'Teacher Sign In - BINUS Pickup' : 'Sign In - BINUS Attendance'}</title>
        <link rel="stylesheet" href="https://unpkg.com/@phosphor-icons/web@2.0.3/src/regular/style.css" />
      </Head>

      <div className={`aura-theme antialiased min-h-screen flex items-center justify-center relative overflow-hidden ${teacherMode ? 'bg-slate-950' : ''}`}>
        <div className="noise-overlay"></div>

        {!teacherMode && (
          <div className="absolute inset-0 overflow-hidden pointer-events-none">
            <div className="absolute top-1/4 left-1/4 w-96 h-96 bg-brand-500/5 rounded-full blur-[100px]"></div>
            <div className="absolute bottom-1/4 right-1/4 w-80 h-80 bg-indigo-500/5 rounded-full blur-[100px]"></div>
          </div>
        )}

        <div className="relative z-10 w-full max-w-md mx-4">
          <div className="text-center mb-8">
            <div className={`inline-flex items-center justify-center w-20 h-20 rounded-2xl mb-6 ${teacherMode ? 'bg-amber-500/10 border border-amber-500/25' : 'bg-white/10 backdrop-blur border border-slate-700/50 shadow-lg shadow-black/20'}`}>
              <img src="/binus-logo.jpg" alt="BINUS" className="w-14 h-14 rounded-lg object-contain bg-white p-0.5" />
            </div>
            <h1 className="text-3xl font-bold tracking-tight text-white">
              {teacherMode ? 'Teacher Pickup Desk' : 'BINUS Attendance'}
            </h1>
            <p className="text-slate-400 mt-2">
              {teacherMode ? 'Simple sign-in for class release validation' : 'Attendance Monitoring System'}
            </p>
          </div>

          <div className={`rounded-2xl overflow-hidden ${teacherMode ? 'border border-amber-500/30 bg-slate-900/90' : 'glass-panel border border-slate-800 shadow-2xl shadow-black/30'}`}>
            <div className="p-8">
              <div className="text-center mb-6">
                <h2 className="text-lg font-semibold text-white">{teacherMode ? 'Teacher Login' : 'Dashboard Access'}</h2>
                <p className="text-sm text-slate-400 mt-1">
                  {teacherMode ? 'Use your assigned account to open the teacher release screen' : 'Sign in with your credentials'}
                </p>
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
                  <label className="text-xs font-medium text-slate-400 block mb-1.5">{teacherMode ? 'Teacher Username' : 'Username'}</label>
                  <div className="relative">
                    <i className="ph ph-user absolute left-4 top-1/2 -translate-y-1/2 text-slate-500"></i>
                    <input
                      type="text"
                      value={username}
                      onChange={e => setUsername(e.target.value)}
                      placeholder={teacherMode ? 'Teacher' : 'Admin'}
                      required
                      autoComplete="username"
                      className={`w-full bg-slate-950/50 border rounded-xl py-3 pl-11 pr-4 text-sm text-white placeholder-slate-600 focus:outline-none transition-colors ${teacherMode ? 'border-slate-600 focus:border-amber-400 focus:ring-1 focus:ring-amber-400' : 'border-slate-700 focus:border-brand-500 focus:ring-1 focus:ring-brand-500'}`}
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
                      className={`w-full bg-slate-950/50 border rounded-xl py-3 pl-11 pr-12 text-sm text-white placeholder-slate-600 focus:outline-none transition-colors ${teacherMode ? 'border-slate-600 focus:border-amber-400 focus:ring-1 focus:ring-amber-400' : 'border-slate-700 focus:border-brand-500 focus:ring-1 focus:ring-brand-500'}`}
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
                  className={`w-full flex items-center justify-center gap-2 px-6 py-3.5 rounded-xl text-sm font-bold transition-all active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed mt-6 ${teacherMode ? 'bg-amber-400 hover:bg-amber-300 text-slate-950 shadow-lg shadow-amber-500/20' : 'bg-brand-500 hover:bg-brand-400 text-slate-950 shadow-lg shadow-brand-500/20'}`}
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

              {!teacherMode ? (
                <div className="mt-6 pt-6 border-t border-slate-800">
                  <div className="flex items-start gap-3 text-xs text-slate-500">
                    <i className="ph ph-shield-check text-brand-500 text-base flex-shrink-0 mt-0.5"></i>
                    <p>Only pre-authorized accounts can access this dashboard. Contact your system administrator to request access.</p>
                  </div>
                </div>
              ) : (
                <div className="mt-6 pt-6 border-t border-slate-700/60">
                  <div className="flex items-start gap-3 text-xs text-slate-400">
                    <i className="ph ph-info text-amber-400 text-base flex-shrink-0 mt-0.5"></i>
                    <p>After sign-in, you will be redirected to the teacher release interface. If access is denied, ask admin to assign your teacher class scope.</p>
                  </div>
                </div>
              )}
            </div>
          </div>

          <p className="text-center text-xs text-slate-600 mt-6">
            BINUS School Simprug - {teacherMode ? 'Teacher Pickup Interface' : 'Facial Attendance System'}
          </p>
        </div>
      </div>
    </>
  );
}
