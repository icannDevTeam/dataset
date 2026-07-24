/**
 * POST /api/pickup/admin/bulk-action
 *
 * Approve, reject, archive, unarchive, or permanently delete many
 * onboarding records in a single call. Wraps the per-record helpers and
 * returns per-record results.
 *
 * Body:
 *   { action: 'approve' | 'reject' | 'archive' | 'unarchive' | 'delete',
 *     recordIds: string[],
 *     reason?: string,          // required when action === 'reject'
 *     approvalNotes?: string,
 *     tenant?: string }
 *
 * Response:
 *   { ok, action, results: [{ recordId, ok, error?, ... }] }
 *
 * Single-record approve/reject behaviour is identical to the dedicated
 * endpoints. Archive flips status='archived' (preserving previousStatus
 * so it can be restored). Delete removes the onboarding record document
 * AND any chaperone face Storage objects staged under
 * chaperone_faces_pending/* that belong to it. Approved records keep
 * their allocated chaperones/{id} docs untouched (admins must use the
 * chaperone management UI to remove those separately).
 */
import { withApi } from '../../../../lib/api-auth';
import { initializeFirebase, getFirebaseStorage } from '../../../../lib/firebase-admin';
import admin from 'firebase-admin';
import crypto from 'crypto';
import { enrollChaperones } from '../../../../lib/chaperone-enroll';

const tenancy = require('../../../../lib/tenancy');
const { can } = require('../../../../lib/rbac');
const { resolveStudentLinks, gradeFromHomeroom, sortEyFirst } = require('../../../../lib/pickup-student-links');
const FIRST_CHAPERONE_NO = 9000000000;
const TEMPLATE_PICKUP_ONBOARDING_APPROVED = 'pickup_onboarding_approved';
const TEMPLATE_PICKUP_ONBOARDING_REJECTED = 'pickup_onboarding_rejected';

function normalizeHomeroomNoPathway(raw) {
  const s = String(raw || '').trim().toUpperCase().replace(/\s+/g, '');
  if (!s) return '';
  if (s.startsWith('EY')) {
    const eyNum = (s.slice(2).match(/^(\d+)/) || [])[1];
    return eyNum ? `EY${eyNum}` : 'EY';
  }
  const m = s.match(/^(\d{1,2})/);
  return m ? m[1] : s;
}

function queueJobId(tid, recordId, templateType) {
  const safe = `${tid}-${recordId}-${templateType}`.replace(/[^A-Za-z0-9_-]/g, '_');
  return safe.slice(0, 180);
}

async function enqueueApprovalNotification(db, tid, recordId, rec, reviewer, approvedAt, allocated) {
  const to = String(rec?.guardian?.email || '').trim().toLowerCase();
  if (!to) return;

  const studentNameById = Object.fromEntries(
    (Array.isArray(rec?.students) ? rec.students : []).map((s) => [s.id, s.name]).filter((x) => x[0])
  );

  const jobId = queueJobId(tid, recordId, TEMPLATE_PICKUP_ONBOARDING_APPROVED);
  const queueRef = db.doc(`email_queue/${jobId}`);
  const existing = await queueRef.get();
  if (existing.exists) return;

  await queueRef.set({
    status: 'pending',
    templateType: TEMPLATE_PICKUP_ONBOARDING_APPROVED,
    tenantId: tid,
    recordId,
    formNumber: rec?.formNumber || null,
    to,
    templateData: {
      guardianName: rec?.guardian?.name || null,
      guardianEmail: rec?.guardian?.email || null,
      formNumber: rec?.formNumber || null,
      approvedAt,
      approvedBy: reviewer,
      students: (rec?.students || []).map((s) => ({
        name: s?.name || null,
        gradeSelection: s?.gradeSelection || null,
        homeroom: s?.homeroom || null,
      })),
      chaperones: (rec?.chaperones || []).map((c) => ({
        name: c?.name || null,
        relation: c?.relation || null,
        authorizedStudentNames: (c?.authorizedStudentIds || [])
          .map((sid) => studentNameById[sid])
          .filter(Boolean),
      })),
      allocatedChaperones: Array.isArray(allocated) ? allocated : [],
    },
    retryCount: 0,
    maxRetries: 3,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    source: 'pickup_admin_bulk_approve',
  }, { merge: false });
}

async function enqueueRejectionNotification(db, tid, recordId, rec, reviewer, rejectedAt, reason) {
  const to = String(rec?.guardian?.email || '').trim().toLowerCase();
  if (!to) return;

  const jobId = queueJobId(tid, recordId, TEMPLATE_PICKUP_ONBOARDING_REJECTED);
  const queueRef = db.doc(`email_queue/${jobId}`);
  const existing = await queueRef.get();
  if (existing.exists) return;

  await queueRef.set({
    status: 'pending',
    templateType: TEMPLATE_PICKUP_ONBOARDING_REJECTED,
    tenantId: tid,
    recordId,
    formNumber: rec?.formNumber || null,
    to,
    templateData: {
      guardianName: rec?.guardian?.name || null,
      guardianEmail: rec?.guardian?.email || null,
      formNumber: rec?.formNumber || null,
      rejectedAt,
      rejectedBy: reviewer,
      rejectionReason: reason,
      students: (rec?.students || []).map((s) => ({
        name: s?.name || null,
        gradeSelection: s?.gradeSelection || null,
        homeroom: s?.homeroom || null,
      })),
    },
    retryCount: 0,
    maxRetries: 3,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    source: 'pickup_admin_bulk_reject',
  }, { merge: false });
}

async function allocateEmployeeNo(db, tid) {
  const ref = db.doc(tenancy.idAllocationsDoc('chaperone-counter', tid));
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const cur = snap.exists ? (snap.data() || {}).last : FIRST_CHAPERONE_NO;
    const nxt = Math.max(cur || 0, FIRST_CHAPERONE_NO) + 1;
    tx.set(ref, {
      last: nxt,
      prefix: tenancy.CHAPERONE_EMPLOYEENO_PREFIX,
      tenantId: tid,
      updatedAt: new Date().toISOString(),
    }, { merge: true });
    return String(nxt);
  });
}

async function copyFace(bucket, fromPath, toPath) {
  const src = bucket.file(fromPath);
  const [exists] = await src.exists();
  if (!exists) return false;
  await src.copy(bucket.file(toPath));
  return true;
}

async function approveOne(db, bucket, tid, recordId, approvalNotes, reviewer) {
  const recRef = db.doc(`${tenancy.pickupOnboardingPath(tid)}/${recordId}`);
  const recSnap = await recRef.get();
  if (!recSnap.exists) throw new Error('record not found');
  let rec = recSnap.data();
  if (rec.status !== 'pending') throw new Error(`status=${rec.status}, not pending`);
  if (!Array.isArray(rec.chaperones) || rec.chaperones.length === 0) {
    throw new Error('no chaperones in record');
  }

  // Sanity: the form must have at least one student linked. Student photos
  // are NOT required — the iPad teacher cards show name + homeroom only.
  const recStudents = Array.isArray(rec.students) ? rec.students : [];
  if (recStudents.length === 0) throw new Error('no students in record');

  // Resolve tmp-* student tokens before creating chaperone docs (see
  // lib/pickup-student-links.js — prevents raw tmp-... IDs on pole tablets).
  rec = await resolveStudentLinks({ db, tid, rec, recRef });

  const now = new Date().toISOString();
  const created = [];
  const studentDenorm = new Map();

  // Form-supplied student meta, used to stamp classes/grades on chaperones
  // (the Enroll board groups by these).
  const studentMetaById = {};
  (rec.students || []).forEach((s) => {
    if (!s || !s.id) return;
    studentMetaById[String(s.id)] = {
      ...s,
      homeroom: normalizeHomeroomNoPathway(s.homeroom || s.className || s.gradeSelection || s.grade),
    };
  });

  for (const c of rec.chaperones) {
    const employeeNo = await allocateEmployeeNo(db, tid);
    const chaperoneId = `chap-${employeeNo}`;
    const finalFacePaths = [];
    for (let i = 0; i < (c.facePaths || []).length; i++) {
      const src = c.facePaths[i];
      const ext = (src.split('.').pop() || 'jpg').toLowerCase();
      const dst = `tenants/${tid}/chaperone_faces/${chaperoneId}/photo-${i}.${ext}`;
      const ok = await copyFace(bucket, src, dst);
      if (ok) finalFacePaths.push(dst);
    }
    if (finalFacePaths.length === 0) continue;

    const studentClassesSet = new Set();
    const studentGradesSet = new Set();
    for (const sid of (c.authorizedStudentIds || [])) {
      const s = studentMetaById[sid];
      if (!s) continue;
      const hr = normalizeHomeroomNoPathway(s.homeroom || s.className || s.gradeSelection || s.grade);
      if (hr) studentClassesSet.add(String(hr));
      const g = s.grade ? String(s.grade) : gradeFromHomeroom(hr);
      if (g) studentGradesSet.add(g);
    }

    const chapDoc = {
      chaperoneId,
      employeeNo,
      tenantId: tid,
      name: c.name,
      relation: c.relation,
      phone: c.phone,
      email: c.email || null,
      idNumber: c.idNumber || null,
      guardianName: rec.guardian.name,
      guardianEmail: rec.guardian.email,
      guardianPhone: rec.guardian.phone,
      authorizedStudentIds: c.authorizedStudentIds || [],
      studentClasses: sortEyFirst(studentClassesSet),
      studentGrades: sortEyFirst(studentGradesSet),
      facePaths: finalFacePaths,
      status: 'approved',
      deviceEnrolled: false,
      deviceEnrollErrors: null,
      approvedAt: now,
      approvedFromOnboarding: recordId,
      reEnrollDueAt: new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString(),
      suspendedAt: null,
    };
    await db.doc(`${tenancy.chaperonesPath(tid)}/${chaperoneId}`).set(chapDoc, { merge: false });
    // Root-collection mirror for legacy readers (tablets, listeners).
    try {
      await db.doc(`chaperones/${chaperoneId}`).set(chapDoc, { merge: false });
    } catch (e) { console.error('[bulk-approve] root chaperone mirror', e.message); }

    for (const sid of (c.authorizedStudentIds || [])) {
      if (!studentDenorm.has(sid)) studentDenorm.set(sid, []);
      studentDenorm.get(sid).push({ chaperoneId, employeeNo, name: c.name, relation: c.relation });
    }
    created.push({ chaperoneId, employeeNo, facesCopied: finalFacePaths.length });
  }

  for (const [sid, addList] of studentDenorm) {
    const sref = db.doc(`${tenancy.studentsPath(tid)}/${sid}`);
    const ssnap = await sref.get();
    if (!ssnap.exists) continue;
    const existing = (ssnap.data().authorizedChaperones || []);
    const ids = new Set(existing.map((e) => e.chaperoneId));
    const merged = existing.concat(addList.filter((a) => !ids.has(a.chaperoneId)));
    await sref.set({ authorizedChaperones: merged }, { merge: true });
  }

  const approvalPatch = {
    status: 'approved',
    reviewedAt: now,
    reviewedBy: reviewer,
    approvalNotes: approvalNotes || null,
    allocatedChaperones: created,
  };
  await recRef.set(approvalPatch, { merge: true });
  try {
    await db.doc(`pickup_onboarding/${recordId}`).set(approvalPatch, { merge: true });
  } catch (e) { console.error('[bulk-approve] root form mirror', e.message); }

  // Phase 3: flip per-student locks (best-effort).
  try {
    await Promise.all((rec.students || []).map((s) => {
      if (!s || !s.id) return null;
      return db.doc(`${tenancy.pickupStudentLocksPath(tid)}/${s.id}`).set({
        status: 'approved',
        approvedAt: now,
      }, { merge: true });
    }));
  } catch (e) { console.error('[bulk-approve] lock update', e.message); }

  let enrollment = [];
  try {
    enrollment = await enrollChaperones(db, bucket, tid, created.map((c) => c.chaperoneId));
  } catch (e) {
    enrollment = created.map((c) => ({ chaperoneId: c.chaperoneId, ok: false, error: e.message }));
  }
  await recRef.set({ enrollment }, { merge: true });

  try {
    await enqueueApprovalNotification(db, tid, recordId, rec, reviewer, now, created);
  } catch (e) {
    console.error('[bulk-approve] approval notification enqueue failed', e.message);
  }

  return { allocated: created, enrollment };
}

async function rejectOne(db, tid, recordId, reason, reviewer) {
  const recRef = db.doc(`${tenancy.pickupOnboardingPath(tid)}/${recordId}`);
  const recSnap = await recRef.get();
  if (!recSnap.exists) throw new Error('record not found');
  const rec = recSnap.data();
  if (rec.status !== 'pending') throw new Error(`status=${rec.status}, not pending`);
  const trimmedReason = reason.trim();
  const rejectedAt = new Date().toISOString();
  await recRef.set({
    status: 'rejected',
    reviewedAt: rejectedAt,
    reviewedBy: reviewer,
    rejectionReason: trimmedReason,
  }, { merge: true });
  // Phase 3: release per-student locks (best-effort).
  try {
    await Promise.all((rec.students || []).map((s) => {
      if (!s || !s.id) return null;
      return db.doc(`${tenancy.pickupStudentLocksPath(tid)}/${s.id}`).set({
        status: 'rejected',
        rejectedAt,
        rejectionReason: trimmedReason,
      }, { merge: true });
    }));
  } catch (e) { console.error('[bulk-reject] lock update', e.message); }

  try {
    await enqueueRejectionNotification(db, tid, recordId, rec, reviewer, rejectedAt, trimmedReason);
  } catch (e) {
    console.error('[bulk-reject] rejection notification enqueue failed', e.message);
  }
}

// ── Archive: soft-flip status — keeps all data, hides from default views.
async function archiveOne(db, tid, recordId, reviewer) {
  const recRef = db.doc(`${tenancy.pickupOnboardingPath(tid)}/${recordId}`);
  const recSnap = await recRef.get();
  if (!recSnap.exists) throw new Error('record not found');
  const rec = recSnap.data();
  if (rec.status === 'archived') throw new Error('already archived');
  await recRef.set({
    status: 'archived',
    previousStatus: rec.status,
    archivedAt: new Date().toISOString(),
    archivedBy: reviewer,
  }, { merge: true });
}

async function unarchiveOne(db, tid, recordId, reviewer) {
  const recRef = db.doc(`${tenancy.pickupOnboardingPath(tid)}/${recordId}`);
  const recSnap = await recRef.get();
  if (!recSnap.exists) throw new Error('record not found');
  const rec = recSnap.data();
  if (rec.status !== 'archived') throw new Error(`status=${rec.status}, not archived`);
  const restored = rec.previousStatus || 'pending';
  await recRef.set({
    status: restored,
    previousStatus: admin.firestore.FieldValue.delete(),
    archivedAt: admin.firestore.FieldValue.delete(),
    archivedBy: admin.firestore.FieldValue.delete(),
    unarchivedAt: new Date().toISOString(),
    unarchivedBy: reviewer,
  }, { merge: true });
  return { restoredTo: restored };
}

// ── Hard delete: removes the onboarding doc + best-effort cleans up
// staged chaperone face photos (chaperone_faces_pending/<tempId>/...).
// Does NOT touch chaperones/{id} or chaperone_faces/{id}/* for approved
// records — those are managed via the chaperone admin UI to avoid
// silently invalidating already-pushed Hikvision enrolments.
async function deleteOne(db, bucket, tid, recordId, reviewer) {
  const recRef = db.doc(`${tenancy.pickupOnboardingPath(tid)}/${recordId}`);
  const recSnap = await recRef.get();
  if (!recSnap.exists) throw new Error('record not found');
  const rec = recSnap.data();

  // Clean up staged photos only — these are scoped to the submission and
  // safe to delete even for approved records (final faces live elsewhere).
  let stagedDeleted = 0;
  for (const c of (rec.chaperones || [])) {
    for (const p of (c.facePaths || [])) {
      if (typeof p !== 'string') continue;
      if (!p.includes('chaperone_faces_pending/')) continue;
      try {
        await bucket.file(p).delete();
        stagedDeleted += 1;
      } catch (e) {
        if (!/no such object/i.test(e?.message || '')) {
          console.warn('[bulk-delete] storage cleanup failed', p, e.message);
        }
      }
    }
  }

  // Release per-student locks so the family can submit again if needed.
  try {
    await Promise.all((rec.students || []).map((s) => {
      if (!s || !s.id) return null;
      return db.doc(`${tenancy.pickupStudentLocksPath(tid)}/${s.id}`).delete().catch(() => null);
    }));
  } catch (e) { console.error('[bulk-delete] lock cleanup', e.message); }

  await recRef.delete();
  return {
    stagedDeleted,
    hadAllocatedChaperones: Array.isArray(rec.allocatedChaperones)
      && rec.allocatedChaperones.length > 0,
  };
}

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { action, recordIds, reason, approvalNotes, tenant } = req.body || {};
  const ALLOWED = ['approve', 'reject', 'archive', 'unarchive', 'delete'];
  if (!ALLOWED.includes(action)) return res.status(400).json({ error: `action must be one of ${ALLOWED.join('|')}` });
  if (!Array.isArray(recordIds) || recordIds.length === 0) return res.status(400).json({ error: 'recordIds required' });
  if (recordIds.length > 100) return res.status(400).json({ error: 'max 100 records per call' });
  if (action === 'reject' && (!reason || reason.trim().length < 4)) {
    return res.status(400).json({ error: 'reason required (min 4 chars) for reject' });
  }

  // Per-action RBAC. archive/unarchive share one grant; delete needs the
  // destructive permission.
  const NEED = {
    approve:    'pickup_admin.bulk_approve',
    reject:     'pickup_admin.bulk_reject',
    archive:    'pickup_admin.archive_submission',
    unarchive:  'pickup_admin.archive_submission',
    delete:     'pickup_admin.delete_submission',
  };
  const need = NEED[action];
  if (!req.user.superAdmin && !can(req.user.permissions, need)) {
    return res.status(403).json({ error: 'forbidden', need: [need] });
  }

  const tid = tenant ? String(tenant) : tenancy.getTenantId();
  const reviewer = req.user.email || 'api-key';

  try {
    initializeFirebase();
    const db = admin.firestore();
    const bucket = getFirebaseStorage().bucket();

    const results = [];
    for (const id of recordIds) {
      try {
        if (action === 'approve') {
          const out = await approveOne(db, bucket, tid, id, approvalNotes, reviewer);
          results.push({ recordId: id, ok: true, ...out });
        } else if (action === 'reject') {
          await rejectOne(db, tid, id, reason, reviewer);
          results.push({ recordId: id, ok: true });
        } else if (action === 'archive') {
          await archiveOne(db, tid, id, reviewer);
          results.push({ recordId: id, ok: true });
        } else if (action === 'unarchive') {
          const out = await unarchiveOne(db, tid, id, reviewer);
          results.push({ recordId: id, ok: true, ...out });
        } else if (action === 'delete') {
          const out = await deleteOne(db, bucket, tid, id, reviewer);
          results.push({ recordId: id, ok: true, ...out });
        }
      } catch (e) {
        results.push({ recordId: id, ok: false, error: e.message });
      }
    }
    return res.status(200).json({ ok: true, action, results });
  } catch (err) {
    console.error('[pickup/admin/bulk-action]', err.message, err.stack);
    return res.status(500).json({ error: 'internal', message: err.message });
  }
}

export default withApi(handler, {
  methods: ['POST'],
  // Outer wrapper only requires the umbrella view grant; the per-action
  // bulk_approve / bulk_reject check happens inside the handler so we can
  // 403 with the precise key the caller is missing.
  permission: 'pickup_admin.view',
});
