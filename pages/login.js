import Head from 'next/head';
import { useRouter } from 'next/router';
import { useEffect } from 'react';
import { useAuth } from '../lib/AuthContext';

export default function LoginPage() {
  const router = useRouter();
  const { user, authorized, loading, error, signIn } = useAuth();

  useEffect(() => {
    if (authorized && user) {
      router.replace('/v2');
    }
  }, [authorized, user, router]);

  if (loading) {
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
                <p className="text-sm text-slate-400 mt-1">Sign in with your authorized Google account</p>
              </div>

              {error && (
                <div className="mb-6 p-4 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400 text-sm flex items-start gap-3">
                  <i className="ph ph-warning-circle text-xl flex-shrink-0 mt-0.5"></i>
                  <span>{error}</span>
                </div>
              )}

              <button
                onClick={signIn}
                disabled={loading}
                className="w-full flex items-center justify-center gap-3 px-6 py-3.5 bg-white hover:bg-gray-50 text-gray-800 rounded-xl text-sm font-semibold transition-all shadow-lg active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <svg className="w-5 h-5" viewBox="0 0 24 24">
                  <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"/>
                  <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                  <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
                  <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
                </svg>
                Sign in with Google
              </button>

              <div className="mt-6 pt-6 border-t border-slate-800">
                <div className="flex items-start gap-3 text-xs text-slate-500">
                  <i className="ph ph-shield-check text-brand-500 text-base flex-shrink-0 mt-0.5"></i>
                  <p>Only pre-authorized email addresses can access this dashboard. Contact your system administrator to request access.</p>
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
