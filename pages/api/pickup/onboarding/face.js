/**
 * POST /api/pickup/onboarding/face
 *
 * Token-gated chaperone face photo upload (Phase 3).
 *
 * Body: { token, tempId, photoIndex, imageBase64 }
 *   - imageBase64: data URL ("data:image/jpeg;base64,...") or raw base64
 *   - tempId    : client-side uuid that ties multiple photos to one chaperone
 *   - photoIndex: 0..2 (max 3 photos per chaperone)
 *
 * Stores at: tenants/{tid}/chaperone_faces_pending/{tempId}/photo-{index}.{ext}
 * Returns:   { ok, path }
 *
 * Rate-limited (30/min per IP). Max payload: 1 MB (post-base64).
 */
import { initializeFirebase, getFirebaseStorage } from '../../../../lib/firebase-admin';

const { verifyPickupOnboardingToken } = require('../../../../lib/pickup-token');
const { enforceRateLimit, clientIp } = require('../../../../lib/rate-limit');

const MAX_BYTES = 600 * 1024;        // 600 KB per photo (matches client compressor)
const MAX_PHOTO_INDEX = 2;            // 0,1,2 → up to 3 photos
const ALLOWED_MIME = {
  jpeg: 'jpg', jpg: 'jpg', png: 'png', webp: 'webp',
};

function parseImage(b64) {
  if (typeof b64 !== 'string' || !b64.length) return null;
  const m = b64.match(/^data:image\/(jpeg|jpg|png|webp);base64,(.+)$/i);
  if (!m) return null;
  const ext = ALLOWED_MIME[m[1].toLowerCase()];
  if (!ext) return null;
  let buf;
  try { buf = Buffer.from(m[2], 'base64'); } catch { return null; }
  if (!buf.length || buf.length > MAX_BYTES) return null;
  return { buf, ext, contentType: `image/${ext === 'jpg' ? 'jpeg' : ext}` };
}

function safeTempId(s) {
  return typeof s === 'string' && /^[A-Za-z0-9_-]{4,64}$/.test(s) ? s : null;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const rl = enforceRateLimit('pickup:onboarding-face', clientIp(req), { max: 30, windowMs: 60_000 });
  if (!rl.allowed) {
    res.setHeader('Retry-After', rl.retryAfter);
    return res.status(429).json({ error: 'rate_limited', retryAfter: rl.retryAfter });
  }

  const { token, tempId, photoIndex, imageBase64 } = req.body || {};
  const claims = verifyPickupOnboardingToken(token || '');
  if (!claims) return res.status(401).json({ error: 'invalid or expired token' });

  const tid = claims.tid;
  const tmp = safeTempId(tempId);
  if (!tmp) return res.status(400).json({ error: 'invalid tempId' });

  const idx = Number(photoIndex);
  if (!Number.isInteger(idx) || idx < 0 || idx > MAX_PHOTO_INDEX) {
    return res.status(400).json({ error: 'photoIndex out of range (0–2)' });
  }

  const img = parseImage(imageBase64);
  if (!img) return res.status(400).json({ error: 'invalid image (jpeg/png/webp ≤ 600KB required)' });

  const path = `tenants/${tid}/chaperone_faces_pending/${tmp}/photo-${idx}.${img.ext}`;

  try {
    initializeFirebase();
    const bucket = getFirebaseStorage().bucket();
    await bucket.file(path).save(img.buf, {
      contentType: img.contentType,
      resumable: false,
      metadata: {
        cacheControl: 'private, max-age=0, no-store',
        metadata: {
          tenantId: tid,
          tempId: tmp,
          photoIndex: String(idx),
          uploadedAt: new Date().toISOString(),
          uploadedFromIp: clientIp(req) || '',
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
