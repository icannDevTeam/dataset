/**
 * /v2/account-security — self-service MFA enrollment, available to every
 * authenticated dashboard user regardless of role/permissions.
 *
 * Deliberately NOT gated by the `settings`/`security_audit` features —
 * viewer and guard roles have settings:false and would otherwise be
 * locked out of enrolling 2FA on their own account. Two-factor auth is a
 * personal account-security action, not an app "feature" to grant/deny.
 */
import Head from 'next/head';
import { useRouter } from 'next/router';
import { useEffect } from 'react';
import V2Layout from '../../components/v2/V2Layout';
import TwoFactorSetup from '../../components/v2/TwoFactorSetup';
import { useAuth } from '../../lib/AuthContext';

export default function AccountSecurityPage() {
  const router = useRouter();
  const { user, authorized, loading } = useAuth();

  useEffect(() => {
    if (!loading && !authorized) {
      router.replace('/login');
    }
  }, [loading, authorized, router]);

  if (loading || !authorized || !user) {
    return (
      <div className="aura-theme antialiased min-h-screen flex items-center justify-center">
        <div className="w-10 h-10 border-2 border-brand-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <V2Layout>
      <Head><title>Account Security · BINUS Attendance</title></Head>
      <div className="max-w-2xl mx-auto px-4 py-8 space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-white">Account Security</h1>
          <p className="text-slate-400 mt-1 text-sm">Manage two-factor authentication on your own account.</p>
        </div>
        <TwoFactorSetup />
      </div>
    </V2Layout>
  );
}
