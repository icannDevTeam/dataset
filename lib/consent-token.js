/**
 * Consent token helpers — Phase B3.
 *
 * Generates and verifies short-lived HMAC tokens carrying:
 *   { tid, sid, exp }   (tenant id, student id, unix expiry seconds)
 *
 * Used in the guardian-facing consent flow: an admin mints a token,
 * emails the guardian a link like
 *   https://.../consent/<token>
 * and the guardian-facing page presents the policy + records consent
 * without ever needing a Firebase account.
 *
 * Token format:
 *   base64url(JSON({tid,sid,exp})).hexHmacSha256
 */
const crypto = require('crypto');

const SECRET = process.env.CONSENT_SIGNING_SECRET
  || process.env.SESSION_SECRET
  || process.env.DASHBOARD_API_KEY
  || null;

function _assertSecret() {
  if (!SECRET) {
    throw new Error(
      'CONSENT_SIGNING_SECRET (or SESSION_SECRET / DASHBOARD_API_KEY) is not set; ' +
      'refusing to sign consent tokens.',
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

/**
 * Mint a consent token.
 * @param {Object} args
 * @param {string} args.tenantId
 * @param {string} args.studentId
 * @param {number} [args.ttlSeconds=2592000] - default 30 days
 */
function signConsentToken({ tenantId, studentId, ttlSeconds = 30 * 24 * 3600 }) {
  _assertSecret();
  if (!tenantId || !studentId) throw new Error('tenantId + studentId required');
  const payload = {
    tid: String(tenantId),
    sid: String(studentId),
    exp: Math.floor(Date.now() / 1000) + Number(ttlSeconds),
  };
  const body = b64urlEncode(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', SECRET).update(body).digest('hex');
  return `${body}.${sig}`;
}

/**
 * Verify a consent token. Returns payload {tid, sid, exp} or null.
 */
function verifyConsentToken(token) {
  if (!SECRET || !token || typeof token !== 'string') return null;
  const dot = token.lastIndexOf('.');
  if (dot === -1) return null;
  const body = token.substring(0, dot);
  const sig = token.substring(dot + 1);
  const expected = crypto.createHmac('sha256', SECRET).update(body).digest('hex');
  // Timing-safe compare
  let sigBuf, expBuf;
  try {
    sigBuf = Buffer.from(sig, 'hex');
    expBuf = Buffer.from(expected, 'hex');
  } catch { return null; }
  if (sigBuf.length !== expBuf.length) return null;
  if (!crypto.timingSafeEqual(sigBuf, expBuf)) return null;
  let payload;
  try {
    payload = JSON.parse(b64urlDecode(body));
  } catch { return null; }
  if (!payload || !payload.tid || !payload.sid || !payload.exp) return null;
  if (payload.exp < Math.floor(Date.now() / 1000)) return null;
  // Reject tokens minted for a different purpose (e.g. pickup-onboarding).
  // Legacy consent tokens carry no `p` claim and remain valid.
  if (payload.p && payload.p !== 'consent') return null;
  return payload;
}

module.exports = { signConsentToken, verifyConsentToken };
