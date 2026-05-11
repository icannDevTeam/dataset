/**
 * lib/session-cookie.js — HMAC-signed `__session` cookie helpers (CJS).
 *
 * The signing logic lives here so both the API route that issues the cookie
 * (pages/api/auth/session.js) and the RBAC wrapper (lib/api-auth.js) verify
 * with the exact same code. No drift, no fallbacks.
 *
 * Cookie format: base64( "<email>:<timestampMs>:<hmacSha256(payload)>" )
 * where payload is "<email>:<timestampMs>".
 *
 * Secret resolution: SESSION_SECRET || DASHBOARD_API_KEY. If neither is set,
 * verifyCookie returns null (fail-closed); signCookie throws.
 */

const crypto = require('crypto');

const SESSION_MAX_AGE_SEC = 60 * 60; // 60 minutes
const SESSION_MAX_AGE_MS = SESSION_MAX_AGE_SEC * 1000;

function _secret() {
  return process.env.SESSION_SECRET || process.env.DASHBOARD_API_KEY || null;
}

function signCookie(payload) {
  const secret = _secret();
  if (!secret) throw new Error('SESSION_SECRET (or DASHBOARD_API_KEY) is not set; refusing to sign cookies.');
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  return Buffer.from(`${payload}:${sig}`).toString('base64');
}

function verifyCookie(cookie) {
  const secret = _secret();
  if (!secret || !cookie) return null;
  try {
    const decoded = Buffer.from(cookie, 'base64').toString();
    const lastColon = decoded.lastIndexOf(':');
    if (lastColon === -1) return null;
    const payload = decoded.substring(0, lastColon);
    const sig = decoded.substring(lastColon + 1);
    const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');
    const sigBuf = Buffer.from(sig);
    const expBuf = Buffer.from(expected);
    if (sigBuf.length !== expBuf.length) return null;
    if (!crypto.timingSafeEqual(sigBuf, expBuf)) return null;
    const parts = payload.split(':');
    const timestamp = parseInt(parts[parts.length - 1], 10);
    if (isNaN(timestamp) || Date.now() - timestamp > SESSION_MAX_AGE_MS) return null;
    return { email: parts.slice(0, -1).join(':'), timestamp };
  } catch {
    return null;
  }
}

module.exports = {
  signCookie,
  verifyCookie,
  SESSION_MAX_AGE_SEC,
  SESSION_MAX_AGE_MS,
};
