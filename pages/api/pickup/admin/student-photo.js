/**
 * POST /api/pickup/admin/student-photo
 *
 * Admin uploads a student profile photo from the onboarding form details view.
 * Parents now only collect student ID + name; the canonical photo is supplied
 * by school admins after the form is submitted.
 *
 * Body:
 *   {
 *     studentId:    string,                    // legacy `students/{sid}` doc id
 *     imageBase64:  'data:image/jpeg;base64,…' // jpeg/png/webp, ≤ 800 KB
 *   }
 *
 * Side-effects:
 *   - Saves the bytes to `tenants/{tid}/student_photos/{sid}.{ext}`
 *   - Generates a long-lived signed URL
 *   - Writes `students/{sid}.photoUrl`, `.photoPath`, `.photoUpdatedAt`
 *
 * Returns: { ok, studentId, photoUrl, photoPath }
 *
 * GET /api/pickup/admin/student-photo?studentId=…
 *   Returns the current `photoUrl` for the student.
 */
import admin from 'firebase-admin';
import { initializeFirebase, getFirebaseStorage } from '../../../../lib/firebase-admin';
import { withAuth } from '../../../../lib/auth-middleware';
const tenancy = require('../../../../lib/tenancy');

const MAX_BYTES = 800 * 1024;
// 7 days is the v4-signed-URL ceiling. The admin UI re-fetches when expired.
const SIGNED_URL_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function decodeBase64Image(b64) {
  const m = String(b64 || '').match(/^data:image\/(jpeg|jpg|png|webp);base64,(.+)$/i);
  if (!m) return null;
  const mime = `image/${m[1].toLowerCase() === 'jpg' ? 'jpeg' : m[1].toLowerCase()}`;
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > MAX_BYTES) return null;
  return { buf, mime, ext: mime.split('/')[1].replace('jpeg', 'jpg') };
}

function sanitizeId(s) {
  return String(s || '').trim().replace(/[^A-Za-z0-9_-]/g, '');
}

async function handler(req, res) {
  try {
    initializeFirebase();
    const db = admin.firestore();
    const bucket = getFirebaseStorage().bucket();
    const tid = tenancy.getTenantId();

    if (req.method === 'GET') {
      const studentId = sanitizeId(req.query.studentId);
      if (!studentId) return res.status(400).json({ error: 'studentId required' });
      const ref = db.doc(`students/${studentId}`);
      const snap = await ref.get();
      if (!snap.exists) return res.status(404).json({ error: 'student not found' });
      const data = snap.data() || {};
      let photoUrl = data.photoUrl || null;
      // Re-sign on demand if we have the path and the URL is missing/expired.
      if (data.photoPath) {
        try {
          const [u] = await bucket.file(data.photoPath).getSignedUrl({
            action: 'read', expires: Date.now() + SIGNED_URL_TTL_MS,
          });
          photoUrl = u;
        } catch {}
      }
      return res.status(200).json({
        ok: true, studentId, photoUrl, photoPath: data.photoPath || null,
      });
    }

    if (req.method !== 'POST') return res.status(405).json({ error: 'method' });

    const studentId = sanitizeId(req.body?.studentId);
    if (!studentId) return res.status(400).json({ error: 'studentId required' });

    const decoded = decodeBase64Image(req.body?.imageBase64);
    if (!decoded) {
      return res.status(400).json({
        error: `imageBase64 invalid (jpeg/png/webp, ≤ ${MAX_BYTES} bytes)`,
      });
    }

    const ref = db.doc(`students/${studentId}`);
    const snap = await ref.get();
    if (!snap.exists) {
      return res.status(404).json({ error: 'student not found in legacy `students/` collection' });
    }

    const dst = `tenants/${tid}/student_photos/${studentId}.${decoded.ext}`;
    await bucket.file(dst).save(decoded.buf, {
      contentType: decoded.mime,
      resumable: false,
      metadata: {
        metadata: {
          uploadedBy: req.user?.email || 'admin',
          uploadedAt: new Date().toISOString(),
        },
      },
    });

    let photoUrl = null;
    try {
      const [u] = await bucket.file(dst).getSignedUrl({
        action: 'read', expires: Date.now() + SIGNED_URL_TTL_MS,
      });
      photoUrl = u;
    } catch (e) {
      console.warn('[student-photo] sign error', e.message);
    }

    await ref.set({
      photoUrl,
      photoPath: dst,
      photoUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
      photoUpdatedBy: req.user?.email || 'admin',
    }, { merge: true });

    return res.status(200).json({ ok: true, studentId, photoUrl, photoPath: dst });
  } catch (e) {
    console.error('[pickup/admin/student-photo]', e.message);
    return res.status(500).json({ error: 'internal', message: e.message });
  }
}

export default withAuth(handler, { methods: ['GET', 'POST'] });

export const config = { api: { bodyParser: { sizeLimit: '4mb' } } };
