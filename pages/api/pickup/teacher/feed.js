/**
 * GET /api/pickup/teacher/feed
 *
 * Session-authenticated feed for the teacher iPad validation screen.
 * Returns pickup_events filtered to the calling teacher's classScopes.
 *
 * Auth: __session cookie (same login as dashboard) — withAuth API key NOT
 *       used here because teachers use session-cookie auth, not API keys.
 *
 * Query: ?tenant=  ?limit=  ?since=ISO (for incremental polling)
 *
 * Response: { ok, classScopes, now, events: [...] }
 *   Events shape is identical to tv/feed to allow shared UI components.
 */
import admin from 'firebase-admin';
import { initializeFirebase, getFirebaseStorage } from '../../../../lib/firebase-admin';
import { verifyCookie } from '../../auth/session';
const tenancy = require('../../../../lib/tenancy');

const DEFAULT_LIMIT = 40;
const MAX_LIMIT = 80;
const WINDOW_MS = 30 * 60 * 1000;
const SIGNED_URL_TTL_MS = 5 * 60 * 1000;
const STUDENT_PHOTO_TTL_MS = 30 * 60 * 1000;

// Per-process caches — same pattern as tv/feed.js
const _urlCache = new Map();
const _studentPathCache = new Map();

function toIso(v) {
  if (!v) return null;
  if (typeof v === 'string') return v;
  if (v?.toDate) {
    try { return v.toDate().toISOString(); } catch { return null; }
  }
  try { return new Date(v).toISOString(); } catch { return null; }
}

async function signed(bucket, path) {
  if (!path) return null;
  const cached = _urlCache.get(path);
  if (cached && cached.exp > Date.now()) return cached.url;
  try {
    const [url] = await bucket.file(path).getSignedUrl({
      action: 'read',
      expires: Date.now() + SIGNED_URL_TTL_MS,
    });
    _urlCache.set(path, { url, exp: Date.now() + SIGNED_URL_TTL_MS - 30_000 });
    return url;
  } catch {
    return null;
  }
}

async function resolveStudentPhotoPath(bucket, tid, homeroom, name) {
  if (!homeroom || !name) return null;
  const key = `${tid}|${homeroom}|${name}`;
  const cached = _studentPathCache.get(key);
  if (cached && cached.exp > Date.now()) return cached.path;
  const candidates = [
    `tenants/${tid}/face_dataset/${homeroom}/${name}/`,
    `face_dataset/${homeroom}/${name}/`,
  ];
  for (const prefix of candidates) {
    try {
      const [files] = await bucket.getFiles({ prefix, maxResults: 1 });
      if (files && files.length > 0) {
        const found = files[0].name;
        _studentPathCache.set(key, { path: found, exp: Date.now() + STUDENT_PHOTO_TTL_MS });
        return found;
      }
    } catch {}
  }
  _studentPathCache.set(key, { path: null, exp: Date.now() + 5 * 60 * 1000 });
  return null;
}

function readCookie(req, name) {
  const raw = req.headers.cookie || '';
  for (const p of raw.split(';').map((x) => x.trim())) {
    if (p.startsWith(`${name}=`)) return decodeURIComponent(p.slice(name.length + 1));
  }
  return null;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method' });

  // Session auth — __session cookie signed by SESSION_SECRET
  const sessionMarker = readCookie(req, '__session');
  const session = sessionMarker ? verifyCookie(sessionMarker) : null;
  if (!session?.email) {
    return res.status(401).json({ error: 'login required' });
  }

  initializeFirebase();
  const db = admin.firestore();
  const bucket = getFirebaseStorage().bucket();

  const actorEmail = String(session.email).toLowerCase();
  const userSnap = await db.collection('dashboard_users').doc(actorEmail).get();
  if (!userSnap.exists) {
    return res.status(403).json({ error: 'account not authorized' });
  }
  const user = userSnap.data() || {};
  if (user.disabled) return res.status(403).json({ error: 'account disabled' });

  const { role = 'viewer', classScopes: rawScopes = [] } = user;

  // Resolve effective class scopes:
  //   - teacher → their assigned classScopes (required)
  //   - owner/admin → may optionally pass ?classes=4A,4C to filter; if not, see all
  const isTeacher = role === 'teacher';
  if (!['owner', 'admin', 'teacher'].includes(role)) {
    return res.status(403).json({ error: 'insufficient role' });
  }

  const classScopes = Array.isArray(rawScopes)
    ? rawScopes.map((x) => String(x).trim().toUpperCase()).filter(Boolean)
    : [];

  if (isTeacher && classScopes.length === 0) {
    return res.status(403).json({ error: 'teacher has no class scope assigned' });
  }

  const tid = req.query.tenant ? String(req.query.tenant) : tenancy.getTenantId();
  const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(req.query.limit, 10) || DEFAULT_LIMIT));

  // Optional: only return events newer than this ISO timestamp (client can track)
  const sinceMs = req.query.since ? new Date(String(req.query.since)).getTime() : null;
  const cutoffMs = sinceMs && !Number.isNaN(sinceMs)
    ? Math.max(sinceMs, Date.now() - WINDOW_MS)
    : Date.now() - WINDOW_MS;

  const cutoff = admin.firestore.Timestamp.fromMillis(cutoffMs);

  const snap = await db.collection(tenancy.pickupEventsPath(tid))
    .where('recordedAt', '>', cutoff)
    .orderBy('recordedAt', 'desc')
    .limit(limit)
    .get();

  const scopeSet = new Set(classScopes);
  const events = [];

  for (const doc of snap.docs) {
    const e = doc.data();

    // For teachers: only include events where at least one student is in their class
    if (isTeacher) {
      const eventClasses = (e.students || []).map((s) => String(s.homeroom || '').trim().toUpperCase());
      if (!eventClasses.some((c) => scopeSet.has(c))) continue;
    }

    const chap = e.chaperone || {};
    const chapPhotoPath = chap.photoUrl || chap.photoUrls?.[0];
    const chapPhoto = chapPhotoPath?.startsWith('http')
      ? chapPhotoPath
      : await signed(bucket, chapPhotoPath);
    const capture = e.capturePath ? await signed(bucket, e.capturePath) : null;
    const teacherCapture = e.teacherRelease?.captureStoragePath
      ? await signed(bucket, e.teacherRelease.captureStoragePath)
      : null;

    const students = await Promise.all((e.students || []).map(async (s) => {
      let url = null;
      if (s.photoUrl) {
        url = s.photoUrl.startsWith('http') ? s.photoUrl : await signed(bucket, s.photoUrl);
      }
      if (!url && s.homeroom && s.name) {
        const resolved = await resolveStudentPhotoPath(bucket, tid, s.homeroom, s.name);
        if (resolved) url = await signed(bucket, resolved);
      }
      return { ...s, photoUrl: url };
    }));

    events.push({
      id: doc.id,
      eventId: e.eventId || doc.id,
      scannedAt: e.scannedAt?.toDate ? e.scannedAt.toDate().toISOString() : e.scannedAt,
      recordedAt: e.recordedAt?.toDate ? e.recordedAt.toDate().toISOString() : e.recordedAt,
      deviceName: e.deviceName,
      gate: e.gate,
      decision: e.decision,
      cardState: e.cardState,
      overrideCode: e.overrideCode || null,
      holdSeconds: e.holdSeconds || 60,
      status: e.status || null,
      chaperone: { ...chap, photoUrl: chapPhoto },
      students,
      capturePath: capture,
      officerOverride: e.officerOverride || null,
      teacherRelease: e.teacherRelease ? {
        ...e.teacherRelease,
        at: toIso(e.teacherRelease.at),
        captureUrl: teacherCapture,
      } : null,
    });
  }

  res.setHeader('Cache-Control', 'no-store, max-age=0');
  return res.status(200).json({
    ok: true,
    now: new Date().toISOString(),
    tenant: tid,
    classScopes,
    role,
    displayName: user.name || actorEmail,
    events,
  });
}
