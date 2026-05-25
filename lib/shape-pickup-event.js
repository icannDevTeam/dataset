/**
 * shape-pickup-event.js — Shared payload shaper for pickup_events.
 *
 * Used by:
 *   - /api/pickup/tablet/feed.js     (initial hydration / polling fallback)
 *   - /lib/pickup-event-bus.js       (real-time SSE broadcaster)
 *
 * Returns the same wire format on both paths so the iPad PWA doesn't need
 * to know whether a card arrived via SSE or polling.
 */

const SIGNED_URL_TTL_MS = 5 * 60 * 1000;
const STUDENT_PHOTO_TTL_MS = 30 * 60 * 1000;

// Per-process caches (cold-start fresh, warm-reuse safe).
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

/**
 * Shape a pickup_events Firestore doc into the wire payload sent to the iPad.
 *
 * @param {object} bucket  — Firebase Storage bucket
 * @param {string} tid     — tenant id
 * @param {object} doc     — Firestore DocumentSnapshot
 */
async function shapePickupEvent(bucket, tid, doc) {
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

// Decisions that are written for audit but never shown on the iPad.
const SILENT_ON_IPAD = new Set(['outside_window', 'unknown_chaperone', 'wrong_terminal']);

module.exports = { shapePickupEvent, SILENT_ON_IPAD };
