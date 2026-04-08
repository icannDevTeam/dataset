import '../styles/globals.css';
import { useRouter } from 'next/router';
import { AuthProvider, useAuth } from '../lib/AuthContext';

// Pages that don't require authentication
const PUBLIC_PAGES = ['/login'];

function AuthGate({ Component, pageProps }) {
  const router = useRouter();
  const { authorized, loading } = useAuth();

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

  return <Component {...pageProps} />;
}

export default function App({ Component, pageProps }) {
  return (
    <AuthProvider>
      <AuthGate Component={Component} pageProps={pageProps} />
    </AuthProvider>
  );
}
