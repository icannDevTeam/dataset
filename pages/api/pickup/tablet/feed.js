/**
 * GET /api/pickup/tablet/feed
 *
 * Token-authenticated feed for the iPad teacher app. Returns pickup_events
 * scoped to the bound release group's terminalIds.
 *
 * Auth:  x-tablet-device-token header (or ?deviceToken=)
 * Query: ?since=ISO  ?max=2  (active limit)
 *
 * Response:
 *   {
 *     ok, now, releaseGroup: { id, name, gradeLabel, terminalIds },
 *     active:  [...],   // status='pending', up to maxActive (default 2)
 *     held:    [...],   // status='held'
 *   }
 *
 * Card shape mirrors /api/pickup/teacher/feed for shared UI components.
 */
import admin from 'firebase-admin';
import { initializeFirebase, getFirebaseStorage } from '../../../../lib/firebase-admin';
const tenancy = require('../../../../lib/tenancy');

const WINDOW_MS = 30 * 60 * 1000;
const SIGNED_URL_TTL_MS = 5 * 60 * 1000;
const STUDENT_PHOTO_TTL_MS = 30 * 60 * 1000;
const _urlCache = new Map();
const _studentPathCache = new Map();

function toIso(v) {
  if (!v) return null;
  if (typeof v === 'string') return v;
  if (v?.toDate) { try { return v.toDate().toISOString(); } catch { return null; } }
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
  } catch { return null; }
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

async function shapeEvent(bucket, tid, doc) {
  const e = doc.data();
  const chap = e.chaperone || {};
  const chapPhotoPath = chap.photoUrl || chap.photoUrls?.[0];
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
      const resolved = await resolveStudentPhotoPath(bucket, tid, s.homeroom, s.name);
      if (resolved) url = await signed(bucket, resolved);
    }
    return { ...s, photoUrl: url };
  }));

  return {
    id: doc.id,
    eventId: e.eventId || doc.id,
    scannedAt: toIso(e.scannedAt),
    recordedAt: toIso(e.recordedAt),
    deviceName: e.deviceName,
    gate: e.gate,
    terminalId: e.terminalId || null,
    decision: e.decision,
    cardState: e.cardState,
    holdSeconds: e.holdSeconds || 60,
    status: e.status || 'pending',
    chaperone: { ...chap, photoUrl: chapPhoto },
    students,
    capturePath: capture,
    teacherRelease: e.teacherRelease ? {
      ...e.teacherRelease,
      at: toIso(e.teacherRelease.at),
    } : null,
    blocked: e.decision === 'unknown_chaperone',
  };
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method' });
  const token = req.headers['x-tablet-device-token'] || req.query.deviceToken;
  if (!token) return res.status(401).json({ error: 'deviceToken required' });

  try {
    initializeFirebase();
    const db = admin.firestore();
    const bucket = getFirebaseStorage().bucket();
    const tid = req.query.tenant ? String(req.query.tenant) : tenancy.getTenantId();

    // Resolve device → release group → terminalIds
    const devSnap = await db.collection(tenancy.tabletDevicesPath(tid))
      .where('deviceToken', '==', String(token))
      .limit(1).get();
    if (devSnap.empty) return res.status(401).json({ error: 'unknown token' });
    const dev = devSnap.docs[0];
    const devData = dev.data();
    if (devData.status !== 'paired') return res.status(401).json({ error: 'not paired' });

    const releaseGroupId = devData.releaseGroupId;
    if (!releaseGroupId) return res.status(409).json({ error: 'no release group bound' });
    const groupSnap = await db.doc(tenancy.releaseGroupDoc(releaseGroupId, tid)).get();
    if (!groupSnap.exists) return res.status(404).json({ error: 'release group not found' });
    const group = groupSnap.data();
    const terminalIds = Array.isArray(group.terminalIds) ? group.terminalIds : [];
    if (terminalIds.length === 0) {
      return res.status(200).json({
        ok: true,
        now: new Date().toISOString(),
        releaseGroup: { id: releaseGroupId, name: group.name, gradeLabel: group.gradeLabel, terminalIds: [] },
        active: [],
        held: [],
      });
    }

    // Touch lastSeenAt
    dev.ref.set({ lastSeenAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true }).catch(() => {});

    const sinceMs = req.query.since ? new Date(String(req.query.since)).getTime() : null;
    const cutoffMs = sinceMs && !Number.isNaN(sinceMs)
      ? Math.max(sinceMs, Date.now() - WINDOW_MS)
      : Date.now() - WINDOW_MS;

    // Firestore IN supports up to 30 values; we only ever expect 1-3 terminals per group.
    // Fetch per-terminal with single equality (no composite index needed) and
    // filter/sort recordedAt in memory.
    const perTerm = await Promise.all(
      terminalIds.slice(0, 30).map((tidx) =>
        db.collection(tenancy.pickupEventsPath(tid))
          .where('terminalId', '==', tidx)
          .limit(200).get()
      )
    );
    const allDocs = perTerm.flatMap((s) => s.docs).filter((d) => {
      const ms = d.data().recordedAt?.toMillis?.() || 0;
      return ms > cutoffMs;
    });
    allDocs.sort((a, b) => {
      const ta = a.data().recordedAt?.toMillis?.() || 0;
      const tb = b.data().recordedAt?.toMillis?.() || 0;
      return tb - ta;
    });
    const snap = { docs: allDocs.slice(0, 80) };

    const maxActive = Math.max(1, Math.min(4, parseInt(req.query.max, 10) || 2));
    const active = [];
    const held = [];
    let todayReleased = 0;
    const todayStartMs = (() => {
      // Local-day start in UTC+7 (WIB)
      const now = new Date(Date.now() + 7 * 3600 * 1000);
      const ymd = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
      return ymd - 7 * 3600 * 1000;
    })();
    for (const doc of snap.docs) {
      const data = doc.data();
      const status = data.status || 'pending';
      if (status === 'pending' && active.length < 50) {
        active.push(doc);
      } else if (status === 'held') {
        held.push(doc);
      } else if (status === 'released') {
        const releasedAt = data.teacherRelease?.at?.toMillis ? data.teacherRelease.at.toMillis()
          : (data.recordedAt?.toMillis ? data.recordedAt.toMillis() : 0);
        if (releasedAt >= todayStartMs) todayReleased++;
      }
    }
    // active is desc-by-recordedAt; show oldest unresolved first (FIFO).
    active.reverse();
    const activeShown = active.slice(0, maxActive);

    const [activeOut, heldOut] = await Promise.all([
      Promise.all(activeShown.map((d) => shapeEvent(bucket, tid, d))),
      Promise.all(held.map((d) => shapeEvent(bucket, tid, d))),
    ]);

    res.setHeader('Cache-Control', 'no-store, max-age=0');
    return res.status(200).json({
      ok: true,
      now: new Date().toISOString(),
      releaseGroup: {
        id: releaseGroupId,
        name: group.name,
        gradeLabel: group.gradeLabel,
        terminalIds,
      },
      active: activeOut,
      held: heldOut,
      todayReleased,
    });
  } catch (e) {
    console.error('[pickup/tablet/feed]', e.message);
    return res.status(500).json({ error: 'internal', message: e.message });
  }
}
