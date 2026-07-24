/**
 * pickup-event-shape.js — Shared shaping for pickup_event Firestore docs
 * into the JSON payload consumed by the iPad teacher PWA.
 *
 * Used by:
 *   - GET  /api/pickup/tablet/feed       (poll fallback / hydration)
 *   - GET  /api/pickup/tablet/stream     (SSE live)
 *   - POST /api/pickup/internal/notify   (broadcaster bridge)
 *
 * NOTE: Per the optimization plan, student photos are NOT rendered on the
 * iPad — the cards show name + homeroom only (sourced from the parent
 * onboarding API). Any student.photoUrl present on the doc is intentionally
 * stripped here to avoid leaking unused signed URLs and to keep the payload
 * small.
 */

const SIGNED_URL_TTL_MS = 5 * 60 * 1000;
const _urlCache = new Map();

function toIso(v) {
  if (!v) return null;
  if (typeof v === 'string') return v;
  if (v?.toDate) { try { return v.toDate().toISOString(); } catch { return null; } }
  try { return new Date(v).toISOString(); } catch { return null; }
}

function isTmpLike(value) {
  return /^tmp-[a-z0-9]/i.test(String(value || '').trim());
}

function pickStudentDisplayName(s) {
  const firstName = String(s?.firstName || '').trim();
  const nickname = String(s?.nickname || '').trim();
  const combined = firstName && nickname ? `${firstName} (${nickname})` : '';
  const candidates = [
    s?.name,
    s?.displayName,
    s?.studentName,
    combined,
    firstName,
    nickname,
    s?.id,
    s?.studentId,
    s?.binusId,
  ];
  for (const c of candidates) {
    const v = String(c || '').trim();
    if (!v) continue;
    if (isTmpLike(v)) continue;
    return v;
  }
  return 'Name pending';
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

/**
 * Shape a Firestore pickup_event doc (or raw data object) into the
 * client-facing card payload.
 *
 * @param {object} bucket - Storage bucket
 * @param {object} input  - either a Firestore DocumentSnapshot or
 *                          { id, data: () => obj } | { id, ...rawData }
 */
async function shapePickupEvent(bucket, input) {
  // Accept both DocumentSnapshot and plain { id, ...data } shapes.
  const id = input.id;
  const e = typeof input.data === 'function' ? input.data() : input;

  const chap = e.chaperone || {};
  const chapPhotoPath = chap.photoUrl || chap.photoUrls?.[0];
  const chapPhoto = chapPhotoPath?.startsWith?.('http')
    ? chapPhotoPath
    : await signed(bucket, chapPhotoPath);
  const capture = e.capturePath
    ? (typeof e.capturePath === 'string' && e.capturePath.startsWith('http')
        ? e.capturePath
        : await signed(bucket, e.capturePath))
    : null;

  // Students: name + homeroom ONLY. No photo lookup.
  const students = (e.students || []).map((s) => ({
    id: s.id || null,
    name: pickStudentDisplayName(s),
    homeroom: s.homeroom || s.className || null,
  }));

  return {
    id,
    eventId: e.eventId || id,
    releaseGroupId: e.releaseGroupId || null,
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

module.exports = { shapePickupEvent, signed, toIso };
