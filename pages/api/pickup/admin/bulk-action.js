/**
 * POST /api/pickup/admin/bulk-action
 *
 * Approve or reject many pending onboarding records in a single call.
 * Wraps the per-record approve/reject logic and returns per-record results.
 *
 * Body:
 *   { action: 'approve' | 'reject', recordIds: string[],
 *     reason?: string,        // required when action === 'reject'
 *     approvalNotes?: string,
 *     tenant?: string }
 *
 * Response:
 *   { ok, action, results: [{ recordId, ok, error?, allocated?, enrollment? }] }
 *
 * On approve we re-use the same allocation + enrollment helper used by the
 * single-record endpoint so behaviour is identical.
 */
import { withAuth } from '../../../../lib/auth-middleware';
import { initializeFirebase, getFirebaseStorage } from '../../../../lib/firebase-admin';
import admin from 'firebase-admin';
import crypto from 'crypto';
import { enrollChaperones } from '../../../../lib/chaperone-enroll';

const tenancy = require('../../../../lib/tenancy');
const FIRST_CHAPERONE_NO = 9000000000;

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
  const rec = recSnap.data();
  if (rec.status !== 'pending') throw new Error(`status=${rec.status}, not pending`);
  if (!Array.isArray(rec.chaperones) || rec.chaperones.length === 0) {
    throw new Error('no chaperones in record');
  }

  const now = new Date().toISOString();
  const created = [];
  const studentDenorm = new Map();

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

    await db.doc(`${tenancy.chaperonesPath(tid)}/${chaperoneId}`).set({
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
      facePaths: finalFacePaths,
      status: 'approved',
      deviceEnrolled: false,
      deviceEnrollErrors: null,
      approvedAt: now,
      approvedFromOnboarding: recordId,
      reEnrollDueAt: new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString(),
      suspendedAt: null,
    }, { merge: false });

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

  await recRef.set({
    status: 'approved',
    reviewedAt: now,
    reviewedBy: reviewer,
    approvalNotes: approvalNotes || null,
    allocatedChaperones: created,
  }, { merge: true });

  let enrollment = [];
  try {
    enrollment = await enrollChaperones(db, bucket, tid, created.map((c) => c.chaperoneId));
  } catch (e) {
    enrollment = created.map((c) => ({ chaperoneId: c.chaperoneId, ok: false, error: e.message }));
  }
  await recRef.set({ enrollment }, { merge: true });

  return { allocated: created, enrollment };
}

async function rejectOne(db, tid, recordId, reason, reviewer) {
  const recRef = db.doc(`${tenancy.pickupOnboardingPath(tid)}/${recordId}`);
  const recSnap = await recRef.get();
  if (!recSnap.exists) throw new Error('record not found');
  const rec = recSnap.data();
  if (rec.status !== 'pending') throw new Error(`status=${rec.status}, not pending`);
  await recRef.set({
    status: 'rejected',
    reviewedAt: new Date().toISOString(),
    reviewedBy: reviewer,
    rejectionReason: reason.trim(),
  }, { merge: true });
}

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { action, recordIds, reason, approvalNotes, tenant } = req.body || {};
  if (!['approve', 'reject'].includes(action)) return res.status(400).json({ error: 'action must be approve|reject' });
  if (!Array.isArray(recordIds) || recordIds.length === 0) return res.status(400).json({ error: 'recordIds required' });
  if (recordIds.length > 100) return res.status(400).json({ error: 'max 100 records per call' });
  if (action === 'reject' && (!reason || reason.trim().length < 4)) {
    return res.status(400).json({ error: 'reason required (min 4 chars) for reject' });
  }
  const tid = tenant ? String(tenant) : tenancy.getTenantId();
  const reviewer = req.headers['x-admin-user'] || 'api-key';

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
        } else {
          await rejectOne(db, tid, id, reason, reviewer);
          results.push({ recordId: id, ok: true });
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

export default withAuth(handler);
