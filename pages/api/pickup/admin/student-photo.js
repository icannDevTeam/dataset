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
import sharp from 'sharp';
import { initializeFirebase, getFirebaseStorage } from '../../../../lib/firebase-admin';
import { withApi } from '../../../../lib/api-auth';
const tenancy = require('../../../../lib/tenancy');

const MAX_BYTES = 800 * 1024;
const MAX_SOURCE_BYTES = 8 * 1024 * 1024;
const SHARP_TIMEOUT_MS = 25000;
const STORAGE_SAVE_TIMEOUT_MS = 30000;
const STORAGE_SAVE_RETRIES = 1;
// 7 days is the v4-signed-URL ceiling. The admin UI re-fetches when expired.
const SIGNED_URL_TTL_MS = 7 * 24 * 60 * 60 * 1000;

async function withTimeout(promise, ms, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function isTransientStorageError(err) {
  const msg = String(err?.message || '').toLowerCase();
  const code = String(err?.code || '').toLowerCase();
  return (
    msg.includes('timeout') ||
    msg.includes('timed out') ||
    msg.includes('econnreset') ||
    msg.includes('socket hang up') ||
    msg.includes('eai_again') ||
    msg.includes('429') ||
    msg.includes('503') ||
    code === 'etimedout' ||
    code === 'econnreset' ||
    code === 'eai_again'
  );
}

async function saveFileWithRetry(fileRef, buf, saveOptions) {
  let lastErr;
  for (let attempt = 0; attempt <= STORAGE_SAVE_RETRIES; attempt++) {
    try {
      await withTimeout(
        fileRef.save(buf, saveOptions),
        STORAGE_SAVE_TIMEOUT_MS,
        'storage_save_timeout',
      );
      return;
    } catch (err) {
      lastErr = err;
      if (attempt >= STORAGE_SAVE_RETRIES || !isTransientStorageError(err)) break;
    }
  }
  throw lastErr;
}

async function decodeBase64Image(b64) {
  const m = String(b64 || '').match(/^data:image\/(jpeg|jpg|png|webp|heic|heif);base64,(.+)$/i);
  if (!m) return null;
  let buf;
  try {
    buf = Buffer.from(m[2], 'base64');
  } catch {
    return null;
  }
  if (!buf.length || buf.length > MAX_SOURCE_BYTES) return null;
  try {
    const out = await withTimeout(
      sharp(buf).rotate().jpeg({ quality: 90 }).toBuffer(),
      SHARP_TIMEOUT_MS,
      'image_processing_timeout',
    );
    if (!out.length || out.length > MAX_BYTES) return null;
    return { buf: out, mime: 'image/jpeg', ext: 'jpg' };
  } catch {
    return null;
  }
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

    const decoded = await decodeBase64Image(req.body?.imageBase64);
    if (!decoded) {
      return res.status(400).json({
        error: `imageBase64 invalid (jpeg/png/webp/heic/heif, normalizes to ≤ ${MAX_BYTES} bytes)`,
      });
    }

    const ref = db.doc(`students/${studentId}`);
    const snap = await ref.get();
    if (!snap.exists) {
      return res.status(404).json({ error: 'student not found in legacy `students/` collection' });
    }

    const dst = `tenants/${tid}/student_photos/${studentId}.${decoded.ext}`;
    await saveFileWithRetry(bucket.file(dst), decoded.buf, {
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
    if (isTransientStorageError(e)) {
      return res.status(503).json({
        error: 'storage_unavailable',
        message: 'Storage is temporarily unavailable. Please retry upload.',
      });
    }
    return res.status(500).json({ error: 'internal', message: e.message });
  }
}

export default withApi(handler, { methods: ['GET', 'POST'], permission: 'pickup_admin.upload_face' });

export const config = { api: { bodyParser: { sizeLimit: '4mb' } } };
