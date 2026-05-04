/**
 * POST /api/pickup/admin/approve
 *
 * Admin-only. Approves a `pickup_onboarding/{recordId}` submission:
 *   1. Allocates a 9XXX employeeNo per chaperone (atomic)
 *   2. Copies staged face photos chaperone_faces_pending/{tempId}/...
 *      → chaperone_faces/{chaperoneId}/photo-N.jpg
 *   3. Creates `chaperones/{chaperoneId}` doc with authorizedStudentIds
 *   4. Denormalizes onto `students/{sid}.authorizedChaperones[]`
 *   5. Marks onboarding doc status='approved'
 *
 * Hikvision device enrollment is NOT performed here — that's a separate
 * P2 step once we know the gates from pickup_settings. The admin gets
 * back a list of allocated employeeNos which the listener will route
 * to pickup_events on first scan.
 *
 * Body: { recordId, tenant?, approvalNotes? }
 */
import { withAuth } from '../../../../lib/auth-middleware';
import { initializeFirebase, getFirebaseStorage } from '../../../../lib/firebase-admin';
import admin from 'firebase-admin';
import crypto from 'crypto';
import { enrollChaperones } from '../../../../lib/chaperone-enroll';

const tenancy = require('../../../../lib/tenancy');

const FIRST_CHAPERONE_NO = 9000000000;

/**
 * Atomically reserve next chaperone employeeNo. Mirror of
 * backend/chaperone_allocator.allocate_chaperone_employee_no.
 */
async function allocateEmployeeNo(db, tid) {
  const ref = db.doc(tenancy.idAllocationsDoc('chaperone-counter', tid));
  const next = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const cur = snap.exists ? (snap.data() || {}).last : FIRST_CHAPERONE_NO;
    const nxt = Math.max(cur || 0, FIRST_CHAPERONE_NO) + 1;
    tx.set(ref, {
      last: nxt,
      prefix: tenancy.CHAPERONE_EMPLOYEENO_PREFIX,
      tenantId: tid,
      updatedAt: new Date().toISOString(),
    }, { merge: true });
    return nxt;
  });
  return String(next);
}

async function copyFace(bucket, fromPath, toPath) {
  const src = bucket.file(fromPath);
  const [exists] = await src.exists();
  if (!exists) return false;
  await src.copy(bucket.file(toPath));
  // Don't delete originals here — schedule for later GC. Leaving them lets
  // an admin reproduce the approval from the audit trail if needed.
  return true;
}

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { recordId, tenant, approvalNotes } = req.body || {};
  if (!recordId || typeof recordId !== 'string') {
    return res.status(400).json({ error: 'recordId required' });
  }
  const tid = tenant ? String(tenant) : tenancy.getTenantId();

  try {
    initializeFirebase();
    const db = admin.firestore();
    const bucket = getFirebaseStorage().bucket();

    const recRef = db.doc(`${tenancy.pickupOnboardingPath(tid)}/${recordId}`);
    const recSnap = await recRef.get();
    if (!recSnap.exists) return res.status(404).json({ error: 'record not found' });
    const rec = recSnap.data();
    if (rec.status !== 'pending') {
      return res.status(409).json({ error: `record status is ${rec.status}, not pending` });
    }
    if (!Array.isArray(rec.chaperones) || rec.chaperones.length === 0) {
      return res.status(400).json({ error: 'record has no chaperones' });
    }

    const now = new Date().toISOString();
    const created = [];
    const studentDenorm = new Map(); // sid -> array of {chaperoneId, name, relation}

    for (const c of rec.chaperones) {
      const employeeNo = await allocateEmployeeNo(db, tid);
      const chaperoneId = `chap-${employeeNo}`;

      // Copy faces
      const finalFacePaths = [];
      for (let i = 0; i < (c.facePaths || []).length; i++) {
        const src = c.facePaths[i];
        const ext = (src.split('.').pop() || 'jpg').toLowerCase();
        const dst = `tenants/${tid}/chaperone_faces/${chaperoneId}/photo-${i}.${ext}`;
        const ok = await copyFace(bucket, src, dst);
        if (ok) finalFacePaths.push(dst);
      }
      if (finalFacePaths.length === 0) {
        // Don't roll back already-allocated IDs — skip this chaperone with note
        continue;
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
        facePaths: finalFacePaths,
        status: 'approved',
        deviceEnrolled: false,    // P2: listener / batch job sets true
        deviceEnrollErrors: null,
        approvedAt: now,
        approvedFromOnboarding: recordId,
        reEnrollDueAt: new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString(),
        suspendedAt: null,
      };
      await db.doc(`${tenancy.chaperonesPath(tid)}/${chaperoneId}`).set(chapDoc, { merge: false });

      for (const sid of (c.authorizedStudentIds || [])) {
        if (!studentDenorm.has(sid)) studentDenorm.set(sid, []);
        studentDenorm.get(sid).push({
          chaperoneId,
          employeeNo,
          name: c.name,
          relation: c.relation,
        });
      }

      created.push({ chaperoneId, employeeNo, facesCopied: finalFacePaths.length });
    }

    // Denormalize onto student docs (best effort — student doc may not exist
    // in tenant scope yet during dual-read window)
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
      reviewedBy: req.headers['x-admin-user'] || 'api-key',
      approvalNotes: approvalNotes || null,
      allocatedChaperones: created,
    }, { merge: true });

    // ── Auto-enrol on Hikvision devices (best-effort) ──────────────────────
    // Failures are recorded on each chaperone doc (deviceEnrolled/deviceEnrollErrors)
    // so the admin can retry via /api/pickup/admin/reenroll without blocking approval.
    let enrollment = [];
    try {
      enrollment = await enrollChaperones(
        db,
        bucket,
        tid,
        created.map((c) => c.chaperoneId),
      );
    } catch (e) {
      console.error('[pickup/admin/approve] enrollment error', e.message);
      enrollment = created.map((c) => ({ chaperoneId: c.chaperoneId, ok: false, error: e.message }));
    }

    await recRef.set({ enrollment }, { merge: true });

    return res.status(200).json({ ok: true, recordId, allocated: created, enrollment });
  } catch (err) {
    console.error('[pickup/admin/approve]', err.message, err.stack);
    return res.status(500).json({ error: 'internal', message: err.message });
  }
}

export default withAuth(handler);
