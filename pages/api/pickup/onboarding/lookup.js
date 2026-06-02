/**
 * POST /api/pickup/onboarding/lookup
 *
 * Token-gated student lookup for the parent onboarding page.
 *
 * Body: { token, studentId }
 * Returns: { ok, student: {id, name, homeroom, photoUrl?} }
 *
 * Source of truth: BINUS API (live). Firestore is no longer consulted
 * for student data here — parents only need name + homeroom keyed by
 * Binusian ID, which the BINUS API serves directly.
 *
 * Phase 3: in-memory LRU cache (24h TTL) + per-IP rate limit (60/min) +
 * Cache-Control to keep the form responsive even under heavy parent
 * traffic. Cache key is per-tenant so tokens for different tenants
 * never collide.
 */
import axios from 'axios';
import { initializeFirebase } from '../../../../lib/firebase-admin';
import admin from 'firebase-admin';

const tenancy = require('../../../../lib/tenancy');
const { inspectPickupOnboardingToken } = require('../../../../lib/pickup-token');
const { enforceRateLimit, clientIp } = require('../../../../lib/rate-limit');
const inviteLinks = require('../../../../lib/onboarding-invites');

// BINUS API only serves on HTTP port 80 (HTTPS port 443 returns 404).
const BINUS_BASE = 'http://binusian.ws';

// Short-lived auth-token cache. BINUS tokens last ~60 min; we refresh
// well before that. One token serves every concurrent lookup.
let _binusToken = null;
let _binusTokenExpiresAt = 0;
async function getBinusToken() {
  const apiKey = process.env.API_KEY;
  if (!apiKey) throw new Error('binus_api_key_missing');
  const now = Date.now();
  if (_binusToken && now < _binusTokenExpiresAt) return _binusToken;
  const r = await axios.get(`${BINUS_BASE}/binusschool/auth/token`, {
    headers: { Authorization: `Basic ${apiKey}`, 'Content-Type': 'application/json' },
    timeout: 15000,
  });
  const tok =
    r.data?.data?.token || r.data?.token || r.data?.access_token || null;
  if (!tok) throw new Error('binus_token_empty');
  _binusToken = tok;
  _binusTokenExpiresAt = now + 50 * 60 * 1000; // refresh after ~50min
  return tok;
}

async function lookupStudentFromBinus(sid) {
  const token = await getBinusToken();
  const r = await axios.post(
    `${BINUS_BASE}/binusschool/bss-student-enrollment`,
    { IdStudent: String(sid) },
    {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      timeout: 20000,
    }
  );
  const result = r.data;
  if (result?.resultCode !== 200) return null;
  const sd = result.studentDataResponse || result.data || result;
  if (!sd || !sd.studentName) return null;
  return {
    name: sd.studentName || sd.name || sd.fullName || '',
    homeroom: sd.homeroom || sd.class || sd.className || null,
    gradeCode: sd.gradeCode || sd.grade || null,
    gradeName: sd.gradeName || null,
  };
}

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
  const inspected = inspectPickupOnboardingToken(token || '');
  if (!inspected.ok) {
    return res.status(401).json({
      error: inspected.reason === 'expired' ? 'token expired' : 'invalid token',
      reason: inspected.reason,
    });
  }
  const claims = inspected.claims;
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

    // Pull student data straight from BINUS API. No Firestore student
    // collection lookup — BINUS is the source of truth for ID → name/class.
    let binus;
    try {
      binus = await lookupStudentFromBinus(sid);
    } catch (err) {
      console.error('[pickup/onboarding/lookup] BINUS error:', err.message);
      return res.status(502).json({ error: 'binus_api_unavailable' });
    }
    if (!binus) return res.status(404).json({ error: 'student not found' });

    const student = {
      id: sid,
      name: binus.name || sid,
      homeroom: binus.homeroom || null,
      gradeCode: binus.gradeCode || null,
      gradeName: binus.gradeName || null,
      photoUrl: null,
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
