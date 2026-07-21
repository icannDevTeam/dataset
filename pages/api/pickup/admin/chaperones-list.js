/**
 * GET /api/pickup/admin/chaperones-list
 *
 * Returns all chaperones with summary fields. Used by the
 * /v2/chaperones bulk-management page (#14).
 *
 * Query: ?status=all|due|never_enrolled|active   (default: all)
 *        ?limit=500
 *        ?includeDeleted=1   include shadow-deleted chaperones
 */
import admin from 'firebase-admin';
import { withApi } from '../../../../lib/api-auth';
import { initializeFirebase, getFirebaseStorage } from '../../../../lib/firebase-admin';
const tenancy = require('../../../../lib/tenancy');

const SIGNED_URL_TTL_MS = 60 * 60 * 1000; // 1h

async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method' });
  const limit = Math.min(1000, parseInt(req.query.limit || '500', 10));
  const status = String(req.query.status || 'all');
  const includeDeleted = ['1', 'true', 'yes'].includes(String(req.query.includeDeleted || '').toLowerCase());
  const tid = tenancy.getTenantId(req.query.tenant);

  initializeFirebase();
  const db = admin.firestore();
  const bucket = getFirebaseStorage().bucket();

  const snap = await db.collection(tenancy.chaperonesPath(tid))
    .orderBy('createdAt', 'desc')
    .limit(limit).get();

  const now = Date.now();
  const baseItems = [];
  const studentIdSet = new Set();
  const facePathByItemId = {};
  snap.forEach((d) => {
    const c = d.data();
    const lifecycleStatus = c.lifecycleStatus || 'active';
    if (!includeDeleted && lifecycleStatus === 'deleted') return;
    const lastEnrolledAt = tsToMs(c.lastEnrolledAt);
    const reenrollDueAt = tsToMs(c.reenrollDueAt);
    const enrol = c.enrollmentSummary || null;
    const everEnrolled = enrol && (enrol.ok > 0 || enrol.total > 0);
    const isDue = reenrollDueAt && reenrollDueAt < now;
    const authorizedStudentIds = c.authorizedStudentIds || [];

    authorizedStudentIds.forEach((sid) => {
      if (sid) studentIdSet.add(String(sid));
    });

    // Resolve preferred face photo path (admin-uploaded > parent-uploaded).
    const facePath =
      (Array.isArray(c.facePaths) && c.facePaths[0]) ||
      (typeof c.photoUrl === 'string' && c.photoUrl) ||
      (Array.isArray(c.photoUrls) && c.photoUrls[0]) ||
      null;
    if (facePath) facePathByItemId[d.id] = facePath;

    baseItems.push({
      id: d.id,
      employeeNo: c.employeeNo || null,
      name: c.name || '—',
      relation: c.relation || c.relationship || null,
      relationship: c.relationship || c.relation || null,
      phone: c.phone || null,
      email: c.email || null,
      idNumber: c.idNumber || null,
      status: c.status || null,
      authorizedStudentIds,
      photoCount:
        (Array.isArray(c.facePaths) ? c.facePaths.length : 0) ||
        (Array.isArray(c.photoUrls) ? c.photoUrls.length : 0),
      enrollmentSummary: enrol,
      everEnrolled,
      reenrollDueAt: reenrollDueAt ? new Date(reenrollDueAt).toISOString() : null,
      isReenrollDue: !!isDue,
      lastSeenAt: tsToIso(c.lastSeenAt),
      lastSeenGate: c.lastSeenGate || null,
      suspended: !!c.suspended,
      createdAt: tsToIso(c.createdAt),
      // Shadow-delete bookkeeping (additive — older docs default to 'active').
      lifecycleStatus,
      deletedAt: tsToIso(c.deletedAt),
      deletedBy: c.deletedBy || null,
      deletedReason: c.deletedReason || null,
      restoredAt: tsToIso(c.restoredAt),
    });
  });

  // Sign one face URL per chaperone in parallel (TTL 1h). Best-effort: a
  // missing storage object never breaks the row — the UI falls back to
  // initials. Signed URLs are short-lived so raw storage paths never leak.
  const photoUrlById = {};
  await Promise.all(Object.entries(facePathByItemId).map(async ([itemId, p]) => {
    try {
      // photoUrl is sometimes already a full https URL (legacy parent flow).
      if (/^https?:\/\//.test(p)) {
        photoUrlById[itemId] = p;
        return;
      }
      const [u] = await bucket.file(p).getSignedUrl({
        action: 'read',
        expires: Date.now() + SIGNED_URL_TTL_MS,
      });
      photoUrlById[itemId] = u;
    } catch {
      // swallow — fallback to initials avatar client-side
    }
  }));

  const studentMetaById = await loadStudentMetaById(db, tid, Array.from(studentIdSet));
  const items = baseItems.map((item) => {
    const linkedStudents = item.authorizedStudentIds
      .map((sid) => studentMetaById[sid])
      .filter(Boolean);

    const classSet = new Set();
    const gradeSet = new Set();
    linkedStudents.forEach((s) => {
      if (s.homeroom) classSet.add(s.homeroom);
      if (s.grade) gradeSet.add(s.grade);
    });

    return {
      ...item,
      photoUrl: photoUrlById[item.id] || null,
      studentClasses: Array.from(classSet),
      studentGrades: Array.from(gradeSet),
      linkedStudents,
    };
  });

  let filtered = items;
  if (status === 'due') filtered = items.filter((c) => c.isReenrollDue);
  else if (status === 'never_enrolled') filtered = items.filter((c) => !c.everEnrolled);
  else if (status === 'active') filtered = items.filter((c) => c.everEnrolled && !c.suspended);

  return res.status(200).json({
    ok: true, total: items.length, items: filtered,
    counts: {
      all: items.length,
      due: items.filter((c) => c.isReenrollDue).length,
      never_enrolled: items.filter((c) => !c.everEnrolled).length,
      active: items.filter((c) => c.everEnrolled && !c.suspended).length,
      suspended: items.filter((c) => c.suspended).length,
      deleted: items.filter((c) => c.lifecycleStatus === 'deleted').length,
    },
    includeDeleted,
  });
}

function tsToMs(v) {
  if (!v) return 0;
  if (typeof v === 'string') return Date.parse(v) || 0;
  if (typeof v?.toDate === 'function') return v.toDate().getTime();
  return 0;
}
function tsToIso(v) {
  if (!v) return null;
  if (typeof v === 'string') return v;
  if (typeof v?.toDate === 'function') return v.toDate().toISOString();
  return null;
}

export default withApi(handler, { methods: ['GET'], permission: 'pickup_admin.view' });

async function loadStudentMetaById(db, tenantId, studentIds) {
  const out = {};
  if (!studentIds?.length) return out;

  const CHUNK = 120;
  for (let i = 0; i < studentIds.length; i += CHUNK) {
    const chunk = studentIds.slice(i, i + CHUNK);
    const snaps = await Promise.all(
      chunk.map((sid) => db.doc(`${tenancy.studentMetadataPath(tenantId)}/${sid}`).get().catch(() => null))
    );

    snaps.forEach((snap, idx) => {
      if (!snap?.exists) return;
      const sid = chunk[idx];
      const m = snap.data() || {};
      out[sid] = {
        id: sid,
        name: cleanString(m.name) || cleanString(m.studentName) || null,
        homeroom: cleanString(m.homeroom) || cleanString(m.className) || cleanString(m.class) || null,
        grade:
          cleanString(m.grade) ||
          cleanString(m.gradeCode) ||
          cleanString(m.gradeName) ||
          cleanString(m.gradeLevel) ||
          null,
      };
    });
  }

  return out;
}

function cleanString(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s || null;
}
