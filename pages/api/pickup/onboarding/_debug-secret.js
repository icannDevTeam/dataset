/**
 * GET /api/pickup/onboarding/_debug-secret
 *
 * Public, intentionally NOT auth-gated so we can hit it during a
 * post-deploy smoke test without juggling cookies. Returns ONLY a
 * fingerprint — never the raw secret. Compare its `activeFingerprint`
 * to /api/pickup/admin/_debug-secret to detect bundle/env drift between
 * the sign and verify lambdas.
 *
 * Rate-limited to thwart brute-force fingerprint inference.
 */
const crypto = require('crypto');
const { enforceRateLimit, clientIp } = require('../../../../lib/rate-limit');

function fingerprint(v) {
  if (!v) return null;
  return crypto.createHmac('sha256', 'fp').update(String(v)).digest('hex').slice(0, 12);
}

export default function handler(req, res) {
  const rl = enforceRateLimit('pickup:debug-secret', clientIp(req), { max: 6, windowMs: 60_000 });
  if (!rl.allowed) {
    res.setHeader('Retry-After', rl.retryAfter);
    return res.status(429).json({ error: 'rate_limited' });
  }
  const c = process.env.CONSENT_SIGNING_SECRET || '';
  const s = process.env.SESSION_SECRET || '';
  const d = process.env.DASHBOARD_API_KEY || '';
  const active = c || s || d || '';
  let activeSource = null;
  if (c) activeSource = 'CONSENT_SIGNING_SECRET';
  else if (s) activeSource = 'SESSION_SECRET';
  else if (d) activeSource = 'DASHBOARD_API_KEY';
  return res.status(200).json({
    activeSource,
    activeFingerprint: fingerprint(active),
    consentPresent: !!c,
    sessionPresent: !!s,
    dashboardPresent: !!d,
    vercelEnv: process.env.VERCEL_ENV || null,
    region: process.env.VERCEL_REGION || null,
    gitSha: (process.env.VERCEL_GIT_COMMIT_SHA || '').slice(0, 7) || null,
  });
}
