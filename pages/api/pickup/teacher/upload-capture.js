/**
 * POST /api/pickup/teacher/upload-capture
 *
 * Uploads teacher-captured evidence image for red-card release.
 * Body: { eventId, imageData, tenant? }
 */
import admin from 'firebase-admin';
import { initializeFirebase, getFirebaseStorage } from '../../../../lib/firebase-admin';
import { verifyCookie } from '../../auth/session';
const tenancy = require('../../../../lib/tenancy');

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '8mb',
    },
  },
};

function readCookie(req, name) {
  const raw = req.headers.cookie || '';
  for (const p of raw.split(';').map((x) => x.trim())) {
    if (p.startsWith(`${name}=`)) return decodeURIComponent(p.slice(name.length + 1));
  }
  return null;
}

function parseDataUrl(imageData) {
  if (typeof imageData !== 'string') return null;
  const m = imageData.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
  if (!m) return null;
  return { mime: m[1], base64: m[2] };
}

function extForMime(mime) {
  if (mime === 'image/png') return 'png';
  if (mime === 'image/webp') return 'webp';
  return 'jpg';
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });

  const { eventId, imageData, tenant } = req.body || {};
  if (!eventId || typeof eventId !== 'string') {
    return res.status(400).json({ error: 'eventId is required' });
  }

  const parsed = parseDataUrl(imageData);
  if (!parsed) {
    return res.status(400).json({ error: 'imageData must be a base64 data URL' });
  }

  const sessionMarker = readCookie(req, '__session');
  const session = sessionMarker ? verifyCookie(sessionMarker) : null;
  if (!session?.email) return res.status(401).json({ error: 'login required' });

  initializeFirebase();
  const db = admin.firestore();
  const actorEmail = String(session.email).toLowerCase();
  const userSnap = await db.collection('dashboard_users').doc(actorEmail).get();
  if (!userSnap.exists) return res.status(403).json({ error: 'account not authorized' });
  const user = userSnap.data() || {};
  if (user.disabled) return res.status(403).json({ error: 'account disabled' });

  const role = String(user.role || 'viewer');
  if (!['owner', 'admin', 'teacher'].includes(role)) {
    return res.status(403).json({ error: 'insufficient role' });
  }

  const tid = tenancy.getTenantId(tenant);

  let buffer;
  try {
    buffer = Buffer.from(parsed.base64, 'base64');
  } catch {
    return res.status(400).json({ error: 'invalid base64 image' });
  }
  if (!buffer || buffer.length === 0) return res.status(400).json({ error: 'empty image' });
  if (buffer.length > 6 * 1024 * 1024) return res.status(400).json({ error: 'image too large (max 6MB)' });

  const ext = extForMime(parsed.mime);
  const ts = Date.now();
  const storagePath = `tenants/${tid}/pickup_captures/${eventId}_${ts}.${ext}`;

  try {
    const bucket = getFirebaseStorage().bucket();
    const file = bucket.file(storagePath);
    await file.save(buffer, {
      metadata: {
        contentType: parsed.mime,
        metadata: {
          eventId,
          uploadedBy: actorEmail,
          source: 'teacher-device',
        },
      },
      resumable: false,
    });

    return res.status(200).json({ ok: true, storagePath });
  } catch (err) {
    console.error('[pickup/teacher/upload-capture]', err.message, err.stack);
    return res.status(500).json({ error: 'upload failed', message: err.message });
  }
}
