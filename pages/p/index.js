/**
 * /p — Branded BINUS School Simprug pickup landing page.
 *
 * Public, no auth. Lets a parent type the 6-char code from their WhatsApp
 * invite (in case the long link was truncated). On submit, POSTs to
 * /api/pickup/short-link/resolve which returns { ok, token }.
 */
import { useState } from 'react';
import Head from 'next/head';
import { useRouter } from 'next/router';

const BRAND = {
  navy: '#003D7A',
  navyDark: '#002A55',
  orange: '#F58220',
  bg: '#F4F6FB',
  surface: '#FFFFFF',
  border: '#E2E8F0',
  borderStrong: '#CBD5E1',
  text: '#0F172A',
  textMuted: '#475569',
  danger: '#B91C1C',
  dangerBg: '#FEF2F2',
};

const FONT_STACK =
  '"Plus Jakarta Sans", "Inter", -apple-system, BlinkMacSystemFont, ' +
  '"Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

export default function PickupLanding() {
  const router = useRouter();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  function onCodeChange(e) {
    // Force uppercase, strip non-alphanumeric, cap at 12 chars
    const v = String(e.target.value || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
    setCode(v);
    if (err) setErr('');
  }

  async function onSubmit(e) {
    e.preventDefault();
    if (busy) return;
    const c = code.trim();
    if (c.length < 4) {
      setErr('Please enter the full code from your invitation.');
      return;
    }
    setBusy(true);
    setErr('');
    try {
      const r = await fetch('/api/pickup/short-link/resolve', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: c }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok || !j.token) {
        setErr(
          j.reason === 'expired'
            ? 'This code has expired. Please request a new invitation from the school.'
            : j.reason === 'not_found'
            ? 'We could not find that code. Please re-check and try again.'
            : 'Something went wrong. Please try again, or contact the school office.'
        );
        setBusy(false);
        return;
      }
      router.replace(`/pickup/onboarding/${encodeURIComponent(j.token)}`);
    } catch {
      setErr('Network error. Please try again.');
      setBusy(false);
    }
  }

  return (
    <>
      <Head>
        <title>Parent Pickup Registration · BINUS School Simprug</title>
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <meta
          name="description"
          content="Register family members authorized to collect your child from BINUS School Simprug."
        />
      </Head>
      <div
        style={{
          minHeight: '100vh',
          background: `linear-gradient(135deg, ${BRAND.bg} 0%, #E8EFF9 100%)`,
          fontFamily: FONT_STACK,
          color: BRAND.text,
        }}
      >
        {/* Header band */}
        <div
          style={{
            background: BRAND.navy,
            color: '#fff',
            padding: '14px 22px',
            display: 'flex',
            alignItems: 'center',
            gap: 12,
          }}
        >
          <img
            src="/binus-logo.jpg"
            alt=""
            style={{ width: 36, height: 36, borderRadius: 8 }}
          />
          <div>
            <div style={{ fontSize: 13, fontWeight: 700, letterSpacing: 0.3 }}>
              BINUS School Simprug
            </div>
            <div style={{ fontSize: 11, opacity: 0.8, letterSpacing: 0.4 }}>
              Pickup Authorization Portal
            </div>
          </div>
        </div>

        {/* Main */}
        <div
          style={{
            maxWidth: 520,
            margin: '0 auto',
            padding: '36px 22px 60px',
          }}
        >
          <div
            style={{
              background: BRAND.surface,
              border: `1px solid ${BRAND.border}`,
              borderRadius: 16,
              padding: '32px 28px',
              boxShadow: '0 4px 12px rgba(15,23,42,0.06)',
            }}
          >
            <div
              style={{
                fontSize: 11,
                color: BRAND.orange,
                letterSpacing: 1.5,
                textTransform: 'uppercase',
                fontWeight: 700,
                marginBottom: 10,
              }}
            >
              Parent Self-Service
            </div>
            <h1
              style={{
                margin: 0,
                fontSize: 24,
                color: BRAND.navyDark,
                lineHeight: 1.25,
                fontWeight: 700,
              }}
            >
              Welcome to BINUS Simprug Pickup Registration
            </h1>
            <p
              style={{
                marginTop: 12,
                color: BRAND.textMuted,
                fontSize: 14.5,
                lineHeight: 1.6,
              }}
            >
              Please enter the 6-character code from the invitation message sent
              to you by the school. The full form lets you register parents,
              guardians, drivers or other adults authorized to collect your child.
            </p>

            <form onSubmit={onSubmit} style={{ marginTop: 22 }}>
              <label
                htmlFor="code"
                style={{
                  display: 'block',
                  fontSize: 12,
                  color: BRAND.textMuted,
                  fontWeight: 700,
                  letterSpacing: 1,
                  textTransform: 'uppercase',
                  marginBottom: 8,
                }}
              >
                Invitation code
              </label>
              <input
                id="code"
                type="text"
                inputMode="text"
                autoCapitalize="characters"
                autoCorrect="off"
                spellCheck="false"
                autoComplete="off"
                value={code}
                onChange={onCodeChange}
                placeholder="e.g. K7M3Q9"
                style={{
                  width: '100%',
                  padding: '14px 16px',
                  border: `1.5px solid ${err ? BRAND.danger : BRAND.borderStrong}`,
                  borderRadius: 10,
                  fontSize: 22,
                  fontFamily:
                    'ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace',
                  letterSpacing: 6,
                  textAlign: 'center',
                  textTransform: 'uppercase',
                  color: BRAND.navyDark,
                  fontWeight: 600,
                  background: BRAND.surface,
                  boxSizing: 'border-box',
                  outline: 'none',
                }}
              />
              {err && (
                <div
                  style={{
                    marginTop: 10,
                    padding: '10px 12px',
                    border: `1px solid ${BRAND.danger}`,
                    background: BRAND.dangerBg,
                    color: BRAND.danger,
                    borderRadius: 8,
                    fontSize: 13.5,
                    lineHeight: 1.45,
                  }}
                >
                  {err}
                </div>
              )}

              <button
                type="submit"
                disabled={busy || code.length < 4}
                style={{
                  marginTop: 18,
                  width: '100%',
                  padding: '14px 22px',
                  background:
                    busy || code.length < 4 ? '#94A3B8' : BRAND.navy,
                  color: '#fff',
                  border: 'none',
                  borderRadius: 10,
                  fontSize: 15,
                  fontWeight: 700,
                  letterSpacing: 0.3,
                  cursor: busy || code.length < 4 ? 'not-allowed' : 'pointer',
                  fontFamily: 'inherit',
                  transition: 'background 0.15s ease',
                }}
              >
                {busy ? 'Opening…' : 'Continue'}
              </button>
            </form>

            <div
              style={{
                marginTop: 22,
                padding: '12px 14px',
                background: '#F8FAFC',
                border: `1px solid ${BRAND.border}`,
                borderRadius: 10,
                fontSize: 12.5,
                color: BRAND.textMuted,
                lineHeight: 1.55,
              }}
            >
              <strong style={{ color: BRAND.text }}>Don't have a code?</strong>{' '}
              Please contact your child's homeroom teacher or the BINUS Simprug
              school office to receive your registration link.
            </div>
          </div>

          <div
            style={{
              marginTop: 22,
              textAlign: 'center',
              fontSize: 11.5,
              color: BRAND.textMuted,
              lineHeight: 1.6,
            }}
          >
            BINUS School Simprug · Jl. Pisangan Raya, Jakarta Selatan
            <br />
            For security questions, contact the school's pickup coordinator.
          </div>
        </div>
      </div>
    </>
  );
}
