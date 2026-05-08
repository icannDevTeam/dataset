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
 *     enroll?:     true,    // default true — re-enroll on Hikvision devices after upload
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
import { withAuth } from '../../../../lib/auth-middleware';
import { enrollChaperones } from '../../../../lib/chaperone-enroll';
const tenancy = require('../../../../lib/tenancy');

const MAX_BYTES = 800 * 1024;        // 800KB per photo
const SIGNED_URL_TTL_MS = 5 * 60 * 1000;

function decodeBase64Image(b64) {
  const m = String(b64 || '').match(/^data:image\/(jpeg|jpg|png|webp);base64,(.+)$/i);
  if (!m) return null;
  const mime = `image/${m[1].toLowerCase() === 'jpg' ? 'jpeg' : m[1].toLowerCase()}`;
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > MAX_BYTES) return null;
  return { buf, mime, ext: mime.split('/')[1].replace('jpeg', 'jpg') };
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
      const data = snap.data();
      const paths = Array.isArray(data.facePaths) ? data.facePaths : [];
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

    if (req.method !== 'POST') return res.status(405).json({ error: 'method' });

    const { chaperoneId, photos, enroll = true, replace = false } = req.body || {};
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
    const existing = snap.data().facePaths || [];
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
      const decoded = decodeBase64Image(photos[i]?.imageBase64);
      if (!decoded) {
        return res.status(400).json({ error: `photo ${i} invalid (must be base64 image \u2264 ${MAX_BYTES} bytes)` });
      }
      const dst = `tenants/${tid}/chaperone_faces/${chaperoneId}/photo-${startIdx + i}.${decoded.ext}`;
      await bucket.file(dst).save(decoded.buf, {
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
    }, { merge: true });

    let enrollment = null;
    if (enroll) {
      try {
        enrollment = await enrollChaperones(db, bucket, tid, [chaperoneId]);
      } catch (e) {
        console.error('[chaperone-photos] enroll error', e.message);
        enrollment = [{ chaperoneId, ok: false, error: e.message }];
      }
    }

    return res.status(200).json({ ok: true, chaperoneId, paths, enrollment });
  } catch (e) {
    console.error('[pickup/admin/chaperone-photos]', e.message);
    return res.status(500).json({ error: 'internal', message: e.message });
  }
}

export default withAuth(handler, { methods: ['GET', 'POST'] });

export const config = { api: { bodyParser: { sizeLimit: '8mb' } } };
