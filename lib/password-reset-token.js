/**
 * Self-service password reset — signed token helpers.
 *
 * Mirrors lib/pickup-token.js but with `purpose:'password-reset'` baked
 * in so a leaked pickup/consent token can't reset a password and
 * vice-versa.
 *
 * Token format:
 *   base64url(JSON({em, tva, exp, p:'password-reset'})).hexHmacSha256
 *
 * `tva` is the user's `tokenValidAfter` (ms epoch, 0 if unset) at the
 * moment the link was issued. Redeeming the token bumps tokenValidAfter,
 * so the claim no longer matches and every outstanding reset link dies —
 * single-use without a dedicated Firestore collection. Any other password
 * rotation (admin reissue-otp, change-password) bumps the same field and
 * has the same invalidating effect.
 */
const crypto = require('crypto');

function _getSecret() {
  return process.env.CONSENT_SIGNING_SECRET
    || process.env.SESSION_SECRET
    || process.env.DASHBOARD_API_KEY
    || null;
}

const PURPOSE = 'password-reset';
const DEFAULT_TTL_SECONDS = 30 * 60;

function _assertSecret(secret) {
  if (!secret) {
    throw new Error(
      'CONSENT_SIGNING_SECRET (or SESSION_SECRET / DASHBOARD_API_KEY) is not set; ' +
      'refusing to sign password-reset tokens.',
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

function signPasswordResetToken({ email, tokenValidAfterMs = 0, ttlSeconds = DEFAULT_TTL_SECONDS }) {
  const SECRET = _getSecret();
  _assertSecret(SECRET);
  if (!email) throw new Error('email required');
  const payload = {
    em: String(email).toLowerCase().trim(),
    tva: Number(tokenValidAfterMs) || 0,
    exp: Math.floor(Date.now() / 1000) + Number(ttlSeconds),
    p: PURPOSE,
  };
  const body = b64urlEncode(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', SECRET).update(body).digest('hex');
  return `${body}.${sig}`;
}

/**
 * @returns {{ok:true, claims:{em:string,tva:number,exp:number}} |
 *           {ok:false, reason:'token_missing'|'secret_missing'|'malformed'|'bad_signature'|'bad_payload'|'wrong_purpose'|'expired'}}
 */
function inspectPasswordResetToken(token) {
  if (!token || typeof token !== 'string') return { ok: false, reason: 'token_missing' };
  const SECRET = _getSecret();
  if (!SECRET) return { ok: false, reason: 'secret_missing' };

  const dot = token.lastIndexOf('.');
  if (dot === -1) return { ok: false, reason: 'malformed' };
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);

  const expected = crypto.createHmac('sha256', SECRET).update(body).digest('hex');
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    return { ok: false, reason: 'bad_signature' };
  }

  let claims;
  try {
    claims = JSON.parse(b64urlDecode(body));
  } catch {
    return { ok: false, reason: 'bad_payload' };
  }
  if (!claims || typeof claims !== 'object') return { ok: false, reason: 'bad_payload' };
  if (claims.p !== PURPOSE) return { ok: false, reason: 'wrong_purpose' };
  if (typeof claims.em !== 'string' || !claims.em) return { ok: false, reason: 'bad_payload' };
  if (!Number.isFinite(claims.exp)) return { ok: false, reason: 'bad_payload' };
  if (claims.exp * 1000 < Date.now()) return { ok: false, reason: 'expired' };

  return { ok: true, claims: { em: claims.em, tva: Number(claims.tva) || 0, exp: claims.exp } };
}

module.exports = {
  signPasswordResetToken,
  inspectPasswordResetToken,
  PASSWORD_RESET_TTL_SECONDS: DEFAULT_TTL_SECONDS,
};
