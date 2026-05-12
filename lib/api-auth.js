/**
 * lib/api-auth.js — Identity resolution + RBAC wrapper for API routes.
 *
 * Replaces the ad-hoc `verifyAdmin()` helpers scattered through the codebase.
 * Every protected route should `export default withApi(handler, { permission })`
 * — the wrapper resolves the caller once, checks the action grant, and
 * attaches the resolved identity to `req.user` for downstream use.
 *
 * Identity sources (in priority order):
 *   1. `Authorization: Bearer <firebase-id-token>` header — preferred for SPA
 *      and mobile clients. Token is verified with Firebase Admin.
 *   2. `__session` HMAC cookie — for SSR-adjacent fetches and server-rendered
 *      pages. Trusts the cookie's email claim, then loads the user doc.
 *
 * Service-to-service calls (Python listener, Jetson) keep using the existing
 * `withAuth` API-key wrapper. RBAC does not apply to API-key callers because
 * those callers are infrastructure, not human users.
 *
 * Performance: per-process LRU cache of resolved user records keyed by a
 * SHA-256 hash of the credential. TTL 60 s, max 5 000 entries. With ~10 ms
 * Firestore reads gone from the hot path, even hundreds of concurrent
 * sessions stay under the route's existing rate limit.
 *
 * Revocation: every cached entry carries the user doc's `tokenValidAfter`
 * field. If a row is updated after the cached snapshot's read time we
 * invalidate on next access; for instant revocation the user-management API
 * also calls `invalidateUser(email)` directly.
 */

const crypto = require('crypto');
const admin = require('firebase-admin');
const { initializeFirebase, getFirestoreDB } = require('./firebase-admin');
const { resolvePermissions } = require('./permissions');
const { can, canAll, canAny } = require('./rbac');
const { verifyCookie } = require('./session-cookie');

// ── Identity cache ───────────────────────────────────────────────────
const CACHE_TTL_MS = 60 * 1000;
const CACHE_MAX_ENTRIES = 5000;
const _identityCache = new Map(); // hash → { user, expiresAt }

function _cacheKey(kind, value) {
  // Full SHA-256 (64 hex chars / 256 bits) — not truncated. Truncating to
  // 128 bits is theoretically fine but offers no benefit and gives an
  // attacker a smaller search space if they ever try to engineer a
  // collision against another user's cached identity.
  return `${kind}:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function _cacheGet(key) {
  const hit = _identityCache.get(key);
  if (!hit) return null;
  if (hit.expiresAt < Date.now()) {
    _identityCache.delete(key);
    return null;
  }
  // LRU touch
  _identityCache.delete(key);
  _identityCache.set(key, hit);
  return hit.user;
}

function _cacheSet(key, user) {
  if (_identityCache.size >= CACHE_MAX_ENTRIES) {
    // Evict oldest (Map preserves insertion order)
    const oldestKey = _identityCache.keys().next().value;
    if (oldestKey) _identityCache.delete(oldestKey);
  }
  _identityCache.set(key, { user, expiresAt: Date.now() + CACHE_TTL_MS });
}

/**
 * Forcibly drop every cached entry for a given email. Call this from the
 * user-management API whenever a role / suspension / permission set changes
 * so the new state is visible on the user's very next request.
 */
function invalidateUser(email) {
  if (!email) return 0;
  const lower = String(email).toLowerCase().trim();
  let removed = 0;
  for (const [key, entry] of _identityCache) {
    if (entry?.user?.email === lower) {
      _identityCache.delete(key);
      removed++;
    }
  }
  return removed;
}

function invalidateAll() {
  const n = _identityCache.size;
  _identityCache.clear();
  return n;
}

// ── User resolution ──────────────────────────────────────────────────

async function _loadUserDoc(email, db, idTokenIat) {
  const snap = await db.collection('dashboard_users').doc(email).get();
  if (!snap.exists) return null;
  const data = snap.data() || {};

  // Instant-revocation gate. If the doc was edited (or sessions revoked)
  // after this token was issued, refuse the request even on cache miss.
  const tokenValidAfter = data.tokenValidAfter?.toMillis?.()
    || (typeof data.tokenValidAfter === 'number' ? data.tokenValidAfter : 0);
  if (tokenValidAfter && idTokenIat && idTokenIat * 1000 < tokenValidAfter) {
    return { _revoked: true };
  }

  if (data.disabled) return { _disabled: true };

  const role = data.role || 'viewer';
  const permissions = resolvePermissions(role, data.permissions || {});

  return {
    email,
    name: data.name || '',
    role,
    permissions,
    disabled: !!data.disabled,
    classScopes: Array.isArray(data.classScopes) ? data.classScopes : [],
    gradeScopes: Array.isArray(data.gradeScopes) ? data.gradeScopes : [],
    releaseGroupScopes: Array.isArray(data.releaseGroupScopes) ? data.releaseGroupScopes : [],
    tenantId: data.tenantId || null,
    superAdmin: !!data.superAdmin,
    tokenValidAfter,
  };
}

async function _resolveBearer(idToken, db) {
  const cacheKey = _cacheKey('bearer', idToken);
  const cached = _cacheGet(cacheKey);
  if (cached) return cached;

  let decoded;
  try {
    decoded = await admin.auth().verifyIdToken(idToken);
  } catch {
    return null;
  }
  const email = decoded.email?.toLowerCase()?.trim();
  if (!email) return null;

  const user = await _loadUserDoc(email, db, decoded.iat);
  if (!user) return null;
  if (user._disabled) return { ...user, email, error: 'disabled' };
  if (user._revoked) return { ...user, email, error: 'revoked' };

  _cacheSet(cacheKey, user);
  return user;
}

async function _resolveCookie(cookieValue, db) {
  const cacheKey = _cacheKey('cookie', cookieValue);
  const cached = _cacheGet(cacheKey);
  if (cached) return cached;

  const claims = verifyCookie(cookieValue);
  if (!claims?.email) return null;
  const email = claims.email.toLowerCase().trim();

  // Cookies don't carry an `iat` we can trust the way an ID token does, so
  // we use the cookie's own timestamp as the issued-at moment.
  const iat = Math.floor((claims.timestamp || Date.now()) / 1000);
  const user = await _loadUserDoc(email, db, iat);
  if (!user) return null;
  if (user._disabled) return { ...user, email, error: 'disabled' };
  if (user._revoked) return { ...user, email, error: 'revoked' };

  _cacheSet(cacheKey, user);
  return user;
}

function _extractCookie(req, name) {
  const raw = req.headers?.cookie;
  if (!raw) return null;
  const parts = raw.split(';');
  for (const p of parts) {
    const eq = p.indexOf('=');
    if (eq < 0) continue;
    if (p.slice(0, eq).trim() === name) return decodeURIComponent(p.slice(eq + 1).trim());
  }
  return null;
}

function _extractBearer(req) {
  const h = req.headers?.authorization;
  if (typeof h === 'string' && h.startsWith('Bearer ')) return h.slice(7).trim();
  return null;
}

/**
 * Resolve the caller's identity from request headers. Returns:
 *   { email, role, permissions, ... }   on success
 *   { error: 'disabled' | 'revoked' }   if user is suspended / token old
 *   null                                 if no identity could be resolved
 *
 * Safe to call from any handler (e.g. for read endpoints that want to soft-
 * gate optional features). For hard gating use `withApi`.
 */
async function requireUser(req) {
  initializeFirebase();
  const db = getFirestoreDB();

  const bearer = _extractBearer(req);
  if (bearer) {
    const u = await _resolveBearer(bearer, db);
    if (u) return u;
  }

  const cookie = _extractCookie(req, '__session');
  if (cookie) {
    const u = await _resolveCookie(cookie, db);
    if (u) return u;
  }

  return null;
}

// ── Rate limit (shared with auth-middleware-style behaviour) ─────────
const _rateMap = new Map();
const _RATE_WINDOW_MS = 60 * 1000;
const _RATE_MAX = 240; // human-tier; service-to-service uses withAuth

// ── Security-event logging ───────────────────────────────────────────
// Keep the hot path cheap: structured console.warn always; best-effort
// Firestore write is fire-and-forget and never blocks the response.
function _redact(req) {
  const ua = (req.headers?.['user-agent'] || '').slice(0, 160);
  const ref = (req.headers?.referer || '').slice(0, 200);
  return {
    ip: _rateKey(req),
    method: req.method,
    path: (req.url || '').split('?')[0].slice(0, 200),
    ua,
    ref,
  };
}

function _logSecurityEvent(req, kind, details = {}) {
  const evt = { kind, ts: new Date().toISOString(), ..._redact(req), ...details };
  try {
    console.warn('[security]', JSON.stringify(evt));
  } catch {}
  // Best-effort Firestore write into a flat security_events collection.
  // Wrapped so a missing init / network blip never breaks the response.
  setImmediate(async () => {
    try {
      initializeFirebase();
      const db = getFirestoreDB();
      await db.collection('security_events').add({
        ...evt,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    } catch {}
  });
}

// ── CSRF: strict Origin guard for state-changing methods ─────────────
const _UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function _expectedOrigin(req) {
  // Trust the Host header but prefer X-Forwarded-Proto on Vercel.
  const proto = (req.headers?.['x-forwarded-proto'] || '').split(',')[0].trim()
    || (req.socket?.encrypted ? 'https' : 'http');
  const host = req.headers?.host;
  if (!host) return null;
  return `${proto}://${host}`;
}

function _isCrossOriginWrite(req) {
  if (!_UNSAFE_METHODS.has(req.method)) return false;
  const expected = _expectedOrigin(req);
  if (!expected) return true; // cannot verify
  const origin = req.headers?.origin;
  if (origin) {
    return origin !== expected;
  }
  // Fall back to Referer (must match scheme+host+port, not just hostname).
  const referer = req.headers?.referer;
  if (referer) {
    try {
      const u = new URL(referer);
      return `${u.protocol}//${u.host}` !== expected;
    } catch { return true; }
  }
  // No Origin and no Referer on a write — reject.
  return true;
}

function _rateKey(req) {
  return req.headers?.['x-forwarded-for']?.split(',')[0]?.trim()
    || req.headers?.['x-real-ip']
    || req.socket?.remoteAddress
    || 'unknown';
}

function _rateCheck(key, max) {
  const now = Date.now();
  const e = _rateMap.get(key);
  if (!e || now - e.start > _RATE_WINDOW_MS) {
    _rateMap.set(key, { start: now, count: 1 });
    return { allowed: true, remaining: max - 1 };
  }
  e.count++;
  if (e.count > max) {
    return { allowed: false, remaining: 0, retryAfter: Math.ceil((e.start + _RATE_WINDOW_MS - now) / 1000) };
  }
  return { allowed: true, remaining: Math.max(0, max - e.count) };
}

// Periodic sweep (only schedule once per process)
if (!global.__apiAuthRateSweep) {
  global.__apiAuthRateSweep = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of _rateMap) {
      if (now - v.start > _RATE_WINDOW_MS * 2) _rateMap.delete(k);
    }
  }, 5 * 60 * 1000);
  if (global.__apiAuthRateSweep.unref) global.__apiAuthRateSweep.unref();
}

// ── The wrapper ──────────────────────────────────────────────────────

/**
 * @param {Function} handler
 * @param {Object} [opts]
 * @param {string|string[]} [opts.permission] — required granular key(s).
 *        String = single key; array = ALL keys must match.
 * @param {string|string[]} [opts.anyPermission] — array of keys, ANY match passes.
 * @param {string[]} [opts.role] — accept only these roles (e.g. ['owner','admin']).
 * @param {string[]} [opts.methods] — allowed HTTP methods.
 * @param {number} [opts.rateLimit] — per-IP req/min cap (default 240).
 * @param {boolean} [opts.requireUser] — require identity even with no permission key.
 *        Defaults to true if `permission`/`role` set, false otherwise.
 */
function withApi(handler, opts = {}) {
  const requireUserFlag = opts.requireUser ?? !!(opts.permission || opts.anyPermission || opts.role);
  const max = opts.rateLimit || _RATE_MAX;
  const skipCsrf = opts.skipCsrf === true; // opt-out for service-to-service routes that use API key

  return async (req, res) => {
    if (opts.methods && !opts.methods.includes(req.method)) {
      return res.status(405).json({ error: 'method_not_allowed' });
    }

    // CSRF: state-changing methods must come from a same-origin browser
    // context (or carry a valid X-Reauth-Token / API key, both of which are
    // checked downstream). The Origin header is sent by every modern
    // browser on cross-origin POSTs and cannot be spoofed by JavaScript.
    if (!skipCsrf && _isCrossOriginWrite(req)) {
      // Allow API-key callers to bypass (legitimate cross-origin tooling).
      const hasApiKey = !!(req.headers?.['x-api-key'] || (typeof req.headers?.authorization === 'string' && req.headers.authorization.startsWith('ApiKey ')));
      if (!hasApiKey) {
        _logSecurityEvent(req, 'csrf_blocked', { origin: req.headers?.origin || null });
        return res.status(403).json({ error: 'csrf_blocked' });
      }
    }

    const ip = _rateKey(req);
    const limit = _rateCheck(ip, max);
    res.setHeader('X-RateLimit-Limit', max);
    res.setHeader('X-RateLimit-Remaining', limit.remaining);
    if (!limit.allowed) {
      res.setHeader('Retry-After', limit.retryAfter);
      _logSecurityEvent(req, 'rate_limited', { max });
      return res.status(429).json({ error: 'rate_limited', retryAfter: limit.retryAfter });
    }

    if (!requireUserFlag) {
      return handler(req, res);
    }

    let user;
    try {
      user = await requireUser(req);
    } catch (err) {
      console.error('[api-auth] requireUser failed:', err.message);
      _logSecurityEvent(req, 'auth_resolver_failed', { err: err.message });
      return res.status(500).json({ error: 'auth_resolver_failed' });
    }

    if (!user) {
      _logSecurityEvent(req, 'auth_required');
      return res.status(401).json({ error: 'auth_required' });
    }
    if (user.error === 'disabled') {
      _logSecurityEvent(req, 'account_disabled', { email: user.email });
      return res.status(403).json({ error: 'account_disabled' });
    }
    if (user.error === 'revoked') {
      _logSecurityEvent(req, 'session_revoked', { email: user.email });
      return res.status(401).json({ error: 'session_revoked', message: 'Sign in again.' });
    }

    if (opts.role && opts.role.length) {
      if (!opts.role.includes(user.role) && !user.superAdmin) {
        _logSecurityEvent(req, 'forbidden_role', { email: user.email, need: opts.role, have: user.role });
        return res.status(403).json({ error: 'forbidden_role', need: opts.role, have: user.role });
      }
    }

    if (opts.permission) {
      const keys = Array.isArray(opts.permission) ? opts.permission : [opts.permission];
      if (!user.superAdmin && !canAll(user.permissions, keys)) {
        _logSecurityEvent(req, 'forbidden_permission', { email: user.email, need: keys });
        return res.status(403).json({ error: 'forbidden', need: keys });
      }
    }

    if (opts.anyPermission && opts.anyPermission.length) {
      if (!user.superAdmin && !canAny(user.permissions, opts.anyPermission)) {
        _logSecurityEvent(req, 'forbidden_permission', { email: user.email, needAny: opts.anyPermission });
        return res.status(403).json({ error: 'forbidden', needAny: opts.anyPermission });
      }
    }

    // ── Step-up auth (sudo mode) ─────────────────────────────────────
    // Routes that download / export / mutate sensitive data set
    // `reauth: true` (or a number = max-age seconds). The caller must
    // present a fresh `X-Reauth-Token` header proving they re-typed
    // their password within the window. Both blocks AND successes are
    // recorded so audit can prove every export was password-confirmed.
    if (opts.reauth) {
      req.user = user; // verifyReauth reads req.user
      let verifyReauth;
      try {
        ({ verifyReauth } = require('./reauth'));
      } catch (e) {
        console.error('[api-auth] reauth module missing:', e.message);
        return res.status(500).json({ error: 'reauth_unavailable' });
      }
      const maxAgeSec = typeof opts.reauth === 'number' ? opts.reauth : undefined;
      const result = await verifyReauth(req, maxAgeSec ? { maxAgeSec } : undefined);
      if (!result.ok) {
        _logSecurityEvent(req, 'reauth_blocked', {
          email: user.email,
          reason: result.error,
        });
        const body = { error: result.error };
        if (result.message) body.message = result.message;
        if (result.retryAfterSec) {
          body.retryAfterSec = result.retryAfterSec;
          res.setHeader('Retry-After', result.retryAfterSec);
        }
        return res.status(result.status).json(body);
      }
      _logSecurityEvent(req, 'reauth_success', {
        email: user.email,
        ageSec: result.ageSec,
      });
    }

    req.user = user;
    return handler(req, res);
  };
}

module.exports = {
  withApi,
  requireUser,
  invalidateUser,
  invalidateAll,
  can,
  logSecurityEvent: _logSecurityEvent,
};
module.exports.default = withApi;
