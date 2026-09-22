import admin from 'firebase-admin';
import { initializeFirebase } from '../../../../lib/firebase-admin';

const tenancy = require('../../../../lib/tenancy');
const { compactStudent, studentMatchesScopes } = require('../../../../lib/manual-pickup');
const { resolveTabletReleaseContext } = require('../../../../lib/tablet-release-context');
const { enforceRateLimit } = require('../../../../lib/rate-limit');

const ROSTER_TTL_MS = 60 * 1000;
const ROSTER_STALE_MS = 5 * 60 * 1000;
const rosterCache = new Map();
const inFlightLoads = new Map();

async function loadTenantRoster(db, tenantId) {
  const existing = inFlightLoads.get(tenantId);
  if (existing) return existing;
  const load = (async () => {
    const snap = await db.collection(tenancy.studentsPath(tenantId)).get();
    return snap.docs
      .map((doc) => compactStudent(doc.id, doc.data() || {}))
      .filter((student) => student.id && student.name && student.homeroom);
  })();
  inFlightLoads.set(tenantId, load);
  try { return await load; }
  finally { inFlightLoads.delete(tenantId); }
}

async function scopedRoster(db, context) {
  const now = Date.now();
  const scopeKey = [...context.scopeTokens].sort().join(',');
  const key = `${context.tenantId}:${context.releaseGroup.id}:${scopeKey}`;
  const cached = rosterCache.get(key);
  if (cached && now - cached.loadedAt < ROSTER_TTL_MS) return cached;
  if (cached && now - cached.loadedAt < ROSTER_STALE_MS) {
    loadTenantRoster(db, context.tenantId).then((all) => {
      const students = all.filter((student) => studentMatchesScopes(student, context.scopeTokens));
      rosterCache.set(key, buildCacheEntry(students));
    }).catch(() => {});
    return cached;
  }
  const all = await loadTenantRoster(db, context.tenantId);
  const students = all.filter((student) => studentMatchesScopes(student, context.scopeTokens));
  const entry = buildCacheEntry(students);
  rosterCache.set(key, entry);
  return entry;
}

function buildCacheEntry(students) {
  const sorted = [...students].sort((left, right) => left.name.localeCompare(
    right.name, undefined, { sensitivity: 'base' }
  ));
  return { students: sorted, loadedAt: Date.now() };
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method' });
  if (process.env.MANUAL_PICKUP_ENABLED !== 'true') return res.status(404).json({ error: 'not_found' });
  const token = req.headers['x-tablet-device-token'] || req.query.deviceToken;
  if (!token) return res.status(401).json({ error: 'deviceToken required' });

  try {
    initializeFirebase();
    const db = admin.firestore();
    const tenantId = tenancy.getTenantId(req.query.tenant);
    const context = await resolveTabletReleaseContext(db, tenantId, token);
    if (context.error) return res.status(context.status).json({ error: context.error });
    if (!context.inWindow) return res.status(409).json({ error: 'release window is closed' });
    if (context.scopeTokens.size === 0) return res.status(409).json({ error: 'release group has no grade scope' });

    const limited = enforceRateLimit(
      'pickup:tablet-roster', `${tenantId}:${context.device.id}`, { max: 30, windowMs: 60_000 }
    );
    if (!limited.allowed) {
      res.setHeader('Retry-After', limited.retryAfter);
      return res.status(429).json({ error: 'rate_limited', retryAfter: limited.retryAfter });
    }

    const roster = await scopedRoster(db, context);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Vary', 'x-tablet-device-token');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
    return res.status(200).json({
      ok: true,
      releaseGroup: { id: context.releaseGroup.id, name: context.releaseGroup.name || context.releaseGroup.id },
      students: roster.students,
      loadedAt: new Date(roster.loadedAt).toISOString(),
    });
  } catch (error) {
    console.error('[pickup/tablet/student-roster]', error.message);
    return res.status(500).json({ error: 'internal' });
  }
}