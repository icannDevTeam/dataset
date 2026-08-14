/**
 * POST /api/pickup/admin/chaperone-photos
 *
 * Admin uploads chaperone face photos AFTER an onboarding submission has been
 * approved (Phase 2 — parents no longer upload faces themselves).
 *
 * Body:
 *   {
 *     chaperoneId: string,
 *     photos:      [{ imageBase64: 'data:image/jpeg;base64,...' }, ...],   // 1..8
 *     replace?:    false,   // if true, deletes existing photo-N.jpg first
 *   }
 *
 * Returns: { ok, chaperoneId, paths, enrollment? }
 *
 * GET /api/pickup/admin/chaperone-photos?chaperoneId=...
 *   Lists current face photo paths + signed URLs for the admin UI.
 */
import admin from 'firebase-admin';
import { initializeFirebase, getFirebaseStorage } from '../../../../lib/firebase-admin';
import { withApi } from '../../../../lib/api-auth';
import { enrollChaperones } from '../../../../lib/chaperone-enroll';
const tenancy = require('../../../../lib/tenancy');

const MAX_BYTES = 800 * 1024;        // 800KB per photo
const SIGNED_URL_TTL_MS = 5 * 60 * 1000;
const SHARP_TIMEOUT_MS = 25000;
const STORAGE_SAVE_TIMEOUT_MS = 30000;
const STORAGE_SAVE_RETRIES = 1;
let _sharpInstance = undefined;

function getSharp() {
  if (_sharpInstance !== undefined) return _sharpInstance;
  try {
    // Lazy load to avoid route boot failures on hosts where sharp binary
    // is unavailable. Route still works with a non-sharp fallback.
    // eslint-disable-next-line global-require
    _sharpInstance = require('sharp');
  } catch {
    _sharpInstance = null;
  }
  return _sharpInstance;
}

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

async function normalizeBase64Image(b64) {
  const m = String(b64 || '').match(/^data:image\/(jpeg|jpg|png|webp|heic|heif);base64,(.+)$/i);
  if (!m) return null;
  const sourceMime = m[1].toLowerCase();
  const buf = Buffer.from(m[2], 'base64');
  if (!buf.length || buf.length > 8 * 1024 * 1024) return null;
  const sharpLib = getSharp();

  // Fallback path when sharp is unavailable in runtime.
  if (!sharpLib) {
    if (!['jpeg', 'jpg', 'png', 'webp'].includes(sourceMime)) return null;
    if (buf.length > MAX_BYTES) return null;
    const ext = sourceMime === 'jpeg' ? 'jpg' : sourceMime;
    const mime = `image/${sourceMime === 'jpg' ? 'jpeg' : sourceMime}`;
    return { buf, mime, ext, sourceMime };
  }

  try {
    const out = await withTimeout(
      sharpLib(buf).rotate().jpeg({ quality: 90 }).toBuffer(),
      SHARP_TIMEOUT_MS,
      'image_processing_timeout',
    );
    if (!out.length || out.length > MAX_BYTES) return null;
    return { buf: out, mime: 'image/jpeg', ext: 'jpg', sourceMime };
  } catch {
    return null;
  }
}

function normalizeFacePaths(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((p) => typeof p === 'string' && p.trim().length > 0);
}

async function handler(req, res) {
  try {
    initializeFirebase();
    const db = admin.firestore();
    const bucket = getFirebaseStorage().bucket();
    const tid = tenancy.getTenantId();

    if (req.method === 'GET') {
      const chaperoneId = String(req.query.chaperoneId || '');
      if (!chaperoneId) return res.status(400).json({ error: 'chaperoneId required' });
      const ref = db.doc(`${tenancy.chaperonesPath(tid)}/${chaperoneId}`);
      const snap = await ref.get();
      if (!snap.exists) return res.status(404).json({ error: 'chaperone not found' });
      const data = snap.data() || {};
      const paths = normalizeFacePaths(data.facePaths);
      const urls = await Promise.all(paths.map(async (p) => {
        try {
          const [u] = await bucket.file(p).getSignedUrl({
            action: 'read', expires: Date.now() + SIGNED_URL_TTL_MS,
          });
          return { path: p, url: u };
        } catch { return { path: p, url: null }; }
      }));
      return res.status(200).json({ ok: true, chaperoneId, photos: urls, status: data.status });
    }

    if (req.method === 'DELETE') {
      const body = req.body || {};
      const chaperoneId = String(body.chaperoneId || req.query.chaperoneId || '');
      const photoPath = typeof body.photoPath === 'string' ? body.photoPath : (typeof req.query.photoPath === 'string' ? req.query.photoPath : null);
      const all = Boolean(body.all || req.query.all === 'true');
      if (!chaperoneId) return res.status(400).json({ error: 'chaperoneId required' });

      const ref = db.doc(`${tenancy.chaperonesPath(tid)}/${chaperoneId}`);
      const snap = await ref.get();
      if (!snap.exists) return res.status(404).json({ error: 'chaperone not found' });

      const current = normalizeFacePaths((snap.data() || {}).facePaths);
      const removePaths = all
        ? [...current]
        : photoPath
          ? current.filter((p) => p === photoPath)
          : [];

      if (removePaths.length === 0) {
        return res.status(200).json({ ok: true, chaperoneId, removed: [], facePaths: current, unchanged: true });
      }

      for (const p of removePaths) {
        try { await bucket.file(p).delete(); } catch {}
      }

      const nextPaths = current.filter((p) => !removePaths.includes(p));
      await ref.set({
        facePaths: nextPaths,
        status: nextPaths.length > 0 ? 'approved' : 'approved_pending_faces',
        facesUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });

      return res.status(200).json({ ok: true, chaperoneId, removed: removePaths, facePaths: nextPaths });
    }

    if (req.method !== 'POST') return res.status(405).json({ error: 'method' });

    const { chaperoneId, photos, replace = false } = req.body || {};
    if (!chaperoneId || typeof chaperoneId !== 'string') {
      return res.status(400).json({ error: 'chaperoneId required' });
    }
    if (!Array.isArray(photos) || photos.length === 0 || photos.length > 2) {
      return res.status(400).json({ error: 'photos must be a 1..2 element array' });
    }

    const ref = db.doc(`${tenancy.chaperonesPath(tid)}/${chaperoneId}`);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ error: 'chaperone not found' });

    // Optionally wipe existing photos first.
    const snapData = snap.data() || {};
    const existing = normalizeFacePaths(snapData.facePaths);

    // Legacy/corrupt docs may contain unexpected non-array values for facePaths.
    // Treat them as empty to keep upload path functional instead of throwing 500.
    if (!Array.isArray(snapData.facePaths) && snapData.facePaths != null) {
      console.warn('[chaperone-photos] normalized non-array facePaths', {
        chaperoneId,
        receivedType: typeof snapData.facePaths,
      });
    }

    if (!replace && existing.length >= 2) {
      return res.status(409).json({
        error: 'face_cap_reached',
        message: 'This chaperone already has 2 photos. Use replace mode to overwrite.',
      });
    }

    if (replace) {
      for (const p of existing) {
        try { await bucket.file(p).delete(); } catch {}
      }
    }
    const startIdx = replace ? 0 : existing.length;

    const paths = replace ? [] : [...existing];
    // Hard cap: at most 2 chaperone face photos retained on the admin side.
    // Without this the append branch (`replace=false`) could grow unbounded.
    if (paths.length + photos.length > 2) {
      return res.status(400).json({
        error: `chaperone face cap is 2 (existing=${existing.length}, ` +
               `requested=${photos.length}, would-be=${paths.length + photos.length}). ` +
               `Use replace=true to start from scratch.`,
      });
    }
    for (let i = 0; i < photos.length; i++) {
      const decoded = await normalizeBase64Image(photos[i]?.imageBase64);
      if (!decoded) {
        return res.status(400).json({ error: `photo ${i} invalid (must be JPEG/PNG/WebP/HEIC/HEIF and normalize to \u2264 ${MAX_BYTES} bytes)` });
      }
      const dst = `tenants/${tid}/chaperone_faces/${chaperoneId}/photo-${startIdx + i}.${decoded.ext}`;
      await saveFileWithRetry(bucket.file(dst), decoded.buf, {
        contentType: decoded.mime,
        resumable: false,
        metadata: { metadata: { uploadedBy: 'admin', uploadedAt: new Date().toISOString() } },
      });
      paths.push(dst);
    }

    await ref.set({
      facePaths: paths,
      status: 'approved',
      facesUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
      reenrollDueAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });

    // Photo updates always require a terminal re-enrollment attempt so the
    // enrolled face template matches the latest admin upload.
    let enrollment = null;
    try {
      enrollment = await enrollChaperones(db, bucket, tid, [chaperoneId]);
    } catch (e) {
      console.error('[chaperone-photos] enroll error', e.message);
      enrollment = [{ chaperoneId, ok: false, error: e.message }];
    }
    const enrollmentOk = Array.isArray(enrollment) && enrollment.length > 0 && enrollment.every((r) => r.ok === true);

    return res.status(200).json({
      ok: true,
      chaperoneId,
      paths,
      enrollment,
      enrollmentTriggered: true,
      enrollmentOk,
      needsEnrollment: !enrollmentOk,
    });
  } catch (e) {
    console.error('[pickup/admin/chaperone-photos]', e.message, e.stack || '');
    if (isTransientStorageError(e)) {
      return res.status(503).json({
        error: 'storage_unavailable',
        message: 'Storage is temporarily unavailable. Please retry upload.',
      });
    }
    return res.status(500).json({ error: 'internal', message: e.message });
  }
}

export default withApi(handler, { methods: ['GET', 'POST', 'DELETE'], permission: 'pickup_admin.upload_face' });

export const config = { api: { bodyParser: { sizeLimit: '12mb' } } };
