/**
 * POST /api/pickup/short-link/resolve
 *
 * Body: { code: "K7M3Q9" }
 * Returns: { ok: true, token } | { ok: false, reason }
 *
 * Public endpoint (no auth) — used by the /p landing page so parents can
 * manually enter the short code from their invitation message. The returned
 * token is then opened at /pickup/onboarding/<token>, which performs the
 * real HMAC signature + purpose + expiry validation.
 *
 * Rate-limited by IP (in-memory, best-effort) to deter brute-forcing of
 * the short-code namespace.
 */
import { getFirestoreDB, initializeFirebase } from '../../../../lib/firebase-admin';

// ── Tiny per-IP rate limiter (best-effort, per-warm-instance) ────────
const RATE_WINDOW_MS = 60 * 1000;
const RATE_MAX = 12; // 12 attempts / minute / IP per warm Lambda
const ipHits = new Map(); // ip -> [timestamps]

function rateLimited(ip) {
  const now = Date.now();
  const arr = (ipHits.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS);
  arr.push(now);
  ipHits.set(ip, arr);
  return arr.length > RATE_MAX;
}

function clientIp(req) {
  const xf = req.headers['x-forwarded-for'];
  if (xf) return String(xf).split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, reason: 'method_not_allowed' });
  }

  if (rateLimited(clientIp(req))) {
    return res.status(429).json({ ok: false, reason: 'rate_limited' });
  }

  const code = String(req.body?.code || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
  if (code.length < 4 || code.length > 12) {
    return res.status(400).json({ ok: false, reason: 'malformed' });
  }

  try {
    initializeFirebase();
    const db = getFirestoreDB();
    const ref = db.collection('pickupShortLinks').doc(code);
    const snap = await ref.get();
    if (!snap.exists) {
      return res.status(404).json({ ok: false, reason: 'not_found' });
    }
    const data = snap.data() || {};
    if (!data.token) {
      return res.status(404).json({ ok: false, reason: 'malformed' });
    }
    const expMs = Number(data.exp || 0);
    if (expMs && Date.now() > expMs) {
      return res.status(410).json({ ok: false, reason: 'expired' });
    }

    ref
      .update({
        hits: (Number(data.hits) || 0) + 1,
        lastHitAt: Date.now(),
      })
      .catch(() => {});

    return res.status(200).json({ ok: true, token: data.token });
  } catch (err) {
    console.error('[short-link/resolve]', err.message);
    return res.status(500).json({ ok: false, reason: 'server_error' });
  }
}
