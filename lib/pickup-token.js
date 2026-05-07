/**
 * Pickup System — onboarding token helpers.
 *
 * Mirrors lib/consent-token.js but with `purpose:'pickup-onboarding'`
 * baked in so a leaked consent token can't open the pickup flow and
 * vice-versa.
 *
 * Token format:
 *   base64url(JSON({tid, sid?, exp, p:'pickup-onboarding'})).hexHmacSha256
 *
 * `sid` is OPTIONAL: a parent of multiple students gets one token per
 * primary student (or a tenant-scoped token with sid=null) and adds
 * siblings inside the form. The student lookup API is reused.
 */
const crypto = require('crypto');

// Resolve on every call instead of at module load. A warm Lambda whose
// process started BEFORE the env var was added would otherwise keep
// the stale value (often null/fallback) for the rest of its lifetime,
// producing tokens that subsequent cold-started Lambdas cannot verify.
function _getSecret() {
  return process.env.CONSENT_SIGNING_SECRET
    || process.env.SESSION_SECRET
    || process.env.DASHBOARD_API_KEY
    || null;
}

const PURPOSE = 'pickup-onboarding';

function _assertSecret(secret) {
  if (!secret) {
    throw new Error(
      'CONSENT_SIGNING_SECRET (or SESSION_SECRET / DASHBOARD_API_KEY) is not set; ' +
      'refusing to sign pickup tokens.',
    );
  }
}

function b64urlEncode(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/=+$/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function b64urlDecode(str) {
  str = String(str).replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return Buffer.from(str, 'base64').toString();
}

function signPickupOnboardingToken({ tenantId, studentId = null, linkId = null, ttlSeconds = 30 * 24 * 3600 }) {
  const SECRET = _getSecret();
  _assertSecret(SECRET);
  if (!tenantId) throw new Error('tenantId required');
  const payload = {
    tid: String(tenantId),
    sid: studentId ? String(studentId) : null,
    lid: linkId ? String(linkId) : null,
    exp: Math.floor(Date.now() / 1000) + Number(ttlSeconds),
    p: PURPOSE,
  };
  const body = b64urlEncode(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', SECRET).update(body).digest('hex');
  return `${body}.${sig}`;
}

/**
 * Detailed verification — returns {ok, claims?, reason?} so callers can
 * render precise error messages ("expired" vs "invalid signature" vs
 * "wrong purpose"). Reasons:
 *   token_missing | secret_missing | malformed | bad_signature |
 *   bad_payload | wrong_purpose | expired
 */
function inspectPickupOnboardingToken(token) {
  const SECRET = _getSecret();
  if (!SECRET) return { ok: false, reason: 'secret_missing' };
  if (!token || typeof token !== 'string') return { ok: false, reason: 'token_missing' };
  const dot = token.lastIndexOf('.');
  if (dot === -1) return { ok: false, reason: 'malformed' };
  const body = token.substring(0, dot);
  const sig = token.substring(dot + 1);
  const expected = crypto.createHmac('sha256', SECRET).update(body).digest('hex');
  let sigBuf, expBuf;
  try {
    sigBuf = Buffer.from(sig, 'hex');
    expBuf = Buffer.from(expected, 'hex');
  } catch { return { ok: false, reason: 'malformed' }; }
  if (sigBuf.length !== expBuf.length) return { ok: false, reason: 'bad_signature' };
  if (!crypto.timingSafeEqual(sigBuf, expBuf)) return { ok: false, reason: 'bad_signature' };
  let payload;
  try { payload = JSON.parse(b64urlDecode(body)); } catch { return { ok: false, reason: 'bad_payload' }; }
  if (!payload || !payload.tid || !payload.exp) return { ok: false, reason: 'bad_payload' };
  if (payload.p !== PURPOSE) return { ok: false, reason: 'wrong_purpose' };
  if (payload.exp < Math.floor(Date.now() / 1000)) return { ok: false, reason: 'expired', claims: payload };
  return { ok: true, claims: payload };
}

function verifyPickupOnboardingToken(token) {
  const r = inspectPickupOnboardingToken(token);
  return r.ok ? r.claims : null;
}

module.exports = {
  signPickupOnboardingToken,
  verifyPickupOnboardingToken,
  inspectPickupOnboardingToken,
  PURPOSE,
};
