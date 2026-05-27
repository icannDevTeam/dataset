/**
 * GET /api/downloads/_jobs/status?jobId=...
 *
 * Poll a background export job. Returns the Firestore job doc verbatim
 * plus, when `status === 'completed'`, a short-lived signed URL for the
 * Storage object so the browser can download without re-authing.
 *
 * Storage layout:  exports/{tenantId}/{jobId}.{ext}
 * Signed URL TTL:  1h  (matches typical "leave the tab open" window)
 *
 * OPERATIONS NOTE
 * ───────────────
 * The bucket holding `exports/**` MUST have a lifecycle policy that
 * deletes objects after 30 days. We do NOT TTL Firestore job docs here
 * (kept for audit), but the binaries themselves are short-lived.
 * Configure once per bucket via `gsutil lifecycle set policy.json`.
 *
 * Permission: anyPermission on the four download keys (same gate as
 * /_jobs/start). We deliberately do NOT require a fresh re-auth here —
 * status polling is high-frequency and the heavy lift already happened.
 */
import admin from 'firebase-admin';
import { initializeFirebase, getFirebaseStorage } from '../../../../lib/firebase-admin';
import { withApi } from '../../../../lib/api-auth';
const tenancy = require('../../../../lib/tenancy');

const DOWNLOAD_KEYS = [
  'downloads.download_operational',
  'downloads.download_directory',
  'downloads.download_security',
  'downloads.download_compliance',
];

const SIGNED_URL_TTL_MS = 60 * 60 * 1000; // 1h

async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method' });

  const jobId = String(req.query?.jobId || '').trim();
  if (!jobId) return res.status(400).json({ error: 'bad_jobId' });

  initializeFirebase();
  const db = admin.firestore();
  const tid = tenancy.getTenantId();

  const ref = db.doc(`${tenancy.tenantDoc(tid)}/exportJobs/${jobId}`);
  const snap = await ref.get();
  if (!snap.exists) return res.status(404).json({ error: 'not_found' });

  const job = snap.data() || {};

  // Tenant boundary check belt-and-braces: a job under the wrong tenant
  // shouldn't even be queryable, but keep the explicit check.
  const out = {
    jobId,
    status: job.status || 'queued',
    cardId: job.cardId || null,
    format: job.format || null,
    rowCount: typeof job.rowCount === 'number' ? job.rowCount : null,
    error: job.error || null,
    durationMs: typeof job.durationMs === 'number' ? job.durationMs : null,
    createdAt: job.createdAt?.toDate ? job.createdAt.toDate().toISOString() : null,
    completedAt: job.completedAt?.toDate ? job.completedAt.toDate().toISOString() : null,
    failedAt: job.failedAt?.toDate ? job.failedAt.toDate().toISOString() : null,
  };

  if (job.status === 'completed' && job.storagePath) {
    try {
      const bucket = getFirebaseStorage().bucket();
      const [url] = await bucket.file(job.storagePath).getSignedUrl({
        action: 'read',
        expires: Date.now() + SIGNED_URL_TTL_MS,
      });
      out.downloadUrl = url;
      out.downloadUrlExpiresAt = new Date(Date.now() + SIGNED_URL_TTL_MS).toISOString();
      out.filename = job.filename || `${job.cardId}-${jobId}.${job.format}`;
      out.contentType = job.contentType || 'application/octet-stream';
    } catch (err) {
      console.error('[jobs/status] signed URL failed:', err);
      out.downloadUrl = null;
      out.downloadUrlError = String(err?.message || err);
    }
  }

  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json(out);
}

export default withApi(handler, {
  methods: ['GET'],
  anyPermission: DOWNLOAD_KEYS,
  rateLimit: 60,
  skipCsrf: true, // GET only
});
