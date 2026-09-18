/**
 * POST /api/auth/reauth — step-up password verification for MFA users.
 *
 * TOTP-enrolled accounts can't complete a secondary client sign-in without
 * a 2FA code, so the browser can't mint a fresh Firebase token for the
 * X-Reauth-Token header. This endpoint verifies the password server-side
 * via Identity Toolkit REST: a response containing mfaPendingCredential
 * means the PASSWORD WAS CORRECT (first factor passed, second pending) —
 * good enough for sudo mode since the session already completed full MFA
 * at sign-in. Mints a short-lived HMAC sudo token verifyReauth() accepts.
 *
 * Body:  { password }
 * Reply: { ok, token }
 */
const { withApi } = require('../../../lib/api-auth');
const { mintReauthToken, recordReauthFailure, recordReauthSuccess, getReauthLock } = require('../../../lib/reauth');
const { enforceRateLimit, clientIp } = require('../../../lib/rate-limit');

const API_KEY = process.env.NEXT_PUBLIC_FIREBASE_API_KEY || 'AIzaSyClDQe4e2NpfVw4nvLG10vzK8wmdGCHJwk';

async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const limited = enforceRateLimit('auth:reauth', clientIp(req), { max: 10, windowMs: 60_000 });
  if (!limited.allowed) {
    res.setHeader('Retry-After', String(limited.retryAfter));
    return res.status(429).json({ error: 'rate_limited', retryAfter: limited.retryAfter });
  }

  const email = String(req.user?.email || '').toLowerCase().trim();
  const password = req.body?.password;
  if (!email) return res.status(401).json({ error: 'auth_required' });
  if (!password || typeof password !== 'string') {
    return res.status(400).json({ error: 'password_required' });
  }

  const lock = getReauthLock(email);
  if (lock) {
    res.setHeader('Retry-After', String(lock.retryAfterSec));
    return res.status(423).json({ error: 'reauth_locked', retryAfter: lock.retryAfterSec });
  }

  try {
    const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, returnSecureToken: true }),
    });
    const data = await r.json().catch(() => ({}));

    // Full token OR mfaPendingCredential both prove the password.
    const passwordOk = r.ok || !!data.mfaPendingCredential
      || String(data?.error?.message || '').startsWith('MFA_');
    if (!passwordOk) {
      recordReauthFailure(email);
      const msg = String(data?.error?.message || '');
      if (msg.includes('INVALID') || msg.includes('PASSWORD')) {
        return res.status(401).json({ error: 'wrong_password', message: 'Incorrect password.' });
      }
      if (msg.includes('TOO_MANY')) {
        return res.status(429).json({ error: 'too_many_attempts', message: 'Too many attempts. Try again in a few minutes.' });
      }
      return res.status(401).json({ error: 'reauth_failed', message: 'Re-authentication failed.' });
    }

    recordReauthSuccess(email);
    return res.status(200).json({ ok: true, token: mintReauthToken(email) });
  } catch (e) {
    console.error('[auth/reauth]', e.message);
    return res.status(500).json({ error: 'internal' });
  }
}

module.exports = withApi(handler, { requireUser: true, methods: ['POST'], rateLimit: 20 });
module.exports.default = module.exports;
