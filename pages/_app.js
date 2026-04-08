import '../styles/globals.css';
import { useRouter } from 'next/router';
import { useEffect, useState } from 'react';
import { AuthProvider, useAuth } from '../lib/AuthContext';
import { canAccess } from '../lib/permissions';

// Pages that don't require authentication
const PUBLIC_PAGES = ['/login'];

function AuthGate({ Component, pageProps }) {
  const router = useRouter();
  const { authorized, role, loading, sessionWarning, extendSession } = useAuth();
  const [accessDenied, setAccessDenied] = useState(false);

  useEffect(() => {
    if (!loading && authorized && role) {
      if (!PUBLIC_PAGES.includes(router.pathname) && !canAccess(role, router.pathname)) {
        setAccessDenied(true);
        setTimeout(() => router.replace('/v2'), 2000);
      } else {
        setAccessDenied(false);
      }
    }
  }, [loading, authorized, role, router.pathname]);

  // Public pages: render without auth check
  if (PUBLIC_PAGES.includes(router.pathname)) {
    return <Component {...pageProps} />;
  }

  // Loading state
  if (loading) {
    return (
      <div className="aura-theme antialiased min-h-screen flex items-center justify-center">
        <div className="noise-overlay"></div>
        <div className="glass-panel rounded-2xl border border-slate-800 p-12 flex flex-col items-center gap-4">
          <div className="w-10 h-10 border-2 border-brand-500 border-t-transparent rounded-full animate-spin"></div>
          <span className="text-slate-400 text-sm">Loading...</span>
        </div>
      </div>
    );
  }

  // Not authorized → redirect to login
  if (!authorized) {
    if (typeof window !== 'undefined') {
      router.replace('/login');
    }
    return null;
  }

  // Access denied for this role → redirect to dashboard
  if (accessDenied) {
    return (
      <div className="aura-theme antialiased min-h-screen flex items-center justify-center">
        <div className="noise-overlay"></div>
        <div className="glass-panel rounded-2xl border border-slate-800 p-12 flex flex-col items-center gap-4">
          <svg className="w-12 h-12 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" /></svg>
          <span className="text-slate-300 text-sm font-medium">Access Denied</span>
          <span className="text-slate-500 text-xs">Redirecting to dashboard...</span>
        </div>
      </div>
    );
  }

  return (
    <>
      <Component {...pageProps} />
      {/* Session timeout warning */}
      {sessionWarning && (
        <div className="fixed bottom-6 right-6 z-[9999] animate-slide-up">
          <div className="glass-panel rounded-xl border border-amber-500/30 bg-slate-900/95 backdrop-blur-xl p-4 shadow-2xl shadow-black/40 max-w-sm">
            <div className="flex items-start gap-3">
              <div className="w-8 h-8 rounded-lg bg-amber-500/10 flex items-center justify-center flex-shrink-0 mt-0.5">
                <svg className="w-4 h-4 text-amber-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-white">Session Expiring</p>
                <p className="text-xs text-slate-400 mt-1">You will be signed out in 2 minutes due to inactivity.</p>
                <button onClick={extendSession}
                  className="mt-3 px-4 py-1.5 bg-amber-500 hover:bg-amber-400 text-slate-950 rounded-lg text-xs font-semibold transition-colors">
                  Stay Signed In
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

export default function App({ Component, pageProps }) {
  return (
    <AuthProvider>
      <AuthGate Component={Component} pageProps={pageProps} />
    </AuthProvider>
  );
}
