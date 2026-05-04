/**
 * GET /api/pickup/tv/feed
 *
 * Public-readable feed for the FireTV / kiosk pickup display.
 * Auth: ?token=$PICKUP_TV_TOKEN  (or x-pickup-tv-token header).
 *       Same-origin requests (e.g. from /pickup/tv on this host) bypass.
 *
 * Query:
 *   tenant   tenant id (default: env tenant)
 *   profile  kiosk profile id  (loads gates + homerooms filter from Firestore)
 *   gate     additional/override gate filter (exact match on event.gate)
 *   limit    max events to return (default 30, max 60)
 *
 * Response:
 *   { ok, now, tenant, profile?, events: [...] }
 *   Events are sorted newest-first and capped to the last 30 minutes.
 *   Student photos auto-resolved from face_dataset storage (with cache).
 */
import admin from 'firebase-admin';
import { initializeFirebase, getFirebaseStorage } from '../../../../lib/firebase-admin';
const tenancy = require('../../../../lib/tenancy');
const kp = require('../../../../lib/kiosk-profiles');
const td = require('../../../../lib/tv-devices');

const KIOSK_TOKEN = process.env.PICKUP_TV_TOKEN || '';
const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 60;
const WINDOW_MS = 30 * 60 * 1000;
const SIGNED_URL_TTL_MS = 5 * 60 * 1000;
const STUDENT_PHOTO_TTL_MS = 30 * 60 * 1000;   // resolved storage path cache

// Caches (per-process, fine for serverless cold/warm reuse)
const _urlCache = new Map();           // storage path → { url, exp }
const _studentPathCache = new Map();   // "tid|homeroom|name" → { path, exp }

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

/**
 * Find first photo file under face_dataset/{homeroom}/{name}/.
 * Tries tenant-scoped path first, then legacy top-level. Cached 30 min.
 */
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
  // Negative cache for short period to avoid hammering storage
  _studentPathCache.set(key, { path: null, exp: Date.now() + 5 * 60 * 1000 });
  return null;
}

function isSameOrigin(req) {
  const host = req.headers.host;
  const origin = req.headers.origin || req.headers.referer || '';
  if (!origin) return false;
  try { return new URL(origin).host === host; } catch { return false; }
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method' });

  const tid = req.query.tenant ? String(req.query.tenant) : tenancy.getTenantId();
  const gateOverride = req.query.gate ? String(req.query.gate) : null;
  let profileId = req.query.profile ? String(req.query.profile) : null;
  const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(req.query.limit, 10) || DEFAULT_LIMIT));

  // Auth — three accepted modes:
  //   1. Per-device token (preferred): x-tv-device-token header — also pins the profile
  //   2. Shared kiosk token: ?token=PICKUP_TV_TOKEN (legacy, still useful for testing)
  //   3. Same-origin requests bypass (e.g. SSR/dev)
  const deviceToken = req.headers['x-tv-device-token'];
  const sharedToken = req.query.token || req.headers['x-pickup-tv-token'];

  initializeFirebase();
  const db = admin.firestore();
  const bucket = getFirebaseStorage().bucket();

  if (deviceToken) {
    try {
      const snap = await db.collection(td.tvDevicesPath(tid))
        .where('deviceToken', '==', String(deviceToken))
        .limit(1).get();
      if (snap.empty) return res.status(401).json({ error: 'unknown device token' });
      const data = snap.docs[0].data();
      if (data.status !== 'paired') return res.status(401).json({ error: data.status || 'revoked' });
      // Profile is pinned by the device record — overrides query param
      if (data.profileId) profileId = data.profileId;
      // Touch lastSeenAt
      snap.docs[0].ref.set({ lastSeenAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true }).catch(() => {});
    } catch (e) {
      return res.status(500).json({ error: 'auth lookup failed', message: e.message });
    }
  } else if (!isSameOrigin(req)) {
    if (!KIOSK_TOKEN) return res.status(500).json({ error: 'kiosk token not configured' });
    if (sharedToken !== KIOSK_TOKEN) return res.status(401).json({ error: 'invalid token' });
  }

  try {    // Load kiosk profile if requested
    let profile = null;
    if (profileId) {
      const psnap = await db.doc(kp.kioskProfileDoc(profileId, tid)).get();
      if (psnap.exists) profile = kp.normalizeProfile(psnap.id, psnap.data());
    }

    const cutoff = admin.firestore.Timestamp.fromMillis(Date.now() - WINDOW_MS);
    const q = db.collection(tenancy.pickupEventsPath(tid))
      .where('recordedAt', '>', cutoff)
      .orderBy('recordedAt', 'desc')
      .limit(limit);
    const snap = await q.get();

    const events = [];
    for (const doc of snap.docs) {
      const e = doc.data();
      // gate URL override (legacy)
      if (gateOverride && e.gate !== gateOverride) continue;
      // profile filter (gates + homerooms)
      const eventForFilter = { ...e, students: e.students || [] };
      if (!kp.eventMatchesProfile(eventForFilter, profile)) continue;

      // Resolve signed URLs for chaperone face + capture + student photos
      const chap = e.chaperone || {};
      const chapPhotoPath = chap.photoUrl || (chap.photoUrls?.[0]);
      const chapPhoto = chapPhotoPath?.startsWith('http')
        ? chapPhotoPath
        : await signed(bucket, chapPhotoPath);
      const capture = e.capturePath ? await signed(bucket, e.capturePath) : null;

      const students = await Promise.all((e.students || []).map(async (s) => {
        let url = null;
        if (s.photoUrl) {
          url = s.photoUrl.startsWith('http') ? s.photoUrl : await signed(bucket, s.photoUrl);
        }
        if (!url && s.homeroom && s.name) {
          // Auto-resolve from legacy face_dataset
          const resolvedPath = await resolveStudentPhotoPath(bucket, tid, s.homeroom, s.name);
          if (resolvedPath) url = await signed(bucket, resolvedPath);
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
        chaperone: { ...chap, photoUrl: chapPhoto },
        students,
        capturePath: capture,
        officerOverride: e.officerOverride || null,
        overrideCode: e.overrideCode || null,
        holdSeconds: e.holdSeconds || 60,
      });
    }

    // No-cache so kiosk always pulls fresh
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    const gateStatus = profile ? kp.gateStatus(profile, new Date()) : { configured: false, open: true };
    return res.status(200).json({
      ok: true,
      now: new Date().toISOString(),
      tenant: tid,
      profile,
      gateStatus,
      events,
    });
  } catch (err) {
    console.error('[pickup/tv/feed]', err.message, err.stack);
    return res.status(500).json({ error: 'internal', message: err.message });
  }
}
