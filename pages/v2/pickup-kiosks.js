/**
 * Legacy redirect — TV kiosk management was merged into /v2/pickup-admin.
 */
import { useEffect } from 'react';
import { useRouter } from 'next/router';

export default function PickupKiosksRedirect() {
  const router = useRouter();
  useEffect(() => {
    router.replace('/v2/pickup-admin?view=kiosks');
  }, [router]);
  return (
    <div style={{
      minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      color: '#94a3b8', fontFamily: 'system-ui, sans-serif', background: '#0f172a',
    }}>
      Redirecting to PickupGuard Admin…
    </div>
  );
}
