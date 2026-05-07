/**
 * GET /api/pickup/admin/_debug-secret
 *
 * Diagnostic — does NOT leak the secret value, only metadata about
 * which env var is being used for pickup-token signing. Helps catch
 * deployments where /admin (signs) and /onboarding (verifies) end up
 * using different secrets due to env-var drift.
 *
 * Returns:
 *   {
 *     consent: { present, length, sha256_8 },
 *     session: { present, length },
 *     dashboard: { present, length },
 *     activeSource: 'CONSENT_SIGNING_SECRET' | 'SESSION_SECRET' | 'DASHBOARD_API_KEY' | null,
 *     activeFingerprint: '<8-hex-chars-of-sha256>',
 *     vercel: { env, region, deploymentUrl, gitSha }
 *   }
 *
 * Temporarily NOT auth-gated so we can compare its fingerprint against
 * /api/pickup/onboarding/_debug-secret to diagnose sign/verify drift.
 * Re-add withAuth() once the diagnosis is complete.
 */
const crypto = require('crypto');

function fingerprint(v) {
  if (!v) return null;
  return crypto.createHmac('sha256', 'fp').update(String(v)).digest('hex').slice(0, 12);
}

async function handler(req, res) {
  const c = process.env.CONSENT_SIGNING_SECRET || '';
  const s = process.env.SESSION_SECRET || '';
  const d = process.env.DASHBOARD_API_KEY || '';
  const active = c || s || d || '';
  let activeSource = null;
  if (c) activeSource = 'CONSENT_SIGNING_SECRET';
  else if (s) activeSource = 'SESSION_SECRET';
  else if (d) activeSource = 'DASHBOARD_API_KEY';
  return res.status(200).json({
    consent:   { present: !!c, length: c.length, fp: fingerprint(c) },
    session:   { present: !!s, length: s.length, fp: fingerprint(s) },
    dashboard: { present: !!d, length: d.length, fp: fingerprint(d) },
    activeSource,
    activeFingerprint: fingerprint(active),
    vercel: {
      env: process.env.VERCEL_ENV || null,
      region: process.env.VERCEL_REGION || null,
      deploymentUrl: process.env.VERCEL_URL || null,
      gitSha: process.env.VERCEL_GIT_COMMIT_SHA || null,
    },
  });
}

export default handler;
