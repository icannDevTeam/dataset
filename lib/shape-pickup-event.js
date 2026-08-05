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

  // Students are shown by name + homeroom only — no photo fetching.
  const students = (e.students || []).map((s) => ({
    id: s.id,
    name: pickStudentDisplayName(s),
    homeroom: s.homeroom || s.className || null,
  }));

  return {
    id: doc.id,
    eventId: e.eventId || doc.id,
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

// Decisions that are written for audit but never shown on the iPad.
// Keep outside_window visible so operators can still process real guardians
// during early/late dismissal windows.
const SILENT_ON_IPAD = new Set(['unknown_chaperone', 'wrong_terminal']);

// Scope-match tokens from a homeroom string. Mirrors
// backend/pickup_event_writer.py::_student_grade_tokens.
//   '5C' -> ['5'];  'EY2A' -> ['EY2', 'EY'];  'EY' -> ['EY']
function gradeTokensFromHomeroom(hr) {
  const raw = String(hr || '').trim().toUpperCase();
  if (!raw) return [];
  const digits = (raw.match(/^(\d{1,2})/) || [])[1];
  if (digits) return [digits];
  if (raw.startsWith('EY')) {
    const eyNum = (raw.slice(2).match(/^(\d+)/) || [])[1];
    return eyNum ? [`EY${eyNum}`, 'EY'] : ['EY'];
  }
  return [];
}

// True when an event's students belong to at least one of the given grade
// scopes. Fail-open: unscoped groups and events with unknown grades always
// match (unknown chaperones must still surface for security).
function eventMatchesScopes(eventLike, scopeSet) {
  if (!scopeSet || scopeSet.size === 0) return true;
  const students = Array.isArray(eventLike?.students) ? eventLike.students : [];
  const tokens = new Set();
  students.forEach((s) => {
    gradeTokensFromHomeroom(s && (s.homeroom || s.className)).forEach((t) => tokens.add(t));
  });
  if (tokens.size === 0) return true;
  return [...tokens].some((t) => scopeSet.has(t));
}

/**
 * Pre-warm signed URL and student path caches for a tenant.
 *
 * Call once when the first iPad subscriber connects. Bulk-signs every
 * chaperone photo and resolves every student photo path so that
 * shapePickupEvent() hits the in-process cache on the first real scan
 * instead of paying ~250ms per Storage API call under pressure.
 *
 * Fire-and-forget — errors are swallowed; cache misses fall back to
 * on-demand signing transparently.
 *
 * @param {object} db      — Firestore admin instance
 * @param {object} bucket  — Firebase Storage bucket
 * @param {string} tid     — tenant id
 */
async function prewarmSession(db, bucket, tid) {
  try {
    const chapSnap = await db.collection(`tenants/${tid}/chaperones`)
      .select('photoUrl', 'photoUrls').get();

    const tasks = [];
    for (const doc of chapSnap.docs) {
      const d = doc.data();
      const paths = [d.photoUrl, ...(d.photoUrls || [])].filter(Boolean);
      for (const p of paths) {
        if (!p.startsWith('http')) tasks.push(signed(bucket, p));
      }
    }

    await Promise.allSettled(tasks);
    console.log(`[pickup-prewarm] ${tid}: ${chapSnap.size} chaperones warmed`);
  } catch (err) {
    console.warn('[pickup-prewarm] non-fatal error during pre-warm:', err.message);
  }
}

module.exports = { shapePickupEvent, prewarmSession, SILENT_ON_IPAD, gradeTokensFromHomeroom, eventMatchesScopes };
