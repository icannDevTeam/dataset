/**
 * POST /api/pickup/onboarding/face
 *
 * Token-gated chaperone face upload. The parent captures 1–5 photos
 * per chaperone in the browser; each photo is uploaded here and the
 * returned storage path is collected into `chaperone.facePaths` in
 * the final submission.
 *
 * Body: { token, tempId, photoIndex, imageBase64 }   // tempId is the
 * client-side per-chaperone identifier used to group uploads, photoIndex
 * is 0..4. The path is namespaced to {tid}/onboarding/{tempId}/ so
 * staged uploads can be GC'd if a submission is abandoned.
 *
 * Returns: { ok, path }
 */
import { initializeFirebase, getFirebaseStorage } from '../../../../lib/firebase-admin';

const tenancy = require('../../../../lib/tenancy');
const { verifyPickupOnboardingToken } = require('../../../../lib/pickup-token');

const MAX_BYTES = 600 * 1024; // 600 KB cap per photo

function decodeBase64Image(b64) {
  const m = String(b64 || '').match(/^data:image\/(jpeg|jpg|png|webp);base64,(.+)$/i);
  let mime = 'image/jpeg';
  let raw = b64;
  if (m) { mime = `image/${m[1].toLowerCase()}`; raw = m[2]; }
  const buf = Buffer.from(raw, 'base64');
  return { buf, mime };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { token, tempId, photoIndex, imageBase64 } = req.body || {};
  const claims = verifyPickupOnboardingToken(token || '');
  if (!claims) return res.status(401).json({ error: 'invalid or expired token' });
  if (!tempId || typeof tempId !== 'string' || !/^[A-Za-z0-9_-]{6,64}$/.test(tempId)) {
    return res.status(400).json({ error: 'tempId required (6–64 alphanumeric)' });
  }
  const idx = Number(photoIndex);
  if (!Number.isInteger(idx) || idx < 0 || idx > 4) {
    return res.status(400).json({ error: 'photoIndex must be 0..4' });
  }
  if (!imageBase64 || typeof imageBase64 !== 'string') {
    return res.status(400).json({ error: 'imageBase64 required' });
  }
  let buf, mime;
  try { ({ buf, mime } = decodeBase64Image(imageBase64)); }
  catch { return res.status(400).json({ error: 'bad base64' }); }
  if (buf.length === 0 || buf.length > MAX_BYTES) {
    return res.status(400).json({ error: `photo size out of range (max ${MAX_BYTES} bytes)` });
  }
  const ext = mime === 'image/png' ? 'png' : (mime === 'image/webp' ? 'webp' : 'jpg');
  const path = `tenants/${claims.tid}/chaperone_faces_pending/${tempId}/photo-${idx}.${ext}`;

  try {
    initializeFirebase();
    const bucket = getFirebaseStorage().bucket();
    const file = bucket.file(path);
    await file.save(buf, {
      contentType: mime,
      resumable: false,
      metadata: {
        cacheControl: 'private, no-cache',
        metadata: {
          purpose: 'pickup-onboarding',
          tenantId: claims.tid,
          tempId,
          photoIndex: String(idx),
          uploadedAt: new Date().toISOString(),
        },
      },
    });
    return res.status(200).json({ ok: true, path });
  } catch (err) {
    console.error('[pickup/onboarding/face]', err.message);
    return res.status(500).json({ error: 'internal' });
  }
}

export const config = { api: { bodyParser: { sizeLimit: '1mb' } } };
