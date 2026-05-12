/**
 * lib/reauth.js — Step-up authentication for high-risk actions.
 *
 * Some actions (e.g. exporting full audit logs, bulk user changes) require
 * the caller to PROVE they still own the session by re-typing their password
 * within the last few minutes — even if their session is otherwise valid.
 *
 * This is the standard "sudo mode" pattern: a long-lived session is fine for
 * browsing, but mutating/exporting sensitive data needs a fresh credential
 * proof recorded in the audit log.
 *
 * Flow
 * ----
 * 1. Client (browser) prompts user for their password.
 * 2. Client signs in to a SECONDARY Firebase Auth app instance with that
 *    password — does NOT disturb the primary session.
 * 3. Client gets a brand-new ID token (`auth_time` ≈ now) and sends it as
 *    `X-Reauth-Token: <idToken>` on the next API call.
 * 4. Server (this module) verifies the token, ensures the email matches the
 *    already-authenticated `req.user.email`, and that `auth_time` is within
 *    `maxAgeSec` (default 300 s).
 *
 * Failure handling
 * ----------------
 * - Per-email lockout: 5 failed attempts / 15 minutes → 423 Locked.
 * - Each failure (and each success) is recorded by the caller via audit-log.
 *
 * NOTE: We never see the user's password on our servers — Firebase REST
 * does the verification. We only see the resulting fresh ID token.
 */

const admin = require('firebase-admin');

const DEFAULT_MAX_AGE_SEC = 300;       // 5 min sudo window
const LOCK_MAX_FAILURES = 5;
const LOCK_WINDOW_MS = 15 * 60 * 1000; // 15 min
const LOCK_DURATION_MS = 15 * 60 * 1000;

// In-process per-email failure tracker (good enough single-instance;
// for multi-instance, swap for Redis using the same key shape).
const _failures = new Map(); // email -> { count, firstAt, lockedUntil }

function _now() { return Date.now(); }

function recordReauthFailure(email) {
  if (!email) return;
  const e = String(email).toLowerCase();
  const now = _now();
  const cur = _failures.get(e) || { count: 0, firstAt: now, lockedUntil: 0 };
  if (now - cur.firstAt > LOCK_WINDOW_MS) {
    cur.count = 0;
    cur.firstAt = now;
    cur.lockedUntil = 0;
  }
  cur.count += 1;
  if (cur.count >= LOCK_MAX_FAILURES) {
    cur.lockedUntil = now + LOCK_DURATION_MS;
  }
  _failures.set(e, cur);
}

function recordReauthSuccess(email) {
  if (!email) return;
  _failures.delete(String(email).toLowerCase());
}

function getReauthLock(email) {
  if (!email) return null;
  const e = String(email).toLowerCase();
  const cur = _failures.get(e);
  if (!cur) return null;
  if (cur.lockedUntil && cur.lockedUntil > _now()) {
    return { lockedUntil: cur.lockedUntil, retryAfterSec: Math.ceil((cur.lockedUntil - _now()) / 1000) };
  }
  return null;
}

/**
 * Verify the X-Reauth-Token header proves a recent password entry by the
 * already-authenticated `req.user`.
 *
 * Returns:
 *   { ok: true,  authTime: <unix-sec>, ageSec, freshUntil }
 *   { ok: false, status: <int>, error: <string>, message?, retryAfterSec? }
 *
 * Caller is expected to:
 *   - return res.status(result.status).json({ error: result.error, ... })
 *     when ok===false, AFTER writing an audit log entry.
 *   - include result.authTime in audit metadata when ok===true.
 */
async function verifyReauth(req, { maxAgeSec = DEFAULT_MAX_AGE_SEC } = {}) {
  const user = req.user;
  if (!user || !user.email) {
    return { ok: false, status: 401, error: 'auth_required' };
  }

  // Lockout check
  const lock = getReauthLock(user.email);
  if (lock) {
    return {
      ok: false,
      status: 423,
      error: 'reauth_locked',
      message: 'Too many failed password attempts. Try again later.',
      retryAfterSec: lock.retryAfterSec,
    };
  }

  const token = req.headers['x-reauth-token'] || req.headers['X-Reauth-Token'];
  if (!token || typeof token !== 'string') {
    return {
      ok: false,
      status: 401,
      error: 'reauth_required',
      message: 'Confirm your password to continue.',
    };
  }

  let decoded;
  try {
    decoded = await admin.auth().verifyIdToken(token, true);
  } catch (err) {
    recordReauthFailure(user.email);
    return {
      ok: false,
      status: 401,
      error: 'reauth_failed',
      message: 'Invalid or expired re-authentication token.',
    };
  }

  const tokenEmail = (decoded.email || '').toLowerCase().trim();
  const userEmail = String(user.email).toLowerCase().trim();
  if (!tokenEmail || tokenEmail !== userEmail) {
    recordReauthFailure(user.email);
    return {
      ok: false,
      status: 401,
      error: 'reauth_email_mismatch',
      message: 'Re-authentication token does not match your session.',
    };
  }

  // auth_time is when the user actually entered their password (vs iat which
  // can be any token refresh). Standard Firebase claim, in seconds.
  const authTime = Number(decoded.auth_time || decoded.iat || 0);
  if (!authTime) {
    recordReauthFailure(user.email);
    return { ok: false, status: 401, error: 'reauth_missing_auth_time' };
  }

  const ageSec = Math.floor(_now() / 1000) - authTime;
  if (ageSec > maxAgeSec) {
    recordReauthFailure(user.email);
    return {
      ok: false,
      status: 401,
      error: 'reauth_stale',
      message: `Re-authentication is older than ${maxAgeSec}s. Try again.`,
    };
  }

  recordReauthSuccess(user.email);
  return {
    ok: true,
    authTime,
    ageSec,
    freshUntil: (authTime + maxAgeSec) * 1000,
  };
}

module.exports = {
  verifyReauth,
  recordReauthFailure,
  recordReauthSuccess,
  getReauthLock,
  DEFAULT_MAX_AGE_SEC,
};
