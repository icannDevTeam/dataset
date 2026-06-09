import admin from 'firebase-admin';
import { initializeFirebase } from '../../../../../lib/firebase-admin';
import { withApi } from '../../../../../lib/api-auth';

const tenancy = require('../../../../../lib/tenancy');
const { logAudit } = require('../../../../../lib/audit-log');
const { can } = require('../../../../../lib/rbac');

function normalizeClassKey(value) {
  return String(value || '').trim().toUpperCase().replace(/\s+/g, '');
}

function normalizeLevel(value, fallbackClassKey = '') {
  const raw = String(value || '').trim().toUpperCase();
  if (raw) return raw;
  const key = normalizeClassKey(fallbackClassKey);
  if (!key) return '';
  if (/^EY\d*$/.test(key)) return 'EY';
  return key.match(/^\d+/)?.[0] || '';
}

async function buildStudentCounts(db, tid) {
  const snap = await db.collection(tenancy.studentsPath(tid)).limit(2000).get();
  const counts = new Map();
  snap.forEach((doc) => {
    const data = doc.data() || {};
    const homeroom = normalizeClassKey(data.homeroom || data.class || data.className || '');
    if (!homeroom) return;
    const faceCount = Array.isArray(data.facePaths)
      ? data.facePaths.length
      : Array.isArray(data.photoUrls)
        ? data.photoUrls.length
        : 0;
    const row = counts.get(homeroom) || {
      studentCount: 0,
      faceReady: 0,
      deviceReady: 0,
      missingParentPhone: 0,
    };
    row.studentCount += 1;
    if (faceCount > 0) row.faceReady += 1;
    if (data.deviceEnrolled === true) row.deviceReady += 1;
    if (!(data.parentPhone || data.guardianPhone)) row.missingParentPhone += 1;
    counts.set(homeroom, row);
  });
  return counts;
}

async function handler(req, res) {
  initializeFirebase();
  const db = admin.firestore();
  const tid = tenancy.getTenantId();
  const coll = db.collection(tenancy.pickupClassesPath(tid));

  if (req.method === 'GET') {
    const [classSnap, counts] = await Promise.all([
      coll.get().catch(() => null),
      buildStudentCounts(db, tid),
    ]);

    const itemsMap = new Map();
    if (classSnap) {
      classSnap.forEach((doc) => {
        const data = doc.data() || {};
        const key = normalizeClassKey(doc.id);
        const metrics = counts.get(key) || {};
        itemsMap.set(key, {
          id: doc.id,
          key,
          label: String(data.label || doc.id).trim() || doc.id,
          level: normalizeLevel(data.level, key),
          active: data.active !== false,
          notes: String(data.notes || '').trim(),
          managed: true,
          studentCount: metrics.studentCount || 0,
          faceReady: metrics.faceReady || 0,
          deviceReady: metrics.deviceReady || 0,
          missingParentPhone: metrics.missingParentPhone || 0,
        });
      });
    }

    for (const [key, metrics] of counts.entries()) {
      if (itemsMap.has(key)) continue;
      itemsMap.set(key, {
        id: key,
        key,
        label: key,
        level: normalizeLevel('', key),
        active: true,
        notes: '',
        managed: false,
        studentCount: metrics.studentCount || 0,
        faceReady: metrics.faceReady || 0,
        deviceReady: metrics.deviceReady || 0,
        missingParentPhone: metrics.missingParentPhone || 0,
      });
    }

    const items = Array.from(itemsMap.values()).sort((left, right) => {
      const levelCmp = String(left.level || '').localeCompare(String(right.level || ''), undefined, { numeric: true });
      if (levelCmp !== 0) return levelCmp;
      return String(left.label || '').localeCompare(String(right.label || ''), undefined, { numeric: true });
    });

    const summary = {
      totalClasses: items.length,
      activeClasses: items.filter((item) => item.active).length,
      managedClasses: items.filter((item) => item.managed).length,
      totalStudents: items.reduce((sum, item) => sum + (item.studentCount || 0), 0),
    };

    return res.status(200).json({ ok: true, items, summary });
  }

  if (req.method === 'POST') {
    if (!req.user.superAdmin && !can(req.user.permissions, 'student_class_management.edit_classes')) {
      return res.status(403).json({ error: 'forbidden', need: ['student_class_management.edit_classes'] });
    }
    const rawLabel = String(req.body?.label || req.body?.key || '').trim();
    const key = normalizeClassKey(rawLabel);
    if (!key) return res.status(400).json({ error: 'class label required' });

    const payload = {
      label: rawLabel.toUpperCase(),
      level: normalizeLevel(req.body?.level, key),
      notes: String(req.body?.notes || '').trim().slice(0, 500),
      active: req.body?.active !== false,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    await coll.doc(key).set(payload, { merge: true });

    await logAudit(db, {
      tenantId: tid,
      actor: { email: req.user.email, name: req.user.name, role: req.user.role },
      req,
      kind: 'class.create_or_update',
      target: { type: 'class', id: key, label: payload.label },
      after: payload,
      summary: `Created or updated class ${payload.label}`,
    });

    return res.status(200).json({ ok: true, id: key });
  }

  if (req.method === 'PATCH') {
    if (!req.user.superAdmin && !can(req.user.permissions, 'student_class_management.edit_classes')) {
      return res.status(403).json({ error: 'forbidden', need: ['student_class_management.edit_classes'] });
    }
    const classId = normalizeClassKey(req.body?.classId || '');
    if (!classId) return res.status(400).json({ error: 'classId required' });
    const ref = coll.doc(classId);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ error: 'class_not_found' });
    const before = snap.data() || {};
    const patch = {};
    if (req.body?.patch?.label !== undefined) {
      const nextLabel = String(req.body.patch.label || '').trim().toUpperCase();
      if (normalizeClassKey(nextLabel) !== classId) {
        return res.status(400).json({ error: 'renaming class key is not supported yet' });
      }
      patch.label = nextLabel;
    }
    if (req.body?.patch?.level !== undefined) patch.level = normalizeLevel(req.body.patch.level, classId);
    if (req.body?.patch?.notes !== undefined) patch.notes = String(req.body.patch.notes || '').trim().slice(0, 500);
    if (req.body?.patch?.active !== undefined) patch.active = req.body.patch.active !== false;
    if (Object.keys(patch).length === 0) return res.status(400).json({ error: 'no valid fields in patch' });
    patch.updatedAt = admin.firestore.FieldValue.serverTimestamp();

    await ref.set(patch, { merge: true });
    await logAudit(db, {
      tenantId: tid,
      actor: { email: req.user.email, name: req.user.name, role: req.user.role },
      req,
      kind: 'class.update',
      target: { type: 'class', id: classId, label: before.label || classId },
      before: Object.fromEntries(Object.keys(patch).filter((key) => key !== 'updatedAt').map((key) => [key, before[key] ?? null])),
      after: Object.fromEntries(Object.keys(patch).filter((key) => key !== 'updatedAt').map((key) => [key, patch[key]])),
      summary: `Updated class ${before.label || classId}`,
    });
    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ error: 'method_not_allowed' });
}

export default withApi(handler, {
  methods: ['GET', 'POST', 'PATCH'],
  anyPermission: ['student_class_management.view', 'student_class_management.view_classes', 'student_class_management.edit_classes'],
});