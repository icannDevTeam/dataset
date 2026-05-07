/**
 * POST /api/pickup/onboarding/lookup
 *
 * Token-gated student lookup for the parent onboarding page.
 *
 * Body: { token, studentId }
 * Returns: { ok, student: {id, name, homeroom, photoUrl?} }
 *
 * Phase 3: in-memory LRU cache (24h TTL) + per-IP rate limit (60/min) +
 * Cache-Control to keep the form responsive even under heavy parent
 * traffic. Cache key is per-tenant so tokens for different tenants
 * never collide.
 */
import { initializeFirebase } from '../../../../lib/firebase-admin';
import admin from 'firebase-admin';

const tenancy = require('../../../../lib/tenancy');
const { verifyPickupOnboardingToken } = require('../../../../lib/pickup-token');
const { enforceRateLimit, clientIp } = require('../../../../lib/rate-limit');
const inviteLinks = require('../../../../lib/onboarding-invites');

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_MAX = 5000;
// Map preserves insertion order → use it as a tiny LRU.
const cache = new Map();

function cacheGet(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.t > CACHE_TTL_MS) { cache.delete(key); return null; }
  // refresh recency
  cache.delete(key); cache.set(key, entry);
  return entry.v;
}
function cacheSet(key, v) {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, { t: Date.now(), v });
  while (cache.size > CACHE_MAX) {
    const first = cache.keys().next().value;
    cache.delete(first);
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const rl = enforceRateLimit('pickup:onboarding-lookup', clientIp(req), { max: 60, windowMs: 60_000 });
  if (!rl.allowed) {
    res.setHeader('Retry-After', rl.retryAfter);
    return res.status(429).json({ error: 'rate_limited', retryAfter: rl.retryAfter });
  }

  const { token, studentId } = req.body || {};
  const claims = verifyPickupOnboardingToken(token || '');
  if (!claims) return res.status(401).json({ error: 'invalid or expired token' });
  if (!studentId || typeof studentId !== 'string') {
    return res.status(400).json({ error: 'studentId required' });
  }
  const sid = String(studentId).trim();
  if (!/^[A-Za-z0-9_-]{4,32}$/.test(sid)) {
    return res.status(400).json({ error: 'studentId looks invalid' });
  }

  const cacheKey = `${claims.tid}|${sid}`;
  const cached = cacheGet(cacheKey);
  if (cached) {
    res.setHeader('Cache-Control', 'private, max-age=600');
    res.setHeader('X-Cache', 'HIT');
    return res.status(200).json({ ok: true, student: cached });
  }

  try {
    initializeFirebase();
    const db = admin.firestore();
    if (claims.lid) {
      const usable = await inviteLinks.assertInviteUsable(db, claims.tid, claims.lid);
      if (!usable.ok) {
        return res.status(usable.status || 403).json({ error: usable.reason });
      }
    }
    let data = null;
    const tenantSnap = await db.doc(`${tenancy.studentsPath(claims.tid)}/${sid}`).get();
    if (tenantSnap.exists) {
      data = tenantSnap.data() || {};
    } else {
      // Fall back to legacy collection (dual-read window)
      const legacy = await db.doc(`students/${sid}`).get();
      if (legacy.exists) data = legacy.data() || {};
    }
    if (!data) return res.status(404).json({ error: 'student not found' });

    const student = {
      id: sid,
      name: data.name || data.fullName || sid,
      homeroom: data.homeroom || data.className || null,
      photoUrl: data.photoUrl || null,
    };

    // Surface any prior lock so the form can refuse to add an
    // already-registered student up-front (rather than only blocking
    // at submit time). Locks live at pickup_student_locks/{sid}.
    let alreadyRegistered = null;
    try {
      const lockSnap = await db.doc(`${tenancy.pickupStudentLocksPath(claims.tid)}/${sid}`).get();
      if (lockSnap.exists) {
        const lock = lockSnap.data() || {};
        if (lock.status && lock.status !== 'rejected') {
          alreadyRegistered = {
            status: lock.status,
            formNumber: lock.formNumber || null,
            guardianName: lock.guardianName || null,
            submittedAt: lock.submittedAt || null,
          };
        }
      }
    } catch { /* non-fatal — lock check is informational */ }

    cacheSet(cacheKey, student);
    res.setHeader('Cache-Control', 'private, max-age=600');
    res.setHeader('X-Cache', 'MISS');
    return res.status(200).json({ ok: true, student, alreadyRegistered });
  } catch (err) {
    console.error('[pickup/onboarding/lookup]', err.message);
    return res.status(500).json({ error: 'internal' });
  }
}
