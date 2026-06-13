/**
 * API Authentication Middleware
 * 
 * Protects API routes with API key authentication.
 * The key is checked from:
 *   1. x-api-key header
 *   2. Authorization: Bearer <key> header
 * 
 * Usage:
 *   import { withAuth } from '../../lib/auth-middleware';
 *   export default withAuth(handler);
 * 
 * Public routes (health, metrics) can skip auth:
 *   export default withAuth(handler, { public: true });
 */

const API_KEY = process.env.DASHBOARD_API_KEY;

// Simple in-memory rate limiter per IP
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW = 60 * 1000; // 1 minute
const RATE_LIMIT_MAX = 120; // requests per window

function getRateLimitKey(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim()
    || req.headers['x-real-ip']
    || req.socket?.remoteAddress
    || 'unknown';
}

function checkRateLimit(key) {
  const now = Date.now();
  const entry = rateLimitMap.get(key);

  if (!entry || now - entry.start > RATE_LIMIT_WINDOW) {
    rateLimitMap.set(key, { start: now, count: 1 });
    return { allowed: true, remaining: RATE_LIMIT_MAX - 1 };
  }

  entry.count++;
  const remaining = Math.max(0, RATE_LIMIT_MAX - entry.count);

  if (entry.count > RATE_LIMIT_MAX) {
    return { allowed: false, remaining: 0, retryAfter: Math.ceil((entry.start + RATE_LIMIT_WINDOW - now) / 1000) };
  }

  return { allowed: true, remaining };
}

// Clean up stale entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateLimitMap) {
    if (now - entry.start > RATE_LIMIT_WINDOW * 2) {
      rateLimitMap.delete(key);
    }
  }
}, 5 * 60 * 1000);

function extractApiKey(req) {
  // Check x-api-key header
  const xApiKey = req.headers['x-api-key'];
  if (xApiKey) return xApiKey;

  // Check Authorization: Bearer <key>
  const authHeader = req.headers['authorization'];
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.slice(7);
  }

  return null;
}

// SECURITY (F-001 fix, 2026-05-13):
// Origin/Referer headers are trivially spoofable from any HTTP client
// (curl -H 'Origin: ...'). Treating them as proof of "same-origin browser
// context" is a complete auth bypass. We now require a real authenticated
// browser session — a valid `__session` HMAC cookie or a Firebase Bearer
// token — IN ADDITION to a matching Origin/Referer. Plain header spoofing
// no longer grants access. Service-to-service callers must carry the
// API key (x-api-key / Authorization: Bearer <key>).
function isSameOriginRequest(req) {
  const proto = (req.headers['x-forwarded-proto'] || '').split(',')[0].trim()
    || (req.socket?.encrypted ? 'https' : 'http');
  const host = req.headers['host'] || '';
  if (!host) return false;
  const expected = `${proto}://${host}`;

  const origin = req.headers['origin'];
  let originMatches = false;
  if (origin) {
    originMatches = origin === expected;
  } else {
    const referer = req.headers['referer'];
    if (!referer) return false;
    try {
      const u = new URL(referer);
      originMatches = `${u.protocol}//${u.host}` === expected;
    } catch {
      return false;
    }
  }
  if (!originMatches) return false;

  // Require proof of an authenticated browser session via the HMAC-signed
  // `__session` cookie (issued by /api/auth/session, verified here).
  // We deliberately do NOT accept a "Bearer ey…" header as proof of session
  // here: regex shape ≠ signature verification (CWE-345). Routes that need
  // to accept Firebase ID tokens must use `withApi` (which calls
  // `admin.auth().verifyIdToken`).
  try {
    const cookieHeader = req.headers['cookie'] || '';
    if (cookieHeader.includes('__session=')) {
      const { verifyCookie } = require('./session-cookie');
      const m = cookieHeader.match(/(?:^|;\s*)__session=([^;]+)/);
      if (m && m[1]) {
        const decoded = decodeURIComponent(m[1]);
        if (verifyCookie(decoded)) return true;
      }
    }
  } catch {}

  return false;
}

/**
 * @param {Function} handler - The API route handler
 * @param {Object} options
 * @param {boolean} options.public - If true, skip authentication (still rate-limited)
 * @param {string[]} options.methods - Allowed HTTP methods (default: all)
 * @param {number} options.rateLimit - Custom rate limit for this endpoint
 */
export function withAuth(handler, options = {}) {
  return async (req, res) => {
    // Method check
    if (options.methods && !options.methods.includes(req.method)) {
      return res.status(405).json({ error: 'Method not allowed' });
    }

    // Rate limiting
    const ip = getRateLimitKey(req);
    const limit = checkRateLimit(ip);

    res.setHeader('X-RateLimit-Limit', options.rateLimit || RATE_LIMIT_MAX);
    res.setHeader('X-RateLimit-Remaining', limit.remaining);

    if (!limit.allowed) {
      res.setHeader('Retry-After', limit.retryAfter);
      return res.status(429).json({ error: 'Too many requests', retryAfter: limit.retryAfter });
    }

    // Auth check (skip for public routes and same-origin requests)
    if (!options.public) {
      const sameOrigin = isSameOriginRequest(req);
      const providedKey = extractApiKey(req);

      if (!sameOrigin) {
        if (!API_KEY) {
          console.error('[AUTH] DASHBOARD_API_KEY not configured — rejecting external request');
          return res.status(500).json({ error: 'Server misconfigured' });
        }

        if (!providedKey) {
          return res.status(401).json({ error: 'Authentication required. Provide x-api-key header.' });
        }

        // Constant-time comparison to prevent timing attacks
        if (!timingSafeEqual(providedKey, API_KEY)) {
          return res.status(403).json({ error: 'Invalid API key' });
        }
      }
    }

    return handler(req, res);
  };
}

function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;

  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);

  try {
    const crypto = require('crypto');
    return crypto.timingSafeEqual(bufA, bufB);
  } catch {
    // Fallback: still constant-time via reduce
    let result = 0;
    for (let i = 0; i < bufA.length; i++) {
      result |= bufA[i] ^ bufB[i];
    }
    return result === 0;
  }
}
