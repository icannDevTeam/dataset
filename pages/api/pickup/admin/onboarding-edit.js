/**
 * PATCH /api/pickup/admin/onboarding-edit
 *
 * Edit / delete a chaperone or student inside a pickup_onboarding record
 * BEFORE approval. Approved records are read-only (use re-enroll / device
 * unenroll flows for those — keeps the audit chain clean).
 *
 * Body shapes:
 *  { recordId, target:'chaperone', tempId, action:'update', patch:{name,phone,email,idNumber,relation,authorizedStudentIds} }
 *  { recordId, target:'chaperone', tempId, action:'delete' }
 *  { recordId, target:'chaperone', tempId, action:'delete-face', facePath }
 *  { recordId, target:'chaperone', tempId, action:'add-face', imageBase64 }
 *  { recordId, target:'record',                action:'add-chaperone', chaperone:{name,phone,email,idNumber,relation,authorizedStudentIds} }
 *  { recordId, target:'student',   id,     action:'update', patch:{name,homeroom} }
 *  { recordId, target:'student',   id,     action:'delete' }
 *
 * All edits are audited via lib/audit-log.
 */
import admin from 'firebase-admin';
import { withApi } from '../../../../lib/api-auth';
import { initializeFirebase, getFirebaseStorage } from '../../../../lib/firebase-admin';

const tenancy = require('../../../../lib/tenancy');
const { logAudit } = require('../../../../lib/audit-log');

const ALLOWED_CHAP_FIELDS = new Set([
  'name', 'phone', 'email', 'idNumber', 'relation', 'authorizedStudentIds',
]);
const ALLOWED_STUDENT_FIELDS = new Set(['name', 'homeroom']);
const MAX_FACES_PER_CHAP = 2;
const MAX_FACE_BYTES = 800 * 1024;
const FACE_MIME = { jpeg: 'jpg', jpg: 'jpg', png: 'png', webp: 'webp' };
const MAX_CHAPERONES_PER_RECORD = 5;
const ALLOWED_RELATIONS = new Set([
  'mother', 'father', 'parent', 'guardian', 'driver', 'nanny',
  'grandparent', 'sibling', 'emergency', 'other',
]);
const FIRST_CHAPERONE_NO = 9000000000;

function gradeFromHomeroom(hr) {
  if (!hr) return null;
  const m = String(hr).match(/^(\d{1,2})/);
  return m ? m[1] : null;
}

// Mirror of approve.js / bulk-action.js. Atomically reserve the next
// chaperone employeeNo so admin-added chaperones slot into the same
// 9XXXXXXXXX namespace as parent-submitted ones.
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

function parseFaceImage(b64) {
  if (typeof b64 !== 'string' || !b64.length) return null;
  const m = b64.match(/^data:image\/(jpeg|jpg|png|webp);base64,(.+)$/i);
  if (!m) return null;
  const ext = FACE_MIME[m[1].toLowerCase()];
  if (!ext) return null;
  let buf;
  try { buf = Buffer.from(m[2], 'base64'); } catch { return null; }
  if (!buf.length || buf.length > MAX_FACE_BYTES) return null;
  return { buf, ext, contentType: `image/${ext === 'jpg' ? 'jpeg' : ext}` };
}

function clean(obj, allowed) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    if (!allowed.has(k)) continue;
    if (k === 'authorizedStudentIds') {
      out[k] = Array.isArray(v) ? v.map(String).filter(Boolean) : [];
    } else if (typeof v === 'string') {
      out[k] = v.trim();
    } else if (v === null) {
      out[k] = null;
    }
  }
  return out;
}

async function handler(req, res) {
  if (req.method !== 'PATCH' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const {
    recordId, target, tempId, id, action, patch, facePath, imageBase64,
    chaperone, tenant,
  } = req.body || {};
  const tid = tenant ? String(tenant) : tenancy.getTenantId();

  if (!recordId) return res.status(400).json({ error: 'recordId required' });
  if (!['chaperone', 'student', 'record'].includes(target)) {
    return res.status(400).json({ error: 'target must be chaperone|student|record' });
  }
  if (!['update', 'delete', 'delete-face', 'add-face', 'add-chaperone'].includes(action)) {
    return res.status(400).json({ error: 'invalid action' });
  }

  try {
    initializeFirebase();
    const db = admin.firestore();
    const ref = db.doc(`${tenancy.pickupOnboardingPath(tid)}/${recordId}`);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ error: 'record not found' });
    const rec = snap.data();

    if (rec.status !== 'pending') {
      // The only post-approval mutation we allow is admin appending a
      // brand-new chaperone (e.g. parent asked the school to add a
      // replacement). Everything else stays locked to preserve the audit
      // trail and force admins through re-enroll / revoke flows.
      const isAddChaperone = target === 'record' && action === 'add-chaperone';
      if (!isAddChaperone) {
        return res.status(409).json({
          error: 'record_not_editable',
          message: `Cannot edit a ${rec.status} record. Re-enroll or revoke instead.`,
        });
      }
    }

    let beforeSnap = null;
    let afterSnap = null;
    let summary = '';
    let auditKind = '';
    let auditTargetLabel = '';

    if (target === 'chaperone') {
      const list = Array.isArray(rec.chaperones) ? [...rec.chaperones] : [];
      const idx = list.findIndex((c) => c.tempId === tempId);
      if (idx === -1) return res.status(404).json({ error: 'chaperone not found in record' });
      const original = list[idx];
      auditTargetLabel = original.name || tempId;

      if (action === 'update') {
        const cleaned = clean(patch, ALLOWED_CHAP_FIELDS);
        if (Object.keys(cleaned).length === 0) {
          return res.status(400).json({ error: 'no editable fields supplied' });
        }
        beforeSnap = {};
        Object.keys(cleaned).forEach((k) => { beforeSnap[k] = original[k] ?? null; });
        list[idx] = { ...original, ...cleaned };
        afterSnap = cleaned;
        summary = `Edited chaperone ${original.name || tempId} on onboarding ${recordId}`;
        auditKind = 'onboarding.chaperone_edit';
      } else if (action === 'delete') {
        beforeSnap = { ...original };
        // Best-effort cleanup of the uploaded face files in Storage
        try {
          const bucket = getFirebaseStorage().bucket();
          await Promise.all((original.facePaths || []).map((p) =>
            bucket.file(p).delete().catch(() => null)));
        } catch {}
        list.splice(idx, 1);
        afterSnap = null;
        summary = `Deleted chaperone ${original.name || tempId} from onboarding ${recordId}`;
        auditKind = 'onboarding.chaperone_delete';
      } else if (action === 'delete-face') {
        if (!facePath) return res.status(400).json({ error: 'facePath required' });
        const paths = original.facePaths || [];
        if (!paths.includes(facePath)) {
          return res.status(404).json({ error: 'facePath not associated with this chaperone' });
        }
        beforeSnap = { facePaths: [...paths] };
        try {
          const bucket = getFirebaseStorage().bucket();
          await bucket.file(facePath).delete().catch(() => null);
        } catch {}
        list[idx] = { ...original, facePaths: paths.filter((p) => p !== facePath) };
        afterSnap = { facePaths: list[idx].facePaths };
        summary = `Removed face photo from chaperone ${original.name || tempId}`;
        auditKind = 'onboarding.chaperone_face_delete';
      } else if (action === 'add-face') {
        const img = parseFaceImage(imageBase64);
        if (!img) {
          return res.status(400).json({
            error: 'invalid_image',
            message: 'Image must be JPEG / PNG / WebP and ≤ 800 KB.',
          });
        }
        const existing = original.facePaths || [];
        if (existing.length >= MAX_FACES_PER_CHAP) {
          return res.status(409).json({
            error: 'max_faces',
            message: `Maximum ${MAX_FACES_PER_CHAP} face photos per chaperone. Delete one first.`,
          });
        }
        // Find next free photo-{i} slot under the same pending folder convention
        // used by the parent flow (chaperone_faces_pending/{tempId}/photo-{i}).
        const usedIdx = new Set();
        existing.forEach((p) => {
          const m = String(p).match(/\/photo-(\d+)\.[a-z]+$/i);
          if (m) usedIdx.add(Number(m[1]));
        });
        let nextIdx = 0;
        while (usedIdx.has(nextIdx)) nextIdx += 1;
        const newPath = `tenants/${tid}/chaperone_faces_pending/${tempId}/photo-${nextIdx}.${img.ext}`;
        try {
          const bucket = getFirebaseStorage().bucket();
          await bucket.file(newPath).save(img.buf, {
            contentType: img.contentType,
            resumable: false,
            metadata: {
              cacheControl: 'private, max-age=0, no-store',
              metadata: {
                tenantId: tid,
                tempId: String(tempId),
                photoIndex: String(nextIdx),
                uploadedAt: new Date().toISOString(),
                uploadedBy: req.headers['x-admin-user'] || 'admin',
                source: 'admin-onboarding-edit',
              },
            },
          });
        } catch (e) {
          return res.status(500).json({ error: 'storage_failed', message: e.message });
        }
        beforeSnap = { facePaths: [...existing] };
        list[idx] = { ...original, facePaths: [...existing, newPath] };
        afterSnap = { facePaths: list[idx].facePaths };
        summary = `Added face photo to chaperone ${original.name || tempId}`;
        auditKind = 'onboarding.chaperone_face_add';
      }

      await ref.update({
        chaperones: list,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }

    if (target === 'record') {
      if (action !== 'add-chaperone') {
        return res.status(400).json({ error: 'unsupported action for record target' });
      }

      const existing = Array.isArray(rec.chaperones) ? rec.chaperones : [];
      if (existing.length >= MAX_CHAPERONES_PER_RECORD) {
        return res.status(409).json({
          error: 'max_chaperones',
          message: `This form already has the maximum ${MAX_CHAPERONES_PER_RECORD} chaperones. Delete one first.`,
        });
      }

      const src = chaperone && typeof chaperone === 'object' ? chaperone : {};
      const name = String(src.name || '').trim();
      const phone = String(src.phone || '').trim();
      const relation = ALLOWED_RELATIONS.has(String(src.relation || '').toLowerCase())
        ? String(src.relation).toLowerCase()
        : 'other';
      const email = src.email ? String(src.email).trim().toLowerCase().slice(0, 128) : null;
      const idNumber = src.idNumber ? String(src.idNumber).trim().slice(0, 32) : null;

      if (!name || name.length < 2 || name.length > 80) {
        return res.status(400).json({ error: 'invalid_name', message: 'Name must be 2–80 characters.' });
      }
      if (!phone || phone.length > 24) {
        return res.status(400).json({ error: 'invalid_phone', message: 'Phone is required (max 24 chars).' });
      }

      const validStudentIds = new Set((rec.students || []).map((s) => String(s.id)));
      const authorizedStudentIds = Array.isArray(src.authorizedStudentIds)
        ? src.authorizedStudentIds.map(String).filter((sid) => validStudentIds.has(sid))
        : [];
      if (authorizedStudentIds.length === 0) {
        return res.status(400).json({
          error: 'no_students',
          message: 'Pick at least one student this chaperone is authorized to collect.',
        });
      }

      // Stable, unique tempId so subsequent /add-face uploads land in the
      // same Storage folder convention used by the parent form.
      const newTempId = `admin-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const newChap = {
        tempId: newTempId,
        name,
        relation,
        phone,
        idNumber,
        email,
        authorizedStudentIds,
        facePaths: [],            // admin uploads photos next via add-face
        addedByAdmin: true,
        addedByAdminAt: new Date().toISOString(),
        addedByAdminEmail: req.headers['x-admin-user'] || null,
      };
      auditTargetLabel = name;
      beforeSnap = null;
      afterSnap = newChap;
      summary = `Added chaperone ${name} to onboarding ${recordId}`;
      auditKind = 'onboarding.chaperone_add';

      const updates = {
        chaperones: [...existing, newChap],
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      };

      // If the parent record is already approved, allocate a chaperoneId
      // immediately so this new adult is a first-class citizen alongside
      // the originally-approved chaperones. Photos + device push happen
      // afterwards via /v2/pickup-enroll like any other chaperone.
      if (rec.status === 'approved') {
        try {
          // Pull student metadata so we can derive grades/homerooms the same
          // way approve.js does.
          const studentMetaById = {};
          await Promise.all(authorizedStudentIds.map(async (sid) => {
            const s = await db.doc(`${tenancy.studentsPath(tid)}/${sid}`).get();
            if (s.exists) { studentMetaById[sid] = s.data() || {}; return; }
            const legacy = await db.doc(`students/${sid}`).get();
            if (legacy.exists) studentMetaById[sid] = legacy.data() || {};
          }));

          const studentClassesSet = new Set();
          const studentGradesSet = new Set();
          for (const sid of authorizedStudentIds) {
            const s = studentMetaById[sid];
            if (!s) continue;
            if (s.homeroom) studentClassesSet.add(String(s.homeroom));
            const g = s.grade ? String(s.grade) : gradeFromHomeroom(s.homeroom);
            if (g) studentGradesSet.add(g);
          }

          const employeeNo = await allocateEmployeeNo(db, tid);
          const chaperoneId = `chap-${employeeNo}`;
          const nowIso = new Date().toISOString();

          const chapDoc = {
            chaperoneId,
            employeeNo,
            tenantId: tid,
            name,
            relation,
            phone,
            email: email || null,
            idNumber: idNumber || null,
            guardianName: rec.guardian?.name || null,
            guardianEmail: rec.guardian?.email || null,
            guardianPhone: rec.guardian?.phone || null,
            authorizedStudentIds,
            studentClasses: [...studentClassesSet],
            studentGrades: [...studentGradesSet],
            facePaths: [],
            status: 'approved_pending_faces',
            deviceEnrolled: false,
            deviceEnrollErrors: null,
            approvedAt: nowIso,
            approvedFromOnboarding: recordId,
            reEnrollDueAt: new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString(),
            suspendedAt: null,
            addedByAdmin: true,
            addedByAdminEmail: req.headers['x-admin-user'] || null,
          };
          await db.doc(`${tenancy.chaperonesPath(tid)}/${chaperoneId}`).set(chapDoc, { merge: false });

          // Denormalize onto authorized student docs (best effort).
          await Promise.all(authorizedStudentIds.map(async (sid) => {
            const sref = db.doc(`${tenancy.studentsPath(tid)}/${sid}`);
            const ssnap = await sref.get();
            if (!ssnap.exists) return;
            const existingDenorm = ssnap.data().authorizedChaperones || [];
            if (existingDenorm.some((e) => e.chaperoneId === chaperoneId)) return;
            await sref.set({
              authorizedChaperones: [
                ...existingDenorm,
                { chaperoneId, employeeNo, name, relation },
              ],
            }, { merge: true });
          }));

          const allocated = Array.isArray(rec.allocatedChaperones) ? rec.allocatedChaperones : [];
          updates.allocatedChaperones = [
            ...allocated,
            { chaperoneId, employeeNo, facesCopied: 0 },
          ];
          afterSnap = { ...newChap, chaperoneId, employeeNo };
        } catch (e) {
          console.error('[onboarding-edit] post-approval allocation failed', e.message);
          return res.status(500).json({
            error: 'allocation_failed',
            message: `Could not allocate chaperoneId: ${e.message}`,
          });
        }
      }

      await ref.update(updates);
    }

    if (target === 'student') {
      const list = Array.isArray(rec.students) ? [...rec.students] : [];
      const idx = list.findIndex((s) => s.id === id);
      if (idx === -1) return res.status(404).json({ error: 'student not found in record' });
      const original = list[idx];
      auditTargetLabel = original.name || id;

      if (action === 'update') {
        const cleaned = clean(patch, ALLOWED_STUDENT_FIELDS);
        if (Object.keys(cleaned).length === 0) {
          return res.status(400).json({ error: 'no editable fields supplied' });
        }
        beforeSnap = {};
        Object.keys(cleaned).forEach((k) => { beforeSnap[k] = original[k] ?? null; });
        list[idx] = { ...original, ...cleaned };
        afterSnap = cleaned;
        summary = `Edited student ${original.name || id} on onboarding ${recordId}`;
        auditKind = 'onboarding.student_edit';
      } else if (action === 'delete') {
        if (list.length <= 1) {
          return res.status(409).json({ error: 'cannot remove the only student on a record' });
        }
        beforeSnap = { ...original };
        list.splice(idx, 1);
        // Remove this id from any chaperone's authorizedStudentIds
        const chaps = (rec.chaperones || []).map((c) => ({
          ...c,
          authorizedStudentIds: (c.authorizedStudentIds || []).filter((sid) => sid !== id),
        }));
        afterSnap = null;
        summary = `Deleted student ${original.name || id} from onboarding ${recordId}`;
        auditKind = 'onboarding.student_delete';
        await ref.update({
          students: list,
          chaperones: chaps,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      } else {
        return res.status(400).json({ error: 'unsupported action for student' });
      }

      if (action === 'update') {
        await ref.update({
          students: list,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      }
    }

    await logAudit(db, {
      tenantId: tid, req,
      actor: { email: req.headers['x-admin-user'] || null, name: null, role: 'admin' },
      kind: auditKind,
      target: { type: target, id: tempId || id, label: auditTargetLabel },
      before: beforeSnap,
      after: afterSnap,
      summary,
      metadata: { recordId },
    });

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[pickup/admin/onboarding-edit]', err.message, err.stack);
    return res.status(500).json({ error: 'internal', message: err.message });
  }
}

export default withApi(handler, { permission: 'pickup_admin.edit_chaperone' });

export const config = { api: { bodyParser: { sizeLimit: '2mb' } } };
