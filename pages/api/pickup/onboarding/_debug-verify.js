/**
 * POST /api/pickup/onboarding/_debug-verify
 * Body: { token: "..." }
 *
 * Returns the body, the supplied sig, AND the sig that THIS lambda
 * computes for that body. If they differ, the create-invite lambda
 * is using a different secret than this verify lambda.
 *
 * Public + rate-limited. To be removed after diagnosis.
 */
const crypto = require('crypto');
const { enforceRateLimit, clientIp } = require('../../../../lib/rate-limit');

function getSecret() {
  return process.env.CONSENT_SIGNING_SECRET
    || process.env.SESSION_SECRET
    || process.env.DASHBOARD_API_KEY
    || null;
}

function fp(v) {
  if (!v) return null;
  return crypto.createHmac('sha256', 'fp').update(String(v)).digest('hex').slice(0, 12);
}

export default function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const rl = enforceRateLimit('pickup:debug-verify', clientIp(req), { max: 6, windowMs: 60_000 });
  if (!rl.allowed) {
    res.setHeader('Retry-After', rl.retryAfter);
    return res.status(429).json({ error: 'rate_limited' });
  }
  const { token } = req.body || {};
  if (!token || typeof token !== 'string') return res.status(400).json({ error: 'token required' });
  const dot = token.lastIndexOf('.');
  if (dot === -1) return res.status(400).json({ error: 'malformed token' });
  const body = token.substring(0, dot);
  const suppliedSig = token.substring(dot + 1);
  const SECRET = getSecret();
  const expectedSig = SECRET
    ? crypto.createHmac('sha256', SECRET).update(body).digest('hex')
    : null;
  const match = !!(expectedSig && expectedSig === suppliedSig);

  // also sign a fresh canary payload so we can compare across lambdas
  const canaryPayload = Buffer.from(JSON.stringify({ probe: 'sign-from-verify-lambda', t: Date.now() }))
    .toString('base64').replace(/=+$/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const canarySig = SECRET
    ? crypto.createHmac('sha256', SECRET).update(canaryPayload).digest('hex')
    : null;

  return res.status(200).json({
    match,
    secretFingerprint: fp(SECRET),
    secretSource: SECRET === process.env.CONSENT_SIGNING_SECRET ? 'CONSENT_SIGNING_SECRET'
      : SECRET === process.env.SESSION_SECRET ? 'SESSION_SECRET'
      : SECRET === process.env.DASHBOARD_API_KEY ? 'DASHBOARD_API_KEY' : null,
    suppliedSig: suppliedSig.slice(0, 16) + '…',
    expectedSig: (expectedSig || '').slice(0, 16) + '…',
    canary: { payload: canaryPayload, sig: canarySig, fullToken: canarySig ? `${canaryPayload}.${canarySig}` : null },
    vercel: {
      env: process.env.VERCEL_ENV || null,
      gitSha: (process.env.VERCEL_GIT_COMMIT_SHA || '').slice(0, 7) || null,
      region: process.env.VERCEL_REGION || null,
    },
  });
}
