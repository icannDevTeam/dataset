/**
 * GET /api/pickup/admin/chaperones-list
 *
 * Returns all chaperones with summary fields. Used by the
 * /v2/chaperones bulk-management page (#14).
 *
 * Query: ?status=all|due|never_enrolled|active   (default: all)
 *        ?limit=500
 */
import admin from 'firebase-admin';
import { withAuth } from '../../../../lib/auth-middleware';
import { initializeFirebase } from '../../../../lib/firebase-admin';
const tenancy = require('../../../../lib/tenancy');

async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method' });
  const limit = Math.min(1000, parseInt(req.query.limit || '500', 10));
  const status = String(req.query.status || 'all');
  const tid = tenancy.getTenantId(req.query.tenant);

  initializeFirebase();
  const db = admin.firestore();

  const snap = await db.collection(tenancy.chaperonesPath(tid))
    .orderBy('createdAt', 'desc')
    .limit(limit).get();

  const now = Date.now();
  const baseItems = [];
  const studentIdSet = new Set();
  snap.forEach((d) => {
    const c = d.data();
    const lastEnrolledAt = tsToMs(c.lastEnrolledAt);
    const reenrollDueAt = tsToMs(c.reenrollDueAt);
    const enrol = c.enrollmentSummary || null;
    const everEnrolled = enrol && (enrol.ok > 0 || enrol.total > 0);
    const isDue = reenrollDueAt && reenrollDueAt < now;
    const authorizedStudentIds = c.authorizedStudentIds || [];

    authorizedStudentIds.forEach((sid) => {
      if (sid) studentIdSet.add(String(sid));
    });

    baseItems.push({
      id: d.id,
      employeeNo: c.employeeNo || null,
      name: c.name || '—',
      relationship: c.relationship || null,
      authorizedStudentIds,
      photoCount: (c.photoUrls || []).length,
      enrollmentSummary: enrol,
      everEnrolled,
      reenrollDueAt: reenrollDueAt ? new Date(reenrollDueAt).toISOString() : null,
      isReenrollDue: !!isDue,
      lastSeenAt: tsToIso(c.lastSeenAt),
      lastSeenGate: c.lastSeenGate || null,
      suspended: !!c.suspended,
      createdAt: tsToIso(c.createdAt),
    });
  });

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
    },
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

export default withAuth(handler, { methods: ['GET'] });

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
