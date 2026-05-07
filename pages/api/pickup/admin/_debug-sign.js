/**
 * GET /api/pickup/admin/_debug-sign
 * Signs a canary payload using the SAME pickup-token module that
 * createInvite uses. Returns the resulting token + secret fingerprint.
 * If admin's fingerprint differs from /api/pickup/onboarding/_debug-verify
 * canary, the two lambdas have different secrets despite both reading
 * process.env.CONSENT_SIGNING_SECRET.
 *
 * Public + rate-limited. To be removed after diagnosis.
 */
const crypto = require('crypto');
const { signPickupOnboardingToken } = require('../../../../lib/pickup-token');
const { enforceRateLimit, clientIp } = require('../../../../lib/rate-limit');

function fp(v) {
  if (!v) return null;
  return crypto.createHmac('sha256', 'fp').update(String(v)).digest('hex').slice(0, 12);
}

export default function handler(req, res) {
  const rl = enforceRateLimit('pickup:debug-sign', clientIp(req), { max: 6, windowMs: 60_000 });
  if (!rl.allowed) {
    res.setHeader('Retry-After', rl.retryAfter);
    return res.status(429).json({ error: 'rate_limited' });
  }
  const SECRET = process.env.CONSENT_SIGNING_SECRET
    || process.env.SESSION_SECRET
    || process.env.DASHBOARD_API_KEY
    || null;
  let token = null;
  let signError = null;
  try {
    token = signPickupOnboardingToken({ tenantId: 'binus-simprug', linkId: 'DEBUG_SIGN', ttlSeconds: 600 });
  } catch (e) {
    signError = String(e && e.message || e);
  }
  return res.status(200).json({
    secretFingerprint: fp(SECRET),
    secretSource: SECRET === process.env.CONSENT_SIGNING_SECRET ? 'CONSENT_SIGNING_SECRET'
      : SECRET === process.env.SESSION_SECRET ? 'SESSION_SECRET'
      : SECRET === process.env.DASHBOARD_API_KEY ? 'DASHBOARD_API_KEY' : null,
    secretLength: (SECRET || '').length,
    token,
    signError,
    vercel: {
      env: process.env.VERCEL_ENV || null,
      gitSha: (process.env.VERCEL_GIT_COMMIT_SHA || '').slice(0, 7) || null,
      region: process.env.VERCEL_REGION || null,
    },
  });
}
