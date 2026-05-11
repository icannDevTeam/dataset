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
    recordId, target, tempId, id, action, patch, facePath, imageBase64, tenant,
  } = req.body || {};
  const tid = tenant ? String(tenant) : tenancy.getTenantId();

  if (!recordId) return res.status(400).json({ error: 'recordId required' });
  if (!['chaperone', 'student'].includes(target)) {
    return res.status(400).json({ error: 'target must be chaperone|student' });
  }
  if (!['update', 'delete', 'delete-face', 'add-face'].includes(action)) {
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
      return res.status(409).json({
        error: 'record_not_editable',
        message: `Cannot edit a ${rec.status} record. Re-enroll or revoke instead.`,
      });
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
