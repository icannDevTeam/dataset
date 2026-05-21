/**
 * /p/[code] — Short-link redirector for parent pickup onboarding.
 *
 * Looks up the 6-char code in Firestore `pickupShortLinks/{code}`, increments
 * a hit counter, then 302-redirects to /pickup/onboarding/<token>.
 *
 * Public (no Firebase Auth); whitelisted in middleware.js. Used so parents
 * can be sent a short link like  https://dataset-sigma.vercel.app/p/K7M3Q9
 * instead of the full 200-char signed token URL.
 */
import Head from 'next/head';
import { getFirestoreDB, initializeFirebase } from '../../lib/firebase-admin';

const BRAND = {
  navy: '#003D7A',
  orange: '#F58220',
  bg: '#F4F6FB',
  surface: '#FFFFFF',
  border: '#E2E8F0',
  text: '#0F172A',
  textMuted: '#475569',
};

const FONT_STACK =
  '"Plus Jakarta Sans", "Inter", -apple-system, BlinkMacSystemFont, ' +
  '"Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

export async function getServerSideProps({ params, res }) {
  const raw = String(params.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (raw.length < 4 || raw.length > 12) {
    return { props: { reason: 'malformed' } };
  }

  try {
    initializeFirebase();
    const db = getFirestoreDB();
    const ref = db.collection('pickupShortLinks').doc(raw);
    const snap = await ref.get();
    if (!snap.exists) {
      return { props: { reason: 'not_found', code: raw } };
    }
    const data = snap.data() || {};
    const token = data.token;
    if (!token) {
      return { props: { reason: 'malformed', code: raw } };
    }
    const expMs = Number(data.exp || 0);
    if (expMs && Date.now() > expMs) {
      return { props: { reason: 'expired', code: raw } };
    }

    // Fire-and-forget hit counter — don't block the redirect on it.
    ref
      .update({
        hits: (Number(data.hits) || 0) + 1,
        lastHitAt: Date.now(),
      })
      .catch(() => {});

    // Server-side 302 — works without JS, no client flash.
    res.writeHead(302, { Location: `/pickup/onboarding/${encodeURIComponent(token)}` });
    res.end();
    return { props: { reason: 'redirecting' } };
  } catch (err) {
    console.error('[/p/[code]] resolve error:', err.message);
    return { props: { reason: 'server_error' } };
  }
}

export default function ShortLinkPage({ reason, code }) {
  const title =
    reason === 'expired'
      ? 'Link Expired'
      : reason === 'not_found'
      ? 'Link Not Found'
      : reason === 'malformed'
      ? 'Invalid Link'
      : reason === 'server_error'
      ? 'Service Unavailable'
      : 'Redirecting…';
  const message =
    reason === 'expired'
      ? 'This pickup-registration link has expired. Please contact the school office to request a new one.'
      : reason === 'not_found'
      ? `We could not find a registration link with the code "${code || ''}". Please double-check the code or contact the school office.`
      : reason === 'malformed'
      ? 'The link in your message looks incomplete. Please ensure you copied the full code, or contact the school office.'
      : reason === 'server_error'
      ? 'We could not look up your link right now. Please try again in a moment.'
      : 'Opening your registration form…';

  return (
    <>
      <Head>
        <title>{title} · BINUS School Simprug Pickup</title>
        <meta name="viewport" content="width=device-width,initial-scale=1" />
      </Head>
      <div
        style={{
          minHeight: '100vh',
          background: BRAND.bg,
          fontFamily: FONT_STACK,
          color: BRAND.text,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 20,
        }}
      >
        <div
          style={{
            background: BRAND.surface,
            border: `1px solid ${BRAND.border}`,
            borderRadius: 16,
            padding: '40px 32px',
            maxWidth: 480,
            width: '100%',
            textAlign: 'center',
            boxShadow: '0 4px 12px rgba(15,23,42,0.06)',
          }}
        >
          <img
            src="/binus-logo.jpg"
            alt="BINUS School Simprug"
            style={{ width: 84, height: 84, borderRadius: 14, marginBottom: 18 }}
          />
          <div
            style={{
              fontSize: 11,
              color: BRAND.textMuted,
              letterSpacing: 1.5,
              textTransform: 'uppercase',
              fontWeight: 700,
            }}
          >
            BINUS School Simprug · Pickup
          </div>
          <h1 style={{ margin: '12px 0 14px', fontSize: 22, color: BRAND.navy }}>{title}</h1>
          <p style={{ color: BRAND.textMuted, fontSize: 14.5, lineHeight: 1.55, margin: 0 }}>
            {message}
          </p>
          {reason !== 'redirecting' && (
            <a
              href="/p"
              style={{
                display: 'inline-block',
                marginTop: 22,
                padding: '10px 22px',
                background: BRAND.navy,
                color: '#fff',
                borderRadius: 8,
                fontWeight: 600,
                textDecoration: 'none',
                fontSize: 14,
              }}
            >
              Enter code manually
            </a>
          )}
        </div>
      </div>
    </>
  );
}
