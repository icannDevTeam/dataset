import admin from 'firebase-admin';
import { initializeFirebase } from '../../../../../lib/firebase-admin';
import { withApi } from '../../../../../lib/api-auth';

const tenancy = require('../../../../../lib/tenancy');
const { logAudit } = require('../../../../../lib/audit-log');
const { can } = require('../../../../../lib/rbac');

const EDITABLE_FIELDS = new Set(['name', 'homeroom', 'gender', 'parentName', 'parentPhone', 'active']);

function normalizeClassKey(value) {
  return String(value || '').trim().toUpperCase().replace(/\s+/g, '');
}

function deriveLevelFromHomeroom(homeroom) {
  const value = normalizeClassKey(homeroom);
  if (!value) return '';
  if (/^EY\d*$/.test(value)) return 'EY';
  const numeric = value.match(/^\d+/)?.[0];
  return numeric || '';
}

function normalizeStudent(doc, classMap) {
  const data = doc.data() || {};
  const homeroom = normalizeClassKey(data.homeroom || data.class || data.className || '');
  const classMeta = classMap.get(homeroom);
  const faceCount = Array.isArray(data.facePaths)
    ? data.facePaths.length
    : Array.isArray(data.photoUrls)
      ? data.photoUrls.length
      : 0;
  const parentPhone = data.parentPhone || data.guardianPhone || '';
  const parentName = data.parentName || data.guardianName || '';
  const studentId = data.binusId || data.binusianId || data.studentId || doc.id;
  const level = String(classMeta?.level || data.grade || deriveLevelFromHomeroom(homeroom) || '').trim().toUpperCase();
  return {
    id: doc.id,
    studentId: String(studentId || ''),
    name: String(data.name || data.fullName || '').trim(),
    homeroom,
    level,
    gender: String(data.gender || '').trim(),
    parentName: String(parentName).trim(),
    parentPhone: String(parentPhone).trim(),
    faceCount,
    deviceEnrolled: data.deviceEnrolled === true,
    active: data.active !== false,
    classManaged: !!classMeta,
    updatedAt: data.updatedAt?.toDate?.()?.toISOString?.() || null,
  };
}

async function buildClassMap(db, tid) {
  const snap = await db.collection(tenancy.pickupClassesPath(tid)).get().catch(() => null);
  const map = new Map();
  if (!snap) return map;
  snap.forEach((doc) => {
    const data = doc.data() || {};
    map.set(normalizeClassKey(doc.id), {
      id: doc.id,
      label: String(data.label || doc.id).trim() || doc.id,
      level: String(data.level || '').trim().toUpperCase(),
      active: data.active !== false,
      notes: String(data.notes || '').trim(),
    });
  });
  return map;
}

async function handler(req, res) {
  initializeFirebase();
  const db = admin.firestore();
  const tid = tenancy.getTenantId();

  if (req.method === 'GET') {
    const [classMap, snap] = await Promise.all([
      buildClassMap(db, tid),
      db.collection(tenancy.studentsPath(tid)).limit(2000).get(),
    ]);

    const items = snap.docs.map((doc) => normalizeStudent(doc, classMap));
    items.sort((left, right) => {
      const levelCmp = String(left.level || '').localeCompare(String(right.level || ''), undefined, { numeric: true });
      if (levelCmp !== 0) return levelCmp;
      const classCmp = String(left.homeroom || '').localeCompare(String(right.homeroom || ''), undefined, { numeric: true });
      if (classCmp !== 0) return classCmp;
      return String(left.name || '').localeCompare(String(right.name || ''));
    });

    const summary = {
      totalStudents: items.length,
      totalClasses: new Set(items.map((item) => item.homeroom).filter(Boolean)).size,
      totalLevels: new Set(items.map((item) => item.level).filter(Boolean)).size,
      faceEnrolled: items.filter((item) => item.faceCount > 0).length,
      deviceEnrolled: items.filter((item) => item.deviceEnrolled).length,
      missingHomeroom: items.filter((item) => !item.homeroom).length,
      missingParentPhone: items.filter((item) => !item.parentPhone).length,
    };

    return res.status(200).json({ ok: true, items, summary });
  }

  if (req.method === 'PATCH') {
    if (!req.user.superAdmin && !can(req.user.permissions, 'student_class_management.edit_students')) {
      return res.status(403).json({ error: 'forbidden', need: ['student_class_management.edit_students'] });
    }
    const studentId = String(req.body?.studentId || '').trim();
    if (!studentId) {
      return res.status(400).json({ error: 'studentId required' });
    }
    const patch = req.body?.patch || {};
    const cleaned = {};
    for (const [key, value] of Object.entries(patch)) {
      if (!EDITABLE_FIELDS.has(key)) continue;
      if (key === 'homeroom') cleaned.homeroom = normalizeClassKey(value);
      else if (key === 'active') cleaned.active = value !== false;
      else cleaned[key] = String(value || '').trim();
    }
    if (Object.keys(cleaned).length === 0) {
      return res.status(400).json({ error: 'no valid fields in patch' });
    }

    const ref = db.collection(tenancy.studentsPath(tid)).doc(studentId);
    const snap = await ref.get();
    if (!snap.exists) {
      return res.status(404).json({ error: 'student_not_found' });
    }

    const before = snap.data() || {};
    if ('homeroom' in cleaned) {
      cleaned.class = cleaned.homeroom || admin.firestore.FieldValue.delete();
      cleaned.className = cleaned.homeroom || admin.firestore.FieldValue.delete();
      const level = deriveLevelFromHomeroom(cleaned.homeroom);
      cleaned.grade = level || admin.firestore.FieldValue.delete();
    }
    cleaned.updatedAt = admin.firestore.FieldValue.serverTimestamp();

    await ref.set(cleaned, { merge: true });

    await logAudit(db, {
      tenantId: tid,
      actor: { email: req.user.email, name: req.user.name, role: req.user.role },
      req,
      kind: 'student.profile_update',
      target: { type: 'student', id: studentId, label: before.name || before.fullName || studentId },
      before: Object.fromEntries(Object.keys(cleaned).filter((key) => key !== 'updatedAt').map((key) => [key, before[key] ?? null])),
      after: Object.fromEntries(Object.keys(cleaned).filter((key) => key !== 'updatedAt').map((key) => [key, cleaned[key]])),
      summary: `Updated student ${before.name || before.fullName || studentId}`,
    });

    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ error: 'method_not_allowed' });
}

export default withApi(handler, {
  methods: ['GET', 'PATCH'],
  anyPermission: ['student_class_management.view', 'student_class_management.view_students', 'student_class_management.edit_students'],
});