/**
 * PickupGuard — onboarding token helpers.
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

const SECRET = process.env.CONSENT_SIGNING_SECRET
  || process.env.SESSION_SECRET
  || process.env.DASHBOARD_API_KEY
  || null;

const PURPOSE = 'pickup-onboarding';

function _assertSecret() {
  if (!SECRET) {
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

function signPickupOnboardingToken({ tenantId, studentId = null, ttlSeconds = 30 * 24 * 3600 }) {
  _assertSecret();
  if (!tenantId) throw new Error('tenantId required');
  const payload = {
    tid: String(tenantId),
    sid: studentId ? String(studentId) : null,
    exp: Math.floor(Date.now() / 1000) + Number(ttlSeconds),
    p: PURPOSE,
  };
  const body = b64urlEncode(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', SECRET).update(body).digest('hex');
  return `${body}.${sig}`;
}

function verifyPickupOnboardingToken(token) {
  if (!SECRET || !token || typeof token !== 'string') return null;
  const dot = token.lastIndexOf('.');
  if (dot === -1) return null;
  const body = token.substring(0, dot);
  const sig = token.substring(dot + 1);
  const expected = crypto.createHmac('sha256', SECRET).update(body).digest('hex');
  let sigBuf, expBuf;
  try {
    sigBuf = Buffer.from(sig, 'hex');
    expBuf = Buffer.from(expected, 'hex');
  } catch { return null; }
  if (sigBuf.length !== expBuf.length) return null;
  if (!crypto.timingSafeEqual(sigBuf, expBuf)) return null;
  let payload;
  try { payload = JSON.parse(b64urlDecode(body)); } catch { return null; }
  if (!payload || !payload.tid || !payload.exp) return null;
  if (payload.p !== PURPOSE) return null;
  if (payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
}

module.exports = { signPickupOnboardingToken, verifyPickupOnboardingToken, PURPOSE };
