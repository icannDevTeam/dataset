/**
 * Two-Factor Authentication (TOTP) self-service card — Settings → Security.
 * Lets the signed-in user enroll/unenroll an authenticator-app factor on
 * their own Firebase Auth account. Does not touch any Pickup Guard code.
 */
import { useState } from 'react';
import QRCode from 'qrcode';
import { useAuth } from '../../lib/AuthContext';
import { multiFactor } from '../../lib/firebase-client';

export default function TwoFactorSetup() {
  const { user, mfaEnrolled, startTotpEnrollment, confirmTotpEnrollment, unenrollTotp } = useAuth();
  const [step, setStep] = useState('idle'); // idle | enrolling | confirming
  const [secret, setSecret] = useState(null);
  const [qrDataUrl, setQrDataUrl] = useState(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const factors = user ? (multiFactor(user).enrolledFactors || []) : [];

  async function handleStart() {
    setError('');
    setBusy(true);
    try {
      const result = await startTotpEnrollment();
      setSecret(result.secret);
      // Rendered entirely in-browser (qrcode package, no network call) so the
      // TOTP secret never leaves the client — our server never sees it.
      const dataUrl = await QRCode.toDataURL(result.otpauthUrl, { width: 220, margin: 1 });
      setQrDataUrl(dataUrl);
      setStep('confirming');
    } catch (err) {
      setError(err?.message || 'Could not start enrollment. Try signing out and back in, then retry.');
    }
    setBusy(false);
  }

  async function handleConfirm(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await confirmTotpEnrollment(secret, code, 'Authenticator app');
      setStep('idle');
      setSecret(null);
      setQrDataUrl(null);
      setCode('');
    } catch (err) {
      console.error('[MFA enroll confirm]', err.code, err.message);
      setError(err?.code === 'auth/invalid-verification-code' ? 'Invalid code. Please try again.' : `Verification failed (${err?.code || 'unknown'}).`);
    }
    setBusy(false);
  }

  async function handleRemove(factorUid) {
    if (!window.confirm('Remove two-factor authentication from your account?')) return;
    setBusy(true);
    try {
      await unenrollTotp(factorUid);
    } catch (err) {
      setError(err?.message || 'Could not remove factor.');
    }
    setBusy(false);
  }

  return (
    <div className="glass-panel rounded-xl border border-slate-800 p-5">
      <div className="flex items-center gap-3 mb-1">
        <div className="w-9 h-9 rounded-lg bg-brand-500/10 flex items-center justify-center">
          <i className="ph ph-device-mobile-camera text-brand-400 text-lg"></i>
        </div>
        <div>
          <h3 className="text-sm font-semibold text-white">Two-Factor Authentication</h3>
          <p className="text-xs text-slate-400">Require an authenticator app code at sign-in, on top of your password.</p>
        </div>
      </div>

      {error && (
        <div className="mt-4 p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-xs">{error}</div>
      )}

      {step === 'idle' && (
        <div className="mt-4">
          {mfaEnrolled || factors.length > 0 ? (
            <div className="space-y-2">
              {factors.map((f) => (
                <div key={f.uid} className="flex items-center justify-between bg-slate-900/50 border border-slate-800 rounded-lg px-3 py-2">
                  <span className="text-sm text-slate-300 flex items-center gap-2">
                    <i className="ph ph-check-circle text-emerald-400"></i>
                    {f.displayName || 'Authenticator app'}
                  </span>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => handleRemove(f.uid)}
                    className="text-xs text-red-400 hover:text-red-300 disabled:opacity-50"
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <button
              type="button"
              disabled={busy}
              onClick={handleStart}
              className="px-4 py-2 rounded-lg text-sm font-semibold bg-brand-500 hover:bg-brand-400 text-slate-950 disabled:opacity-50"
            >
              {busy ? 'Starting…' : 'Set up authenticator app'}
            </button>
          )}
        </div>
      )}

      {step === 'confirming' && secret && (
        <form onSubmit={handleConfirm} className="mt-4 space-y-3">
          <p className="text-xs text-slate-400">
            Scan this with Google Authenticator, Authy, or 1Password:
          </p>
          {qrDataUrl && (
            <div className="bg-white rounded-lg p-3 w-fit">
              <img src={qrDataUrl} alt="Scan this QR code with your authenticator app" width={220} height={220} />
            </div>
          )}
          <details className="text-xs text-slate-500">
            <summary className="cursor-pointer hover:text-slate-300">Can&apos;t scan? Enter the key manually</summary>
            <div className="mt-2 bg-slate-900/70 border border-slate-800 rounded-lg px-3 py-2 font-mono text-sm text-brand-300 break-all select-all">
              {secret.secretKey}
            </div>
            <p className="mt-1">Account name: {user?.email} · Issuer: BINUS Attendance Dashboard</p>
          </details>
          <input
            type="text"
            inputMode="numeric"
            autoFocus
            value={code}
            onChange={e => setCode(e.target.value.replace(/[^0-9]/g, '').slice(0, 6))}
            placeholder="Enter 6-digit code"
            maxLength={6}
            required
            className="w-full bg-slate-950/50 border border-slate-700 rounded-lg py-2 px-3 text-center tracking-[0.4em] text-white placeholder-slate-600 focus:outline-none focus:border-brand-500"
          />
          <div className="flex gap-2">
            <button
              type="submit"
              disabled={busy || code.length !== 6}
              className="px-4 py-2 rounded-lg text-sm font-semibold bg-brand-500 hover:bg-brand-400 text-slate-950 disabled:opacity-50"
            >
              {busy ? 'Verifying…' : 'Confirm'}
            </button>
            <button
              type="button"
              onClick={() => { setStep('idle'); setSecret(null); setQrDataUrl(null); setCode(''); setError(''); }}
              className="px-4 py-2 rounded-lg text-sm text-slate-400 hover:text-slate-200"
            >
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
